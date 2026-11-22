import { DataSource, Repository } from 'typeorm';

import { ShareBucketEntity } from './share-bucket.entity';
import { ShareWindowService } from './share-window.service';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
// A minute-aligned "now" keeps the boundary maths easy to read.
const NOW = Date.UTC(2026, 10, 19, 18, 0, 0);

describe('ShareWindowService', () => {
    let dataSource: DataSource;
    let repo: Repository<ShareBucketEntity>;
    let service: ShareWindowService;

    const config = (values: Record<string, string>) => ({ get: (k: string) => values[k] }) as any;

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'sqlite',
            database: ':memory:',
            entities: [ShareBucketEntity],
            synchronize: true,
        });
        await dataSource.initialize();
        repo = dataSource.getRepository(ShareBucketEntity);
        service = new ShareWindowService(repo, config({}));
    });

    afterEach(async () => {
        await dataSource.destroy();
    });

    it('defaults to a 72 hour window', () => {
        expect(service.windowHours).toBe(72);
    });

    it('honours SHARE_WINDOW_HOURS', () => {
        const s = new ShareWindowService(repo, config({ SHARE_WINDOW_HOURS: '6' }));
        expect(s.windowHours).toBe(6);
    });

    it('sums work per address and gives fractions that add to 1', async () => {
        service.recordShare('A', 1000, NOW - 5 * MIN);
        service.recordShare('A', 1000, NOW - 4 * MIN);
        service.recordShare('B', 500, NOW - 3 * MIN);
        service.recordShare('C', 1500, NOW - 2 * MIN);

        const w = await service.getWindow(NOW);
        expect(w.totalDifficulty).toBe(4000);
        expect(w.totalShares).toBe(4);
        expect(w.miners.map(m => [m.address, m.difficulty, m.shares, m.fraction])).toEqual([
            ['A', 2000, 2, 0.5],
            ['C', 1500, 1, 0.375],
            ['B', 500, 1, 0.125],
        ]);
        expect(w.miners.reduce((s, m) => s + m.fraction, 0)).toBeCloseTo(1, 12);
    });

    it('gives the same window before and after a flush', async () => {
        service.recordShare('A', 100, NOW - 10 * MIN);
        service.recordShare('B', 300, NOW - 10 * MIN);
        const before = await service.getWindow(NOW);
        await service.flush();
        const after = await service.getWindow(NOW);
        expect(after).toEqual(before);
        expect(await repo.count()).toBe(2);
    });

    it('adds to an existing bucket across flushes', async () => {
        service.recordShare('A', 100, NOW - MIN);
        await service.flush();
        service.recordShare('A', 250, NOW - MIN + 1000);
        await service.flush();
        const rows = await repo.find();
        expect(rows).toHaveLength(1);
        expect(rows[0].difficulty).toBe(350);
        expect(rows[0].shares).toBe(2);
    });

    it('includes shares from exactly 72h ago and excludes older ones', async () => {
        service.recordShare('edge', 7, NOW - 72 * HOUR);
        service.recordShare('old', 9, NOW - 72 * HOUR - 1);
        service.recordShare('new', 1, NOW);
        await service.flush();
        const w = await service.getWindow(NOW);
        expect(w.miners.map(m => m.address).sort()).toEqual(['edge', 'new']);
        expect(w.from).toBe(new Date(NOW - 72 * HOUR).toISOString());
    });

    it('drops work as it ages out of the window', async () => {
        service.recordShare('A', 10, NOW);
        service.recordShare('B', 10, NOW + 2 * HOUR);
        expect((await service.getWindow(NOW + 2 * HOUR)).totalDifficulty).toBe(20);
        const later = await service.getWindow(NOW + 73 * HOUR);
        expect(later.miners.map(m => m.address)).toEqual(['B']);
    });

    it('ignores shares with no address or a bad difficulty', async () => {
        service.recordShare('', 10, NOW);
        service.recordShare('A', 0, NOW);
        service.recordShare('A', -5, NOW);
        service.recordShare('A', NaN, NOW);
        service.recordShare('A', Infinity, NOW);
        const w = await service.getWindow(NOW);
        expect(w.miners).toEqual([]);
        expect(w.totalDifficulty).toBe(0);
    });

    it('prunes only buckets more than an hour older than the window', async () => {
        service.recordShare('keep', 1, NOW - 72 * HOUR - 30 * MIN);
        service.recordShare('drop', 1, NOW - 74 * HOUR);
        await service.flush();
        await service.prune(NOW);
        const left = (await repo.find()).map(r => r.address);
        expect(left).toEqual(['keep']);
    });

    it('counts every share exactly once when a read races a flush', async () => {
        for (let i = 0; i < 200; i++) {
            service.recordShare(`m${i % 7}`, 1 + (i % 5), NOW - (i % 30) * MIN);
        }
        const expected = await service.getWindow(NOW);
        const [, during] = await Promise.all([service.flush(), service.getWindow(NOW)]);
        const after = await service.getWindow(NOW);
        expect(during.totalDifficulty).toBe(expected.totalDifficulty);
        expect(after.totalDifficulty).toBe(expected.totalDifficulty);
        expect(after.totalShares).toBe(200);
    });

    it('keeps the work when a flush fails and writes it on the next one', async () => {
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        const spy = jest.spyOn(repo, 'query').mockRejectedValueOnce(new Error('disk full'));
        service.recordShare('A', 42, NOW);
        await service.flush();
        expect(await repo.count()).toBe(0);
        expect((await service.getWindow(NOW)).totalDifficulty).toBe(42);
        spy.mockRestore();
        await service.flush();
        expect((await repo.find())[0].difficulty).toBe(42);
        expect((await service.getWindow(NOW)).totalDifficulty).toBe(42);
        errorSpy.mockRestore();
    });

    it('retries only the part of a flush that was not stored', async () => {
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        for (let i = 0; i < 500; i++) {
            service.recordShare(`M${i}`, 10, NOW);
        }
        const real = repo.query.bind(repo);
        let call = 0;
        const spy = jest.spyOn(repo, 'query').mockImplementation(async (...args: [string, any[]?]) => {
            if (++call === 2) {
                throw new Error('disk full');
            }
            return real(...args);
        });
        await service.flush();
        spy.mockRestore();
        expect(await repo.count()).toBe(200);
        expect((await service.getWindow(NOW)).totalDifficulty).toBe(5000);
        await service.flush();
        expect(await repo.count()).toBe(500);
        expect((await service.getWindow(NOW)).totalDifficulty).toBe(5000);
        errorSpy.mockRestore();
    });
});
