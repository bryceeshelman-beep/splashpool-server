import { Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import { BlocksEntity } from '../../ORM/blocks/blocks.entity';
import { ShareWindowService } from '../../ORM/share-window/share-window.service';
import { BitcoinRpcService } from '../../services/bitcoin-rpc.service';
import { SplashRoundEntity } from './round.entity';

/**
 * Tracks the pool's work since its last accepted block (the website's tank).
 * Share work comes from ShareWindowService (counted on the share path, taken
 * here every 10 s). A new row in blocks_entity whose hash is in the active
 * chain closes the round; a rejected submission does not.
 */
@Injectable()
export class RoundService implements OnModuleInit, OnApplicationShutdown {

    private lock: Promise<void> = Promise.resolve();

    constructor(
        @InjectRepository(SplashRoundEntity)
        private readonly rounds: Repository<SplashRoundEntity>,
        @InjectRepository(BlocksEntity)
        private readonly blocks: Repository<BlocksEntity>,
        private readonly shareWindowService: ShareWindowService,
        private readonly bitcoinRpcService: BitcoinRpcService,
    ) { }

    async onModuleInit() {
        await this.exclusive(async () => {
            const open = await this.rounds.findOne({ where: { endedAt: IsNull() } });
            if (open != null) {
                return;
            }
            // First start: open a round from the last stored pool block (or now),
            // seeded with any share-window work since then.
            const last = await this.blocks.find({ order: { id: 'DESC' }, take: 1 });
            const startedAt = last[0]?.createdAt ? new Date(last[0].createdAt).getTime() : Date.now();
            const seed = await this.shareWindowService.workSince(startedAt);
            await this.rounds.insert({ startedAt, endedAt: null, work: seed, blockId: last[0]?.id ?? null, height: null });
            console.log(`Splash tank: opened round at ${new Date(startedAt).toISOString()} with ${seed} work`);
        });
    }

    private exclusive<T>(fn: () => Promise<T>): Promise<T> {
        const run = this.lock.then(fn, fn);
        this.lock = run.then(() => undefined, () => undefined);
        return run;
    }

    @Interval(10 * 1000)
    public async tick(): Promise<void> {
        await this.exclusive(async () => {
            await this.addPendingWork();
            await this.closeOnNewBlocks();
        });
    }

    private async addPendingWork() {
        const work = this.shareWindowService.takeRoundWork();
        if (work > 0) {
            try {
                await this.rounds.increment({ endedAt: IsNull() }, 'work', work);
            } catch (e) {
                this.shareWindowService.returnRoundWork(work);
                console.error('Splash tank: work update failed', e);
            }
        }
    }

    private async closeOnNewBlocks() {
        const open = await this.rounds.findOne({ where: { endedAt: IsNull() } });
        if (open == null) {
            return;
        }
        const lastSeen = open.blockId ?? 0;
        const fresh = await this.blocks.createQueryBuilder('b')
            .select(['b.id', 'b.height', 'b.blockData', 'b.createdAt'])
            .where('b.id > :id', { id: lastSeen })
            .orderBy('b.id', 'ASC')
            .getMany();
        let current = open;
        for (const b of fresh) {
            const inChain = await this.isInActiveChain(b.blockData, b.height);
            if (!inChain) {
                // Remember it so a rejected block is checked only once.
                await this.rounds.update({ id: current.id }, { blockId: b.id });
                current.blockId = b.id;
                continue;
            }
            const endedAt = b.createdAt ? new Date(b.createdAt).getTime() : Date.now();
            await this.rounds.update({ id: current.id }, { endedAt, blockId: b.id, height: b.height });
            await this.rounds.insert({ startedAt: endedAt, endedAt: null, work: 0, blockId: b.id, height: null });
            current = await this.rounds.findOne({ where: { endedAt: IsNull() } });
            console.log(`Splash tank: SPLASH at height ${b.height}, round closed with ${open.work} work`);
        }
    }

    private async isInActiveChain(blockHex: string, height: number): Promise<boolean> {
        try {
            // Header hash = double SHA256 of the first 80 bytes, byte-reversed.
            const header = Buffer.from(blockHex.slice(0, 160), 'hex');
            const crypto = await import('crypto');
            const h1 = crypto.createHash('sha256').update(header).digest();
            const hash = Buffer.from(crypto.createHash('sha256').update(h1).digest()).reverse().toString('hex');
            const chainHash = await this.bitcoinRpcService.getBlockHash(height);
            return chainHash === hash;
        } catch (e) {
            console.error('Splash tank: block check failed', e?.message ?? e);
            return false;
        }
    }

    /** The open round: start time and work so far (including work not yet saved). */
    public async current(): Promise<{ startedAt: number, work: number }> {
        const open = await this.rounds.findOne({ where: { endedAt: IsNull() } });
        const pending = this.shareWindowService.peekRoundWork();
        return { startedAt: open?.startedAt ?? Date.now(), work: (open?.work ?? 0) + pending };
    }

    /** Closed rounds keyed by the block height that ended them. */
    public async closedByHeight(): Promise<Map<number, SplashRoundEntity>> {
        const rows = await this.rounds.createQueryBuilder('r').where('r.endedAt IS NOT NULL').getMany();
        return new Map(rows.filter(r => r.height != null).map(r => [r.height, r]));
    }

    async onApplicationShutdown(): Promise<void> {
        await this.exclusive(() => this.addPendingWork());
    }
}
