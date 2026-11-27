import { ConfigService } from '@nestjs/config';
import { plainToInstance } from 'class-transformer';
import { validate, ValidationError, ValidatorOptions } from 'class-validator';
import { Socket } from 'net';

import { AddressSettingsService } from '../ORM/address-settings/address-settings.service';
import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { ClientService } from '../ORM/client/client.service';
import { BitcoinRpcService } from '../services/bitcoin-rpc.service';
import { IJobTemplate, StratumV1JobsService } from '../services/stratum-v1-jobs.service';
import { eRequestMethod } from './enums/eRequestMethod';
import { eResponseMethod } from './enums/eResponseMethod';
import { eStratumErrorCode } from './enums/eStratumErrorCode';
import { MinerSession, ShareRejectReason } from './MinerSession';
import { AuthorizationMessage } from './stratum-messages/AuthorizationMessage';
import { ConfigurationMessage } from './stratum-messages/ConfigurationMessage';
import { MiningSubmitMessage } from './stratum-messages/MiningSubmitMessage';
import { StratumErrorMessage } from './stratum-messages/StratumErrorMessage';
import { SubscriptionMessage } from './stratum-messages/SubscriptionMessage';
import { SuggestDifficulty } from './stratum-messages/SuggestDifficultyMessage';
import { StratumV1ClientStatistics } from './StratumV1ClientStatistics';
import { ExternalSharesService } from '../services/external-shares.service';
import { ShareWindowService } from '../ORM/share-window/share-window.service';
import { FoundBlocksService } from '../splash/found-blocks';
import { IConnectionReporter } from '../splash/ip-guard';
import { PayoutService } from '../splash/payout.service';

// Moved to MinerSession (shared with Stratum V2); re-exported for existing importers.
export { bip310XorMask, VERSION_ROLLING_MASK } from './MinerSession';

// Stratum messages are under 1 KB.
const MAX_LINE_LENGTH = 16 * 1024;
const MAX_PENDING_INPUT_BYTES = 1024 * 1024;
// More than a miner sends in one packet, and too few to be worth flooding.
const MAX_SUBMITS_AFTER_CLOSE = 16;
const VALIDATION_ERROR_LOG_INTERVAL_MS = 60 * 1000;
// Unknown or unusable messages in a row, with no accepted share between them,
// before a connection is closed as junk.
const MAX_INVALID_MESSAGES = 10;
// Sent by real firmware and safe to ignore: these never count toward that limit.
const HARMLESS_METHODS = new Set(['mining.extranonce.subscribe', 'mining.multi_version', 'mining.ping']);

// V1 errors for each shared share-reject reason (codes and texts as before).
const V1_REJECT_CODES: Record<ShareRejectReason, eStratumErrorCode> = {
    'job-not-found': eStratumErrorCode.JobNotFound,
    'template-not-found': eStratumErrorCode.JobNotFound,
    'invalid-ntime': eStratumErrorCode.OtherUnknown,
    'invalid-version': eStratumErrorCode.OtherUnknown,
    'duplicate': eStratumErrorCode.DuplicateShare,
    'low-difficulty': eStratumErrorCode.LowDifficultyShare,
};

/**
 * Stratum V1 (JSON lines). Parses and answers V1 messages; the pool logic
 * (jobs, shares, blocks, vardiff, statistics) is in MinerSession.
 */
export class StratumV1Client extends MinerSession {
    private static validationErrorLogState = new Map<string, { nextLogAt: number, suppressed: number, sample: string }>();

    private clientSubscription: SubscriptionMessage;
    private clientConfiguration: ConfigurationMessage;
    private clientAuthorization: AuthorizationMessage;
    private clientSuggestedDifficulty: SuggestDifficulty;

    private stratumInitialized = false;
    private usedSuggestedDifficulty = false;

    private buffer: string = '';
    private pendingInputBytes = 0;
    private submitsAfterClose = 0;
    private authTimer: NodeJS.Timeout = null;

    constructor(
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

        // A connection must subscribe and authorize within this many seconds,
        // or it is closed as junk. 0 (the default) turns it off.
        const authTimeoutSeconds = this.configNumber('SPLASH_AUTH_TIMEOUT_SECONDS', 0);
        if (authTimeoutSeconds > 0) {
            this.authTimer = setTimeout(() => {
                this.authTimer = null;
                if (!this.stratumInitialized && !this.connectionClosed) {
                    this.closeAsJunk('auth-timeout');
                }
            }, authTimeoutSeconds * 1000);
            this.authTimer.unref?.();
            this.socket.once('close', () => this.clearAuthTimer());
        }

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
                this.invalidTotal++;
                this.closeAsJunk('oversize');
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

    protected get minerAddress(): string | undefined {
        return this.clientAuthorization?.address;
    }

    protected get minerWorker(): string | undefined {
        return this.clientAuthorization?.worker;
    }

    protected get minerUserAgent(): string | undefined {
        return this.clientSubscription?.userAgent;
    }

    public async destroy() {
        this.clearAuthTimer();
        await super.destroy();
    }

    private async handleMessage(message: string) {
        //console.log(`Received from ${this.extraNonceAndSessionId}`, message);

        // Parse the message and check if it's the initial subscription message
        let parsedMessage = null;
        try {
            parsedMessage = JSON.parse(message);
        } catch (e) {
            parsedMessage = null;
        }
        if (parsedMessage == null || typeof parsedMessage !== 'object' || Array.isArray(parsedMessage)) {
            // Not a Stratum message at all: no miner sends this.
            this.invalidTotal++;
            this.closeAsJunk('bad-json');
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
                        this.setCloseReason('blocked-agent');
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
                    this.setCloseReason('bad-submit');
                    this.closeSocket();
                    return;
                }
                break;
            }
            default: {
                // Ignored, as upstream does. Known-harmless methods and replies
                // (an id with result or error and no method, e.g. answers to
                // client.get_version or client.show_message) never count. Ten
                // other unknown messages in a row with no accepted share in
                // between is a junk connection.
                if (StratumV1Client.isHarmlessMessage(parsedMessage)) {
                    break;
                }
                this.invalidTotal++;
                this.invalidSinceAccepted++;
                if (this.invalidSinceAccepted >= MAX_INVALID_MESSAGES) {
                    this.closeAsJunk('unknown-method');
                    return;
                }
                break;
            }
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
            this.setCloseReason('blocked-agent');
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

        this.startWork();
    }

    protected async sendNewMiningJob(jobTemplate: IJobTemplate) {
        const job = this.buildJob(jobTemplate);
        if (job == null) {
            return;
        }

        const success = await this.write(job.response(jobTemplate));
        if (!success) {
            return;
        }
        this.lastSentMiningJobTimestamp = jobTemplate.block.timestamp;
    }

    protected async applyNewDifficulty(targetDiff: number) {
        const data = JSON.stringify({
            id: null,
            method: eResponseMethod.SET_DIFFICULTY,
            params: [targetDiff]
        }) + '\n';


        await this.socket.write(data);
        await this.sendRefreshedJob();
    }

    private async handleMiningSubmission(submission: MiningSubmitMessage) {
        // All strict hex (MiningSubmitMessage). Only these parsed values are used.
        await this.processShare({
            jobId: submission.jobId,
            extraNonce2: submission.extraNonce2.toLowerCase(),
            nonce: parseInt(submission.nonce, 16),
            timestamp: parseInt(submission.ntime, 16),
            version: { xorMask: parseInt(submission.versionMask, 16), bip310Fallback: true },
        }, {
            reject: (reason, message) => this.write(new StratumErrorMessage(submission.id, V1_REJECT_CODES[reason], message).response()),
            accept: () => this.write(JSON.stringify(submission.response()) + '\n'),
        });
        // The reply has been sent above.
        return false;
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

    /** A message real firmware sends that is safe to ignore. */
    private static isHarmlessMessage(message: any): boolean {
        if (typeof message.method === 'string') {
            return HARMLESS_METHODS.has(message.method);
        }
        return message.method == null && 'id' in message && ('result' in message || 'error' in message);
    }


    private clearAuthTimer() {
        if (this.authTimer != null) {
            clearTimeout(this.authTimer);
            this.authTimer = null;
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
