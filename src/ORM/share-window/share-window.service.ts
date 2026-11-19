import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { promises as fs } from 'fs';
import { Repository } from 'typeorm';

import { ShareBucketEntity } from './share-bucket.entity';

const MINUTE_MS = 60 * 1000;
const DEFAULT_WINDOW_HOURS = 72;

export interface IShareWindowMiner {
    address: string;
    difficulty: number;
    shares: number;
    fraction: number;
}

export interface IShareWindow {
    windowHours: number;
    fromBucket: number;
    from: string;
    to: string;
    totalDifficulty: number;
    totalShares: number;
    miners: IShareWindowMiner[];
}

interface IPendingBucket {
    address: string;
    bucket: number;
    difficulty: number;
    shares: number;
}

/**
 * Splash Pool share window (time-based PPLNS).
 *
 * Every accepted share credits its difficulty to the miner's payout address in
 * a per-minute bucket. The window is every bucket that started within the last
 * SHARE_WINDOW_HOURS (default 72 = 3 days). Writes are buffered in memory and
 * flushed every 10 seconds; reads always include the unflushed buffer, so the
 * window is exact at any moment.
 */
@Injectable()
export class ShareWindowService implements OnApplicationShutdown {

    private pending = new Map<string, IPendingBucket>();
    private lock: Promise<void> = Promise.resolve();
    private readonly windowMs: number;
    private readonly shareLogPath: string;

    constructor(
        @InjectRepository(ShareBucketEntity)
        private readonly repository: Repository<ShareBucketEntity>,
        private readonly configService: ConfigService,
    ) {
        const hours = parseFloat(this.configService.get('SHARE_WINDOW_HOURS'));
        this.windowMs = (Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_WINDOW_HOURS) * 60 * MINUTE_MS;
        this.shareLogPath = this.configService.get('SPLASH_SHARE_LOG') || null;
    }

    public get windowHours(): number {
        return this.windowMs / (60 * MINUTE_MS);
    }

    /** Credit one accepted share. Synchronous and cheap: called on the share path. */
    public recordShare(address: string, difficulty: number, now: number = Date.now(), worker?: string): void {
        if (!address || !(difficulty > 0) || !Number.isFinite(difficulty)) {
            return;
        }
        const bucket = Math.floor(now / MINUTE_MS);
        const key = `${address}|${bucket}`;
        const entry = this.pending.get(key);
        if (entry) {
            entry.difficulty += difficulty;
            entry.shares += 1;
        } else {
            this.pending.set(key, { address, bucket, difficulty, shares: 1 });
        }

        if (this.shareLogPath) {
            const line = JSON.stringify({ t: now, address, worker: worker ?? null, difficulty }) + '\n';
            fs.appendFile(this.shareLogPath, line).catch(e => console.error('Splash share log write failed', e));
        }
    }

    /** First bucket (unix minute) inside the window that ends at `now`. */
    public fromBucket(now: number = Date.now()): number {
        return Math.ceil((now - this.windowMs) / MINUTE_MS);
    }

    @Interval(10 * 1000)
    public async flush(): Promise<void> {
        await this.exclusive(() => this.flushLocked());
    }

    // Reads and flushes take turns, so a read never sees a batch that has left
    // `pending` but is not yet committed (or one counted twice).
    private exclusive<T>(fn: () => Promise<T>): Promise<T> {
        const run = this.lock.then(fn, fn);
        this.lock = run.then(() => undefined, () => undefined);
        return run;
    }

    private async flushLocked(): Promise<void> {
        if (this.pending.size === 0) {
            return;
        }
        const batch = Array.from(this.pending.values());
        this.pending = new Map();
        try {
            await this.repository.manager.transaction(async manager => {
                for (const b of batch) {
                    await manager.query(
                        `INSERT INTO share_bucket_entity (address, bucket, difficulty, shares)
                         VALUES (?, ?, ?, ?)
                         ON CONFLICT(address, bucket) DO UPDATE SET
                           difficulty = difficulty + excluded.difficulty,
                           shares = shares + excluded.shares`,
                        [b.address, b.bucket, b.difficulty, b.shares]
                    );
                }
            });
        } catch (e) {
            // Put the batch back so no work is lost; the next flush retries it.
            for (const b of batch) {
                const key = `${b.address}|${b.bucket}`;
                const entry = this.pending.get(key);
                if (entry) {
                    entry.difficulty += b.difficulty;
                    entry.shares += b.shares;
                } else {
                    this.pending.set(key, { ...b });
                }
            }
            console.error('Splash share window flush failed', e);
        }
    }

    /** Work per address over the window ending at `now`, largest first. */
    public async getWindow(now: number = Date.now()): Promise<IShareWindow> {
        return await this.exclusive(() => this.getWindowLocked(now));
    }

    private async getWindowLocked(now: number): Promise<IShareWindow> {
        const fromBucket = this.fromBucket(now);
        const nowBucket = Math.floor(now / MINUTE_MS);

        const rows: { address: string, difficulty: number, shares: number }[] = await this.repository.query(
            `SELECT address, SUM(difficulty) AS difficulty, SUM(shares) AS shares
             FROM share_bucket_entity
             WHERE bucket >= ? AND bucket <= ?
             GROUP BY address`,
            [fromBucket, nowBucket]
        );

        const totals = new Map<string, { difficulty: number, shares: number }>();
        for (const r of rows) {
            totals.set(r.address, { difficulty: Number(r.difficulty), shares: Number(r.shares) });
        }
        // Include work not yet flushed. No flush can run during this read.
        for (const p of this.pending.values()) {
            if (p.bucket < fromBucket || p.bucket > nowBucket) {
                continue;
            }
            const t = totals.get(p.address) ?? { difficulty: 0, shares: 0 };
            t.difficulty += p.difficulty;
            t.shares += p.shares;
            totals.set(p.address, t);
        }

        let totalDifficulty = 0;
        let totalShares = 0;
        for (const t of totals.values()) {
            totalDifficulty += t.difficulty;
            totalShares += t.shares;
        }

        const miners: IShareWindowMiner[] = Array.from(totals.entries())
            .map(([address, t]) => ({
                address,
                difficulty: t.difficulty,
                shares: t.shares,
                fraction: totalDifficulty > 0 ? t.difficulty / totalDifficulty : 0,
            }))
            .sort((a, b) => b.difficulty - a.difficulty || a.address.localeCompare(b.address));

        return {
            windowHours: this.windowHours,
            fromBucket,
            from: new Date(fromBucket * MINUTE_MS).toISOString(),
            to: new Date(now).toISOString(),
            totalDifficulty,
            totalShares,
            miners,
        };
    }

    /** Drop buckets more than an hour older than the window. */
    @Interval(60 * 60 * 1000)
    public async prune(now: number = Date.now()): Promise<void> {
        const keepFrom = this.fromBucket(now) - 60;
        await this.exclusive(() => this.repository.query(`DELETE FROM share_bucket_entity WHERE bucket < ?`, [keepFrom]));
    }

    async onApplicationShutdown(): Promise<void> {
        await this.flush();
    }
}
