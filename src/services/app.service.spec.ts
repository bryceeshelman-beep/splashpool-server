import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DataSource } from 'typeorm';

import { AppService } from './app.service';

it('runs the payout database in WAL mode with synchronous = NORMAL', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'splash-db-'));
    const db = new DataSource({ type: 'sqlite', database: join(dir, 'db.sqlite'), enableWAL: true });
    await db.initialize();
    await db.query('PRAGMA synchronous = OFF');
    jest.useFakeTimers();
    await new AppService(null, null, db, null).onModuleInit();
    jest.clearAllTimers();
    jest.useRealTimers();
    expect(await db.query('PRAGMA synchronous')).toEqual([{ synchronous: 1 }]);
    expect(await db.query('PRAGMA journal_mode')).toEqual([{ journal_mode: 'wal' }]);
    await db.destroy();
    await fs.rm(dir, { recursive: true, force: true });
});

describe('checkpoint timer', () => {
    let query: jest.Mock;
    const checkpoints = () => query.mock.calls.filter(([q]) => q.includes('wal_checkpoint')).length;

    beforeEach(async () => {
        jest.useFakeTimers();
        query = jest.fn().mockResolvedValue([{ busy: 0, log: 1, checkpointed: 1 }]);
        await new AppService(null, null, { query } as any, null).onModuleInit();
    });
    afterEach(() => {
        jest.clearAllTimers();
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    it('runs every 10 s', async () => {
        await jest.advanceTimersByTimeAsync(9_999);
        expect(checkpoints()).toBe(0);
        await jest.advanceTimersByTimeAsync(20_001);
        expect(checkpoints()).toBe(3);
    });

    it('does not pile up behind a long read', async () => {
        query.mockImplementation(() => new Promise(() => undefined));
        await jest.advanceTimersByTimeAsync(60_000);
        expect(checkpoints()).toBe(1);
    });

    it('keeps trying after a failure, and logs it once', async () => {
        const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        query.mockRejectedValue(new Error('SQLITE_LOCKED'));
        await jest.advanceTimersByTimeAsync(30_000);
        expect(checkpoints()).toBe(3);
        expect(error).toHaveBeenCalledTimes(1);
        const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
        query.mockResolvedValue([{ busy: 0, log: 1, checkpointed: 1 }]);
        await jest.advanceTimersByTimeAsync(20_000);
        expect(log).toHaveBeenCalledTimes(1);
    });
});
