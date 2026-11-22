// Public pool-stats endpoint for listing sites (MiningPoolStats and similar).
// Built only from aggregate numbers in the site summary: no miner addresses,
// worker names or per-miner data. GET /api/site/poolstats.

export const POOL_NAME = 'Splash Pool';
export const POOL_WEBSITE = 'https://splashpool.us';
export const POOL_STRATUM = ['stratum+tcp://stratum.splashpool.us:3333'];

export interface SummaryForStats {
    chain: string | null;
    height: number | null;
    pool: { hashrate: number; activeAddresses: number; workers: number };
    blocksFound: number;
    lastBlock: { height: number; hash: string; foundAt: string } | null;
    rules: { splashBonusSats: number; feePercentOfShared: number; windowHours: number; minPayoutSats: number };
    updatedAt: string;
}

export function poolStatsFrom(s: SummaryForStats) {
    const foundMs = s.lastBlock ? Date.parse(s.lastBlock.foundAt) : NaN;
    return {
        pool: POOL_NAME,
        website: POOL_WEBSITE,
        coin: 'BTC',
        algorithm: 'sha256',
        chain: s.chain,
        stratum: POOL_STRATUM,
        hashrate: Math.round(s.pool.hashrate || 0),
        hashrateUnit: 'H/s',
        hashrateWindowMinutes: 10,
        miners: s.pool.activeAddresses,
        workers: s.pool.workers,
        blocksFound: s.blocksFound,
        lastBlock: s.lastBlock
            ? {
                height: s.lastBlock.height,
                hash: s.lastBlock.hash,
                timestamp: Number.isFinite(foundMs) ? Math.floor(foundMs / 1000) : null,
                foundAt: s.lastBlock.foundAt,
            }
            : null,
        fee: s.rules.feePercentOfShared,
        feeUnit: 'percent',
        feeAppliesTo: 'shared reward (block reward minus the Splash Bonus); the Splash Bonus is fee-free',
        payoutScheme: 'PPLNS',
        payoutSchemeDetail: `Splash Bonus of ${s.rules.splashBonusSats / 1e8} BTC to the block finder, then the rest split by work over the last ${s.rules.windowHours} hours (time-window PPLNS), paid directly in the coinbase`,
        splashBonusBtc: s.rules.splashBonusSats / 1e8,
        payoutWindowHours: s.rules.windowHours,
        minPayoutBtc: s.rules.minPayoutSats / 1e8,
        networkHeight: s.height,
        updatedAt: s.updatedAt,
    };
}
