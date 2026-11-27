import { ConfigService } from '@nestjs/config';
import * as bitcoinjs from 'bitcoinjs-lib';
import * as crypto from 'crypto';
import { Socket } from 'net';
import { firstValueFrom, Subscription, switchMap } from 'rxjs';
import { clearInterval } from 'timers';

import { AddressSettingsService } from '../ORM/address-settings/address-settings.service';
import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { ClientEntity } from '../ORM/client/client.entity';
import { ClientService } from '../ORM/client/client.service';
import { ShareWindowService } from '../ORM/share-window/share-window.service';
import { BitcoinRpcService } from '../services/bitcoin-rpc.service';
import { ExternalSharesService } from '../services/external-shares.service';
import { IJobTemplate, StratumV1JobsService } from '../services/stratum-v1-jobs.service';
import { ISubmitResult } from '../splash/block-submission';
import { FoundBlocksService } from '../splash/found-blocks';
import { IConnectionReporter } from '../splash/ip-guard';
import { PayoutService } from '../splash/payout.service';
import { MiningJob } from './MiningJob';
import { EXTRANONCE1_SIZE_BYTES } from './stratum.constants';
import { StratumV1ClientStatistics } from './StratumV1ClientStatistics';

export const TRUE_DIFF_ONE = 2.695953529101131e67;
const BLOCKED_USER_AGENT_LOG_INTERVAL_MS = 60 * 1000;
// Consensus: a block may be at most two hours ahead of the node's clock.
const MAX_FUTURE_BLOCK_SECONDS = 2 * 60 * 60;

// The rolling mask the pool offers (mining.configure in V1; BIP320 bits in SV2).
export const VERSION_ROLLING_MASK = 0x1fffe000;

/**
 * BIP310: block version = (job version & ~mask) | (submitted bits & mask).
 * Returned as the XOR mask that turns the job version into that version, so
 * the existing header/block builders (which XOR) can use it unchanged.
 */
export function bip310XorMask(jobVersion: number, submittedBits: number): number {
    const rolled = ((jobVersion & ~VERSION_ROLLING_MASK) | (submittedBits & VERSION_ROLLING_MASK)) >>> 0;
    return (jobVersion ^ rolled) >>> 0;
}

/** Why a share was refused. Each protocol maps these to its own error codes. */
export type ShareRejectReason =
    'job-not-found'
    | 'template-not-found'
    | 'invalid-ntime'
    | 'invalid-version'
    | 'duplicate'
    | 'low-difficulty';

/** A share, already parsed by the protocol layer. */
export interface IShareSubmission {
    jobId: string;
    /** Hex, lower case: the part of the extranonce after the session id. */
    extraNonce2: string;
    nonce: number;
    timestamp: number;
    /** Either an XOR mask against the job version, or the full version. */
    version: { xorMask: number, bip310Fallback: boolean } | { full: number };
}

/** How the protocol layer answers a share. Each returns false if the reply could not be sent. */
export interface IShareReplies {
    reject(reason: ShareRejectReason, message: string): Promise<boolean>;
    accept(shareDifficulty: number): Promise<boolean>;
}

/**
 * Splash Pool: one miner's session, whatever protocol it speaks. Holds the
 * pool logic that must be the same for every way in: building this miner's
 * jobs (payout outputs), judging and crediting shares, block submission,
 * statistics, vardiff, and the reject limit. A protocol (Stratum V1 or V2)
 * extends this, parses its own messages and supplies the identity and the
 * replies.
 */
export abstract class MinerSession {
    private static blockedUserAgentLogState = new Map<string, { nextLogAt: number, suppressed: number }>();
    private static rejectKickLog = { nextLogAt: 0, suppressed: 0 };

    protected stratumSubscription: Subscription;
    protected backgroundWork: NodeJS.Timeout[] = [];

    protected statistics: StratumV1ClientStatistics;
    protected sessionDifficulty: number = 100000;
    private minDifficultyCache: number;
    private maxDifficultyCache: number;
    // Splash Pool reject limit: per-connection counts for the current minute.
    private rejectWindowStart = 0;
    private rejectWindowAccepted = 0;
    private rejectWindowRejected = 0;

    protected entity: ClientEntity;
    private creatingEntity: Promise<void>;

    public extraNonceAndSessionId: string;
    public sessionStart: Date;
    public noFee: boolean;
    public hashRate: number = 0;

    protected connectionClosed = false;
    protected lastSentMiningJobTimestamp: number = null;

    protected miningSubmissionHeaders = new Set<string>()
    // This connection's jobs and the difficulty each was issued at. A share is
    // judged and credited only by that, never by the current session difficulty.
    protected issuedJobs = new Map<string, number>();

    // Splash Pool connection hygiene (see closeAsJunk and connectionSummary).
    protected readonly connectedAt = Date.now();
    protected closeReason: string = null;
    protected invalidSinceAccepted = 0;
    protected invalidTotal = 0;
    protected acceptedTotal = 0;
    protected rejectedTotal = 0;

    constructor(
        public readonly socket: Socket,
        protected readonly stratumV1JobsService: StratumV1JobsService,
        protected readonly bitcoinRpcService: BitcoinRpcService,
        protected readonly clientService: ClientService,
        protected readonly clientStatisticsService: ClientStatisticsService,
        protected readonly foundBlocks: FoundBlocksService,
        protected readonly configService: ConfigService,
        protected readonly addressSettingsService: AddressSettingsService,
        protected readonly externalSharesService: ExternalSharesService,
        protected readonly shareWindowService?: ShareWindowService,
        protected readonly payoutService?: PayoutService,
        protected readonly ipReporter?: IConnectionReporter
    ) {
    }

    /** The miner's payout address, once it has logged in. */
    protected abstract get minerAddress(): string | undefined;
    /** The worker name, once it has logged in. */
    protected abstract get minerWorker(): string | undefined;
    /** The miner's user agent (V1 subscribe; SV2 vendor/hardware). */
    protected abstract get minerUserAgent(): string | undefined;
    /** Sends this miner a new job built from the template. */
    protected abstract sendNewMiningJob(jobTemplate: IJobTemplate): Promise<void>;
    /** Tells the miner its new difficulty, and gives it work at that difficulty. */
    protected abstract applyNewDifficulty(targetDiff: number): Promise<void>;
    /** Extra fields for the close log (empty for V1, so its line is unchanged). */
    protected connectionSummaryExtra(): string {
        return '';
    }

    public async destroy() {
        if (this.extraNonceAndSessionId) {
            await this.clientService.delete(this.extraNonceAndSessionId);
        }

        if (this.stratumSubscription != null) {
            this.stratumSubscription.unsubscribe();
        }

        this.backgroundWork.forEach(work => {
            clearInterval(work);
        });
    }

    protected getRandomHexString() {
        const randomBytes = crypto.randomBytes(EXTRANONCE1_SIZE_BYTES);
        return randomBytes.toString('hex');
    }

    /** Starts sending jobs, and checks the difficulty every minute. */
    protected startWork() {
        // No jobs until the share window has been read. Waiting miners then get
        // the current template at once.
        const jobs$ = this.payoutService?.enabled
            ? this.payoutService.ready$.pipe(switchMap(() => this.stratumV1JobsService.newMiningJob$))
            : this.stratumV1JobsService.newMiningJob$;
        this.stratumSubscription = jobs$.subscribe(async (jobTemplate) => {
            try {
                if(jobTemplate.blockData.clearJobs){
                    this.miningSubmissionHeaders.clear();
                    this.issuedJobs.clear();
                }
                await this.sendNewMiningJob(jobTemplate);
            } catch (e) {
                await this.socket.end();
                console.error(e);
            }
        });

        this.backgroundWork.push(
            setInterval(async () => {
                // An error here must not become an unhandled rejection, which
                // would crash the whole pool. Drop this one miner instead.
                try {
                    await this.checkDifficulty();
                } catch (e) {
                    console.error(e);
                    try { await this.socket.end(); } catch { }
                }
            }, 60 * 1000)
        );
    }

    /**
     * Builds this miner's job for the template (its Splash payout outputs) and
     * records it, or closes the connection and returns null if it can't.
     */
    protected buildJob(jobTemplate: IJobTemplate): MiningJob | null {

        let payoutInformation;
        const devFeeAddress = this.configService.get('DEV_FEE_ADDRESS');
        //50Th/s
        this.noFee = false;
        if (this.entity) {
            this.hashRate = this.statistics.hashRate;
            this.noFee = this.hashRate != 0 && this.hashRate < 50000000000000;
        }
        if (this.payoutService?.enabled) {
            // Splash Pool: exact outputs, built below.
        } else if (this.noFee || devFeeAddress == null || devFeeAddress.length < 1) {
            payoutInformation = [
                { address: this.minerAddress, percent: 100 }
            ];

        } else {
            payoutInformation = [
                { address: devFeeAddress, percent: 1.5 },
                { address: this.minerAddress, percent: 98.5 }
            ];
        }

        const networkConfig = this.configService.get('NETWORK');
        let network;

        if (networkConfig === 'mainnet') {
            network = bitcoinjs.networks.bitcoin;
        } else if (networkConfig === 'testnet') {
            network = bitcoinjs.networks.testnet;
        } else if (networkConfig === 'regtest') {
            network = bitcoinjs.networks.regtest;
        } else {
            throw new Error('Invalid network configuration');
        }

        let job: MiningJob;
        try {
            if (this.payoutService?.enabled) {
                // This miner's Splash Bonus as finder, the fee, and the 3-day window split.
                payoutInformation = this.payoutService.outputsFor(this.minerAddress, jobTemplate.blockData.coinbasevalue);
            }
            job = new MiningJob(
                this.configService,
                network,
                this.stratumV1JobsService.getNextId(),
                payoutInformation,
                jobTemplate
            );
        } catch (e) {
            // Backstop: drop this connection only, and never fall back to another payout.
            console.error(`Splash: no job built for ${this.minerAddress}, closing its connection`, e);
            this.closeSocket();
            return null;
        }

        this.stratumV1JobsService.addJob(job);
        this.issuedJobs.set(job.jobId, this.sessionDifficulty);
        return job;
    }

    protected async ensureClientEntity() {
        if (this.entity != null) {
            return;
        }

        if (this.creatingEntity == null) {
            this.creatingEntity = (async () => {
                this.entity = await this.clientService.insert({
                    sessionId: this.extraNonceAndSessionId,
                    address: this.minerAddress,
                    clientName: this.minerWorker,
                    userAgent: this.minerUserAgent,
                    startTime: new Date(),
                    bestDifficulty: 0
                });
            })();
        }

        await this.creatingEntity;
    }

    /**
     * Judges one share and, if it is good, credits it, submits a block if it is
     * one, and updates the statistics. The protocol layer has parsed it and
     * sends the replies. Every share follows exactly the same rules, whichever
     * protocol it came in on.
     */
    protected async processShare(submission: IShareSubmission, replies: IShareReplies): Promise<void> {

        const issuedDifficulty = this.issuedJobs.get(submission.jobId);
        // Another connection's job is "not found" here.
        const job = issuedDifficulty == null ? null : this.stratumV1JobsService.getJobById(submission.jobId);

        // a miner may submit a job that doesn't exist anymore if it was removed by a new block notification (or expired, 5 min)
        if (job == null) {
            if (this.noteShareResult(false)) {
                return;
            }
            await replies.reject('job-not-found', 'Job not found');
            return;
        }
        const jobTemplate = this.stratumV1JobsService.getJobTemplateById(job.jobTemplateId);

        if (jobTemplate == null) {
            if (this.noteShareResult(false)) {
                return;
            }
            await replies.reject('template-not-found', 'Job Template not found');
            return;
        }

        const extraNonce2 = submission.extraNonce2;
        const nonce = submission.nonce;
        const timestamp = submission.timestamp;
        const v = submission.version;
        // SV2 sends the whole version: as an XOR mask it is exact, with no
        // V1-style ambiguity about what the bits mean.
        let versionMask = 'full' in v ? ((jobTemplate.block.version ^ v.full) >>> 0) : v.xorMask;
        const bip310Fallback = 'full' in v ? false : v.bip310Fallback;

        // Work that could never be a valid block earns nothing.
        let invalid: string = null;
        let invalidReason: ShareRejectReason = null;
        if (timestamp < jobTemplate.blockData.mintime || timestamp > Math.floor(Date.now() / 1000) + MAX_FUTURE_BLOCK_SECONDS) {
            invalid = 'Invalid ntime';
            invalidReason = 'invalid-ntime';
        } else if ((versionMask & ~VERSION_ROLLING_MASK) !== 0) {
            invalid = 'Invalid version bits';
            invalidReason = 'invalid-version';
        }
        if (invalid != null) {
            if (this.noteShareResult(false)) {
                return;
            }
            await replies.reject(invalidReason, invalid);
            return;
        }

        // A block always counts, so the chance of a share is set by the lower of
        // the two difficulties, and so is the credit.
        const shareDifficulty = Math.min(issuedDifficulty, jobTemplate.blockData.networkDifficulty);

        const header = job.buildHeaderBuffer(
            jobTemplate,
            versionMask,
            nonce,
            this.extraNonceAndSessionId,
            extraNonce2,
            timestamp
        );
        let { submissionDifficulty } = this.calculateDifficulty(header);
        let finalHeader = header;

        // Splash Pool: firmware disagrees on what the submitted version bits mean.
        // Bitaxe-style firmware sends only the bits it flipped (XOR, above); BIP310
        // firmware (e.g. the Hammer) sends the full rolled bits. The two only differ
        // when the template version already has a bit inside the rolling mask, as
        // in any soft-fork signalling period. Try the BIP310 reading, expressed as
        // the equivalent XOR mask, before calling the share low.
        if (bip310Fallback && submissionDifficulty < shareDifficulty && versionMask) {
            const bip310Mask = bip310XorMask(jobTemplate.block.version, versionMask);
            if (bip310Mask !== versionMask) {
                const altHeader = job.buildHeaderBuffer(
                    jobTemplate,
                    bip310Mask,
                    nonce,
                    this.extraNonceAndSessionId,
                    extraNonce2,
                    timestamp
                );
                const alt = this.calculateDifficulty(altHeader).submissionDifficulty;
                if (alt > submissionDifficulty) {
                    submissionDifficulty = alt;
                    versionMask = bip310Mask;
                    finalHeader = altHeader;
                }
            }
        }

        // One header is one piece of work, however it was spelled and whichever
        // job id it came under. So this check has to follow the BIP310 fallback.
        const headerKey = finalHeader.toString('base64');
        if (this.miningSubmissionHeaders.has(headerKey)) {
            if (this.noteShareResult(false)) {
                return;
            }
            await replies.reject('duplicate', 'Duplicate share');
            return;
        }
        this.miningSubmissionHeaders.add(headerKey);

        // A block solution is always accepted, even below the session difficulty
        // (possible on test networks, where blocks can be easier than the floor).
        if (submissionDifficulty >= shareDifficulty) {
            this.noteShareResult(true);
            // Taken now: both can change while this awaits.
            const address = this.minerAddress;
            const worker = this.minerWorker;
            const credit = () => this.shareWindowService?.recordShare(address, shareDifficulty, Date.now(), worker);

            // A block is saved and submitted before the reply, which fails if the
            // miner has gone or the pool is stopping. It must not depend on either.
            let submitting: Promise<ISubmitResult> = null;
            if (submissionDifficulty >= jobTemplate.blockData.networkDifficulty) {
                // Splash Pool: credit this share to the 3-day window before any
                // block handling, so a block-finding share counts too.
                credit();
                console.log('!!! BLOCK FOUND !!!');
                const updatedJobBlock = job.copyAndUpdateBlock(
                    jobTemplate,
                    versionMask,
                    nonce,
                    this.extraNonceAndSessionId,
                    extraNonce2,
                    timestamp
                );
                const hex = updatedJobBlock.toHex(false);
                const height = jobTemplate.blockData.height;
                const hash = updatedJobBlock.getId();
                submitting = this.foundBlocks.found({
                    hex, hash, height, address, worker, sessionId: this.extraNonceAndSessionId, foundAt: Date.now(),
                });
                // A spare copy if the disk fails. The journal can drop or cut it.
                console.log(`Submitting block ${hash} at height ${height}: ${hex}`);
            }

            const success = await replies.accept(shareDifficulty);
            if (!success) {
                return;
            }

            if (submitting == null) {
                credit();
            } else {
                const { outcome, response } = await submitting;
                //success
                if (outcome === 'accepted' && response == null) {
                    await this.addressSettingsService.resetBestDifficultyAndShares();
                }
            }
            await this.ensureClientEntity();
            try {
                await this.statistics.addShares(this.entity, shareDifficulty);
                const now = new Date();
                // only update every minute
                if (this.entity.updatedAt == null || now.getTime() - this.entity.updatedAt.getTime() > 1000 * 60) {
                    await this.clientService.heartbeat(this.entity.address, this.entity.clientName, this.entity.sessionId, this.hashRate, now);
                    this.entity.updatedAt = now;
                }

            } catch (e) {
                console.log(e);
            }

            if (submissionDifficulty > this.entity.bestDifficulty) {
                await this.clientService.updateBestDifficultyIfHigher(this.extraNonceAndSessionId, submissionDifficulty);
                this.entity.bestDifficulty = submissionDifficulty;
                await this.addressSettingsService.updateBestDifficultyIfHigher(this.minerAddress, submissionDifficulty, this.entity.userAgent);
            }


            const externalShareSubmissionEnabled: boolean = this.configService.get('EXTERNAL_SHARE_SUBMISSION_ENABLED')?.toLowerCase() == 'true';
            const minimumDifficulty: number = parseFloat(this.configService.get('MINIMUM_DIFFICULTY')) || 1000000000000.0; // 1T
            if (externalShareSubmissionEnabled && submissionDifficulty >= minimumDifficulty) {
                // Submit share to API if enabled
                this.externalSharesService.submitShare({
                    worker: this.minerWorker,
                    address: this.minerAddress,
                    userAgent: this.minerUserAgent,
                    header: finalHeader.toString('hex'),
                    externalPoolName: this.configService.get('POOL_IDENTIFIER') || 'Public-Pool'
                });
            }

        } else {
            if (this.noteShareResult(false)) {
                return;
            }
            await replies.reject('low-difficulty', 'Difficulty too low');
        }
    }

    /**
     * Splash Pool: lowest share difficulty a connection may have, so nobody can
     * flood the pool with trivially easy shares via suggest_difficulty or by
     * idling until vardiff decays. SPLASH_MIN_DIFFICULTY sets it; unset, it is
     * 512 on mainnet (a ~400 GH/s Bitaxe still gets a share every ~5 s) and off
     * elsewhere.
     */
    protected get minDifficulty(): number {
        if (this.minDifficultyCache == null) {
            const raw = this.configService.get('SPLASH_MIN_DIFFICULTY');
            const parsed = raw == null || `${raw}`.trim() === '' ? NaN : Number(raw);
            if (Number.isFinite(parsed) && parsed >= 0) {
                this.minDifficultyCache = parsed;
            } else {
                if (raw != null && `${raw}`.trim() !== '') {
                    console.warn(`Ignoring invalid SPLASH_MIN_DIFFICULTY=${raw}`);
                }
                this.minDifficultyCache = this.configService.get('NETWORK') === 'mainnet' ? 512 : 0;
            }
        }
        return this.minDifficultyCache;
    }

    /**
     * Splash Pool: highest share difficulty a connection is given. A higher
     * suggestion can't earn extra credit (credit is capped at the network
     * difficulty), but numbers like 1e308 confuse some firmware and dashboards.
     * SPLASH_MAX_DIFFICULTY sets it; the default 2^53 is the largest whole number
     * sent exactly, about 60x mainnet difficulty in 2026.
     */
    protected get maxDifficulty(): number {
        if (this.maxDifficultyCache == null) {
            const raw = this.configService.get('SPLASH_MAX_DIFFICULTY');
            const parsed = raw == null || `${raw}`.trim() === '' ? NaN : Number(raw);
            if (Number.isFinite(parsed) && parsed > 0) {
                this.maxDifficultyCache = parsed;
            } else {
                if (raw != null && `${raw}`.trim() !== '') {
                    console.warn(`Ignoring invalid SPLASH_MAX_DIFFICULTY=${raw}`);
                }
                this.maxDifficultyCache = 2 ** 53;
            }
        }
        return this.maxDifficultyCache;
    }

    protected clampDifficulty(difficulty: number): number {
        if (!Number.isFinite(difficulty)) {
            return Math.max(100000, this.minDifficulty);
        }
        // The floor wins if the two are misconfigured the wrong way round.
        return Math.max(Math.min(difficulty, this.maxDifficulty), this.minDifficulty);
    }

    protected async checkDifficulty() {
        // While jobs are held there is no work to retarget, and a retarget sends a job.
        if (this.payoutService?.enabled && !this.payoutService.ready) {
            return;
        }
        const suggested = this.statistics.getSuggestedDifficulty(this.sessionDifficulty);
        if (suggested == null) {
            return;
        }
        const targetDiff = this.clampDifficulty(suggested);

        if (targetDiff != this.sessionDifficulty) {
            //console.log(`Adjusting ${this.extraNonceAndSessionId} difficulty from ${this.sessionDifficulty} to ${targetDiff}`);
            this.sessionDifficulty = targetDiff;
            await this.applyNewDifficulty(targetDiff);
        }
    }

    /** New work at the current difficulty, outside the template cycle. */
    protected async sendRefreshedJob() {
        const jobTemplate = await firstValueFrom(this.stratumV1JobsService.newMiningJob$);
        const nextTimestamp = Math.max(
            jobTemplate.block.timestamp,
            Math.floor(Date.now() / 1000),
            (this.lastSentMiningJobTimestamp ?? 0) + 1
        );
        // We need to clear jobs so the difficulty takes effect, but avoid mutating or
        // re-sending the shared cached template with byte-identical work.
        const refreshedJobTemplate: IJobTemplate = {
            ...jobTemplate,
            block: Object.assign(new bitcoinjs.Block(), jobTemplate.block, {
                timestamp: nextTimestamp
            }),
            blockData: { ...jobTemplate.blockData, clearJobs: true }
        };
        await this.sendNewMiningJob(refreshedJobTemplate);
    }

    protected calculateDifficulty(header: Buffer): { submissionDifficulty: number, submissionHash: string } {

        const hashResult = bitcoinjs.crypto.hash256(header);

        const target = this.le256todouble(hashResult);
        const submissionDifficulty = target === 0 ? Number.POSITIVE_INFINITY : TRUE_DIFF_ONE / target;
        return { submissionDifficulty, submissionHash: hashResult.toString('hex') };
    }


    protected le256todouble(target: Buffer): number {

        let number = 0;
        for (let i = target.length - 1; i >= 0; i--) {
            number = number * 256 + target[i];
        }

        return number;
    }

    protected isBlockedUserAgent(userAgent: string): boolean {
        const blockedUserAgents = this.configService.get<string>('NON_COMPLIANT_USER_AGENTS')
            || this.configService.get<string>('BLOCKED_USER_AGENTS')
            || this.configService.get<string>('COMPLIANT_HEADERS');
        if (!blockedUserAgents || blockedUserAgents.trim() === '') {
            return false;
        }

        const blockedList = blockedUserAgents.split(',').map(ua => ua.trim().toLowerCase());
        const userAgentLower = userAgent.toLowerCase();

        return blockedList.some(blocked => blocked.length > 0 && userAgentLower.includes(blocked));
    }

    protected logBlockedUserAgent(userAgent: string) {
        const now = Date.now();
        const logState = MinerSession.blockedUserAgentLogState.get(userAgent);

        if (logState != null && now < logState.nextLogAt) {
            logState.suppressed += 1;
            return;
        }

        const suppressed = logState?.suppressed ?? 0;
        const suffix = suppressed > 0 ? ` (${suppressed} similar connections suppressed)` : '';
        console.log(`Blocked non-compliant connection from userAgent: ${userAgent}${suffix}`);
        MinerSession.blockedUserAgentLogState.set(userAgent, {
            nextLogAt: now + BLOCKED_USER_AGENT_LOG_INTERVAL_MS,
            suppressed: 0
        });
    }

    /**
     * Splash Pool reject limit. Counts accepted and rejected shares per minute and
     * disconnects a connection whose rejects reach SPLASH_REJECT_LIMIT (default 200)
     * and SPLASH_REJECT_RATIO (default 0.9) of its submissions in that minute, so
     * nobody can burn pool CPU with junk shares. A healthy miner never gets close:
     * vardiff aims for a share every few seconds, and stale rejects after a new
     * block or difficulty change are a small fraction. SPLASH_REJECT_LIMIT=0 turns
     * it off. Returns true if the connection was closed.
     */
    protected noteShareResult(accepted: boolean): boolean {
        const now = Date.now();
        if (now - this.rejectWindowStart >= 60_000) {
            this.rejectWindowStart = now;
            this.rejectWindowAccepted = 0;
            this.rejectWindowRejected = 0;
        }
        if (accepted) {
            this.rejectWindowAccepted++;
            this.acceptedTotal++;
            this.invalidSinceAccepted = 0;
            this.ipReporter?.accepted();
            return false;
        }
        this.rejectWindowRejected++;
        this.rejectedTotal++;
        const limit = this.configNumber('SPLASH_REJECT_LIMIT', 200);
        if (limit <= 0 || this.rejectWindowRejected < limit) {
            return false;
        }
        const ratio = this.configNumber('SPLASH_REJECT_RATIO', 0.9);
        const total = this.rejectWindowAccepted + this.rejectWindowRejected;
        if (this.rejectWindowRejected / total < ratio) {
            return false;
        }
        const log = MinerSession.rejectKickLog;
        if (now >= log.nextLogAt) {
            console.warn(`Splash: disconnecting ${this.minerAddress ?? '?'}.${this.minerWorker ?? '?'} (${this.socket.remoteAddress}): ${this.rejectWindowRejected} rejected / ${total} shares this minute${log.suppressed > 0 ? ` (+${log.suppressed} similar disconnects not logged)` : ''}`);
            log.nextLogAt = now + 10_000;
            log.suppressed = 0;
        } else {
            log.suppressed++;
        }
        this.closeAsJunk('rejects');
        return true;
    }

    /** Closes a connection that is junk and tells the IP guard. */
    protected closeAsJunk(reason: string) {
        this.setCloseReason(reason);
        this.ipReporter?.junk();
        this.closeSocket();
    }

    /** Why this connection closed. The first reason given wins. */
    public setCloseReason(reason: string) {
        if (this.closeReason == null) {
            this.closeReason = reason;
        }
    }

    /**
     * One line describing this connection, for the SPLASH_CONN_LOG close log.
     * Miner-supplied text (worker, user agent) is cut short and stripped of
     * anything but printable ASCII, so it can't forge or break log lines.
     */
    public connectionSummary(ip: string, hadError: boolean): string {
        const clean = (s: unknown, max: number) => s == null ? '-' : (String(s).replace(/[^\x21-\x7e]/g, '?').slice(0, max) || '-');
        const reason = this.closeReason ?? (hadError ? 'error' : 'client-closed');
        const address = this.minerAddress;
        const workerName = this.minerWorker;
        const worker = address == null ? '-' : `${clean(address, 100)}${workerName ? '.' + clean(workerName, 40) : ''}`;
        const seconds = Math.round((Date.now() - this.connectedAt) / 1000);
        return `Splash conn: ip=${clean(ip?.replace(/^::ffff:/i, ''), 45)} worker=${worker} agent=${clean(this.minerUserAgent, 40)}`
            + ` reason=${reason} dur=${seconds}s acc=${this.acceptedTotal} rej=${this.rejectedTotal} invalid=${this.invalidTotal}`
            + this.connectionSummaryExtra();
    }

    protected configNumber(key: string, fallback: number): number {
        const raw = this.configService.get(key);
        const n = raw == null || `${raw}`.trim() === '' ? NaN : Number(raw);
        return Number.isFinite(n) && n >= 0 ? n : fallback;
    }

    protected closeSocket() {
        this.connectionClosed = true;
        if (!this.socket.destroyed) {
            this.socket.destroy();
        }
    }
}
