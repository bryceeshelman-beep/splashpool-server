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
// the block), or the node has the block and it isn't on the best chain (yet).
const UNSETTLED = ['duplicate', 'inconclusive', 'duplicate-inconclusive'];

// Quickly at first, then every 30 s for two hours.
export const RETRY_DELAYS_MS = [2_000, 5_000, 10_000, ...Array<number>(240).fill(30_000)];

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

/** Resubmit an unsettled block until the node accepts or rejects it, or time runs out. */
export async function settleBlock(rpc: Rpc, block: IFoundBlock, delays = RETRY_DELAYS_MS): Promise<ISubmitResult> {
    let last: ISubmitResult = { outcome: 'unknown', response: 'not retried' };
    for (const ms of delays) {
        await new Promise(resolve => setTimeout(resolve, ms));
        last = await submitBlock(rpc, block);
        if (last.outcome !== 'unknown') {
            break;
        }
    }
    return last;
}
