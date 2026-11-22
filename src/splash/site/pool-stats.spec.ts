import { poolStatsFrom, SummaryForStats } from './pool-stats';

const base: SummaryForStats = {
    chain: 'main',
    height: 976816,
    pool: { hashrate: 7069778895940.466, activeAddresses: 1, workers: 2 },
    blocksFound: 0,
    lastBlock: null,
    rules: { splashBonusSats: 112500000, feePercentOfShared: 0.125, windowHours: 72, minPayoutSats: 10000 },
    updatedAt: '2026-11-21T01:05:00.940Z',
};

describe('poolStatsFrom', () => {
    it('reports aggregate stats, fee and scheme with no block yet', () => {
        const s = poolStatsFrom(base);
        expect(s.hashrate).toBe(7069778895940);
        expect(s.miners).toBe(1);
        expect(s.workers).toBe(2);
        expect(s.lastBlock).toBeNull();
        expect(s.fee).toBe(0.125);
        expect(s.payoutScheme).toBe('PPLNS');
        expect(s.splashBonusBtc).toBe(1.125);
        expect(s.minPayoutBtc).toBe(0.0001);
    });

    it('gives the last block height and unix timestamp', () => {
        const s = poolStatsFrom({ ...base, blocksFound: 1, lastBlock: { height: 977000, hash: 'ab'.repeat(32), foundAt: '2026-11-22T10:00:00.000Z' } });
        expect(s.lastBlock).toEqual({ height: 977000, hash: 'ab'.repeat(32), timestamp: 1795341600, foundAt: '2026-11-22T10:00:00.000Z' });
    });

    it('never passes through miner addresses or extra summary fields', () => {
        const leaky = { ...base, pool: { ...base.pool, miners: ['bc1qsecretminer'] }, topOutputs: [{ address: 'bc1qsecretminer' }] } as any;
        const json = JSON.stringify(poolStatsFrom(leaky));
        expect(json).not.toContain('bc1q');
    });
});
