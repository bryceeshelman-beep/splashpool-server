import { ConfigService } from '@nestjs/config';
import { Socket } from 'net';

import { MinerSession, ShareRejectReason } from '../models/MinerSession';
import { StratumV1ClientStatistics } from '../models/StratumV1ClientStatistics';
import { EXTRANONCE2_SIZE_BYTES } from '../models/stratum.constants';
import { AddressSettingsService } from '../ORM/address-settings/address-settings.service';
import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { ClientService } from '../ORM/client/client.service';
import { ShareWindowService } from '../ORM/share-window/share-window.service';
import { BitcoinRpcService } from '../services/bitcoin-rpc.service';
import { ExternalSharesService } from '../services/external-shares.service';
import { IJobTemplate, StratumV1JobsService } from '../services/stratum-v1-jobs.service';
import { FoundBlocksService } from '../splash/found-blocks';
import { IConnectionReporter } from '../splash/ip-guard';
import { PayoutService } from '../splash/payout.service';
import { difficultyToTarget, enc, SubmitSharesExtended, SubmitSharesStandard, targetToDifficulty } from './codec';

export type Sv2ChannelType = 'standard' | 'extended';

// SV2 error codes for each shared share-reject reason (sv2-spec 5.3.14 names
// the first four; the rest are free text, as the spec allows).
const SV2_REJECT_CODES: Record<ShareRejectReason, string> = {
    'job-not-found': 'invalid-job-id',
    'template-not-found': 'stale-share',
    'invalid-ntime': 'invalid-timestamp',
    'invalid-version': 'invalid-version',
    'duplicate': 'duplicate-share',
    'low-difficulty': 'difficulty-too-low',
};

// Bitaxe v2.14.x drops any incoming SV2 message over this many bytes.
export const BITAXE_V214_MAX_PAYLOAD = 2048;

/** What a channel needs from its connection. */
export interface ISv2ChannelLink {
    /** Encrypts and writes one plaintext frame. False if the connection is gone. */
    send(frame: Buffer): Promise<boolean>;
    readonly remoteAddress: string;
    readonly logShares: boolean;
}

/**
 * One Stratum V2 mining channel (standard or extended): one miner identity,
 * with all pool rules from MinerSession. Translates jobs, targets and shares
 * between SV2 messages and the shared pool logic, and nothing else.
 */
export class Sv2Channel extends MinerSession {
    private static rejectLogState = { nextLogAt: 0, suppressed: 0 };
    private static bigJobWarned = new Set<string>();

    private address: string;
    private worker: string;
    private userAgent: string;
    // Lowest difficulty the miner allows (from its max_target).
    private clientMinDifficulty = 0;

    // SV2 job ids are per channel; the pool's are global hex strings.
    private nextSv2JobId = 1;
    private readonly sv2ToPoolJob = new Map<number, string>();
    // Pool job ids sent as future jobs: SetTarget applies to these too (spec 5.3.21).
    private readonly futureJobs = new Set<string>();
    private lastPrevHash: Buffer = null;
    private lastPrevHashNtime = 0;

    constructor(
        public readonly channelId: number,
        public readonly type: Sv2ChannelType,
        private readonly link: ISv2ChannelLink,
        socket: Socket,
        stratumV1JobsService: StratumV1JobsService,
        bitcoinRpcService: BitcoinRpcService,
        clientService: ClientService,
        clientStatisticsService: ClientStatisticsService,
        foundBlocks: FoundBlocksService,
        configService: ConfigService,
        addressSettingsService: AddressSettingsService,
        externalSharesService: ExternalSharesService,
        shareWindowService?: ShareWindowService,
        payoutService?: PayoutService,
        ipReporter?: IConnectionReporter
    ) {
        super(socket, stratumV1JobsService, bitcoinRpcService, clientService, clientStatisticsService, foundBlocks,
            configService, addressSettingsService, externalSharesService, shareWindowService, payoutService, ipReporter);
    }

    protected get minerAddress() { return this.address; }
    protected get minerWorker() { return this.worker; }
    protected get minerUserAgent() { return this.userAgent; }

    protected connectionSummaryExtra(): string {
        return ` proto=sv2 channel=${this.type}`;
    }

    /** The extranonce prefix this channel's miner gets (hex). */
    public get extranoncePrefix(): string {
        return this.type === 'standard'
            ? this.extraNonceAndSessionId + '00'.repeat(EXTRANONCE2_SIZE_BYTES)
            : this.extraNonceAndSessionId;
    }

    /** Extended channels: the bytes the miner rolls. */
    public get extranonceSize(): number {
        return this.type === 'extended' ? EXTRANONCE2_SIZE_BYTES : 0;
    }

    public get difficulty(): number {
        return this.sessionDifficulty;
    }

    /**
     * Sets the miner up and returns the starting target. The caller sends the
     * Open...Success, then calls start().
     */
    public open(address: string, worker: string, userAgent: string, nominalHashRate: number, maxTarget: Buffer): Buffer {
        this.address = address;
        this.worker = worker;
        this.userAgent = userAgent;
        this.sessionStart = new Date();
        this.statistics = new StratumV1ClientStatistics(this.clientStatisticsService);
        this.extraNonceAndSessionId = this.getRandomHexString();
        this.clientMinDifficulty = targetToDifficulty(maxTarget);
        this.sessionDifficulty = this.clampDifficulty(this.startingDifficulty(nominalHashRate));
        return difficultyToTarget(this.sessionDifficulty);
    }

    public start() {
        this.startWork();
    }

    /** UpdateChannel: a new max_target (the nominal hash rate is left to vardiff). */
    public async update(maxTarget: Buffer) {
        this.clientMinDifficulty = targetToDifficulty(maxTarget);
        const d = this.clampDifficulty(this.sessionDifficulty);
        if (d !== this.sessionDifficulty) {
            this.sessionDifficulty = d;
            await this.applyNewDifficulty(d);
        }
    }

    /** Starting point for vardiff: the share rate it aims for (one per 10 s), from the claimed hash rate. */
    private startingDifficulty(nominalHashRate: number): number {
        if (!(nominalHashRate > 0) || !Number.isFinite(nominalHashRate)) {
            return this.sessionDifficulty;
        }
        const d = nominalHashRate * 10 / 2 ** 32;
        // Powers of two, like vardiff's own steps.
        return d >= 1 ? 2 ** Math.round(Math.log2(d)) : d;
    }

    protected clampDifficulty(difficulty: number): number {
        // Never easier than the miner's max_target allows (spec 5.3.21).
        return Math.max(super.clampDifficulty(difficulty), this.clientMinDifficulty);
    }

    protected async applyNewDifficulty(targetDiff: number) {
        // Spec 5.3.21: the new target covers jobs that arrived as future jobs; jobs
        // sent with ntime_start keep theirs. Shares are still judged and credited
        // at the difficulty their job holds, so nothing earns more than it met.
        for (const poolId of this.futureJobs) {
            if (this.issuedJobs.has(poolId)) this.issuedJobs.set(poolId, targetDiff);
        }
        const ok = await this.link.send(enc.setTarget({ channelId: this.channelId, maximumTarget: difficultyToTarget(targetDiff) }));
        if (!ok) return;
        // Jobs already sent keep their target (spec 5.3.21), so new work carries the new one.
        await this.sendRefreshedJob();
    }

    protected async sendNewMiningJob(jobTemplate: IJobTemplate) {
        const job = this.buildJob(jobTemplate);
        if (job == null) {
            return;
        }
        // Forget ids of jobs the pool no longer holds for us (cleared on a new block or expired).
        for (const [id, poolId] of this.sv2ToPoolJob) {
            if (!this.issuedJobs.has(poolId)) this.sv2ToPoolJob.delete(id);
        }
        for (const poolId of this.futureJobs) {
            if (!this.issuedJobs.has(poolId)) this.futureJobs.delete(poolId);
        }
        const sv2JobId = this.nextSv2JobId;
        this.nextSv2JobId = (this.nextSv2JobId % 0xffffffff) + 1;
        this.sv2ToPoolJob.set(sv2JobId, job.jobId);

        const prevHash = jobTemplate.block.prevHash;
        const newPrevHash = this.lastPrevHash == null || !this.lastPrevHash.equals(prevHash);
        // ntime_start may not go below the last SetNewPrevHash's (spec 5.3.16).
        const ntime = newPrevHash ? jobTemplate.block.timestamp : Math.max(jobTemplate.block.timestamp, this.lastPrevHashNtime);
        const version = jobTemplate.block.version >>> 0;

        // A new prevhash: a future job, then SetNewPrevHash naming it.
        const minNtime = newPrevHash ? null : ntime;
        if (newPrevHash) this.futureJobs.add(job.jobId);
        let jobFrame: Buffer;
        if (this.type === 'standard') {
            jobFrame = enc.newMiningJob({
                channelId: this.channelId, jobId: sv2JobId, minNtime, version,
                merkleRoot: job.merkleRoot(this.extraNonceAndSessionId, '00'.repeat(EXTRANONCE2_SIZE_BYTES)),
            });
        } else {
            jobFrame = enc.newExtendedMiningJob({
                channelId: this.channelId, jobId: sv2JobId, minNtime, version, versionRollingAllowed: true,
                merklePath: jobTemplate.merkle_branch.map(b => Buffer.from(b, 'hex')),
                coinbaseTxPrefix: job.coinbasePrefix, coinbaseTxSuffix: job.coinbaseSuffix,
            });
            this.warnIfTooBigForOldFirmware(jobFrame.length - 6);
        }
        if (!await this.link.send(jobFrame)) return;
        if (newPrevHash) {
            const ok = await this.link.send(enc.setNewPrevHash({
                channelId: this.channelId, jobId: sv2JobId, prevHash, minNtime: ntime, nbits: jobTemplate.block.bits >>> 0,
            }));
            if (!ok) return;
            this.lastPrevHash = Buffer.from(prevHash);
            this.lastPrevHashNtime = ntime;
        }
        this.lastSentMiningJobTimestamp = ntime;
    }

    /** Bitaxe v2.14.x can't take extended jobs over 2 KB; v2.15+ can (8 KB). Logged once per address. */
    private warnIfTooBigForOldFirmware(payloadBytes: number) {
        if (payloadBytes <= BITAXE_V214_MAX_PAYLOAD || this.userAgent?.toLowerCase().indexOf('bitaxe') !== 0) return;
        if (Sv2Channel.bigJobWarned.has(this.address)) return;
        if (Sv2Channel.bigJobWarned.size > 10000) Sv2Channel.bigJobWarned.clear();
        Sv2Channel.bigJobWarned.add(this.address);
        console.warn(`SV2: extended job for ${this.address}.${this.worker} is ${payloadBytes} bytes; AxeOS before v2.15 drops jobs over ${BITAXE_V214_MAX_PAYLOAD} bytes (use a Standard channel or update AxeOS)`);
    }

    /** SubmitSharesStandard / SubmitSharesExtended for this channel. */
    public async submit(m: SubmitSharesStandard | SubmitSharesExtended, extended: boolean) {
        const reject = (code: string) => this.link.send(enc.submitSharesError({ channelId: this.channelId, sequenceNumber: m.sequenceNumber, errorCode: code }));
        if (extended !== (this.type === 'extended')) {
            this.logReject('wrong-submit-type');
            if (!this.noteShareResult(false)) await reject('invalid-channel-id');
            return;
        }
        let extraNonce2 = '00'.repeat(EXTRANONCE2_SIZE_BYTES);
        if (extended) {
            const en = (m as SubmitSharesExtended).extranonce;
            if (en.length !== EXTRANONCE2_SIZE_BYTES) {
                this.logReject('invalid-extranonce');
                if (!this.noteShareResult(false)) await reject('invalid-extranonce');
                return;
            }
            extraNonce2 = en.toString('hex');
        }
        // Unknown ids reach processShare as an id no job has, so they count and reply as V1's do.
        const poolJobId = this.sv2ToPoolJob.get(m.jobId) ?? `sv2-unknown-${m.jobId}`;
        await this.processShare({
            jobId: poolJobId,
            extraNonce2,
            nonce: m.nonce >>> 0,
            timestamp: m.ntime >>> 0,
            version: { full: m.version >>> 0 },
        }, {
            reject: (reason, message) => {
                // An id we issued but the pool has dropped (new block) is stale, not invalid.
                const code = reason === 'job-not-found' && m.jobId > 0 && m.jobId < this.nextSv2JobId ? 'stale-share' : SV2_REJECT_CODES[reason];
                this.logReject(`${code} (${message})`);
                return reject(code);
            },
            accept: async (shareDifficulty) => {
                if (this.link.logShares) {
                    console.log(`SV2 share accepted: ${this.address}.${this.worker} ch=${this.channelId} seq=${m.sequenceNumber} diff=${shareDifficulty}`);
                }
                return this.link.send(enc.submitSharesSuccess({
                    channelId: this.channelId, lastSequenceNumber: m.sequenceNumber, newSubmitsAcceptedCount: 1,
                    newSharesSum: BigInt(Math.max(0, Math.floor(shareDifficulty))),
                }));
            },
        });
    }

    private logReject(what: string) {
        const log = Sv2Channel.rejectLogState;
        const now = Date.now();
        if (now < log.nextLogAt) {
            log.suppressed++;
            return;
        }
        const ip = this.link.remoteAddress?.replace(/^::ffff:/i, '');
        console.log(`SV2 share rejected: ${this.address}.${this.worker} (${ip}) ch=${this.channelId} ${what}${log.suppressed > 0 ? ` (+${log.suppressed} similar not logged)` : ''}`);
        log.nextLogAt = now + 10_000;
        log.suppressed = 0;
    }

    /** V1's user-agent block list (NON_COMPLIANT_USER_AGENTS), logged the same way. */
    public isBlockedAgent(userAgent: string): boolean {
        if (!this.isBlockedUserAgent(userAgent)) return false;
        this.logBlockedUserAgent(userAgent);
        return true;
    }

    /** Closes this channel's miner session (not the connection). */
    public async close() {
        this.connectionClosed = true;
        await this.destroy();
    }
}
