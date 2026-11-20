import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import * as bitcoinjs from 'bitcoinjs-lib';
import { Repository } from 'typeorm';

import { IMiningInfo } from '../../models/bitcoin-rpc/IMiningInfo';
import { BlocksEntity } from '../../ORM/blocks/blocks.entity';
import { ClientStatisticsService } from '../../ORM/client-statistics/client-statistics.service';
import { ClientService } from '../../ORM/client/client.service';
import { IShareWindow, ShareWindowService } from '../../ORM/share-window/share-window.service';
import { BitcoinRpcService } from '../../services/bitcoin-rpc.service';
import { networkFromConfig, PayoutService } from '../payout.service';
import { IPayoutOutput } from '../payout-builder';
import { decodeBlock, IDecodedBlock } from './block-decoder';
import { RoundService } from './round.service';

const MINUTE_MS = 60_000;
// When this pool process started (for "pool uptime" on the site).
const POOL_STARTED_AT = Date.now() - Math.round(process.uptime() * 1000);
const HASHES_PER_DIFF1 = 4294967296; // 2^32

type BlockStatus = 'confirmed' | 'orphaned' | 'pending';

export interface ISiteBlock {
    height: number;
    hash: string;
    foundAt: string;
    finder: string;
    worker: string;
    reward: number;
    subsidy: number;
    txFees: number;
    fee: number;
    finderPaid: number;
    minersPaid: number;
    status: BlockStatus;
    confirmations: number;
    roundWork: number | null;
    outputs: { address: string, value: number, role: 'fee' | 'finder' | 'share' }[];
}

/** Hashrate (H/s) from summed share difficulty over `ms`. */
export function hashrateFromWork(work: number, ms: number): number {
    return ms > 0 ? (work * HASHES_PER_DIFF1) / (ms / 1000) : 0;
}

/**
 * Read-only data for the public website (served under /api/site).
 * Everything here is cached briefly so a busy site costs the pool little.
 */
@Injectable()
export class SiteService {

    private readonly network: bitcoinjs.networks.Network;
    private readonly halvingInterval: number;
    private miningInfo: IMiningInfo = null;
    private readonly decoded = new Map<number, IDecodedBlock>();
    // Block hashes buried 100+ deep: treated as final, no more RPC checks.
    private readonly finalHashes = new Set<string>();
    private readonly cache = new Map<string, { at: number, value: any }>();
    private inflight = new Map<string, Promise<any>>();

    constructor(
        configService: ConfigService,
        @InjectRepository(BlocksEntity)
        private readonly blocksRepository: Repository<BlocksEntity>,
        private readonly bitcoinRpcService: BitcoinRpcService,
        private readonly clientService: ClientService,
        private readonly clientStatisticsService: ClientStatisticsService,
        private readonly shareWindowService: ShareWindowService,
        private readonly payoutService: PayoutService,
        private readonly roundService: RoundService,
    ) {
        const net = configService.get('NETWORK');
        this.network = networkFromConfig(net);
        this.halvingInterval = net === 'regtest' ? 150 : 210_000;
        this.bitcoinRpcService.newBlock$.subscribe(info => this.miningInfo = info);
    }

    // Small TTL cache; concurrent misses share one computation.
    private async cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
        const hit = this.cache.get(key);
        if (hit && Date.now() - hit.at < ttlMs) {
            return hit.value;
        }
        const running = this.inflight.get(key);
        if (running) {
            return running;
        }
        const p = fn().then(value => {
            if (this.cache.size > 5000) {
                this.cache.clear();
            }
            this.cache.set(key, { at: Date.now(), value });
            return value;
        }).finally(() => this.inflight.delete(key));
        this.inflight.set(key, p);
        return p;
    }

    private window(): Promise<IShareWindow> {
        return this.cached('window', 30_000, () => this.shareWindowService.getWindow());
    }

    private async poolActivity(now: number) {
        const from = Math.floor((now - 10 * MINUTE_MS) / MINUTE_MS) * MINUTE_MS;
        const sums = await this.shareWindowService.activitySince(from);
        let work = 0;
        for (const v of sums.values()) {
            work += v.difficulty;
        }
        return { hashrate: hashrateFromWork(work, now - from), activeAddresses: sums.size };
    }

    public summary() {
        return this.cached('summary', 15_000, async () => {
            const now = Date.now();
            const [activity, workers, round, blocks, window] = await Promise.all([
                this.poolActivity(now),
                this.clientService.connectedClientCount(),
                this.roundService.current(),
                this.blocks(),
                this.window(),
            ]);
            const difficulty = this.miningInfo?.difficulty ?? null;
            const confirmed = blocks.filter(b => b.status === 'confirmed');
            const status = this.payoutService.status();
            return {
                chain: this.miningInfo?.chain ?? null,
                height: this.miningInfo?.blocks ?? null,
                networkDifficulty: difficulty,
                networkHashrate: this.miningInfo?.networkhashps ?? null,
                pool: {
                    hashrate: activity.hashrate,
                    activeAddresses: activity.activeAddresses,
                    workers,
                    windowAddresses: window.miners.length,
                    startedAt: new Date(POOL_STARTED_AT).toISOString(),
                    uptimeSeconds: Math.floor((now - POOL_STARTED_AT) / 1000),
                    lastShareAt: this.shareWindowService.lastShareAt != null ? new Date(this.shareWindowService.lastShareAt).toISOString() : null,
                },
                tank: {
                    startedAt: new Date(round.startedAt).toISOString(),
                    work: round.work,
                    expectedWork: difficulty,
                    level: difficulty ? round.work / difficulty : null,
                },
                blocksFound: confirmed.length,
                lastBlock: confirmed[0] ? { height: confirmed[0].height, hash: confirmed[0].hash, foundAt: confirmed[0].foundAt } : null,
                rules: {
                    splashBonusSats: status.splashBonusSats,
                    feePpm: status.feePpm,
                    feePercentOfShared: status.feePercentOfShared,
                    windowHours: this.shareWindowService.windowHours,
                    minPayoutSats: status.minPayoutSats,
                },
                updatedAt: new Date(now).toISOString(),
            };
        });
    }

    /** Block list for the site: each block's top payouts only (full split: block()). */
    public async blockList(limit = 100) {
        const all = await this.blocks();
        return all.slice(0, Math.max(1, Math.min(limit, 500))).map(({ outputs, ...b }) => ({
            ...b,
            topOutputs: outputs.slice(0, 6),
        }));
    }

    /** Every block stored at `height` (normally one), with the full payout split. */
    public async block(height: number) {
        if (!Number.isSafeInteger(height) || height < 0) {
            throw new BadRequestException('height must be a block height');
        }
        const found = (await this.blocks()).filter(b => b.height === height);
        if (found.length === 0) {
            throw new NotFoundException('No pool block at that height');
        }
        return found;
    }

    public blocks(): Promise<ISiteBlock[]> {
        return this.cached('blocks', 30_000, async () => {
            const rows = await this.blocksRepository.createQueryBuilder('b')
                .select(['b.id', 'b.height', 'b.minerAddress', 'b.worker', 'b.blockData', 'b.createdAt'])
                .orderBy('b.id', 'DESC')
                .take(500)
                .getMany();
            const tip = this.miningInfo?.blocks ?? null;
            const rounds = await this.roundService.closedByHeight();
            const feeAddress = this.payoutService.feeAddress;
            const out: ISiteBlock[] = [];
            for (const r of rows) {
                let d = this.decoded.get(r.id);
                if (d == null) {
                    try {
                        d = decodeBlock(r.blockData, r.height, this.network, this.halvingInterval);
                    } catch (e) {
                        console.error(`Splash site: cannot decode block id ${r.id}`, e?.message ?? e);
                        continue;
                    }
                    this.decoded.set(r.id, d);
                }
                let status: BlockStatus = 'pending';
                if (this.finalHashes.has(d.hash)) {
                    status = 'confirmed';
                } else if (tip != null && tip >= r.height) {
                    try {
                        status = (await this.bitcoinRpcService.getBlockHash(r.height)) === d.hash ? 'confirmed' : 'orphaned';
                    } catch {
                        status = 'pending';
                    }
                    if (status === 'confirmed' && tip - r.height >= 100) {
                        this.finalHashes.add(d.hash);
                    }
                }
                const outputs = d.outputs
                    .filter(o => o.address != null && o.value > 0)
                    .map(o => ({
                        address: o.address,
                        value: o.value,
                        role: (o.address === feeAddress ? 'fee' : o.address === r.minerAddress ? 'finder' : 'share') as 'fee' | 'finder' | 'share',
                    }));
                const sum = (role: string) => outputs.filter(o => o.role === role).reduce((s, o) => s + o.value, 0);
                out.push({
                    height: r.height,
                    hash: d.hash,
                    foundAt: r.createdAt ? new Date(r.createdAt).toISOString() : new Date(d.time * 1000).toISOString(),
                    finder: r.minerAddress,
                    worker: r.worker,
                    reward: d.reward,
                    subsidy: d.subsidy,
                    txFees: d.txFees,
                    fee: sum('fee'),
                    finderPaid: sum('finder'),
                    minersPaid: outputs.filter(o => o.role !== 'fee').length,
                    status,
                    confirmations: status === 'confirmed' && tip != null ? tip - r.height + 1 : 0,
                    roundWork: rounds.get(r.height)?.work ?? null,
                    outputs: outputs.sort((a, b) => (a.role === 'finder' ? -1 : b.role === 'finder' ? 1 : 0) || b.value - a.value),
                });
            }
            return out;
        });
    }

    public address(address: string) {
        if (typeof address !== 'string' || address.length > 90 || !this.payoutService.isPayable(address)) {
            throw new BadRequestException('Not a valid Bitcoin address for this pool');
        }
        return this.cached(`addr|${address}`, 20_000, async () => {
            const now = Date.now();
            const from10 = Math.floor((now - 10 * MINUTE_MS) / MINUTE_MS) * MINUTE_MS;
            const from60 = Math.floor((now - 60 * MINUTE_MS) / MINUTE_MS) * MINUTE_MS;
            const from24 = Math.floor((now - 24 * 60 * MINUTE_MS) / MINUTE_MS) * MINUTE_MS;
            const [a10, a60, a24, workers, chart, window, blocks] = await Promise.all([
                this.shareWindowService.activitySince(from10, address),
                this.shareWindowService.activitySince(from60, address),
                this.shareWindowService.activitySince(from24, address),
                this.clientService.getByAddress(address),
                this.clientStatisticsService.getChartDataForAddress(address),
                this.window(),
                this.blocks(),
            ]);
            const w = (m: Map<string, { difficulty: number }>) => m.get(address)?.difficulty ?? 0;
            const mine = window.miners.find(m => m.address === address);

            const status = this.payoutService.status();
            let estimate = null;
            if (this.payoutService.enabled && status.lastReward > 0) {
                const reward = status.lastReward;
                // Count only what this address earns as a miner, never the pool fee,
                // even when the address is also the fee address (outputs merge).
                const mine = (outs: IPayoutOutput[], parts: ('bonus' | 'split' | 'rounding')[]) =>
                    outs.filter(o => o.address === address).reduce((s, o) => s + parts.reduce((t, k) => t + o[k], 0), 0);
                estimate = {
                    reward,
                    // Someone else finds it: just this address's work share of the split.
                    ifPoolFinds: mine(this.payoutService.build(this.payoutService.feeAddress, reward).outputs, ['split']),
                    // This address finds it: the Splash Bonus plus its work share.
                    ifYouFind: mine(this.payoutService.build(address, reward).outputs, ['bonus', 'split', 'rounding']),
                };
            }

            const paidBlocks = blocks
                .filter(b => b.status !== 'orphaned' && b.outputs.some(o => o.address === address))
                .map(b => ({
                    height: b.height,
                    hash: b.hash,
                    foundAt: b.foundAt,
                    status: b.status,
                    finder: b.finder === address,
                    received: b.outputs.filter(o => o.address === address).reduce((s, o) => s + o.value, 0),
                }));

            return {
                address,
                hashrate: {
                    m10: hashrateFromWork(w(a10), now - from10),
                    h1: hashrateFromWork(w(a60), now - from60),
                    h24: hashrateFromWork(w(a24), now - from24),
                },
                window: {
                    hours: window.windowHours,
                    work: mine?.difficulty ?? 0,
                    fraction: mine?.fraction ?? 0,
                    shares: mine?.shares ?? 0,
                },
                estimate,
                workers: workers.map(k => ({
                    name: k.clientName,
                    sessionId: k.sessionId,
                    hashrate: k.hashRate,
                    bestDifficulty: k.bestDifficulty,
                    startTime: k.startTime,
                    lastSeen: k.updatedAt,
                })),
                chart,
                paidBlocks,
                totalReceived: paidBlocks.filter(b => b.status === 'confirmed').reduce((s, b) => s + b.received, 0),
                updatedAt: new Date(now).toISOString(),
            };
        });
    }
}
