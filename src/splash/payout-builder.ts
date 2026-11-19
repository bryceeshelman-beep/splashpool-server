// Splash Pool payout rules, as pure functions (no I/O), so they can be tested
// exhaustively. All amounts are integer satoshis.
//
//   fee    = floor(reward * feeBps / 10000)                 (1% = 100 bps)
//   finder = min(finderBonus, reward - fee)
//   split  = reward - fee - finder, shared by window work (time-based PPLNS)
//
// Miners whose split share is under minPayout are dropped and their portion
// is spread over the rest (non-custodial: nothing is owed or carried over).
// At most maxSplitOutputs miners are paid; the smallest are dropped first.
// Satoshis lost to rounding go to the finder, so outputs always sum to reward.
// Outputs paying the same address are merged into one.

export interface IWindowWork {
    address: string;
    difficulty: number;
}

export interface IPayoutParams {
    reward: number;
    finderAddress: string;
    feeAddress: string;
    window: IWindowWork[];
    feeBps: number;
    finderBonusSats: number;
    minPayoutSats: number;
    maxSplitOutputs: number;
}

export interface IPayoutOutput {
    address: string;
    value: number;
    // What this output is made of, for display and audit.
    fee: number;
    finder: number;
    split: number;
}

export interface IPayoutResult {
    outputs: IPayoutOutput[];
    reward: number;
    fee: number;
    finderBonus: number;
    splitPool: number;
    roundingToFinder: number;
    paidMiners: number;
    droppedMiners: number;
}

function assertSats(name: string, v: number) {
    if (!Number.isSafeInteger(v) || v < 0) {
        throw new Error(`${name} must be a non-negative integer number of sats, got ${v}`);
    }
}

/**
 * Proportional integer split of `pool` sats by `weights`, after dropping
 * entries below `minPayout` (repeatedly, since dropping raises the others)
 * and keeping at most `maxCount` of the largest. Returns floor amounts; the
 * caller assigns the leftover sats.
 */
export function splitByWork(pool: number, window: IWindowWork[], minPayout: number, maxCount: number): { paid: Map<string, number>, dropped: number } {
    // Merge duplicate addresses and ignore non-positive work.
    const work = new Map<string, number>();
    for (const w of window) {
        if (!(w.difficulty > 0) || !Number.isFinite(w.difficulty) || !w.address) {
            continue;
        }
        work.set(w.address, (work.get(w.address) ?? 0) + w.difficulty);
    }
    const total = work.size;

    // Largest work first; ties broken by address so the result is deterministic.
    let kept = Array.from(work.entries())
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    if (kept.length > maxCount) {
        kept = kept.slice(0, Math.max(0, maxCount));
    }

    if (pool <= 0 || kept.length === 0) {
        return { paid: new Map(), dropped: total };
    }

    // Dropping the smallest miner only raises everyone else's amount, so the
    // answer is the largest k where the k-th largest miner, sharing with the
    // top k, still reaches the minimum. One pass over prefix sums finds it.
    const prefix: number[] = [];
    let running = 0;
    for (const [, d] of kept) {
        running += d;
        prefix.push(running);
    }
    let k = kept.length;
    while (k > 0 && !(Math.floor(pool * (kept[k - 1][1] / prefix[k - 1])) >= minPayout)) {
        k--;
    }
    if (k === 0) {
        return { paid: new Map(), dropped: total };
    }
    const sumK = prefix[k - 1];
    const paid = new Map<string, number>();
    for (let i = 0; i < k; i++) {
        paid.set(kept[i][0], Math.floor(pool * (kept[i][1] / sumK)));
    }
    return { paid, dropped: total - k };
}

export function buildPayouts(p: IPayoutParams): IPayoutResult {
    assertSats('reward', p.reward);
    assertSats('finderBonusSats', p.finderBonusSats);
    assertSats('minPayoutSats', p.minPayoutSats);
    if (!Number.isInteger(p.feeBps) || p.feeBps < 0 || p.feeBps > 10000) {
        throw new Error(`feeBps must be an integer 0..10000, got ${p.feeBps}`);
    }
    if (!Number.isInteger(p.maxSplitOutputs) || p.maxSplitOutputs < 0) {
        throw new Error(`maxSplitOutputs must be a non-negative integer, got ${p.maxSplitOutputs}`);
    }
    if (!p.finderAddress) {
        throw new Error('finderAddress is required');
    }
    if (p.feeBps > 0 && !p.feeAddress) {
        throw new Error('feeAddress is required when feeBps > 0');
    }

    const fee = Math.floor(p.reward * p.feeBps / 10000);
    const finderBonus = Math.min(p.finderBonusSats, p.reward - fee);
    const splitPool = p.reward - fee - finderBonus;

    const { paid, dropped } = splitByWork(splitPool, p.window, Math.max(1, p.minPayoutSats), p.maxSplitOutputs);
    let splitPaid = 0;
    for (const v of paid.values()) {
        splitPaid += v;
    }
    // Rounding leftovers, or the whole split if nobody qualified, go to the finder.
    const roundingToFinder = splitPool - splitPaid;

    const byAddress = new Map<string, IPayoutOutput>();
    const add = (address: string, part: 'fee' | 'finder' | 'split', value: number) => {
        if (value <= 0) {
            return;
        }
        const o = byAddress.get(address) ?? { address, value: 0, fee: 0, finder: 0, split: 0 };
        o[part] += value;
        o.value += value;
        byAddress.set(address, o);
    };

    add(p.feeAddress, 'fee', fee);
    add(p.finderAddress, 'finder', finderBonus + roundingToFinder);
    for (const [address, value] of paid) {
        add(address, 'split', value);
    }

    // Fee first, then the finder, then everyone else by amount.
    const outputs = Array.from(byAddress.values()).sort((a, b) => {
        const rank = (o: IPayoutOutput) => (o.address === p.feeAddress && o.fee > 0 ? 0 : o.address === p.finderAddress ? 1 : 2);
        return rank(a) - rank(b) || b.value - a.value || (a.address < b.address ? -1 : 1);
    });

    const total = outputs.reduce((s, o) => s + o.value, 0);
    if (total !== p.reward) {
        throw new Error(`payout outputs sum to ${total}, expected ${p.reward}`);
    }

    return {
        outputs,
        reward: p.reward,
        fee,
        finderBonus,
        splitPool,
        roundingToFinder,
        paidMiners: paid.size,
        droppedMiners: dropped,
    };
}
