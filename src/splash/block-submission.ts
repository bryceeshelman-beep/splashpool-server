import { createHash } from 'crypto';

import { BitcoinRpcService } from '../services/bitcoin-rpc.service';

type Rpc = Pick<BitcoinRpcService, 'SUBMIT_BLOCK' | 'getBlockHash'>;

export interface IFoundBlock {
    hex: string;
    hash: string;
    height: number;
}

export interface ISubmitResult {
    outcome: 'accepted' | 'rejected' | 'unknown';
    response: string;
}

// Answers that don't settle it: the RPC failed (the node may still have taken
// the block), the node has the block and it isn't on the best chain (yet), or
// the node is still catching up and hasn't got the parent.
const UNSETTLED = ['duplicate', 'inconclusive', 'duplicate-inconclusive', 'prev-blk-not-found'];

export const CONFIRMATIONS = 100;

/** Block hash = double SHA256 of the 80-byte header, byte-reversed. */
export function headerHash(blockHex: string): string {
    const sha = (b: Buffer) => createHash('sha256').update(b).digest();
    return sha(sha(Buffer.from(blockHex.slice(0, 160), 'hex'))).reverse().toString('hex');
}

/**
 * Where a block stands. `inChain` is null when the node can't say, which is not
 * a no. Only `buried` makes a no final: reorgs and node restarts undo the rest.
 */
export async function chainState(
    rpc: Pick<BitcoinRpcService, 'getBlockHash' | 'getMiningInfo'>,
    block: Pick<IFoundBlock, 'hash' | 'height'>,
): Promise<{ inChain: boolean | null, buried: boolean }> {
    try {
        const tip = (await rpc.getMiningInfo())?.blocks;
        const inChain = (await rpc.getBlockHash(block.height)) === block.hash;
        return { inChain, buried: tip != null && tip - block.height + 1 >= CONFIRMATIONS };
    } catch {
        return { inChain: null, buried: false };
    }
}

/** Submit once. A block is ours only if the node took it or has it in its chain. */
export async function submitBlock(rpc: Rpc, block: IFoundBlock): Promise<ISubmitResult> {
    const response = await rpc.SUBMIT_BLOCK(block.hex);
    if (response == null || response === 'SUCCESS!') {
        return { outcome: 'accepted', response };
    }
    try {
        if (await rpc.getBlockHash(block.height) === block.hash) {
            return { outcome: 'accepted', response };
        }
    } catch {
        // Height not reached, or the node can't answer: go by the response.
    }
    const unsettled = UNSETTLED.includes(response) || response.startsWith('RPC_ERROR');
    return { outcome: unsettled ? 'unknown' : 'rejected', response };
}
