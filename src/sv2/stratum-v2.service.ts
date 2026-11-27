import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Server, Socket } from 'net';

import { AddressSettingsService } from '../ORM/address-settings/address-settings.service';
import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { ClientService } from '../ORM/client/client.service';
import { ShareWindowService } from '../ORM/share-window/share-window.service';
import { BitcoinRpcService } from '../services/bitcoin-rpc.service';
import { ExternalSharesService } from '../services/external-shares.service';
import { StratumV1JobsService } from '../services/stratum-v1-jobs.service';
import { FoundBlocksService } from '../splash/found-blocks';
import { IpGuard, ipGuardOptions } from '../splash/ip-guard';
import { PayoutService } from '../splash/payout.service';
import { IAuthorityKey, loadAuthorityFile } from './authority';
import { ellswiftKeygen, IEllSwiftKeypair } from './ellswift';
import { signCertificate } from './noise';
import { DEFAULT_MAX_CHANNELS_PER_CONNECTION, IChannelBudget, Sv2Connection } from './sv2-connection';

const DEFAULT_CERT_VALIDITY_SECONDS = 24 * 60 * 60;
// Channels one IP may hold over all its connections (a proxy for a farm is one IP).
const DEFAULT_MAX_CHANNELS_PER_IP = 1024;
const CHANNEL_LIMIT_CEILING = 65536;

/** Open channels per IP. */
export class ChannelBudget implements IChannelBudget {
    private readonly open = new Map<string, number>();
    constructor(private readonly perIp: number) { }
    take(ip: string): boolean {
        const n = this.open.get(ip) ?? 0;
        if (n >= this.perIp) return false;
        this.open.set(ip, n + 1);
        return true;
    }
    give(ip: string): void {
        const n = this.open.get(ip) ?? 0;
        if (n <= 1) this.open.delete(ip); else this.open.set(ip, n - 1);
    }
    count(ip: string): number { return this.open.get(ip) ?? 0; }
}
// Certificates start an hour back, for miners whose clocks run behind.
const CERT_BACKDATE_SECONDS = 60 * 60;

/**
 * Splash Pool: the Stratum V2 listener (Mining Protocol only). Off unless
 * SV2_ENABLED=true. A separate way in to the same pool: every channel is a
 * MinerSession, exactly like a V1 connection.
 */
@Injectable()
export class StratumV2Service implements OnModuleInit {
    private server: Server | null = null;
    private readonly sockets = new Set<Socket>();
    private stopping = false;
    private authority: IAuthorityKey;
    private staticKey: IEllSwiftKeypair;

    constructor(
        private readonly configService: ConfigService,
        private readonly stratumV1JobsService: StratumV1JobsService,
        private readonly bitcoinRpcService: BitcoinRpcService,
        private readonly clientService: ClientService,
        private readonly clientStatisticsService: ClientStatisticsService,
        private readonly foundBlocks: FoundBlocksService,
        private readonly addressSettingsService: AddressSettingsService,
        private readonly externalSharesService: ExternalSharesService,
        private readonly shareWindowService: ShareWindowService,
        private readonly payoutService: PayoutService
    ) { }

    private get enabled(): boolean {
        return String(this.configService.get('SV2_ENABLED') ?? '').trim().toLowerCase() === 'true';
    }

    async onModuleInit(): Promise<void> {
        if (!this.enabled) {
            console.log('Stratum V2: off (SV2_ENABLED is not true)');
            return;
        }
        if (process.env.MASTER == 'true') {
            return;
        }
        const port = Number(this.configService.get('SV2_PORT'));
        const keyFile = this.configService.get<string>('SV2_AUTHORITY_KEY_FILE');
        if (!Number.isInteger(port) || port <= 0 || port > 65535 || !keyFile) {
            // Never take V1 down over an SV2 setting.
            console.error('Stratum V2: NOT started: SV2_PORT and SV2_AUTHORITY_KEY_FILE must both be set');
            return;
        }
        try {
            this.authority = loadAuthorityFile(keyFile);
        } catch (e) {
            console.error(`Stratum V2: NOT started: ${(e as Error).message}`);
            return;
        }
        // A new static Noise key each start (as SRI does); certificates are signed per connection.
        this.staticKey = ellswiftKeygen();
        console.log(`Stratum V2: authority public key ${this.authority.base58}`);
        // Same delay as V1, so the job pipeline is up first.
        setTimeout(() => this.listen(port), 10 * 1000);
    }

    private certificate(): Buffer {
        const now = Math.floor(Date.now() / 1000);
        const validity = Number(this.configService.get('SV2_CERT_VALIDITY_SECONDS')) || DEFAULT_CERT_VALIDITY_SECONDS;
        return signCertificate(this.authority.secret, this.staticKey.publicKey, now - CERT_BACKDATE_SECONDS, now + validity);
    }

    /** A whole number from 1 to CHANNEL_LIMIT_CEILING, else the default. */
    private limit(key: string, fallback: number): number {
        const raw = this.configService.get(key);
        const n = raw == null || `${raw}`.trim() === '' ? NaN : Number(raw);
        if (Number.isInteger(n) && n >= 1 && n <= CHANNEL_LIMIT_CEILING) return n;
        if (raw != null && `${raw}`.trim() !== '') console.warn(`Ignoring invalid ${key}=${raw}`);
        return fallback;
    }

    private flag(key: string, fallback: boolean): boolean {
        const raw = this.configService.get(key);
        if (raw == null || `${raw}`.trim() === '') return fallback;
        return `${raw}`.trim().toLowerCase() === 'true';
    }

    private listen(port: number) {
        if (this.stopping) return;
        const guard = new IpGuard(ipGuardOptions(key => this.configService.get(key)));
        console.log(`Stratum V2 ${guard.describe()}`);
        const authTimeout = Number(this.configService.get('SPLASH_AUTH_TIMEOUT_SECONDS'));
        const perConnection = this.limit('SV2_MAX_CHANNELS_PER_CONNECTION', DEFAULT_MAX_CHANNELS_PER_CONNECTION);
        const perIp = this.limit('SV2_MAX_CHANNELS_PER_IP', DEFAULT_MAX_CHANNELS_PER_IP);
        console.log(`Stratum V2 channels: at most ${perConnection} per connection, ${perIp} per IP`);
        const options = {
            staticKey: this.staticKey,
            maxChannelsPerConnection: perConnection,
            channelBudget: new ChannelBudget(perIp),
            certificate: () => this.certificate(),
            logShares: this.flag('SV2_LOG_SHARES', this.configService.get('NETWORK') !== 'mainnet'),
            connLog: this.flag('SPLASH_CONN_LOG', false),
            authTimeoutSeconds: Number.isFinite(authTimeout) && authTimeout > 0 ? authTimeout : 0,
        };
        const services = {
            stratumV1JobsService: this.stratumV1JobsService,
            bitcoinRpcService: this.bitcoinRpcService,
            clientService: this.clientService,
            clientStatisticsService: this.clientStatisticsService,
            foundBlocks: this.foundBlocks,
            configService: this.configService,
            addressSettingsService: this.addressSettingsService,
            externalSharesService: this.externalSharesService,
            shareWindowService: this.shareWindowService,
            payoutService: this.payoutService,
        };

        const server = new Server((socket: Socket) => {
            if (this.stopping) {
                socket.destroy();
                return;
            }
            const ip = socket.remoteAddress;
            const reporter = guard.open(ip, socket);
            if (reporter == null) {
                socket.on('error', () => undefined);
                socket.destroy();
                return;
            }
            this.sockets.add(socket);
            socket.setTimeout(1000 * 60 * 5);
            socket.on('timeout', () => socket.destroy());
            socket.on('error', () => undefined);
            let conn: Sv2Connection;
            try {
                conn = new Sv2Connection(socket, services, options, reporter);
            } catch (e) {
                console.error('Stratum V2: could not set up a connection', e);
                socket.destroy();
            }
            socket.on('close', async (hadError: boolean) => {
                this.sockets.delete(socket);
                guard.close(ip, socket);
                try {
                    await conn?.onClosed(hadError, this.stopping);
                } catch (e) {
                    console.error('Stratum V2: error cleaning up a connection', e);
                }
            });
        });
        server.on('error', err => console.error(`Stratum V2 server error: ${err.message}`));
        const max = Number(this.configService.get('STRATUM_MAX_CONNECTIONS_PER_LISTENER'));
        server.maxConnections = Number.isInteger(max) && max > 0 ? max : 10000;
        server.listen(port, '0.0.0.0', () => console.log(`Stratum V2 server is listening on port ${port}`));
        this.server = server;
    }

    /** For shutdown: no new connections and no more shares (with V1's stopIntake). */
    public stopIntake() {
        this.stopping = true;
        this.server?.close();
        this.sockets.forEach(s => s.destroy());
    }
}
