import { buildPayouts, IPayoutParams, splitByWork } from './payout-builder';

const BTC = 100_000_000;

const base = (over: Partial<IPayoutParams> = {}): IPayoutParams => ({
    reward: 314_500_000,
    finderAddress: 'FINDER',
    feeAddress: 'FEE',
    window: [],
    feePpm: 1250,
    splashBonusSats: 1.125 * BTC,
    minPayoutSats: 10_000,
    maxSplitOutputs: 250,
    ...over,
});

const sum = (r: { outputs: { value: number }[] }) => r.outputs.reduce((s, o) => s + o.value, 0);
const valueOf = (r: { outputs: { address: string, value: number }[] }, a: string) => r.outputs.find(o => o.address === a)?.value;

describe('buildPayouts', () => {

    it('matches the worked example: 3.125 BTC subsidy + 0.02 BTC fees', () => {
        // Splash Bonus 1.125 BTC; shared 2.02 BTC; fee 0.125% of 2.02 = 252,500 sats;
        // 2.017475 BTC split by work: A 50%, B 30%, C 20%.
        const r = buildPayouts(base({
            window: [
                { address: 'A', difficulty: 5000 },
                { address: 'B', difficulty: 3000 },
                { address: 'C', difficulty: 2000 },
            ],
        }));
        expect(r.splashBonus).toBe(112_500_000);
        expect(r.sharedPool).toBe(202_000_000);
        expect(r.fee).toBe(252_500);
        expect(r.splitPool).toBe(201_747_500);
        expect(r.outputs.map(o => [o.address, o.value])).toEqual([
            ['FEE', 252_500],
            ['FINDER', 112_500_000 + r.roundingToFinder],
            ['A', 100_873_750],
            ['B', 60_524_250],
            ['C', Math.floor(201_747_500 * (2000 / 10000))],
        ]);
        expect(r.roundingToFinder).toBeLessThanOrEqual(2);
        expect(sum(r)).toBe(314_500_000);
    });

    it('takes 0.125% of the reward minus the Splash Bonus, never of the bonus', () => {
        // Mainnet subsidy since the 2024 halving is 3.125 BTC: fee on 2 BTC.
        expect(buildPayouts(base({ reward: 312_500_000 })).fee).toBe(250_000);
        expect(buildPayouts(base({ reward: 312_500_000 + 2_000_000 })).fee).toBe(252_500);
        // testnet4 is still on its first 50 BTC subsidy: floor(4,887,617,508 * 0.00125).
        expect(buildPayouts(base({ reward: 5_000_117_508 })).fee).toBe(6_109_521);
        // The fee does not depend on the bonus being paid: same shared amount, same fee.
        expect(buildPayouts(base({ reward: 212_500_000, splashBonusSats: 12_500_000 })).fee).toBe(250_000);
    });

    it('pays the finder its window share on top of the bonus, in one output', () => {
        const r = buildPayouts(base({
            window: [
                { address: 'FINDER', difficulty: 1 },
                { address: 'B', difficulty: 1 },
            ],
        }));
        const finder = r.outputs.find(o => o.address === 'FINDER');
        expect(finder.bonus).toBe(112_500_000);
        expect(finder.split).toBe(100_873_750);
        expect(finder.value).toBe(213_373_750);
        expect(r.outputs.filter(o => o.address === 'FINDER')).toHaveLength(1);
        expect(sum(r)).toBe(r.reward);
    });

    it('gives the whole split to the finder when the window is empty', () => {
        const r = buildPayouts(base());
        expect(r.outputs.map(o => [o.address, o.value])).toEqual([
            ['FEE', 252_500],
            ['FINDER', 314_247_500],
        ]);
    });

    it('caps the Splash Bonus at the reward, leaving no fee and no split', () => {
        // After the 2032 halving the subsidy (0.78125 BTC) is below the bonus.
        const r = buildPayouts(base({ reward: 80_000_000, window: [{ address: 'A', difficulty: 1 }] }));
        expect(r.splashBonus).toBe(80_000_000);
        expect(r.fee).toBe(0);
        expect(r.splitPool).toBe(0);
        expect(r.outputs.map(o => o.address)).toEqual(['FINDER']);
        expect(sum(r)).toBe(80_000_000);
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
        // shared 200,000,099 * 0.00125 = 250,000.12 -> 250,000
        expect(r.fee).toBe(250_000);
        // split 199,750,099 / 3 = 66,583,366.33 each -> 1 sat left over
        expect(valueOf(r, 'A')).toBe(66_583_366);
        expect(r.roundingToFinder).toBe(1);
        expect(valueOf(r, 'FINDER')).toBe(112_500_001);
        expect(sum(r)).toBe(312_500_099);
    });

    it('drops miners under the minimum payout and re-shares their portion', () => {
        // Split pool is 201,747,500. Tiny gets 201,747,500 * 1e-6 = 201 sats < 10,000.
        const r = buildPayouts(base({
            window: [
                { address: 'Big', difficulty: 999_999 },
                { address: 'Tiny', difficulty: 1 },
            ],
        }));
        expect(valueOf(r, 'Tiny')).toBeUndefined();
        expect(valueOf(r, 'Big')).toBe(201_747_500);
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
        expect(fee[0].fee).toBe(252_500);
        expect(fee[0].split).toBe(201_747_500);
        expect(r.outputs[0].address).toBe('FEE');
    });

    it('allows a zero fee with no fee output', () => {
        const r = buildPayouts(base({ feePpm: 0, feeAddress: '' }));
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
        expect(() => buildPayouts(base({ feePpm: 1_000_001 }))).toThrow();
        expect(() => buildPayouts(base({ feePpm: 0.5 }))).toThrow();
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

describe('output byte budget', () => {
    // Pretend sizes: names starting with T are taproot (43 B), others P2WPKH (31 B).
    const size = (a: string) => 8 + 1 + (a.startsWith('T') ? 34 : 22);
    const window = Array.from({ length: 50 }, (_, i) => ({ address: `${i % 2 ? 'T' : 'W'}${i}`, difficulty: 1000 - i }));

    it('pays the largest miners that fit, counting fee and finder outputs', () => {
        const r = buildPayouts(base({ window, maxOutputBytes: 31 * 2 + 31 + 43 + 31, outputBytes: size }));
        // fee + finder use 62 of 167 bytes: W0 (31), T1 (43), W2 (31) fit exactly.
        expect(r.outputs.map(o => o.address)).toEqual(['FEE', 'FINDER', 'W0', 'T1', 'W2']);
        expect(r.outputs.reduce((n, o) => n + size(o.address), 0)).toBeLessThanOrEqual(167);
        expect(sum(r)).toBe(r.reward);
    });

    it('does not charge the finder or fee address again when they also mine', () => {
        const r = buildPayouts(base({ window, finderAddress: 'W0', maxOutputBytes: 31 * 2 + 43, outputBytes: size }));
        // W0 merges into the finder output, so T1 still fits.
        expect(r.outputs.map(o => o.address)).toEqual(['FEE', 'W0', 'T1']);
    });

    it('keeps every output within the budget across random windows', () => {
        let seed = 7;
        const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
        for (let t = 0; t < 200; t++) {
            const w = Array.from({ length: Math.floor(rand() * 400) }, (_, i) => ({ address: `${rand() < 0.5 ? 'T' : 'W'}${i}`, difficulty: rand() * 1e9 }));
            const budget = 62 + Math.floor(rand() * 6000);
            const r = buildPayouts(base({ window: w, maxOutputBytes: budget, outputBytes: size }));
            expect(r.outputs.reduce((n, o) => n + size(o.address), 0)).toBeLessThanOrEqual(budget);
            expect(sum(r)).toBe(r.reward);
        }
    });

    it('needs a size function', () => {
        expect(() => buildPayouts(base({ maxOutputBytes: 100 }))).toThrow(/outputBytes/);
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
