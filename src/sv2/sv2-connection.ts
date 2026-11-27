import { ConfigService } from '@nestjs/config';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Socket } from 'net';

import { AuthorizationMessage } from '../models/stratum-messages/AuthorizationMessage';
import { AddressSettingsService } from '../ORM/address-settings/address-settings.service';
import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { ClientService } from '../ORM/client/client.service';
import { ShareWindowService } from '../ORM/share-window/share-window.service';
import { BitcoinRpcService } from '../services/bitcoin-rpc.service';
import { ExternalSharesService } from '../services/external-shares.service';
import { StratumV1JobsService } from '../services/stratum-v1-jobs.service';
import { FoundBlocksService } from '../splash/found-blocks';
import { IConnectionReporter } from '../splash/ip-guard';
import { PayoutService } from '../splash/payout.service';
import { CHANNEL_MSG_BIT, dec, enc, EXT, EXT_NEGOTIATION_MSG, MAX_TLV_WORKER_IDENTITY_BYTES, MSG, Sv2DecodeError, WORKER_IDENTITY_FIELD } from './codec';
import { IDecryptedFrame, NoiseResponder, Sv2NoiseError } from './noise';
import { Sv2Channel, Sv2ChannelType } from './sv2-channel';
import { IEllSwiftKeypair } from './ellswift';

// Everything a miner sends is small; jobs only go the other way.
const MAX_INBOUND_PAYLOAD = 4096;
const HANDSHAKE_TIMEOUT_MS = 10_000;
// Channels on one connection (a proxy puts each miner on its own channel).
export const DEFAULT_MAX_CHANNELS_PER_CONNECTION = 256;
// A proxy (SRI translator) opens channels only when its miners connect, so it
// may sit set up with none for a while; 30 min unless SV2_IDLE_AFTER_SETUP_SECONDS.
export const DEFAULT_IDLE_AFTER_SETUP_SECONDS = 30 * 60;
// Extensions this pool supports (sv2-spec extensions/): worker-specific hashrate tracking.
export const SUPPORTED_EXTENSIONS: readonly number[] = [EXT.WorkerHashrateTracking];
// Unknown or unusable messages in a row, with no accepted share between them.
const MAX_INVALID_MESSAGES = 10;
const MAX_PENDING_INPUT_BYTES = 1024 * 1024;

// SetupConnection flags (sv2-spec 5.3.1).
const REQUIRES_WORK_SELECTION = 1 << 1;

export interface ISv2Services {
    stratumV1JobsService: StratumV1JobsService;
    bitcoinRpcService: BitcoinRpcService;
    clientService: ClientService;
    clientStatisticsService: ClientStatisticsService;
    foundBlocks: FoundBlocksService;
    configService: ConfigService;
    addressSettingsService: AddressSettingsService;
    externalSharesService: ExternalSharesService;
    shareWindowService: ShareWindowService;
    payoutService: PayoutService;
}

/** Channels per IP, over all of that IP's connections. */
export interface IChannelBudget {
    take(ip: string): boolean;
    give(ip: string): void;
}

export interface ISv2ConnectionOptions {
    staticKey: IEllSwiftKeypair;
    maxChannelsPerConnection?: number;
    channelBudget?: IChannelBudget;
    /** Signs a fresh certificate for this connection. */
    certificate: () => Buffer;
    logShares: boolean;
    connLog: boolean;
    authTimeoutSeconds: number;
    /** After the Noise handshake and SetupConnection: how long with no channel, and with no traffic, before closing. */
    idleAfterSetupSeconds?: number;
}

/** User agent as the pool shows it: vendor/hardware, marked as SV2. Printable ASCII only. */
export function sv2UserAgent(vendor: string, hardwareVersion: string, firmware: string): string {
    const clean = (s: string) => (s ?? '').replace(/[^\x21-\x7e]/g, '').slice(0, 32);
    const base = [clean(vendor) || 'unknown', clean(hardwareVersion), clean(firmware)].filter(s => s.length > 0).join('/');
    return `${base} (SV2)`;
}

/**
 * One Stratum V2 connection: the Noise handshake, SetupConnection, extension
 * negotiation, and mining channels (each a separate miner identity), up to
 * maxChannelsPerConnection and the IP's channel budget.
 */
export class Sv2Connection {
    private readonly noise: NoiseResponder;
    private state: 'handshake' | 'setup' | 'ready' = 'handshake';
    private readonly channels = new Map<number, Sv2Channel>();
    private nextChannelId = 1;
    private userAgent: string = null;
    private closed = false;
    private closeReason: string = null;
    private invalidSinceAccepted = 0;
    private pendingInputBytes = 0;
    private work: Promise<void> = Promise.resolve();
    private handshakeTimer: NodeJS.Timeout;
    private authTimer: NodeJS.Timeout = null;
    private readonly connectedAt = Date.now();
    // Extension negotiation (0x0001): answered once, before any channel.
    private extensionsNegotiated = false;
    private workerTracking = false;

    constructor(
        private readonly socket: Socket,
        private readonly services: ISv2Services,
        private readonly options: ISv2ConnectionOptions,
        private readonly ipReporter?: IConnectionReporter
    ) {
        this.noise = new NoiseResponder(options.staticKey, options.certificate(), MAX_INBOUND_PAYLOAD);
        this.handshakeTimer = setTimeout(() => {
            if (this.state === 'handshake') this.closeAsJunk('handshake-timeout');
        }, HANDSHAKE_TIMEOUT_MS);
        this.handshakeTimer.unref?.();
        // Same login deadline as V1 (SPLASH_AUTH_TIMEOUT_SECONDS, 0 = off): a channel must be open by then.
        if (options.authTimeoutSeconds > 0) {
            this.authTimer = setTimeout(() => {
                if (this.channels.size === 0) this.closeAsJunk('auth-timeout');
            }, options.authTimeoutSeconds * 1000);
            this.authTimer.unref?.();
        }
        socket.on('data', (data: Buffer) => this.onData(data));
    }

    private get ip(): string {
        return this.socket.remoteAddress?.replace(/^::ffff:/i, '');
    }

    private onData(data: Buffer) {
        if (this.closed) return;
        this.pendingInputBytes += data.length;
        if (this.pendingInputBytes > MAX_PENDING_INPUT_BYTES) {
            this.closeAsJunk('oversize');
            return;
        }
        let result: { reply: Buffer | null, frames: IDecryptedFrame[] };
        try {
            result = this.noise.push(data);
        } catch (e) {
            // Bad MAC, oversize frame, or not SV2 at all.
            this.closeAsJunk(e instanceof Sv2NoiseError || e instanceof Sv2DecodeError ? 'bad-noise' : 'error');
            return;
        }
        if (result.reply != null) {
            clearTimeout(this.handshakeTimer);
            this.state = 'setup';
            this.socket.write(result.reply);
            console.log(`SV2 handshake ok: ip=${this.ip}`);
        }
        // Frames are handled strictly in order, one at a time.
        const frames = result.frames;
        this.work = this.work.then(async () => {
            for (const f of frames) {
                if (this.closed) break;
                try {
                    await this.handleFrame(f);
                } catch (e) {
                    if (e instanceof Sv2DecodeError) {
                        this.closeAsJunk('bad-message');
                    } else {
                        console.error('SV2: error handling a message', e);
                        this.close('error');
                    }
                    break;
                }
            }
            this.pendingInputBytes -= data.length;
        });
    }

    /** Encrypts and writes a frame. Encryption and write happen together, so nonces stay in order. */
    public send(frame: Buffer): Promise<boolean> {
        if (this.closed || this.socket.destroyed || this.socket.writableEnded) return Promise.resolve(false);
        let wire: Buffer;
        try {
            wire = this.noise.encryptFrame(frame);
        } catch (e) {
            console.error('SV2: could not encrypt a frame', e);
            return Promise.resolve(false);
        }
        return new Promise(resolve => this.socket.write(wire, err => resolve(err == null)));
    }

    private async handleFrame(f: IDecryptedFrame) {
        const t = f.header.msgType;
        const extension = f.header.extensionType & ~CHANNEL_MSG_BIT;
        if (this.state === 'setup') {
            if (t !== MSG.SetupConnection || extension !== 0) {
                this.closeAsJunk('no-setup');
                return;
            }
            await this.onSetupConnection(dec.setupConnection(f.payload));
            return;
        }
        if (extension === EXT.Negotiation && t === EXT_NEGOTIATION_MSG.RequestExtensions) {
            await this.onRequestExtensions(dec.requestExtensions(f.payload));
            return;
        }
        if (extension !== 0) {
            // Any other extension's own messages: not offered here.
            this.noteInvalid();
            return;
        }
        switch (t) {
            case MSG.OpenStandardMiningChannel:
                await this.onOpenChannel('standard', dec.openStandardMiningChannel(f.payload));
                break;
            case MSG.OpenExtendedMiningChannel:
                await this.onOpenChannel('extended', dec.openExtendedMiningChannel(f.payload));
                break;
            case MSG.SubmitSharesStandard: {
                const m = dec.submitSharesStandard(f.payload);
                await this.onSubmit(m.channelId, m.sequenceNumber, ch => ch.submit(m, false));
                break;
            }
            case MSG.SubmitSharesExtended: {
                // TLV fields may follow (sv2-spec 3.4.3). Unnegotiated ones are ignored.
                const { share: m, tlvs } = dec.submitSharesExtendedWithTlvs(f.payload);
                const workerName = this.workerTracking ? this.tlvWorkerName(tlvs) : null;
                await this.onSubmit(m.channelId, m.sequenceNumber, ch => ch.submit(m, true, workerName));
                break;
            }
            case MSG.UpdateChannel: {
                const m = dec.updateChannel(f.payload);
                const ch = this.channels.get(m.channelId);
                if (ch == null) {
                    await this.send(enc.updateChannelError({ channelId: m.channelId, errorCode: 'invalid-channel-id' }));
                    this.noteInvalid();
                } else {
                    await ch.update(m.maxTarget);
                }
                break;
            }
            case MSG.CloseChannel: {
                const m = dec.closeChannel(f.payload);
                const ch = this.channels.get(m.channelId);
                if (ch != null) {
                    this.channels.delete(m.channelId);
                    this.options.channelBudget?.give(this.ip);
                    if (this.options.connLog) console.log(ch.connectionSummary(this.ip, false).replace('reason=client-closed', 'reason=close-channel'));
                    await ch.close();
                }
                break;
            }
            default:
                // Job Declaration, Template Distribution, custom jobs, a second
                // SetupConnection, or anything else: not offered here.
                this.noteInvalid();
        }
    }

    /** Extension 0x0002's worker name on a share, if it has one. */
    private tlvWorkerName(tlvs: { extensionType: number, fieldType: number, value: Buffer }[]): string | null {
        const t = tlvs.find(x => x.extensionType === EXT.WorkerHashrateTracking && x.fieldType === WORKER_IDENTITY_FIELD);
        if (t == null) return null;
        if (t.value.length === 0 || t.value.length > MAX_TLV_WORKER_IDENTITY_BYTES) {
            throw new Sv2DecodeError(`worker identity TLV of ${t.value.length} bytes`);
        }
        const name = t.value.toString('utf8');
        if (!Buffer.from(name, 'utf8').equals(t.value)) throw new Sv2DecodeError('worker identity TLV is not valid UTF-8');
        return name;
    }

    /** RequestExtensions (extension 0x0001): once, right after SetupConnection, before any channel. */
    private async onRequestExtensions(m: ReturnType<typeof dec.requestExtensions>) {
        if (this.extensionsNegotiated || this.channels.size > 0) {
            this.noteInvalid();
            return;
        }
        this.extensionsNegotiated = true;
        const requested = [...new Set(m.requestedExtensions)];
        const supported = requested.filter(e => SUPPORTED_EXTENSIONS.includes(e));
        if (supported.length === 0) {
            // None supported (or none asked for): an Error, and the client carries on without (spec 0x0001, 4.1).
            await this.send(enc.requestExtensionsError({ requestId: m.requestId, unsupportedExtensions: requested, requiredExtensions: [] }));
            return;
        }
        // Only the supported ones are confirmed; the client must not use the others.
        await this.send(enc.requestExtensionsSuccess({ requestId: m.requestId, supportedExtensions: supported }));
        this.workerTracking = supported.includes(EXT.WorkerHashrateTracking);
    }

    private async onSetupConnection(m: ReturnType<typeof dec.setupConnection>) {
        const fail = async (errorCode: string, flags = 0) => {
            await this.send(enc.setupConnectionError({ flags, errorCode }));
            this.close(`setup-${errorCode}`);
        };
        if (m.protocol !== 0) {
            return fail('unsupported-protocol');
        }
        if (m.minVersion > 2 || m.maxVersion < 2) {
            return fail('protocol-version-mismatch');
        }
        if (m.flags & REQUIRES_WORK_SELECTION) {
            return fail('unsupported-feature-flags', REQUIRES_WORK_SELECTION);
        }
        this.userAgent = sv2UserAgent(m.vendor, m.hardwareVersion, m.firmware);
        // Same user-agent block list as V1.
        if (this.newChannel(0, 'standard').isBlockedAgent(this.userAgent)) {
            return fail('blocked-agent');
        }
        // Version rolling is allowed and extended channels are not required: flags 0.
        await this.send(enc.setupConnectionSuccess({ usedVersion: 2, flags: 0 }));
        this.state = 'ready';
        // Set up and authenticated: the 30 s login deadline gives way to a longer
        // one, for channels and for traffic both (a proxy with no miners yet).
        const idle = this.options.idleAfterSetupSeconds ?? DEFAULT_IDLE_AFTER_SETUP_SECONDS;
        if (this.authTimer) clearTimeout(this.authTimer);
        this.authTimer = setTimeout(() => {
            if (this.channels.size === 0) this.close('no-channel-timeout');
        }, idle * 1000);
        this.authTimer.unref?.();
        this.socket.setTimeout(idle * 1000);
    }

    private newChannel(id: number, type: Sv2ChannelType): Sv2Channel {
        const s = this.services;
        return new Sv2Channel(id, type, {
            send: f => this.send(f),
            remoteAddress: this.socket.remoteAddress,
            logShares: this.options.logShares,
        }, this.socket, s.stratumV1JobsService, s.bitcoinRpcService, s.clientService, s.clientStatisticsService,
            s.foundBlocks, s.configService, s.addressSettingsService, s.externalSharesService, s.shareWindowService,
            s.payoutService, this.ipReporter);
    }

    private async onOpenChannel(type: Sv2ChannelType, m: { requestId: number, userIdentity: string, nominalHashRate: number, maxTarget: Buffer, minExtranonceSize?: number }) {
        const fail = async (errorCode: string) => {
            await this.send(enc.openMiningChannelError({ requestId: m.requestId, errorCode }));
            this.noteInvalid();
        };
        if (this.channels.size >= (this.options.maxChannelsPerConnection ?? DEFAULT_MAX_CHANNELS_PER_CONNECTION)) {
            return fail('max-channels-reached');
        }
        // The same address.worker parsing and address check as mining.authorize.
        const auth = plainToInstance(AuthorizationMessage, { id: 0, method: 'mining.authorize', params: [m.userIdentity, ''] });
        const errors = await validate(auth, { whitelist: true });
        if (errors.length > 0) {
            console.log(`SV2 channel refused: ip=${this.ip} invalid user identity "${m.userIdentity.replace(/[^\x21-\x7e]/g, '?').slice(0, 100)}"`);
            return fail('unknown-user');
        }
        if (type === 'extended' && (m.minExtranonceSize ?? 0) > 8) {
            return fail('min-extranonce-size-too-large');
        }
        if (this.options.channelBudget != null && !this.options.channelBudget.take(this.ip)) {
            return fail('max-channels-reached');
        }
        const id = this.nextChannelId++;
        const ch = this.newChannel(id, type);
        const target = ch.open(auth.address, auth.worker, this.userAgent, m.nominalHashRate, m.maxTarget);
        const prefix = Buffer.from(ch.extranoncePrefix, 'hex');
        const ok = type === 'standard'
            ? await this.send(enc.openStandardMiningChannelSuccess({ requestId: m.requestId, channelId: id, target, extranoncePrefix: prefix, groupChannelId: 0 }))
            : await this.send(enc.openExtendedMiningChannelSuccess({ requestId: m.requestId, channelId: id, target, extranonceSize: ch.extranonceSize, extranoncePrefix: prefix, groupChannelId: 0 }));
        if (!ok) {
            this.options.channelBudget?.give(this.ip);
            return;
        }
        this.channels.set(id, ch);
        console.log(`SV2 channel open: ip=${this.ip} worker=${auth.address}.${auth.worker} type=${type} id=${id} diff=${ch.difficulty} agent=${this.userAgent} session=${ch.extraNonceAndSessionId}`);
        ch.start();
    }

    private async onSubmit(channelId: number, sequenceNumber: number, f: (ch: Sv2Channel) => Promise<void>) {
        const ch = this.channels.get(channelId);
        if (ch == null) {
            await this.send(enc.submitSharesError({ channelId, sequenceNumber, errorCode: 'invalid-channel-id' }));
            this.noteInvalid();
            return;
        }
        this.invalidSinceAccepted = 0;
        await f(ch);
    }

    private noteInvalid() {
        this.invalidSinceAccepted++;
        if (this.invalidSinceAccepted >= MAX_INVALID_MESSAGES) {
            this.closeAsJunk('unknown-method');
        }
    }

    private closeAsJunk(reason: string) {
        this.ipReporter?.junk();
        this.close(reason);
    }

    private close(reason: string) {
        if (this.closeReason == null) this.closeReason = reason;
        if (!this.socket.destroyed) this.socket.destroy();
    }

    /** Called once the socket has closed: log and clean up every channel. */
    public async onClosed(hadError: boolean, stopping: boolean) {
        this.closed = true;
        clearTimeout(this.handshakeTimer);
        if (this.authTimer) clearTimeout(this.authTimer);
        const reason = stopping ? 'pool-stopping' : this.closeReason;
        if (this.channels.size === 0) {
            if (this.options.connLog || this.state !== 'handshake') {
                const seconds = Math.round((Date.now() - this.connectedAt) / 1000);
                console.log(`Splash conn: ip=${this.ip} worker=- agent=${this.userAgent ?? '-'} reason=${reason ?? (hadError ? 'error' : 'client-closed')} dur=${seconds}s acc=0 rej=0 invalid=${this.invalidSinceAccepted} proto=sv2 stage=${this.state}`);
            }
            return;
        }
        for (const ch of this.channels.values()) {
            this.options.channelBudget?.give(this.ip);
            if (reason != null) ch.setCloseReason(reason);
            console.log(ch.connectionSummary(this.ip, hadError));
            // When stopping, skip it: startup clears the client table anyway.
            if (!stopping) await ch.close();
        }
        this.channels.clear();
    }
}
