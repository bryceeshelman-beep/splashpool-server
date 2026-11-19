import { buildPayouts, IPayoutParams, splitByWork } from './payout-builder';

const BTC = 100_000_000;

const base = (over: Partial<IPayoutParams> = {}): IPayoutParams => ({
    reward: 314_500_000,
    finderAddress: 'FINDER',
    feeAddress: 'FEE',
    window: [],
    feeBps: 100,
    finderBonusSats: 1 * BTC,
    minPayoutSats: 10_000,
    maxSplitOutputs: 250,
    ...over,
});

const sum = (r: { outputs: { value: number }[] }) => r.outputs.reduce((s, o) => s + o.value, 0);
const valueOf = (r: { outputs: { address: string, value: number }[] }, a: string) => r.outputs.find(o => o.address === a)?.value;

describe('buildPayouts', () => {

    it('matches the worked example in the build plan', () => {
        // 3.125 BTC subsidy + 0.02 BTC fees; A 50%, B 30%, C 20% of window work.
        const r = buildPayouts(base({
            window: [
                { address: 'A', difficulty: 5000 },
                { address: 'B', difficulty: 3000 },
                { address: 'C', difficulty: 2000 },
            ],
        }));
        expect(r.outputs.map(o => [o.address, o.value])).toEqual([
            ['FEE', 3_145_000],
            ['FINDER', 100_000_000],
            ['A', 105_677_500],
            ['B', 63_406_500],
            ['C', 42_271_000],
        ]);
        expect(r.roundingToFinder).toBe(0);
        expect(sum(r)).toBe(314_500_000);
    });

    it('takes 3,125,000 sats on a fee-less mainnet block, and 1% of fees on top', () => {
        // Mainnet subsidy since the 2024 halving is 3.125 BTC.
        expect(buildPayouts(base({ reward: 312_500_000 })).fee).toBe(3_125_000);
        expect(buildPayouts(base({ reward: 312_500_000 + 2_000_000 })).fee).toBe(3_125_000 + 20_000);
        // testnet4 is still on its first 50 BTC subsidy.
        expect(buildPayouts(base({ reward: 5_000_117_508 })).fee).toBe(50_001_175);
    });

    it('pays the finder its window share on top of the bonus, in one output', () => {
        const r = buildPayouts(base({
            window: [
                { address: 'FINDER', difficulty: 1 },
                { address: 'B', difficulty: 1 },
            ],
        }));
        const finder = r.outputs.find(o => o.address === 'FINDER');
        expect(finder.finder).toBe(100_000_000);
        expect(finder.split).toBe(105_677_500);
        expect(finder.value).toBe(205_677_500);
        expect(r.outputs.filter(o => o.address === 'FINDER')).toHaveLength(1);
        expect(sum(r)).toBe(r.reward);
    });

    it('gives the whole split to the finder when the window is empty', () => {
        const r = buildPayouts(base());
        expect(r.outputs.map(o => [o.address, o.value])).toEqual([
            ['FEE', 3_145_000],
            ['FINDER', 311_355_000],
        ]);
    });

    it('caps the finder bonus at what is left after the fee', () => {
        const r = buildPayouts(base({ reward: 50_000_000, window: [{ address: 'A', difficulty: 1 }] }));
        expect(r.fee).toBe(500_000);
        expect(r.finderBonus).toBe(49_500_000);
        expect(r.splitPool).toBe(0);
        expect(valueOf(r, 'A')).toBeUndefined();
        expect(sum(r)).toBe(50_000_000);
    });

    it('rounds the fee down and sends rounding leftovers to the finder', () => {
        const r = buildPayouts(base({
            reward: 312_500_099,
            window: [
                { address: 'A', difficulty: 1 },
                { address: 'B', difficulty: 1 },
                { address: 'C', difficulty: 1 },
            ],
        }));
        expect(r.fee).toBe(3_125_000);
        // split pool 209,375,099 / 3 = 69,791,699.67 each -> 2 sats left over
        expect(valueOf(r, 'A')).toBe(69_791_699);
        expect(r.roundingToFinder).toBe(2);
        expect(valueOf(r, 'FINDER')).toBe(100_000_002);
        expect(sum(r)).toBe(312_500_099);
    });

    it('drops miners under the minimum payout and re-shares their portion', () => {
        // Split pool is 211,355,000. Tiny gets 211,355,000 * 1e-6 = 211 sats < 10,000.
        const r = buildPayouts(base({
            window: [
                { address: 'Big', difficulty: 999_999 },
                { address: 'Tiny', difficulty: 1 },
            ],
        }));
        expect(valueOf(r, 'Tiny')).toBeUndefined();
        expect(valueOf(r, 'Big')).toBe(211_355_000);
        expect(r.droppedMiners).toBe(1);
        expect(sum(r)).toBe(r.reward);
    });

    it('caps the number of split outputs, keeping the largest', () => {
        const window = Array.from({ length: 10 }, (_, i) => ({ address: `M${i}`, difficulty: 100 + i }));
        const r = buildPayouts(base({ window, maxSplitOutputs: 3 }));
        const paid = r.outputs.filter(o => o.split > 0).map(o => o.address);
        expect(paid).toEqual(['M9', 'M8', 'M7']);
        expect(r.droppedMiners).toBe(7);
        expect(sum(r)).toBe(r.reward);
    });

    it('merges the fee address into one output when it also mines', () => {
        const r = buildPayouts(base({ window: [{ address: 'FEE', difficulty: 1 }] }));
        const fee = r.outputs.filter(o => o.address === 'FEE');
        expect(fee).toHaveLength(1);
        expect(fee[0].fee).toBe(3_145_000);
        expect(fee[0].split).toBe(211_355_000);
        expect(r.outputs[0].address).toBe('FEE');
    });

    it('allows a zero fee with no fee output', () => {
        const r = buildPayouts(base({ feeBps: 0, feeAddress: '' }));
        expect(r.outputs.map(o => o.address)).toEqual(['FINDER']);
        expect(sum(r)).toBe(r.reward);
    });

    it('ignores window entries with no work or no address, and merges duplicates', () => {
        const r = buildPayouts(base({
            window: [
                { address: 'A', difficulty: 1 },
                { address: 'A', difficulty: 1 },
                { address: 'B', difficulty: 2 },
                { address: 'Z', difficulty: 0 },
                { address: '', difficulty: 5 },
                { address: 'N', difficulty: NaN },
            ],
        }));
        expect(valueOf(r, 'A')).toBe(valueOf(r, 'B'));
        expect(valueOf(r, 'Z')).toBeUndefined();
        expect(valueOf(r, 'N')).toBeUndefined();
        expect(sum(r)).toBe(r.reward);
    });

    it('rejects bad parameters', () => {
        expect(() => buildPayouts(base({ reward: 1.5 }))).toThrow();
        expect(() => buildPayouts(base({ reward: -1 }))).toThrow();
        expect(() => buildPayouts(base({ feeBps: 10001 }))).toThrow();
        expect(() => buildPayouts(base({ feeBps: 0.5 }))).toThrow();
        expect(() => buildPayouts(base({ finderAddress: '' }))).toThrow();
        expect(() => buildPayouts(base({ feeAddress: '' }))).toThrow();
    });

    it('always sums to the reward across many random windows', () => {
        let seed = 12345;
        const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
        for (let t = 0; t < 500; t++) {
            const n = Math.floor(rand() * 400);
            const window = Array.from({ length: n }, (_, i) => ({ address: `M${i % 300}`, difficulty: rand() * 1e12 * rand() }));
            const reward = Math.floor(rand() * 6.5 * BTC);
            const r = buildPayouts(base({ reward, window, finderAddress: `M${Math.floor(rand() * 300)}` }));
            expect(sum(r)).toBe(reward);
            expect(r.outputs.filter(o => o.split > 0).length).toBeLessThanOrEqual(250);
            for (const o of r.outputs) {
                expect(Number.isSafeInteger(o.value)).toBe(true);
                expect(o.value).toBeGreaterThan(0);
                if (o.split > 0) expect(o.split).toBeGreaterThanOrEqual(10_000);
            }
            expect(new Set(r.outputs.map(o => o.address)).size).toBe(r.outputs.length);
        }
    });
});

describe('splitByWork', () => {
    it('returns nothing for an empty pool', () => {
        expect(splitByWork(0, [{ address: 'A', difficulty: 1 }], 1, 10).paid.size).toBe(0);
    });

    it('drops everyone when nobody can reach the minimum', () => {
        const r = splitByWork(100, [{ address: 'A', difficulty: 1 }, { address: 'B', difficulty: 1 }], 1000, 10);
        expect(r.paid.size).toBe(0);
        expect(r.dropped).toBe(2);
    });
});
