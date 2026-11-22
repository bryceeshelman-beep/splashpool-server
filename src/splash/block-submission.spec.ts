import { settleBlock, submitBlock } from './block-submission';

const block = { hex: '00', hash: 'ours', height: 100 };
const rpc = (answers: string[], chain: (string | Error)[] = [new Error('height out of range')]) => ({
    SUBMIT_BLOCK: jest.fn(async () => (answers.length > 1 ? answers.shift() : answers[0])),
    getBlockHash: jest.fn(async () => {
        const next = chain.length > 1 ? chain.shift() : chain[0];
        if (next instanceof Error) {
            throw next;
        }
        return next;
    }),
});

describe('block submission', () => {
    it('accepts what the node accepted', async () => {
        expect((await submitBlock(rpc(['SUCCESS!']), block)).outcome).toBe('accepted');
    });

    it.each(['high-hash', 'bad-cb-amount', 'rejected', 'duplicate-invalid', 'prev-blk-not-found', 'bad-blk-sigops'])(
        'rejects %s', async (reason) => {
            expect((await submitBlock(rpc([reason]), block)).outcome).toBe('rejected');
        });

    it.each(['duplicate', 'inconclusive', 'duplicate-inconclusive', 'RPC_ERROR: timeout'])(
        '%s is not a find by itself', async (reason) => {
            expect((await submitBlock(rpc([reason], ['someone else']), block)).outcome).toBe('unknown');
        });

    it.each(['duplicate', 'inconclusive', 'RPC_ERROR: timeout'])(
        '%s is a find if the block is in the chain', async (reason) => {
            expect((await submitBlock(rpc([reason], ['ours']), block)).outcome).toBe('accepted');
        });

    it('finds a block the node took before the reply was lost', async () => {
        const r = rpc(['RPC_ERROR: timeout', 'duplicate'], [new Error('down'), 'ours']);
        expect((await settleBlock(r, block, [0, 0])).outcome).toBe('accepted');
    });

    it('resubmits until a node that was down takes it', async () => {
        const r = rpc(['RPC_ERROR: refused', 'RPC_ERROR: refused', 'SUCCESS!']);
        expect((await settleBlock(r, block, [0, 0, 0, 0])).outcome).toBe('accepted');
        expect(r.SUBMIT_BLOCK).toHaveBeenCalledTimes(3);
    });

    it('stops at a rejection', async () => {
        const r = rpc(['high-hash']);
        expect((await settleBlock(r, block, [0, 0, 0])).outcome).toBe('rejected');
        expect(r.SUBMIT_BLOCK).toHaveBeenCalledTimes(1);
    });

    it('never turns a lost race into a find', async () => {
        expect((await settleBlock(rpc(['inconclusive'], ['someone else']), block, [0, 0])).outcome).toBe('unknown');
    });
});
