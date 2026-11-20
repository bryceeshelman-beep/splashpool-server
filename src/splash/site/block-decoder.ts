import * as bitcoinjs from 'bitcoinjs-lib';

export interface IDecodedOutput {
    address: string | null;   // null for non-address outputs (witness commitment, OP_RETURN)
    value: number;            // sats
}

export interface IDecodedBlock {
    hash: string;
    height: number;
    time: number;             // header timestamp, unix seconds
    reward: number;           // sum of coinbase outputs, sats
    subsidy: number;          // sats
    txFees: number;           // reward - subsidy, sats
    outputs: IDecodedOutput[];
}

/** Block subsidy at `height` in sats (halving every 210,000 blocks). */
export function subsidyAt(height: number, halvingInterval = 210_000): number {
    const halvings = Math.floor(height / halvingInterval);
    if (halvings >= 64) {
        return 0;
    }
    // 50 BTC >> halvings, done in floating point safely below 2^53.
    return Math.floor(5_000_000_000 / Math.pow(2, halvings));
}

/** Decode a stored block's header and coinbase outputs. */
export function decodeBlock(blockHex: string, height: number, network: bitcoinjs.networks.Network, halvingInterval = 210_000): IDecodedBlock {
    const block = bitcoinjs.Block.fromHex(blockHex);
    const coinbase = block.transactions?.[0];
    if (coinbase == null) {
        throw new Error('Block has no coinbase transaction');
    }
    const outputs: IDecodedOutput[] = coinbase.outs.map(o => {
        let address: string | null = null;
        try {
            address = bitcoinjs.address.fromOutputScript(o.script, network);
        } catch {
            address = null;
        }
        return { address, value: Number(o.value) };
    });
    const reward = outputs.reduce((s, o) => s + o.value, 0);
    const subsidy = subsidyAt(height, halvingInterval);
    return {
        hash: block.getId(),
        height,
        time: block.timestamp,
        reward,
        subsidy,
        txFees: Math.max(0, reward - subsidy),
        outputs,
    };
}
