import * as bitcoinjs from 'bitcoinjs-lib';

import { MiningJob } from '../models/MiningJob';
import { IJobTemplate } from '../services/stratum-v1-jobs.service';
import { isPayableAddress, PayoutService } from './payout.service';

// End-to-end check of what a miner is actually handed: the payout service's
// outputs, built into a real coinbase by MiningJob, decoded back.

const net = bitcoinjs.networks.testnet;

// One testnet address of every supported type (from the test node's wallet).
const ADDR = {
    p2wpkh: 'tb1q83j4vhk0ty6fmq5h3kkxw2gf5z5emctnch5dvc',
    p2tr: 'tb1pdt5f2macg0qdu8jvdptx6cmc0rqwt2vevprkect9vjh4hex9r54qy495gj',
    p2pkh: 'n3Aq72S5PAE634bk5qz87pEvrTsojDKWq9',
    p2sh: '2Mu32tnvghZi7gX75pgw61vMntFr36Enfsx',
    p2wsh: bitcoinjs.payments.p2wsh({ hash: Buffer.alloc(32, 7), network: net }).address,
};
const FEE = 'tb1q29suxu0226smyuy4zrkggelksx6aqe0u3t47ca';
const FINDER = 'tb1qnp8j49j3al9evmzx5hqfknrnkl3xnzfrhvuhls';
const MAINNET = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';

const config = (values: Record<string, string>) => ({ get: (k: string) => values[k] }) as any;

const baseConfig = {
    NETWORK: 'testnet',
    SPLASH_PAYOUTS: 'true',
    SPLASH_FEE_ADDRESS: FEE,
};

const fakeWindow = (miners: { address: string, difficulty: number }[]) => ({
    windowHours: 72,
    getWindow: async () => ({
        windowHours: 72, fromBucket: 0, from: '', to: '', totalDifficulty: 0, totalShares: 0,
        miners: miners.map(m => ({ ...m, shares: 1, fraction: 0 })),
    }),
}) as any;

const FILLER = '010000000001017405e391018c5e9dc79f324f9607c9c46d21b02f66dabaa870b4add871d6379f01000000171600148d7a0a3461e3891723e5fdf8129caa0075060cffffffffff01fcf60200000000001600148d7a0a3461e3891723e5fdf8129caa0075060cff0248304502210088025cffdaf69d310c6fed11832edd9c19b6a912c132262701ad0e6133227d9202207d73bbf777abd2aeae995d684e6bb1a048c5ac722e16de48bdd35643df7decf001210283409659355b6d1cc3c32decd5d561abaac86c37a353b52895a5e6c196d6f44800000000';
const FILLER_WU = bitcoinjs.Transaction.fromHex(FILLER).weight();

function jobTemplate(reward: number, extraTxs = 0): IJobTemplate {
    const block = new bitcoinjs.Block();
    block.version = 0x20000000;
    block.prevHash = Buffer.alloc(32, 1);
    block.merkleRoot = Buffer.alloc(32, 2);
    block.timestamp = 1795100000;
    block.bits = 0x1d00ffff;
    block.witnessCommit = Buffer.alloc(32, 3);
    block.transactions = [];
    const filler = bitcoinjs.Transaction.fromHex(FILLER);
    for (let i = 0; i < extraTxs; i++) {
        block.transactions.push(filler);
    }
    return {
        block,
        merkle_branch: [],
        blockData: { id: '1', creation: Date.now(), coinbasevalue: reward, networkDifficulty: 1, height: 162300, mintime: 0, clearJobs: true },
    };
}

async function service(miners: { address: string, difficulty: number }[], extra: Record<string, string> = {}) {
    const s = new PayoutService(config({ ...baseConfig, ...extra }), fakeWindow(miners));
    await s.refresh();
    return s;
}

describe('Splash coinbase', () => {

    beforeEach(() => {
        jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    });
    afterEach(() => jest.restoreAllMocks());

    it('pays every supported address type with the exact script and amount', async () => {
        const miners = Object.values(ADDR).map((address, i) => ({ address, difficulty: 1000 * (i + 1) }));
        const s = await service(miners);
        const reward = 5_000_000_000;
        const outputs = s.outputsFor(FINDER, reward);
        const tpl = jobTemplate(reward);
        const job = new MiningJob(config({ POOL_IDENTIFIER: '-=+SplashPool+=-' }), net, '1', outputs, tpl);
        const cb = job.cloneCoinbaseTransaction();

        // Payout outputs, then the witness commitment last.
        expect(cb.outs).toHaveLength(outputs.length + 1);
        outputs.forEach((o, i) => {
            expect(cb.outs[i].value).toBe(o.value);
            expect(cb.outs[i].script.equals(bitcoinjs.address.toOutputScript(o.address, net))).toBe(true);
            expect(bitcoinjs.address.fromOutputScript(cb.outs[i].script, net)).toBe(o.address);
        });
        const commitment = cb.outs[cb.outs.length - 1];
        expect(commitment.value).toBe(0);
        expect(commitment.script.subarray(0, 6).toString('hex')).toBe('6a24aa21a9ed');

        const paid = cb.outs.reduce((sum, o) => sum + o.value, 0);
        expect(paid).toBe(reward);

        // Fee first, finder second. Fee = 0.125% of (50 BTC - 1.125 BTC Splash Bonus).
        expect(bitcoinjs.address.fromOutputScript(cb.outs[0].script, net)).toBe(FEE);
        expect(cb.outs[0].value).toBe(6_109_375);
        expect(bitcoinjs.address.fromOutputScript(cb.outs[1].script, net)).toBe(FINDER);
        // 1.125 BTC Splash Bonus plus at most a few sats of rounding from the split.
        expect(cb.outs[1].value).toBeGreaterThanOrEqual(112_500_000);
        expect(cb.outs[1].value).toBeLessThan(112_500_000 + miners.length);

        // Block identity: the coinbase scriptSig carries the -=+SplashPool+=- tag.
        expect(cb.ins[0].script.toString('latin1')).toContain('-=+SplashPool+=-');

        // Every address type got paid.
        for (const a of Object.values(ADDR)) {
            expect(outputs.some(o => o.address === a)).toBe(true);
        }
    });

    it('builds a different finder output for each miner, with the same split', async () => {
        const s = await service([{ address: ADDR.p2wpkh, difficulty: 1 }, { address: ADDR.p2tr, difficulty: 1 }]);
        const a = s.outputsFor(ADDR.p2wpkh, 5_000_000_000);
        const b = s.outputsFor(ADDR.p2tr, 5_000_000_000);
        const val = (outs: { address: string, value: number }[], addr: string) => outs.find(o => o.address === addr).value;
        // Each is the finder in its own job: bonus + its half of the split.
        expect(val(a, ADDR.p2wpkh)).toBe(val(b, ADDR.p2tr));
        // The difference is the 1.125 BTC Splash Bonus, plus 1 sat of rounding:
        // the split (50 BTC - 1.125 - 6,109,375 fee) is odd, so it halves unevenly.
        expect(val(a, ADDR.p2wpkh) - val(a, ADDR.p2tr)).toBe(112_500_001);
        expect(val(b, ADDR.p2tr) - val(b, ADDR.p2wpkh)).toBe(112_500_001);
    });

    it('skips window addresses that are not valid on this network', async () => {
        const s = await service([{ address: MAINNET, difficulty: 5 }, { address: ADDR.p2wpkh, difficulty: 5 }]);
        const outs = s.outputsFor(FINDER, 5_000_000_000);
        expect(outs.some(o => o.address === MAINNET)).toBe(false);
        expect(s.status().snapshotMiners).toBe(1);
    });

    it('refuses to start with a fee address that is invalid for the network', () => {
        expect(() => new PayoutService(config({ ...baseConfig, SPLASH_FEE_ADDRESS: MAINNET }), fakeWindow([]))).toThrow(/SPLASH_FEE_ADDRESS/);
        expect(() => new PayoutService(config({ ...baseConfig, SPLASH_FEE_ADDRESS: 'garbage' }), fakeWindow([]))).toThrow();
        expect(() => new PayoutService(config({ ...baseConfig, SPLASH_FEE_PPM: '1.5' }), fakeWindow([]))).toThrow();
        expect(() => new PayoutService(config({ ...baseConfig, SPLASH_FEE_PPM: '1000001' }), fakeWindow([]))).toThrow();
    });

    it('refuses the old fee and finder-bonus setting names', () => {
        expect(() => new PayoutService(config({ ...baseConfig, SPLASH_FEE_BPS: '100' }), fakeWindow([]))).toThrow(/SPLASH_FEE_PPM/);
        expect(() => new PayoutService(config({ ...baseConfig, SPLASH_FINDER_BONUS_SATS: '100000000' }), fakeWindow([]))).toThrow(/SPLASH_BONUS_SATS/);
    });

    it('defaults to a 1.125 BTC Splash Bonus and a 0.125% fee on the shared portion', () => {
        const st = new PayoutService(config(baseConfig), fakeWindow([])).status();
        expect(st.splashBonusSats).toBe(112_500_000);
        expect(st.feePpm).toBe(1250);
        expect(st.feePercentOfShared).toBe(0.125);
    });

    it('stays off unless SPLASH_PAYOUTS=true', async () => {
        const s = new PayoutService(config({ NETWORK: 'testnet' }), fakeWindow([]));
        expect(s.enabled).toBe(false);
    });

    it('keeps the last snapshot when a window read fails', async () => {
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        const win = fakeWindow([{ address: ADDR.p2wpkh, difficulty: 1 }]);
        const s = new PayoutService(config(baseConfig), win);
        await s.refresh();
        win.getWindow = async () => { throw new Error('db locked'); };
        await s.refresh();
        expect(s.status().snapshotMiners).toBe(1);
        expect(errorSpy).toHaveBeenCalled();
    });

    it('fits 250 split outputs alongside a full block template', async () => {
        const miners = Array.from({ length: 250 }, (_, i) => ({
            address: bitcoinjs.payments.p2wsh({ hash: Buffer.alloc(32, i + 1), network: net }).address,
            difficulty: 1000 + i,
        }));
        const s = await service(miners, { SPLASH_MAX_COINBASE_OUTPUT_BYTES: '100000' });
        const reward = 5_000_000_000;
        const outputs = s.outputsFor(FINDER, reward);
        expect(outputs.length).toBe(252);
        // A template already filled to (4,000,000 - 50,000) weight, as bitcoind
        // builds it with blockreservedweight=50000.
        const tpl = jobTemplate(reward, Math.floor((4_000_000 - 50_000) / FILLER_WU));
        const job = new MiningJob(config({ POOL_IDENTIFIER: '-=+SplashPool+=-' }), net, '1', outputs, tpl);
        expect(job.cloneCoinbaseTransaction().weight()).toBeLessThan(50_000);
    });

    it('refuses a job whose block would be over the weight limit', async () => {
        const miners = Array.from({ length: 250 }, (_, i) => ({
            address: bitcoinjs.payments.p2wsh({ hash: Buffer.alloc(32, i + 1), network: net }).address,
            difficulty: 1000 + i,
        }));
        const s = await service(miners, { SPLASH_MAX_COINBASE_OUTPUT_BYTES: '100000' });
        const outputs = s.outputsFor(FINDER, 5_000_000_000);
        // A template built with only the default 8,000 WU reserved.
        const tpl = jobTemplate(5_000_000_000, Math.floor((4_000_000 - 8_000) / FILLER_WU));
        expect(() => new MiningJob(config({}), net, '1', outputs, tpl)).toThrow(/exceeds 4000000/);
    });

    it('keeps the default coinbase small enough for AxeOS/OSM firmware', async () => {
        // 250 taproot-sized miners would be ~11 KB of outputs; firmware crashed at ~6.4 KB.
        const miners = Array.from({ length: 250 }, (_, i) => ({
            address: bitcoinjs.payments.p2wsh({ hash: Buffer.alloc(32, i + 1), network: net }).address,
            difficulty: 1000 + i,
        }));
        const s = await service(miners);
        const outputs = s.outputsFor(FINDER, 5_000_000_000);
        const bytes = outputs.reduce((n, o) => n + s.outputBytes(o.address), 0);
        expect(bytes).toBeLessThanOrEqual(5000);
        expect(outputs.length).toBe(2 + Math.floor((5000 - 62) / 43));
        const job = new MiningJob(config({ POOL_IDENTIFIER: '-=+SplashPool+=-' }), net, '1', outputs, jobTemplate(5_000_000_000));
        // coinb2 in mining.notify; 12,142 hex chars ran fine on both firmwares, 13,002 crashed them.
        expect((job as any).coinbasePart2.length).toBeLessThan(10_400);
        // The largest miners are the ones kept.
        expect(outputs.some(o => o.address === miners[249].address)).toBe(true);
        expect(outputs.some(o => o.address === miners[0].address)).toBe(false);
    });

    it('sizes outputs by address type', async () => {
        const s = await service([]);
        expect(s.outputBytes(ADDR.p2wpkh)).toBe(31);
        expect(s.outputBytes(ADDR.p2tr)).toBe(43);
        expect(s.outputBytes(ADDR.p2wsh)).toBe(43);
        expect(s.outputBytes(ADDR.p2pkh)).toBe(34);
        expect(s.outputBytes(ADDR.p2sh)).toBe(32);
    });

    it('refuses exact outputs that do not sum to the reward', () => {
        const tpl = jobTemplate(1000);
        expect(() => new MiningJob(config({}), net, '1', [{ address: FINDER, value: 999 }], tpl)).toThrow(/sum to 999/);
        expect(() => new MiningJob(config({}), net, '1', [{ address: FINDER, value: 1000.5 }], tpl)).toThrow();
    });

    it('never pays an empty script for an unrecognised address', () => {
        const tpl = jobTemplate(1000);
        expect(() => new MiningJob(config({}), net, '1', [{ address: 'not-an-address', value: 1000 }], tpl)).toThrow();
        expect(() => new MiningJob(config({}), net, '1', [{ address: 'not-an-address', percent: 100 }], tpl)).toThrow();
    });

    it('recognises payable addresses per network', () => {
        expect(isPayableAddress(ADDR.p2tr, net)).toBe(true);
        expect(isPayableAddress(MAINNET, net)).toBe(false);
        expect(isPayableAddress(MAINNET, bitcoinjs.networks.bitcoin)).toBe(true);
    });
});
