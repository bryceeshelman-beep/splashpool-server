import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import * as bitcoinjs from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';

import { ShareWindowService } from '../ORM/share-window/share-window.service';
import { buildPayouts, IPayoutResult, IWindowWork } from './payout-builder';

// Taproot (bc1p/tb1p) addresses need the ECC library. main.ts also sets it up;
// doing it here too means this module never depends on that hidden setup.
bitcoinjs.initEccLib(ecc);

export function networkFromConfig(networkConfig: string): bitcoinjs.networks.Network {
    switch (networkConfig) {
        case 'mainnet': return bitcoinjs.networks.bitcoin;
        case 'testnet': return bitcoinjs.networks.testnet;
        case 'regtest': return bitcoinjs.networks.regtest;
        default: throw new Error(`Invalid NETWORK configuration: ${networkConfig}`);
    }
}

/** True when `address` decodes to a standard output script on `network`. */
export function isPayableAddress(address: string, network: bitcoinjs.networks.Network): boolean {
    try {
        return bitcoinjs.address.toOutputScript(address, network).length > 0;
    } catch {
        return false;
    }
}

const intConfig = (raw: string, fallback: number) => {
    if (raw == null || raw === '') {
        return fallback;
    }
    const v = Number(raw);
    if (!Number.isSafeInteger(v) || v < 0) {
        throw new Error(`Expected a non-negative integer, got "${raw}"`);
    }
    return v;
};

/**
 * Splash Pool payouts: each miner's block template pays the fee, that miner as
 * finder, and everyone in the 3-day share window, straight from the block
 * reward. The window is snapshotted every 30 seconds so building a job stays
 * synchronous and cheap.
 */
@Injectable()
export class PayoutService implements OnModuleInit {

    public readonly enabled: boolean;
    public readonly feeAddress: string;
    public readonly feeBps: number;
    public readonly finderBonusSats: number;
    public readonly minPayoutSats: number;
    public readonly maxSplitOutputs: number;
    public readonly maxOutputBytes: number;
    private readonly network: bitcoinjs.networks.Network;

    private snapshot: IWindowWork[] = [];
    private snapshotAt: Date = null;
    private lastReward: number = null;

    constructor(
        private readonly configService: ConfigService,
        private readonly shareWindowService: ShareWindowService,
    ) {
        this.enabled = this.configService.get('SPLASH_PAYOUTS')?.toLowerCase() === 'true';
        this.feeAddress = this.configService.get('SPLASH_FEE_ADDRESS') || '';
        this.feeBps = intConfig(this.configService.get('SPLASH_FEE_BPS'), 100);
        this.finderBonusSats = intConfig(this.configService.get('SPLASH_FINDER_BONUS_SATS'), 100_000_000);
        this.minPayoutSats = intConfig(this.configService.get('SPLASH_MIN_PAYOUT_SATS'), 10_000);
        this.maxSplitOutputs = intConfig(this.configService.get('SPLASH_MAX_SPLIT_OUTPUTS'), 250);
        // AxeOS 2.11 and OSM 2.15 crash between 6,000 and 6,400 bytes of
        // outputs (tested 2026-11-19); 5,000 leaves room for a full mainnet
        // block's merkle branch in the same mining.notify line.
        this.maxOutputBytes = intConfig(this.configService.get('SPLASH_MAX_COINBASE_OUTPUT_BYTES'), 5000);
        this.network = networkFromConfig(this.configService.get('NETWORK'));

        if (this.enabled) {
            if (this.feeBps > 10000) {
                throw new Error('SPLASH_FEE_BPS must be at most 10000');
            }
            // Refuse to start rather than build blocks that pay a bad fee script.
            if (this.feeBps > 0 && !isPayableAddress(this.feeAddress, this.network)) {
                throw new Error(`SPLASH_FEE_ADDRESS "${this.feeAddress}" is not a valid ${this.configService.get('NETWORK')} address`);
            }
        }
    }

    async onModuleInit(): Promise<void> {
        if (this.enabled) {
            await this.refresh();
            console.log(`Splash payouts ON: fee ${this.feeBps / 100}% to ${this.feeAddress}, finder ${this.finderBonusSats} sats, min ${this.minPayoutSats} sats, max ${this.maxSplitOutputs} split outputs / ${this.maxOutputBytes} output bytes, window ${this.shareWindowService.windowHours}h`);
        }
    }

    @Interval(30 * 1000)
    public async refresh(): Promise<void> {
        if (!this.enabled) {
            return;
        }
        try {
            const window = await this.shareWindowService.getWindow();
            const payable: IWindowWork[] = [];
            for (const m of window.miners) {
                if (isPayableAddress(m.address, this.network)) {
                    payable.push({ address: m.address, difficulty: m.difficulty });
                } else {
                    console.warn(`Splash: skipping unpayable window address ${m.address}`);
                }
            }
            // Pre-merge and pre-sort in splitByWork's order (largest work first, ties by
            // address). It merges and sorts again per call, but on sorted input that
            // is near-linear, which keeps per-miner job building cheap.
            const merged = new Map<string, number>();
            for (const m of payable) {
                merged.set(m.address, (merged.get(m.address) ?? 0) + m.difficulty);
            }
            this.snapshot = Array.from(merged, ([address, difficulty]) => ({ address, difficulty }))
                .sort((a, b) => b.difficulty - a.difficulty || (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
            this.snapshotAt = new Date();
            this.outputsCache.clear();
        } catch (e) {
            // Keep the previous snapshot; a stale split is better than none.
            console.error('Splash: share window refresh failed, keeping previous snapshot', e);
        }
    }

    /** The reward split for a block found by `finderAddress`. */
    public build(finderAddress: string, reward: number): IPayoutResult {
        this.lastReward = reward;
        return buildPayouts({
            reward,
            finderAddress,
            feeAddress: this.feeAddress,
            window: this.snapshot,
            feeBps: this.feeBps,
            finderBonusSats: this.finderBonusSats,
            minPayoutSats: this.minPayoutSats,
            maxSplitOutputs: this.maxSplitOutputs,
            maxOutputBytes: this.maxOutputBytes,
            outputBytes: (a: string) => this.outputBytes(a),
        });
    }

    // finder|reward -> outputs, valid until the next snapshot. Many workers share one
    // address, and every one of them needs a job on every new block.
    private readonly outputsCache = new Map<string, { address: string, value: number }[]>();

    /** Exact outputs for MiningJob. */
    public outputsFor(finderAddress: string, reward: number): { address: string, value: number }[] {
        const key = `${finderAddress}|${reward}`;
        let outputs = this.outputsCache.get(key);
        if (outputs == null) {
            outputs = this.build(finderAddress, reward).outputs.map(o => ({ address: o.address, value: o.value }));
            if (this.outputsCache.size > 50_000) {
                this.outputsCache.clear();
            }
            this.outputsCache.set(key, outputs);
        } else {
            this.lastReward = reward;
        }
        return outputs.map(o => ({ ...o }));
    }

    public status() {
        return {
            enabled: this.enabled,
            feeAddress: this.feeAddress,
            feeBps: this.feeBps,
            finderBonusSats: this.finderBonusSats,
            minPayoutSats: this.minPayoutSats,
            maxSplitOutputs: this.maxSplitOutputs,
            maxOutputBytes: this.maxOutputBytes,
            snapshotAt: this.snapshotAt?.toISOString() ?? null,
            snapshotMiners: this.snapshot.length,
            lastReward: this.lastReward,
        };
    }

    private readonly scriptSizes = new Map<string, number>();

    /** Serialized size of an output paying `address`: value, script length, script. */
    public outputBytes(address: string): number {
        let n = this.scriptSizes.get(address);
        if (n == null) {
            const script = bitcoinjs.address.toOutputScript(address, this.network).length;
            n = 8 + (script < 253 ? 1 : 3) + script;
            if (this.scriptSizes.size > 100_000) {
                this.scriptSizes.clear();
            }
            this.scriptSizes.set(address, n);
        }
        return n;
    }

    public isPayable(address: string): boolean {
        return isPayableAddress(address, this.network);
    }
}
