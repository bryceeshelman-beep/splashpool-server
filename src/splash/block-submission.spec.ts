import { chainState, submitBlock } from './block-submission';

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

    it.each(['high-hash', 'bad-cb-amount', 'rejected', 'duplicate-invalid', 'bad-blk-sigops'])(
        'rejects %s', async (reason) => {
            expect((await submitBlock(rpc([reason]), block)).outcome).toBe('rejected');
        });

    it.each(['duplicate', 'inconclusive', 'duplicate-inconclusive', 'prev-blk-not-found', 'RPC_ERROR: timeout'])(
        '%s is not a find by itself', async (reason) => {
            expect((await submitBlock(rpc([reason], ['someone else']), block)).outcome).toBe('unknown');
        });

    it.each(['duplicate', 'inconclusive', 'RPC_ERROR: timeout'])(
        '%s is a find if the block is in the chain', async (reason) => {
            expect((await submitBlock(rpc([reason], ['ours']), block)).outcome).toBe('accepted');
        });

    it.each([
        ['ours, 99 deep', 198, 'ours', true, false],
        ['ours, 100 deep', 199, 'ours', true, true],
        ['another, 99 deep', 198, 'theirs', false, false],
        ['another, 100 deep', 199, 'theirs', false, true],
        ['node cannot say', 199, new Error('down'), null, false],
        ['tip unknown', null, 'theirs', false, false],
    ])('%s', async (_, tip, answer, inChain, buried) => {
        const r = { ...rpc([], [answer as string]), getMiningInfo: jest.fn(async () => (tip == null ? null : { blocks: tip }) as any) };
        expect(await chainState(r, block)).toEqual({ inChain, buried });
    });
});
