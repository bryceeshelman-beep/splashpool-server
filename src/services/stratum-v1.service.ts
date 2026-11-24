import { PayoutService } from '../splash/payout.service';
import { ShareWindowService } from '../ORM/share-window/share-window.service';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Server, Socket } from 'net';
import { monitorEventLoopDelay } from 'perf_hooks';

import { StratumV1Client } from '../models/StratumV1Client';
import { FoundBlocksService } from '../splash/found-blocks';
import { IpGuard, ipGuardOptions } from '../splash/ip-guard';
import { AddressSettingsService } from '../ORM/address-settings/address-settings.service';
import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { ClientService } from '../ORM/client/client.service';
import { BitcoinRpcService } from './bitcoin-rpc.service';
import { ExternalSharesService } from './external-shares.service';
import { StratumV1JobsService } from './stratum-v1-jobs.service';

interface StratumListenerState {
    port: number;
    server: Server | null;
    paused: boolean;
}

const DEFAULT_BACKPRESSURE_CHECK_INTERVAL_MS = 5000;
const DEFAULT_BACKPRESSURE_EVENT_LOOP_P95_MS = 2000;
const DEFAULT_BACKPRESSURE_EVENT_LOOP_RESUME_P95_MS = 250;
const DEFAULT_BACKPRESSURE_RSS_MB = 2500;
const DEFAULT_BACKPRESSURE_RESUME_RSS_MB = 2000;
const DEFAULT_BACKPRESSURE_HEALTHY_CHECKS = 3;
const DEFAULT_MAX_CONNECTIONS_PER_LISTENER = 10000;


@Injectable()
export class StratumV1Service implements OnModuleInit {

    private readonly listeners: StratumListenerState[] = [];
    private readonly eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
    private backpressureMonitor: NodeJS.Timeout | null = null;
    private healthyBackpressureChecks = 0;
    // One for the life of the process: a paused and resumed listener keeps its bans.
    private ipGuard: IpGuard | null = null;
    private readonly sockets = new Set<Socket>();
    private stopping = false;

    constructor(
        private readonly bitcoinRpcService: BitcoinRpcService,
        private readonly clientService: ClientService,
        private readonly clientStatisticsService: ClientStatisticsService,
        private readonly foundBlocks: FoundBlocksService,
        private readonly configService: ConfigService,
        private readonly stratumV1JobsService: StratumV1JobsService,
        private readonly addressSettingsService: AddressSettingsService,
        private readonly externalSharesService: ExternalSharesService,
        private readonly shareWindowService: ShareWindowService,
        private readonly payoutService: PayoutService
    ) {

    }

    async onModuleInit(): Promise<void> {

        // Splash Pool: also when run as a single process (no NODE_APP_INSTANCE),
        // so connections from before a crash or reboot aren't still counted.
        const singleProcess = process.env.NODE_APP_INSTANCE == null && process.env.MASTER == null;
        if (singleProcess || process.env.NODE_APP_INSTANCE == '0' || process.env.MASTER == 'true') {
            await this.clientService.deleteAll();
        }

        if (process.env.MASTER == 'true') {
            console.log('Master process skipping Stratum socket listeners');
            return;
        }

        setTimeout(() => {
            this.startSocketServer(this.getStratumPort());
        }, 1000 * 10);

        this.startBackpressureMonitor();

    }

    private startSocketServer(port: number) {
        const listener: StratumListenerState = {
            port,
            server: null,
            paused: false
        };
        this.listeners.push(listener);
        this.listen(listener);
    }

    private createSocketServer(): Server {
        if (this.ipGuard == null) {
            this.ipGuard = new IpGuard(ipGuardOptions(key => this.configService.get(key)));
            console.log(this.ipGuard.describe());
        }
        const guard = this.ipGuard;
        // One line per closed connection (who, why, how long, shares). Off by default.
        const connLog = String(this.configService.get('SPLASH_CONN_LOG') ?? '').trim().toLowerCase() === 'true';
        const server = new Server(async (socket: Socket) => {
            if (this.stopping) {
                socket.destroy();
                return;
            }
            // Read now: a socket forgets its address once it's closed.
            const ip = socket.remoteAddress;
            const reporter = guard.open(ip, socket);
            if (reporter == null) {
                // Before any client exists, so refusing costs almost nothing.
                socket.on('error', () => undefined);
                socket.destroy();
                return;
            }
            this.sockets.add(socket);
            socket.on('close', () => {
                this.sockets.delete(socket);
                guard.close(ip, socket);
            });

            //5 min
            socket.setTimeout(1000 * 60 * 5);

            const client = new StratumV1Client(
                socket,
                this.stratumV1JobsService,
                this.bitcoinRpcService,
                this.clientService,
                this.clientStatisticsService,
                this.foundBlocks,
                this.configService,
                this.addressSettingsService,
                this.externalSharesService,
                this.shareWindowService,
                this.payoutService,
                reporter
            );


            socket.on('close', async (hadError: boolean) => {
                if (connLog) {
                    if (this.stopping) {
                        client.setCloseReason('pool-stopping');
                    }
                    console.log(client.connectionSummary(ip, hadError));
                }
                // When stopping, skip it: these writes would hold up saving the
                // shares, and startup clears the client table anyway.
                if (!this.stopping && client.extraNonceAndSessionId != null) {
                    // Handle socket disconnection
                    await client.destroy();
                    console.log(`Client ${client.extraNonceAndSessionId} disconnected, hadError?:${hadError}`);
                }
            });

            socket.on('timeout', () => {
                client.setCloseReason('idle');
                console.log('socket timeout');
                socket.end();
                socket.destroy();
            });

            socket.on('error', async (error: Error) => { });

            //   //console.log(`Client disconnected, socket error,  ${client.extraNonceAndSessionId}`);


        });

        server.on('error', (err) => {
            console.error(`Server error: ${err.message}`);
        });
        this.configureConnectionLimit(server);

        return server;
    }

    /** For shutdown: no new connections and no more shares. */
    public stopIntake() {
        this.stopping = true;
        if (this.backpressureMonitor != null) {
            clearInterval(this.backpressureMonitor);
        }
        this.listeners.forEach(listener => listener.server?.close());
        this.sockets.forEach(socket => socket.destroy());
    }

    private listen(listener: StratumListenerState) {
        if (this.stopping || listener.server != null) {
            return;
        }

        const server = this.createSocketServer();
        listener.server = server;
        listener.paused = false;

        server.listen(listener.port, '0.0.0.0', () => { // IPv4 only: a router's NAT doesn't shield IPv6
            console.log(`Stratum server is listening on port ${listener.port}`);
        });
    }

    private startBackpressureMonitor() {
        if (this.isBackpressureDisabled() || this.backpressureMonitor != null) {
            return;
        }

        this.eventLoopDelay.enable();
        this.backpressureMonitor = setInterval(() => {
            this.checkBackpressure();
        }, this.getBackpressureCheckIntervalMs());
    }

    private checkBackpressure() {
        const eventLoopP95Ms = this.getEventLoopP95Ms();
        const rssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
        const overloaded = eventLoopP95Ms >= this.getBackpressureEventLoopP95Ms()
            || rssMb >= this.getBackpressureRssMb();
        const paused = this.listeners.some(listener => listener.paused);

        if (overloaded) {
            this.healthyBackpressureChecks = 0;
            if (!paused) {
                this.pauseAccepting(eventLoopP95Ms, rssMb);
            }
            this.eventLoopDelay.reset();
            return;
        }

        if (!paused) {
            this.eventLoopDelay.reset();
            return;
        }

        const healthy = eventLoopP95Ms <= this.getBackpressureResumeEventLoopP95Ms()
            && rssMb <= this.getBackpressureResumeRssMb();
        if (!healthy) {
            this.healthyBackpressureChecks = 0;
            this.eventLoopDelay.reset();
            return;
        }

        this.healthyBackpressureChecks++;
        if (this.healthyBackpressureChecks >= this.getBackpressureHealthyChecks()) {
            this.resumeAccepting(eventLoopP95Ms, rssMb);
            this.healthyBackpressureChecks = 0;
        }

        this.eventLoopDelay.reset();
    }

    private pauseAccepting(eventLoopP95Ms: number, rssMb: number) {
        console.warn(`Pausing Stratum accepts: eventLoopP95Ms=${eventLoopP95Ms}, rssMb=${rssMb}`);
        for (const listener of this.listeners) {
            if (listener.paused || listener.server == null) {
                continue;
            }

            const server = listener.server;
            listener.server = null;
            listener.paused = true;
            server.close((error) => {
                if (error != null) {
                    console.error(`Error while pausing Stratum listener on port ${listener.port}: ${error.message}`);
                }
            });
        }
    }

    private resumeAccepting(eventLoopP95Ms: number, rssMb: number) {
        console.warn(`Resuming Stratum accepts: eventLoopP95Ms=${eventLoopP95Ms}, rssMb=${rssMb}`);
        for (const listener of this.listeners) {
            if (!listener.paused || listener.server != null) {
                continue;
            }

            this.listen(listener);
        }
    }

    private configureConnectionLimit(server: Server) {
        server.maxConnections = this.getMaxConnectionsPerListener();
        (server as Server & { dropMaxConnection: boolean }).dropMaxConnection = true;
    }

    private getEventLoopP95Ms() {
        return Math.round(this.eventLoopDelay.percentile(95) / 1e6);
    }

    private isBackpressureDisabled() {
        return process.env.STRATUM_BACKPRESSURE_ENABLED?.toLowerCase() === 'false';
    }

    private getBackpressureCheckIntervalMs() {
        return this.getPositiveIntegerEnv('STRATUM_BACKPRESSURE_CHECK_INTERVAL_MS', DEFAULT_BACKPRESSURE_CHECK_INTERVAL_MS);
    }

    private getBackpressureEventLoopP95Ms() {
        return this.getPositiveIntegerEnv('STRATUM_BACKPRESSURE_EVENT_LOOP_P95_MS', DEFAULT_BACKPRESSURE_EVENT_LOOP_P95_MS);
    }

    private getBackpressureResumeEventLoopP95Ms() {
        return this.getPositiveIntegerEnv('STRATUM_BACKPRESSURE_EVENT_LOOP_RESUME_P95_MS', DEFAULT_BACKPRESSURE_EVENT_LOOP_RESUME_P95_MS);
    }

    private getBackpressureRssMb() {
        return this.getPositiveIntegerEnv('STRATUM_BACKPRESSURE_RSS_MB', DEFAULT_BACKPRESSURE_RSS_MB);
    }

    private getBackpressureResumeRssMb() {
        return this.getPositiveIntegerEnv('STRATUM_BACKPRESSURE_RESUME_RSS_MB', DEFAULT_BACKPRESSURE_RESUME_RSS_MB);
    }

    private getBackpressureHealthyChecks() {
        return this.getPositiveIntegerEnv('STRATUM_BACKPRESSURE_HEALTHY_CHECKS', DEFAULT_BACKPRESSURE_HEALTHY_CHECKS);
    }

    private getMaxConnectionsPerListener() {
        return this.getPositiveIntegerEnv('STRATUM_MAX_CONNECTIONS_PER_LISTENER', DEFAULT_MAX_CONNECTIONS_PER_LISTENER);
    }

    private getStratumPort() {
        return this.getPositiveIntegerEnv('STRATUM_PORT', 3333);
    }

    private getPositiveIntegerEnv(key: string, fallback: number) {
        const configured = parseInt(process.env[key], 10);
        if (Number.isFinite(configured) && configured > 0) {
            return configured;
        }
        return fallback;

    }

}
