import { ConfigService } from '@nestjs/config';
import { Socket } from 'net';
import { firstValueFrom } from 'rxjs';

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

// AxeOS v2.14.x reads a target as a whole difficulty: sv2_target_to_pdiff()
// truncates to uint32, at least 1 and at most 2^32-1 (v2.15 keeps a double).
// So every SV2 difficulty is a power of two from 1 to 2^31: whole, sent as an
// exact target, and read back by the firmware as exactly the same number.
// Anything else and the firmware mines easier than the pool judges (2328.3 is
// read as 2328), and the shares in between are rejected.
export const SV2_MIN_DIFFICULTY = 1;
export const SV2_MAX_DIFFICULTY = 2 ** 31;

// A Standard-channel miner can't make new work: it searches one job's merkle
// root over 2^32 nonces x 2^16 version-rolling values (mask 0x1fffe000), then
// starts over and finds the same shares again (duplicates). So the pool sends
// a new job, which is always a new coinbase (MiningJob puts its job id in the
// coinbase nSequence), before that can happen.
export const STANDARD_JOB_SEARCH_SPACE = 2 ** 32 * 2 ** 16;
export const STANDARD_REFRESH_MAX_SECONDS = 30;
export const STANDARD_REFRESH_MIN_SECONDS = 1;
// Refresh after a quarter of the search space, leaving room for a miner faster
// than measured or rolling fewer version bits.
const STANDARD_REFRESH_SAFETY = 4;
// No hashrate known at all (none claimed or measured yet).
const STANDARD_REFRESH_UNKNOWN_SECONDS = 10;

/** How often a Standard channel at this hashrate (H/s) needs new work; tooFast: more often than once a second. */
export function standardRefreshSeconds(hashrate: number): { seconds: number, tooFast: boolean } {
    if (!Number.isFinite(hashrate) || !(hashrate > 0)) return { seconds: STANDARD_REFRESH_UNKNOWN_SECONDS, tooFast: false };
    const wanted = STANDARD_JOB_SEARCH_SPACE / hashrate / STANDARD_REFRESH_SAFETY;
    return {
        seconds: Math.min(STANDARD_REFRESH_MAX_SECONDS, Math.max(STANDARD_REFRESH_MIN_SECONDS, wanted)),
        tooFast: wanted < STANDARD_REFRESH_MIN_SECONDS,
    };
}

/**
 * The SV2 difficulty for a wanted one: the nearest power of two (as vardiff
 * steps), within [lower, upper] rounded inward to powers of two, and within
 * [1, 2^31]. If the bounds cross, the lower one wins, as in V1.
 */
export function sv2Difficulty(wanted: number, lower: number, upper: number): number {
    const lo = 2 ** Math.ceil(Math.log2(Math.min(Math.max(lower || 0, SV2_MIN_DIFFICULTY), SV2_MAX_DIFFICULTY)));
    const hi = 2 ** Math.floor(Math.log2(Math.max(Math.min(upper > 0 ? upper : Infinity, SV2_MAX_DIFFICULTY), SV2_MIN_DIFFICULTY)));
    if (hi < lo) return lo;
    if (!Number.isFinite(wanted) || !(wanted > 0)) return lo;
    const nearest = 2 ** Math.round(Math.log2(wanted));
    return Math.min(Math.max(nearest, lo), hi);
}

// SRI's translator in aggregated mode opens one channel for a whole farm as
// "<address>.translator-proxy": no single worker name can stand for it.
export const AGGREGATED_PROXY_WORKER = 'translator-proxy';

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
    private refreshTimer: NodeJS.Timeout = null;
    // Extension 0x0002: the worker name a proxy sends with each share. The first
    // one names the channel (if no share has been recorded yet) and then stays.
    private tlvWorker: string = null;
    private tlvWorkerConflictWarned = false;
    private refreshTooFastWarned = false;
    private nominalHashRate = 0;
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
        this.nominalHashRate = Number.isFinite(nominalHashRate) && nominalHashRate > 0 ? nominalHashRate : 0;
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
        // Rounded to a power of two by clampDifficulty (1 TH/s: 2328.3 -> 2048).
        return nominalHashRate * 10 / 2 ** 32;
    }

    /** Every difficulty this channel uses (start, vardiff, UpdateChannel) comes through here. */
    protected clampDifficulty(difficulty: number): number {
        // The pool's floor and cap, and never easier than the miner's max_target allows (spec 5.3.21).
        if (!Number.isFinite(difficulty)) difficulty = this.minDifficulty;
        return sv2Difficulty(difficulty, Math.max(this.minDifficulty, this.clientMinDifficulty), this.maxDifficulty);
    }

    protected async applyNewDifficulty(targetDiff: number) {
        // Jobs sent with ntime_start keep their target (spec 5.3.21), and shares
        // on them are judged and credited at it. Jobs that arrived as future jobs
        // are ambiguous: the spec moves them to the new target, but Bitaxe
        // firmware (v2.14/v2.15) fixes a job's difficulty when it starts mining
        // it, so it keeps working at the old one until the refresh job below
        // arrives. Such a job only ever moves DOWN: then neither reading gets a
        // valid share rejected, and nobody is credited above what they were
        // asked for (a raise is credited at the old, lower difficulty).
        for (const poolId of this.futureJobs) {
            const issued = this.issuedJobs.get(poolId);
            if (issued != null && targetDiff < issued) this.issuedJobs.set(poolId, targetDiff);
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
                // Every MiningJob's coinbase carries its own job id (nSequence), so each
                // job, a refresh included, is a new merkle root: new work, even with the
                // same template and ntime.
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
        this.scheduleStandardRefresh();
    }

    /** The hashrate refreshes are paced for: measured once there is one, else what the miner claimed. */
    private get refreshHashRate(): number {
        const measured = this.statistics?.hashRate;
        return Number.isFinite(measured) && measured > 0 ? measured : this.nominalHashRate;
    }

    /** Standard channels: new work before the miner can run out of the current job. Restarted by every job sent. */
    private scheduleStandardRefresh() {
        if (this.type !== 'standard' || this.connectionClosed) return;
        if (this.refreshTimer != null) clearTimeout(this.refreshTimer);
        const hashrate = this.refreshHashRate;
        const { seconds, tooFast } = standardRefreshSeconds(hashrate);
        if (tooFast && !this.refreshTooFastWarned) {
            this.refreshTooFastWarned = true;
            console.warn(`SV2: Standard channel for ${this.address}.${this.worker} at ${(hashrate / 1e12).toFixed(1)} TH/s would need new work `
                + `more than once a second to avoid duplicate shares; use an Extended channel (AxeOS v2.15+ or any larger miner)`);
        }
        this.refreshTimer = setTimeout(() => {
            this.refreshTimer = null;
            this.refreshStandardJob().catch(e => {
                console.error('SV2: could not refresh a Standard job', e);
                this.scheduleStandardRefresh();
            });
        }, seconds * 1000);
        this.refreshTimer.unref?.();
    }

    private async refreshStandardJob() {
        if (this.connectionClosed) return;
        // While jobs are held (payouts not ready), there is nothing to send yet.
        if (this.payoutService?.enabled && !this.payoutService.ready) {
            this.scheduleStandardRefresh();
            return;
        }
        // Same template, older jobs stay valid: a new job, so a new coinbase (its job id in nSequence).
        await this.sendNewMiningJob(await firstValueFrom(this.stratumV1JobsService.newMiningJob$));
    }

    /** Bitaxe v2.14.x can't take extended jobs over 2 KB; v2.15+ can (8 KB). Logged once per address. */
    private warnIfTooBigForOldFirmware(payloadBytes: number) {
        if (payloadBytes <= BITAXE_V214_MAX_PAYLOAD || this.userAgent?.toLowerCase().indexOf('bitaxe') !== 0) return;
        if (Sv2Channel.bigJobWarned.has(this.address)) return;
        if (Sv2Channel.bigJobWarned.size > 10000) Sv2Channel.bigJobWarned.clear();
        Sv2Channel.bigJobWarned.add(this.address);
        console.warn(`SV2: extended job for ${this.address}.${this.worker} is ${payloadBytes} bytes; if it runs AxeOS before v2.15 it drops jobs over ${BITAXE_V214_MAX_PAYLOAD} bytes (update AxeOS to v2.15+, or use a Standard channel on v2.14)`);
    }

    /** SubmitSharesStandard / SubmitSharesExtended for this channel. */
    /**
     * A worker name from a share's 0x0002 TLV (a proxy passing on its miner's own
     * worker name). Same parsing as V1's "address.worker": up to the first dot.
     * It names the channel only before the miner's record exists, so a channel
     * keeps one name for its life; a different name later is logged, not used.
     */
    public applyTlvWorkerName(name: string) {
        const worker = name.split('.')[0];
        if (worker.length === 0 || worker === this.address || this.worker === AGGREGATED_PROXY_WORKER) return;
        if (this.tlvWorker != null) {
            if (worker !== this.tlvWorker && !this.tlvWorkerConflictWarned) {
                this.tlvWorkerConflictWarned = true;
                const clean = (x: string) => x.replace(/[^\x21-\x7e]/g, '?').slice(0, 40);
                console.warn(`SV2: channel ${this.address}.${clean(this.worker)} sent shares for another worker "${clean(worker)}"; `
                    + `they count as ${clean(this.worker)} (one worker per channel: use a non-aggregated proxy)`);
            }
            return;
        }
        this.tlvWorker = worker;
        if (this.entity != null || worker === this.worker) return;
        const clean = (x: string) => x.replace(/[^\x21-\x7e]/g, '?').slice(0, 40);
        console.log(`SV2 worker name: ${this.address}.${clean(this.worker)} is ${this.address}.${clean(worker)} (from the proxy) session=${this.extraNonceAndSessionId}`);
        this.worker = worker;
    }

    public async submit(m: SubmitSharesStandard | SubmitSharesExtended, extended: boolean, tlvWorkerName: string | null = null) {
        if (tlvWorkerName != null) this.applyTlvWorkerName(tlvWorkerName);
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
        if (this.refreshTimer != null) clearTimeout(this.refreshTimer);
        this.refreshTimer = null;
        await this.destroy();
    }
}
