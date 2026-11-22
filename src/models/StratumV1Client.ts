import { ConfigService } from '@nestjs/config';
import * as bitcoinjs from 'bitcoinjs-lib';
import { plainToInstance } from 'class-transformer';
import { validate, ValidationError, ValidatorOptions } from 'class-validator';
import * as crypto from 'crypto';
import { Socket } from 'net';
import { firstValueFrom, Subscription, switchMap } from 'rxjs';
import { clearInterval } from 'timers';

import { AddressSettingsService } from '../ORM/address-settings/address-settings.service';
import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { ClientEntity } from '../ORM/client/client.entity';
import { ClientService } from '../ORM/client/client.service';
import { BitcoinRpcService } from '../services/bitcoin-rpc.service';
import { IJobTemplate, StratumV1JobsService } from '../services/stratum-v1-jobs.service';
import { eRequestMethod } from './enums/eRequestMethod';
import { eResponseMethod } from './enums/eResponseMethod';
import { eStratumErrorCode } from './enums/eStratumErrorCode';
import { MiningJob } from './MiningJob';
import { AuthorizationMessage } from './stratum-messages/AuthorizationMessage';
import { ConfigurationMessage } from './stratum-messages/ConfigurationMessage';
import { MiningSubmitMessage } from './stratum-messages/MiningSubmitMessage';
import { StratumErrorMessage } from './stratum-messages/StratumErrorMessage';
import { SubscriptionMessage } from './stratum-messages/SubscriptionMessage';
import { EXTRANONCE1_SIZE_BYTES } from './stratum.constants';
import { SuggestDifficulty } from './stratum-messages/SuggestDifficultyMessage';
import { StratumV1ClientStatistics } from './StratumV1ClientStatistics';
import { ExternalSharesService } from '../services/external-shares.service';
import { ShareWindowService } from '../ORM/share-window/share-window.service';
import { ISubmitResult } from '../splash/block-submission';
import { FoundBlocksService } from '../splash/found-blocks';
import { IConnectionReporter } from '../splash/ip-guard';
import { PayoutService } from '../splash/payout.service';

const TRUE_DIFF_ONE = 2.695953529101131e67;
const BLOCKED_USER_AGENT_LOG_INTERVAL_MS = 60 * 1000;
// Consensus: a block may be at most two hours ahead of the node's clock.
const MAX_FUTURE_BLOCK_SECONDS = 2 * 60 * 60;
// Stratum messages are under 1 KB.
const MAX_LINE_LENGTH = 16 * 1024;
const MAX_PENDING_INPUT_BYTES = 1024 * 1024;
// More than a miner sends in one packet, and too few to be worth flooding.
const MAX_SUBMITS_AFTER_CLOSE = 16;
const VALIDATION_ERROR_LOG_INTERVAL_MS = 60 * 1000;

export class StratumV1Client {
    private static blockedUserAgentLogState = new Map<string, { nextLogAt: number, suppressed: number }>();
    private static validationErrorLogState = new Map<string, { nextLogAt: number, suppressed: number, sample: string }>();

    private clientSubscription: SubscriptionMessage;
    private clientConfiguration: ConfigurationMessage;
    private clientAuthorization: AuthorizationMessage;
    private clientSuggestedDifficulty: SuggestDifficulty;
    private stratumSubscription: Subscription;
    private backgroundWork: NodeJS.Timeout[] = [];

    private statistics: StratumV1ClientStatistics;
    private stratumInitialized = false;
    private usedSuggestedDifficulty = false;
    private sessionDifficulty: number = 100000;
    private minDifficultyCache: number;
    // Splash Pool reject limit: per-connection counts for the current minute.
    private rejectWindowStart = 0;
    private rejectWindowAccepted = 0;
    private rejectWindowRejected = 0;
    private static rejectKickLog = { nextLogAt: 0, suppressed: 0 };

    private entity: ClientEntity;
    private creatingEntity: Promise<void>;

    public extraNonceAndSessionId: string;
    public sessionStart: Date;
    public noFee: boolean;
    public hashRate: number = 0;

    private buffer: string = '';
    private connectionClosed = false;
    private lastSentMiningJobTimestamp: number = null;

    private miningSubmissionHeaders = new Set<string>()
    // This connection's jobs and the difficulty each was issued at. A share is
    // judged and credited only by that, never by the current session difficulty.
    private issuedJobs = new Map<string, number>();
    private pendingInputBytes = 0;
    private submitsAfterClose = 0;

    constructor(
        public readonly socket: Socket,
        private readonly stratumV1JobsService: StratumV1JobsService,
        private readonly bitcoinRpcService: BitcoinRpcService,
        private readonly clientService: ClientService,
        private readonly clientStatisticsService: ClientStatisticsService,
        private readonly foundBlocks: FoundBlocksService,
        private readonly configService: ConfigService,
        private readonly addressSettingsService: AddressSettingsService,
        private readonly externalSharesService: ExternalSharesService,
        private readonly shareWindowService?: ShareWindowService,
        private readonly payoutService?: PayoutService,
        private readonly ipReporter?: IConnectionReporter
    ) {

        this.socket.on('data', (data: Buffer) => {
            if (this.connectionClosed) {
                return;
            }
            this.buffer += data.toString();
            let lines = this.buffer.split('\n');
            this.buffer = lines.pop() || ''; // Save the last part of the data (incomplete line) to the buffer
            this.pendingInputBytes += data.length;
            if (this.pendingInputBytes > MAX_PENDING_INPUT_BYTES
                || this.buffer.length > MAX_LINE_LENGTH
                || lines.some(l => l.length > MAX_LINE_LENGTH)) {
                this.buffer = '';
                this.closeSocket();
                return;
            }

            (async () => {
                for (const m of lines.filter(l => l.length > 0)) {
                    if (this.connectionClosed) {
                        break;
                    }
                    if (this.socket.destroyed || this.socket.writableEnded) {
                        // Already received, and one could be a block: still judge the
                        // submits of a miner that logged in, up to a small limit.
                        if (!this.stratumInitialized || this.submitsAfterClose >= MAX_SUBMITS_AFTER_CLOSE) {
                            break;
                        }
                        if (!m.includes(eRequestMethod.SUBMIT)) {
                            continue;
                        }
                        this.submitsAfterClose++;
                    }
                    try {
                        await this.handleMessage(m);
                    } catch (e) {
                        await this.socket.end();
                        console.error(e);
                    }
                }
                this.pendingInputBytes -= data.length;
            })();
        });


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

    private getRandomHexString() {
        const randomBytes = crypto.randomBytes(EXTRANONCE1_SIZE_BYTES);
        return randomBytes.toString('hex');
    }


    private async handleMessage(message: string) {
        //console.log(`Received from ${this.extraNonceAndSessionId}`, message);

        // Parse the message and check if it's the initial subscription message
        let parsedMessage = null;
        try {
            parsedMessage = JSON.parse(message);
        } catch (e) {
            //console.log("Invalid JSON");
            await this.socket.end();
            return;
        }



        switch (parsedMessage.method) {
            case eRequestMethod.SUBSCRIBE: {
                const subscriptionMessage = plainToInstance(
                    SubscriptionMessage,
                    parsedMessage,
                );

                const validatorOptions: ValidatorOptions = {
                    whitelist: true,
                    //forbidNonWhitelisted: true,
                };

                const errors = await validate(subscriptionMessage, validatorOptions);

                if (errors.length === 0) {
                    if (this.isBlockedUserAgent(subscriptionMessage.userAgent)) {
                        this.logBlockedUserAgent(subscriptionMessage.userAgent);
                        this.closeSocket();
                        return;
                    }

                    if (this.sessionStart == null) {
                        this.sessionStart = new Date();
                        this.statistics = new StratumV1ClientStatistics(this.clientStatisticsService);
                        this.extraNonceAndSessionId = this.getRandomHexString();
                        console.log(`New client ID: : ${this.extraNonceAndSessionId}, ${this.socket.remoteAddress}:${this.socket.remotePort}`);
                    }

                    this.clientSubscription = subscriptionMessage;
                    const success = await this.write(JSON.stringify(this.clientSubscription.response(this.extraNonceAndSessionId)) + '\n');
                    if (!success) {
                        return;
                    }
                } else {
                    console.error('Subscription validation error');
                    const err = new StratumErrorMessage(
                        subscriptionMessage.id,
                        eStratumErrorCode.OtherUnknown,
                        'Subscription validation error',
                        errors).response();
                    console.error(err);
                    const success = await this.write(err);
                    if (!success) {
                        return;
                    }
                    this.noteShareResult(false); // Repeated, this is a junk connection.
                }

                break;
            }
            case eRequestMethod.CONFIGURE: {

                const configurationMessage = plainToInstance(
                    ConfigurationMessage,
                    parsedMessage,
                );

                const validatorOptions: ValidatorOptions = {
                    whitelist: true,
                    //forbidNonWhitelisted: true,
                };

                const errors = await validate(configurationMessage, validatorOptions);

                if (errors.length === 0) {
                    this.clientConfiguration = configurationMessage;
                    //const response = this.buildSubscriptionResponse(configurationMessage.id);
                    const success = await this.write(JSON.stringify(this.clientConfiguration.response()) + '\n');
                    if (!success) {
                        return;
                    }

                } else {
                    console.error('Configuration validation error');
                    const err = new StratumErrorMessage(
                        configurationMessage.id,
                        eStratumErrorCode.OtherUnknown,
                        'Configuration validation error',
                        errors).response();
                    console.error(err);
                    const success = await this.write(err);
                    if (!success) {
                        return;
                    }
                    this.noteShareResult(false); // Repeated, this is a junk connection.
                }

                break;
            }
            case eRequestMethod.AUTHORIZE: {

                const authorizationMessage = plainToInstance(
                    AuthorizationMessage,
                    parsedMessage,
                );

                const validatorOptions: ValidatorOptions = {
                    whitelist: true,
                    //forbidNonWhitelisted: true,
                };

                const errors = await validate(authorizationMessage, validatorOptions);

                if (errors.length === 0) {
                    const firstLogin = this.clientAuthorization == null;
                    this.clientAuthorization = authorizationMessage;
                    // d= sets the starting difficulty only, so only the first login counts.
                    if (firstLogin && this.clientSuggestedDifficulty == null && this.clientAuthorization.startingDiff != null && this.clientAuthorization.startingDiff > this.sessionDifficulty) {
                        this.sessionDifficulty = this.clientAuthorization.startingDiff;
                    }
                    const success = await this.write(JSON.stringify(this.clientAuthorization.response()) + '\n');
                    if (!success) {
                        return;
                    }
                } else {
                    console.error('Authorization validation error');
                    const err = new StratumErrorMessage(
                        authorizationMessage.id,
                        eStratumErrorCode.OtherUnknown,
                        'Authorization validation error',
                        errors).response();
                    console.error(err);
                    const success = await this.write(err);
                    if (!success) {
                        return;
                    }
                    this.noteShareResult(false); // Repeated, this is a junk connection.
                }

                break;
            }
            case eRequestMethod.SUGGEST_DIFFICULTY: {
                if (this.usedSuggestedDifficulty == true) {
                    return;
                }

                const suggestDifficultyMessage = plainToInstance(
                    SuggestDifficulty,
                    parsedMessage
                );

                const validatorOptions: ValidatorOptions = {
                    whitelist: true,
                    //forbidNonWhitelisted: true,
                };

                const errors = await validate(suggestDifficultyMessage, validatorOptions);

                if (errors.length === 0) {
                    // Checked again: two can arrive together and both pass the check above.
                    if (this.usedSuggestedDifficulty) {
                        return;
                    }
                    this.usedSuggestedDifficulty = true;
                    const previousDifficulty = this.sessionDifficulty;
                    this.clientSuggestedDifficulty = suggestDifficultyMessage;
                    this.sessionDifficulty = this.clampDifficulty(suggestDifficultyMessage.suggestedDifficulty);
                    const success = await this.write(JSON.stringify(this.clientSuggestedDifficulty.response(this.sessionDifficulty)) + '\n');
                    if (!success) {
                        return;
                    }
                    // AxeOS suggests after login, so after its first job. That job keeps
                    // its difficulty, so send one that carries the new one.
                    if (this.issuedJobs.size > 0 && this.sessionDifficulty !== previousDifficulty) {
                        await this.sendRefreshedJob();
                    }
                } else {
                    console.error('Suggest difficulty validation error');
                    const err = new StratumErrorMessage(
                        suggestDifficultyMessage.id,
                        eStratumErrorCode.OtherUnknown,
                        'Suggest difficulty validation error',
                        errors).response();
                    console.error(err);
                    const success = await this.write(err);
                    if (!success) {
                        return;
                    }
                    this.noteShareResult(false); // Repeated, this is a junk connection.
                }
                break;
            }
            case eRequestMethod.SUBMIT: {

                if (this.stratumInitialized == false) {
                    console.log('Submit before initalized');
                    await this.socket.end();
                    return;
                }


                const miningSubmitMessage = plainToInstance(
                    MiningSubmitMessage,
                    parsedMessage,
                );

                const validatorOptions: ValidatorOptions = {
                    whitelist: true,
                    //forbidNonWhitelisted: true,
                };

                const errors = await validate(miningSubmitMessage, validatorOptions);

                if (errors.length === 0 && this.stratumInitialized == true) {
                    const result = await this.handleMiningSubmission(miningSubmitMessage);
                    if (result == true) {
                        const success = await this.write(JSON.stringify(miningSubmitMessage.response()) + '\n');
                        if (!success) {
                            return;
                        }
                    }


                } else {
                    this.logValidationError('Mining Submit validation error', errors);
                    const err = new StratumErrorMessage(
                        miningSubmitMessage.id,
                        eStratumErrorCode.OtherUnknown,
                        'Mining Submit validation error',
                        errors).response();
                    const success = await this.write(err);
                    if (!success) {
                        return;
                    }
                    this.closeSocket();
                    return;
                }
                break;
            }
            // default: {
            //     console.log("Invalid message");
            //     console.log(parsedMessage);
            //     await this.socket.end();
            //     return;
            // }
        }


        if (this.clientSubscription != null
            && this.clientAuthorization != null
            && this.stratumInitialized == false) {

            await this.initStratum();

        }
    }

    private async initStratum() {
        this.stratumInitialized = true;

        if (this.isBlockedUserAgent(this.clientSubscription.userAgent)) {
            this.logBlockedUserAgent(this.clientSubscription.userAgent);
            this.closeSocket();
            return;
        }

        switch (this.clientSubscription.userAgent) {
            case 'cpuminer': {
                this.sessionDifficulty = 0.1;
            }
        }
        this.sessionDifficulty = this.clampDifficulty(this.sessionDifficulty);

        if (this.clientSuggestedDifficulty == null) {
            //console.log(`Setting difficulty to ${this.sessionDifficulty}`)
            const setDifficulty = JSON.stringify(new SuggestDifficulty().response(this.sessionDifficulty));
            const success = await this.write(setDifficulty + '\n');
            if (!success) {
                return;
            }
        }

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

    private async sendNewMiningJob(jobTemplate: IJobTemplate) {

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
                { address: this.clientAuthorization.address, percent: 100 }
            ];

        } else {
            payoutInformation = [
                { address: devFeeAddress, percent: 1.5 },
                { address: this.clientAuthorization.address, percent: 98.5 }
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
                payoutInformation = this.payoutService.outputsFor(this.clientAuthorization.address, jobTemplate.blockData.coinbasevalue);
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
            console.error(`Splash: no job built for ${this.clientAuthorization.address}, closing its connection`, e);
            this.closeSocket();
            return;
        }

        this.stratumV1JobsService.addJob(job);
        this.issuedJobs.set(job.jobId, this.sessionDifficulty);


        const success = await this.write(job.response(jobTemplate));
        if (!success) {
            return;
        }
        this.lastSentMiningJobTimestamp = jobTemplate.block.timestamp;


        //console.log(`Sent new job to ${this.clientAuthorization.worker}.${this.extraNonceAndSessionId}. (clearJobs: ${jobTemplate.blockData.clearJobs}, fee?: ${!this.noFee})`)

    }


    private async ensureClientEntity() {
        if (this.entity != null) {
            return;
        }

        if (this.creatingEntity == null) {
            this.creatingEntity = (async () => {
                this.entity = await this.clientService.insert({
                    sessionId: this.extraNonceAndSessionId,
                    address: this.clientAuthorization.address,
                    clientName: this.clientAuthorization.worker,
                    userAgent: this.clientSubscription.userAgent,
                    startTime: new Date(),
                    bestDifficulty: 0
                });
            })();
        }

        await this.creatingEntity;
    }

    private async handleMiningSubmission(submission: MiningSubmitMessage) {

        const issuedDifficulty = this.issuedJobs.get(submission.jobId);
        // Another connection's job is "not found" here.
        const job = issuedDifficulty == null ? null : this.stratumV1JobsService.getJobById(submission.jobId);

        // a miner may submit a job that doesn't exist anymore if it was removed by a new block notification (or expired, 5 min)
        if (job == null) {
            const err = new StratumErrorMessage(
                submission.id,
                eStratumErrorCode.JobNotFound,
                'Job not found').response();
            if (this.noteShareResult(false)) {
                return false;
            }
            //console.log(err);
            const success = await this.write(err);
            if (!success) {
                return false;
            }
            return false;
        }
        const jobTemplate = this.stratumV1JobsService.getJobTemplateById(job.jobTemplateId);

        if (jobTemplate == null) {
            const err = new StratumErrorMessage(
                submission.id,
                eStratumErrorCode.JobNotFound,
                'Job Template not found').response();
            if (this.noteShareResult(false)) {
                return false;
            }
            //console.log(err);
            const success = await this.write(err);
            if (!success) {
                return false;
            }
            return false;
        }

        // All strict hex (MiningSubmitMessage). Only these parsed values are used below.
        const extraNonce2 = submission.extraNonce2.toLowerCase();
        let versionMask = parseInt(submission.versionMask, 16);
        const nonce = parseInt(submission.nonce, 16);
        const timestamp = parseInt(submission.ntime, 16);

        // Work that could never be a valid block earns nothing.
        let invalid: string = null;
        if (timestamp < jobTemplate.blockData.mintime || timestamp > Math.floor(Date.now() / 1000) + MAX_FUTURE_BLOCK_SECONDS) {
            invalid = 'Invalid ntime';
        } else if ((versionMask & ~VERSION_ROLLING_MASK) !== 0) {
            invalid = 'Invalid version bits';
        }
        if (invalid != null) {
            if (this.noteShareResult(false)) {
                return false;
            }
            await this.write(new StratumErrorMessage(submission.id, eStratumErrorCode.OtherUnknown, invalid).response());
            return false;
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
        if (submissionDifficulty < shareDifficulty && versionMask) {
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
            const err = new StratumErrorMessage(
                submission.id,
                eStratumErrorCode.DuplicateShare,
                'Duplicate share').response();
            if (this.noteShareResult(false)) {
                return false;
            }
            const success = await this.write(err);
            if (!success) {
                return false;
            }
            return false;
        }
        this.miningSubmissionHeaders.add(headerKey);

        //console.log(`DIFF: ${submissionDifficulty} of ${this.sessionDifficulty} from ${this.clientAuthorization.worker + '.' + this.extraNonceAndSessionId}`);


        // A block solution is always accepted, even below the session difficulty
        // (possible on test networks, where blocks can be easier than the floor).
        if (submissionDifficulty >= shareDifficulty) {
            this.noteShareResult(true);
            // Taken now: both can change while this awaits.
            const { address, worker } = this.clientAuthorization;
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

            const success = await this.write(JSON.stringify(submission.response()) + '\n');
            if (!success) {
                return false;
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
                await this.addressSettingsService.updateBestDifficultyIfHigher(this.clientAuthorization.address, submissionDifficulty, this.entity.userAgent);
            }


            const externalShareSubmissionEnabled: boolean = this.configService.get('EXTERNAL_SHARE_SUBMISSION_ENABLED')?.toLowerCase() == 'true';
            const minimumDifficulty: number = parseFloat(this.configService.get('MINIMUM_DIFFICULTY')) || 1000000000000.0; // 1T
            if (externalShareSubmissionEnabled && submissionDifficulty >= minimumDifficulty) {
                // Submit share to API if enabled
                this.externalSharesService.submitShare({
                    worker: this.clientAuthorization.worker,
                    address: this.clientAuthorization.address,
                    userAgent: this.clientSubscription.userAgent,
                    header: finalHeader.toString('hex'),
                    externalPoolName: this.configService.get('POOL_IDENTIFIER') || 'Public-Pool'
                });
            }

        } else {
            const err = new StratumErrorMessage(
                submission.id,
                eStratumErrorCode.LowDifficultyShare,
                'Difficulty too low').response();
            if (this.noteShareResult(false)) {
                return false;
            }

            const success = await this.write(err);
            if (!success) {
                return false;
            }

            return false;
        }

        //await this.checkDifficulty();
        return false;

    }

    /**
     * Splash Pool: lowest share difficulty a connection may have, so nobody can
     * flood the pool with trivially easy shares via suggest_difficulty or by
     * idling until vardiff decays. SPLASH_MIN_DIFFICULTY sets it; unset, it is
     * 512 on mainnet (a ~400 GH/s Bitaxe still gets a share every ~5 s) and off
     * elsewhere.
     */
    private get minDifficulty(): number {
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

    private clampDifficulty(difficulty: number): number {
        if (!Number.isFinite(difficulty)) {
            return Math.max(100000, this.minDifficulty);
        }
        return Math.max(difficulty, this.minDifficulty);
    }

    private async checkDifficulty() {
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

            const data = JSON.stringify({
                id: null,
                method: eResponseMethod.SET_DIFFICULTY,
                params: [targetDiff]
            }) + '\n';


            await this.socket.write(data);
            await this.sendRefreshedJob();
        }
    }

    /** New work at the current difficulty, outside the template cycle. */
    private async sendRefreshedJob() {
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

    private calculateDifficulty(header: Buffer): { submissionDifficulty: number, submissionHash: string } {

        const hashResult = bitcoinjs.crypto.hash256(header);

        const target = this.le256todouble(hashResult);
        const submissionDifficulty = target === 0 ? Number.POSITIVE_INFINITY : TRUE_DIFF_ONE / target;
        return { submissionDifficulty, submissionHash: hashResult.toString('hex') };
    }


    private le256todouble(target: Buffer): number {

        let number = 0;
        for (let i = target.length - 1; i >= 0; i--) {
            number = number * 256 + target[i];
        }

        return number;
    }

    private isBlockedUserAgent(userAgent: string): boolean {
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

    private logBlockedUserAgent(userAgent: string) {
        const now = Date.now();
        const logState = StratumV1Client.blockedUserAgentLogState.get(userAgent);

        if (logState != null && now < logState.nextLogAt) {
            logState.suppressed += 1;
            return;
        }

        const suppressed = logState?.suppressed ?? 0;
        const suffix = suppressed > 0 ? ` (${suppressed} similar connections suppressed)` : '';
        console.log(`Blocked non-compliant connection from userAgent: ${userAgent}${suffix}`);
        StratumV1Client.blockedUserAgentLogState.set(userAgent, {
            nextLogAt: now + BLOCKED_USER_AGENT_LOG_INTERVAL_MS,
            suppressed: 0
        });
    }

    private logValidationError(label: string, errors: ValidationError[]) {
        const now = Date.now();
        const signature = this.getValidationErrorSignature(errors);
        const sample = this.getValidationErrorSample(errors);
        const key = `${label}:${signature}`;
        const logState = StratumV1Client.validationErrorLogState.get(key);

        if (logState != null && now < logState.nextLogAt) {
            logState.suppressed += 1;
            return;
        }

        const suppressed = logState?.suppressed ?? 0;
        const suffix = suppressed > 0 ? ` (${suppressed} similar validation errors suppressed)` : '';
        console.warn(`${label}: ${signature}${sample}${suffix}`);
        StratumV1Client.validationErrorLogState.set(key, {
            nextLogAt: now + VALIDATION_ERROR_LOG_INTERVAL_MS,
            suppressed: 0,
            sample
        });
    }

    private getValidationErrorSignature(errors: ValidationError[]): string {
        if (errors.length === 0) {
            return 'unknown';
        }

        return errors.map(error => {
            const constraints = Object.keys(error.constraints ?? {}).sort().join('|') || 'invalid';
            return `${error.property}:${constraints}`;
        }).join(';');
    }

    private getValidationErrorSample(errors: ValidationError[]): string {
        const values = errors
            .map(error => error.value)
            .filter(value => value != null)
            .map(value => String(value).replace(/[\r\n]/g, '').slice(0, 64));

        if (values.length === 0) {
            return '';
        }

        return ` sample=${values.join(',')}`;
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
    private noteShareResult(accepted: boolean): boolean {
        const now = Date.now();
        if (now - this.rejectWindowStart >= 60_000) {
            this.rejectWindowStart = now;
            this.rejectWindowAccepted = 0;
            this.rejectWindowRejected = 0;
        }
        if (accepted) {
            this.rejectWindowAccepted++;
            this.ipReporter?.accepted();
            return false;
        }
        this.rejectWindowRejected++;
        const limit = this.configNumber('SPLASH_REJECT_LIMIT', 200);
        if (limit <= 0 || this.rejectWindowRejected < limit) {
            return false;
        }
        const ratio = this.configNumber('SPLASH_REJECT_RATIO', 0.9);
        const total = this.rejectWindowAccepted + this.rejectWindowRejected;
        if (this.rejectWindowRejected / total < ratio) {
            return false;
        }
        const log = StratumV1Client.rejectKickLog;
        if (now >= log.nextLogAt) {
            console.warn(`Splash: disconnecting ${this.clientAuthorization?.address ?? '?'}.${this.clientAuthorization?.worker ?? '?'} (${this.socket.remoteAddress}): ${this.rejectWindowRejected} rejected / ${total} shares this minute${log.suppressed > 0 ? ` (+${log.suppressed} similar disconnects not logged)` : ''}`);
            log.nextLogAt = now + 10_000;
            log.suppressed = 0;
        } else {
            log.suppressed++;
        }
        this.ipReporter?.junk();
        this.closeSocket();
        return true;
    }

    private configNumber(key: string, fallback: number): number {
        const raw = this.configService.get(key);
        const n = raw == null || `${raw}`.trim() === '' ? NaN : Number(raw);
        return Number.isFinite(n) && n >= 0 ? n : fallback;
    }

    private closeSocket() {
        this.connectionClosed = true;
        if (!this.socket.destroyed) {
            this.socket.destroy();
        }
    }

    private async write(message: string): Promise<boolean> {
        try {
            if (!this.socket.destroyed && !this.socket.writableEnded) {

                await new Promise((resolve, reject) => {
                    this.socket.write(message, (error) => {
                        if (error) {
                            reject(error);
                        } else {
                            resolve(true);
                        }
                    });
                });

                return true;
            } else {
                console.error(`Error: Cannot write to closed or ended socket. ${this.extraNonceAndSessionId} ${message}`);
                this.destroy();
                if (!this.socket.destroyed) {
                    this.socket.destroy();
                }
                return false;
            }
        } catch (error) {
            this.destroy();
            if (!this.socket.writableEnded) {
                await this.socket.end();
            } else if (!this.socket.destroyed) {
                this.socket.destroy();
            }
            console.error(`Error occurred while writing to socket: ${this.extraNonceAndSessionId}`, error);
            return false;
        }
    }

}

// The rolling mask the pool offers in mining.configure.
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
