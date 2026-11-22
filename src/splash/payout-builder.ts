// Splash Pool payout rules, as pure functions (no I/O), so they can be tested
// exhaustively. All amounts are integer satoshis.
//
//   splash bonus = min(splashBonusSats, reward)       to the finder, no fee taken
//   shared       = reward - splash bonus
//   fee          = floor(shared * feePpm / 1,000,000)  (0.125% = 1250 ppm)
//   split        = shared - fee, shared by window work (time-based PPLNS);
//                  the finder gets its slice of this too
//
// Miners whose split share is under minPayout are dropped and their portion
// is spread over the rest (non-custodial: nothing is owed or carried over).
// At most maxSplitOutputs miners are paid; the smallest are dropped first,
// but the finder and fee addresses are never dropped by this or the byte limit.
// With maxOutputBytes, all outputs together (fee, finder, split) must also fit
// in that many serialized bytes: miner firmware (AxeOS/ESP-Miner and forks)
// crashes on mining.notify lines much over ~12 KB, and a P2TR output is 43
// bytes where P2WPKH is 31, so a byte budget is the honest limit.
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
    // Pool fee in parts per million of the shared portion (1250 = 0.125%).
    feePpm: number;
    // The Splash Bonus: paid in full to the block finder, before the fee.
    splashBonusSats: number;
    minPayoutSats: number;
    maxSplitOutputs: number;
    // Optional serialized-size budget for all payout outputs, in bytes.
    maxOutputBytes?: number;
    // Serialized size of one output paying `address` (8 value + script length + script).
    outputBytes?: (address: string) => number;
}

export interface IPayoutOutput {
    address: string;
    value: number;
    // What this output is made of, for display and audit.
    fee: number;
    bonus: number;
    split: number;
    // Sats left over from rounding the split down (finder only, a few sats).
    rounding: number;
}

export interface IPayoutResult {
    outputs: IPayoutOutput[];
    reward: number;
    fee: number;
    splashBonus: number;
    // reward - splashBonus: what the fee is taken from.
    sharedPool: number;
    // sharedPool - fee: what is split by window work.
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
 * and keeping at most `maxCount` of the largest. `pinned` addresses (finder,
 * fee) survive the count and byte cuts but not the minimum. Returns floor
 * amounts; the caller assigns the leftover sats.
 */
export function splitByWork(
    pool: number,
    window: IWindowWork[],
    minPayout: number,
    maxCount: number,
    budget?: { bytes: number, sizeOf: (address: string) => number },
    pinned: ReadonlySet<string> = new Set(),
): { paid: Map<string, number>, dropped: number } {
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
    const ranked = Array.from(work.entries())
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

    // Pinned addresses take count slots but no bytes (their outputs exist
    // anyway). Everyone else is taken largest-first until a limit is hit.
    let slots = maxCount;
    for (const address of pinned) {
        if (work.has(address)) {
            slots--;
        }
    }
    let used = 0;
    const kept: [string, number][] = [];
    for (const entry of ranked) {
        if (!pinned.has(entry[0])) {
            if (slots <= 0) {
                continue;
            }
            if (budget) {
                used += budget.sizeOf(entry[0]);
                if (used > budget.bytes) {
                    slots = 0;
                    continue;
                }
            }
            slots--;
        }
        kept.push(entry);
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
    assertSats('splashBonusSats', p.splashBonusSats);
    assertSats('minPayoutSats', p.minPayoutSats);
    if (!Number.isInteger(p.feePpm) || p.feePpm < 0 || p.feePpm > 1_000_000) {
        throw new Error(`feePpm must be an integer 0..1000000, got ${p.feePpm}`);
    }
    if (!Number.isInteger(p.maxSplitOutputs) || p.maxSplitOutputs < 0) {
        throw new Error(`maxSplitOutputs must be a non-negative integer, got ${p.maxSplitOutputs}`);
    }
    if (!p.finderAddress) {
        throw new Error('finderAddress is required');
    }
    if (p.feePpm > 0 && !p.feeAddress) {
        throw new Error('feeAddress is required when feePpm > 0');
    }

    const splashBonus = Math.min(p.splashBonusSats, p.reward);
    const sharedPool = p.reward - splashBonus;
    // BigInt: sharedPool * feePpm can pass 2^53 for large rewards.
    const fee = Number(BigInt(sharedPool) * BigInt(p.feePpm) / 1_000_000n);
    const splitPool = sharedPool - fee;

    const fixed = new Set([p.finderAddress, ...(fee > 0 ? [p.feeAddress] : [])]);
    let budget: { bytes: number, sizeOf: (address: string) => number } = undefined;
    if (p.maxOutputBytes != null) {
        if (!p.outputBytes) {
            throw new Error('maxOutputBytes needs outputBytes');
        }
        assertSats('maxOutputBytes', p.maxOutputBytes);
        // Fee and finder outputs are always present; a miner who is also the
        // fee or finder address merges into that output and costs nothing.
        let fixedBytes = 0;
        for (const a of fixed) {
            fixedBytes += p.outputBytes(a);
        }
        budget = {
            bytes: Math.max(0, p.maxOutputBytes - fixedBytes),
            sizeOf: p.outputBytes,
        };
    }
    const { paid, dropped } = splitByWork(splitPool, p.window, Math.max(1, p.minPayoutSats), p.maxSplitOutputs, budget, fixed);
    let splitPaid = 0;
    for (const v of paid.values()) {
        splitPaid += v;
    }
    // Rounding leftovers, or the whole split if nobody qualified, go to the finder.
    const roundingToFinder = splitPool - splitPaid;

    const byAddress = new Map<string, IPayoutOutput>();
    const add = (address: string, part: 'fee' | 'bonus' | 'split' | 'rounding', value: number) => {
        if (value <= 0) {
            return;
        }
        const o = byAddress.get(address) ?? { address, value: 0, fee: 0, bonus: 0, split: 0, rounding: 0 };
        o[part] += value;
        o.value += value;
        byAddress.set(address, o);
    };

    add(p.feeAddress, 'fee', fee);
    add(p.finderAddress, 'bonus', splashBonus);
    add(p.finderAddress, 'rounding', roundingToFinder);
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
        splashBonus,
        sharedPool,
        splitPool,
        roundingToFinder,
        paidMiners: paid.size,
        droppedMiners: dropped,
    };
}
