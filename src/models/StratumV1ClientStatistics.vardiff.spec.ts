import { StratumV1ClientStatistics } from './StratumV1ClientStatistics';

describe('StratumV1ClientStatistics vardiff', () => {
    const stats = () => new StratumV1ClientStatistics({ insert: async () => { }, update: async () => { } } as any);

    it('rounds down to a power of two, including above 2^31', () => {
        const s: any = stats();
        expect(s.nearestPowerOfTwo(1)).toBe(1);
        expect(s.nearestPowerOfTwo(1000)).toBe(512);
        expect(s.nearestPowerOfTwo(100000)).toBe(65536);
        expect(s.nearestPowerOfTwo(2 ** 31 - 1)).toBe(2 ** 30);
        expect(s.nearestPowerOfTwo(3e9)).toBe(2 ** 31);
        expect(s.nearestPowerOfTwo(1e12)).toBe(2 ** 39);
        expect(s.nearestPowerOfTwo(2 ** 50)).toBe(2 ** 50);
    });

    it('keeps the stock behaviour below 1', () => {
        const s: any = stats();
        expect(s.nearestPowerOfTwo(0.5)).toBeCloseTo(0.32);
        expect(s.nearestPowerOfTwo(0.000001)).toBe(0.00001);
    });

    // Simulate a miner of a given hashrate: shares arrive at hashrate/(diff*2^32) per
    // second; the pool re-targets every 60 s. Returns the settled difficulty and how
    // many minutes it took.
    function ramp(hashrate: number, startDiff = 100000) {
        jest.useFakeTimers();
        let t = Date.UTC(2026, 0, 1);
        jest.setSystemTime(t);
        const s: any = stats();
        let diff = startDiff; let minutes = 0; let maxRate = 0;
        for (; minutes < 30; minutes++) {
            const rate = hashrate / (diff * 2 ** 32);
            maxRate = Math.max(maxRate, rate);
            // Expected shares this minute, delivered evenly (deterministic).
            const n = Math.min(Math.round(rate * 60), 2000);
            for (let i = 0; i < n; i++) {
                jest.setSystemTime(t + (i + 1) * 60000 / (n + 1));
                s.submissionCache.push({ time: new Date(), difficulty: diff });
                if (s.submissionCache.length > 31) s.submissionCache.shift();
            }
            t += 60000; jest.setSystemTime(t);
            const next = s.getSuggestedDifficulty(diff);
            if (next == null && n >= 5) break;
            if (next != null) diff = next;
        }
        jest.useRealTimers();
        return { diff, minutes, secondsPerShare: (diff * 2 ** 32) / hashrate, maxRate };
    }

    it.each([
        ['1 TH/s', 1e12], ['200 TH/s', 200e12], ['1 PH/s', 1e15], ['100 PH/s', 100e15], ['2 EH/s', 2e18],
    ])('settles a %s miner at a sane share rate', (_, h) => {
        const r = ramp(h as number);
        expect(r.secondsPerShare).toBeGreaterThan(2.5);
        expect(r.secondsPerShare).toBeLessThan(40);
    });
});
