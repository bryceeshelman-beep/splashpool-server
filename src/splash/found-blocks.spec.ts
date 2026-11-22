import { Block } from 'bitcoinjs-lib';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DataSource } from 'typeorm';

import { BlocksEntity } from '../ORM/blocks/blocks.entity';
import { BlocksService } from '../ORM/blocks/blocks.service';
import { headerHash } from './block-submission';
import { FoundBlocksService, retryDelay } from './found-blocks';

const FOUND_AT = Date.UTC(2026, 10, 20, 7, 8, 9);
const make = (n = 1, size = 100) => {
    const hex = n.toString(16).padStart(2, '0').repeat(80) + 'ab'.repeat(size);
    return { hex, hash: headerHash(hex), height: 100 + n, address: 'miner', worker: 'rig', sessionId: '0000000' + n, foundAt: FOUND_AT };
};

describe('found-block files', () => {
    let dir: string;
    let db: DataSource;
    let chain: Map<number, string>;
    let tip: number;
    let down: boolean;
    let answer: string;
    let rpc: any;
    let notify: jest.Mock;
    let started: FoundBlocksService[];

    const start = (network = 'mainnet') => {
        const s = new FoundBlocksService(rpc, new BlocksService(db, db.getRepository(BlocksEntity)),
            { notifySubscribersBlockFound: notify } as any,
            { get: (key: string) => (key === 'NETWORK' ? network : dir) } as any);
        started.push(s);
        return s;
    };
    const settle = () => new Promise(resolve => setTimeout(resolve, 150));
    const restart = async (network?: string) => {
        await Promise.all(started.map(s => s.stop()));
        const s = start(network);
        await s.onApplicationBootstrap();
        await settle();
        return s;
    };
    const files = async (sub = '') => (await fs.readdir(join(dir, sub)).catch(() => [])).filter(f => f.includes('.json'));
    const rows = () => db.getRepository(BlocksEntity).find();
    const name = (b: ReturnType<typeof make>) => `${b.height}-${b.hash}.json`;

    beforeEach(async () => {
        for (const m of ['log', 'error'] as const) {
            jest.spyOn(console, m).mockImplementation(() => undefined);
        }
        dir = await fs.mkdtemp(join(tmpdir(), 'splash-found-'));
        db = new DataSource({ type: 'sqlite', database: ':memory:', entities: [BlocksEntity], synchronize: true });
        await db.initialize();
        chain = new Map();
        tip = 101;
        down = false;
        answer = 'SUCCESS!';
        // These blocks are only a header and filler.
        jest.spyOn(Block, 'fromHex').mockReturnValue({} as any);
        notify = jest.fn().mockResolvedValue(undefined);
        started = [];
        rpc = {
            SUBMIT_BLOCK: jest.fn(async (hex: string) => {
                if (down) {
                    return 'RPC_ERROR: refused';
                }
                if (answer === 'SUCCESS!') {
                    chain.set(100 + parseInt(hex.slice(0, 2), 16), headerHash(hex));
                }
                return answer;
            }),
            getMiningInfo: jest.fn(async () => (down ? null : { blocks: tip })),
            getBlockHash: jest.fn(async (height: number) => {
                if (down || !chain.has(height)) {
                    throw new Error('out of range');
                }
                return chain.get(height);
            }),
        };
    });
    afterEach(async () => {
        await Promise.all(started.map(s => s.stop()));
        await settle();
        await db.destroy();
        await fs.rm(dir, { recursive: true, force: true });
        jest.restoreAllMocks();
    });

    it('writes the whole block to a private file', async () => {
        const b = make(1, 4_000_000);
        const s = start();
        await s.found(b);
        await s.stop();
        expect(await files()).toEqual([name(b)]);
        expect(JSON.parse(await fs.readFile(join(dir, name(b)), 'utf8'))).toEqual({ ...b, network: 'mainnet' });
        expect((await fs.stat(join(dir, name(b)))).mode & 0o777).toBe(0o600);
    });

    it('submits before a hung disk answers', async () => {
        let release: () => void;
        jest.spyOn(fs, 'mkdir').mockImplementationOnce(() => new Promise(r => release = () => r(undefined)) as any);
        expect((await start().found(make())).outcome).toBe('accepted');
        expect(await files()).toEqual([]);
        release();
    });

    it('submits and records with a full disk, and writes the file later', async () => {
        const open = jest.spyOn(fs, 'open').mockRejectedValueOnce(new Error('ENOSPC'));
        const s = start();
        expect((await s.found(make())).outcome).toBe('accepted');
        await settle();
        expect(await files()).toEqual([]);
        expect(await rows()).toHaveLength(1);
        open.mockRestore();
        await s.stop();
        expect(await files()).toHaveLength(1);
    });

    it('starts the write even if the node never answers', async () => {
        rpc.SUBMIT_BLOCK.mockImplementation(() => new Promise(() => undefined));
        const s = start();
        void s.found(make());
        await settle();
        expect(await files()).toHaveLength(1);
    });

    it('stop waits for a file still being written', async () => {
        const s = start();
        void s.found(make(1, 3_000_000));
        await s.stop();
        expect(await files()).toEqual([name(make(1, 3_000_000))]);
    });

    it('retries on startup what a stop interrupted', async () => {
        down = true;
        expect((await start().found(make())).outcome).toBe('unknown');
        expect(await rows()).toHaveLength(0);
        down = false;
        await restart();
        expect(chain.get(101)).toBe(make().hash);
        expect(await rows()).toHaveLength(1);
    });

    it('resubmits an accepted block the node lost in a crash', async () => {
        await start().found(make());
        chain.clear();
        tip = 100;
        await restart();
        expect(chain.get(101)).toBe(make().hash);
        expect(await rows()).toHaveLength(1);
        expect(notify).toHaveBeenCalledTimes(1);
    });

    it('also resubmits while running, without a restart', async () => {
        await start().found(make());
        chain.clear();
        await new Promise(resolve => setTimeout(resolve, 2_400));
        expect(chain.get(101)).toBe(make().hash);
    });

    it('does not resubmit a block that is in the chain', async () => {
        await start().found(make());
        await restart();
        expect(rpc.SUBMIT_BLOCK).toHaveBeenCalledTimes(1);
    });

    it('keeps prev-blk-not-found until the parent arrives', async () => {
        answer = 'prev-blk-not-found';
        expect((await start().found(make())).outcome).toBe('unknown');
        answer = 'SUCCESS!';
        await restart();
        expect(await rows()).toHaveLength(1);
    });

    it('keeps even a refused block, for a refusal can pass (time-too-new)', async () => {
        answer = 'time-too-new';
        expect((await start().found(make())).outcome).toBe('rejected');
        expect(await rows()).toHaveLength(0);
        answer = 'SUCCESS!';
        await restart();
        expect(await rows()).toHaveLength(1);
    });

    it('records once, with the original finder and time', async () => {
        await start().found(make());
        await restart();
        await restart();
        const found = await rows();
        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ minerAddress: 'miner', worker: 'rig', sessionId: '00000001', height: 101 });
        expect(new Date(found[0].createdAt).getTime()).toBe(FOUND_AT);
        expect(notify).toHaveBeenCalledTimes(1);
    });

    it('puts back a row the database lost, with the original time', async () => {
        await start().found(make());
        await db.query('DELETE FROM blocks_entity');
        await restart();
        expect(new Date((await rows())[0].createdAt).getTime()).toBe(FOUND_AT);
    });

    it('records on the next start when the database write failed', async () => {
        jest.spyOn(BlocksService.prototype, 'saveOnce').mockRejectedValueOnce(new Error('SQLITE_FULL'));
        expect((await start().found(make())).outcome).toBe('accepted');
        expect(await rows()).toHaveLength(0);
        await restart();
        expect(await rows()).toHaveLength(1);
    });

    it('a failed notification does not undo the record', async () => {
        notify.mockRejectedValue(new Error('discord down'));
        await start().found(make());
        expect(await rows()).toHaveLength(1);
    });

    it('is done at 100 confirmations, not at 99', async () => {
        await start().found(make());
        tip = 199;
        await restart();
        expect(await files()).toHaveLength(1);
        tip = 200;
        await restart();
        expect(await files()).toEqual([]);
        expect(await files('done')).toEqual([name(make())]);
    });

    it.each([
        ['cannot finish', async () => false],
        ['fails', async () => { throw new Error('SQLITE_LOCKED'); }],
    ])('keeps the file while the database checkpoint %s', async (_, result) => {
        await start().found(make());
        tip = 200;
        const spy = jest.spyOn(BlocksService.prototype, 'checkpoint').mockImplementation(result as any);
        await restart();
        expect(await files()).toEqual([name(make())]);
        expect(await files('done')).toEqual([]);
        spy.mockRestore();
        await restart();
        expect(await files('done')).toEqual([name(make())]);
    });

    it('is lost only when another block is 100 deep', async () => {
        answer = 'inconclusive';
        chain.set(101, 'someone else');
        await start().found(make());
        tip = 199;
        await restart();
        expect(await files()).toHaveLength(1);
        tip = 200;
        await restart();
        expect(await files('lost')).toEqual([name(make())]);
        expect(await rows()).toHaveLength(0);
    });

    it('a node that cannot answer never makes a block lost', async () => {
        down = true;
        tip = 900;
        await start().found(make());
        await restart();
        expect(await files()).toHaveLength(1);
        expect(await files('lost')).toEqual([]);
    });

    it('resubmits parents before children', async () => {
        down = true;
        const s = start();
        await s.found(make(3));
        await s.found(make(1));
        await s.found(make(2));
        down = false;
        rpc.SUBMIT_BLOCK.mockClear();
        await restart();
        expect(rpc.SUBMIT_BLOCK.mock.calls.map(c => c[0].slice(0, 2))).toEqual(['01', '02', '03']);
    });

    it('recovers a complete .tmp left by a crash before the rename', async () => {
        await fs.writeFile(join(dir, `${name(make())}.tmp`), JSON.stringify({ ...make(), network: 'mainnet' }));
        await restart();
        expect(await files()).toEqual([name(make())]);
        expect(await rows()).toHaveLength(1);
    });

    it('leaves cut-off or altered files alone and still recovers the rest', async () => {
        await fs.writeFile(join(dir, '1-cut.json.tmp'), '{"hex":"0101');
        await fs.writeFile(join(dir, '2-bad.json'), JSON.stringify({ ...make(2), hash: 'ff', network: 'mainnet' }));
        await fs.writeFile(join(dir, name(make())), JSON.stringify({ ...make(), network: 'mainnet' }));
        await restart();
        expect(rpc.SUBMIT_BLOCK).toHaveBeenCalledTimes(1);
        expect(await files()).toHaveLength(3);
    });

    it('ignores another network', async () => {
        await start('regtest').found(make());
        rpc.SUBMIT_BLOCK.mockClear();
        await restart('mainnet');
        expect(rpc.SUBMIT_BLOCK).not.toHaveBeenCalled();
    });

    it('an unusable directory stops neither startup nor submission', async () => {
        await fs.writeFile(join(dir, 'file'), '');
        const real = dir;
        dir = join(dir, 'file', 'sub');
        const s = start();
        await s.onApplicationBootstrap();
        expect((await s.found(make())).outcome).toBe('accepted');
        dir = real;
    });

    it('retries quickly, then every 30 s, then every 5 min', () => {
        expect([0, 1, 2, 3, 242, 243].map(n => retryDelay(n, 'unknown') / 1000)).toEqual([2, 5, 10, 30, 30, 300]);
        expect(retryDelay(5, 'rejected')).toBe(300_000);
        expect(retryDelay(5_000, 'accepted')).toBe(30_000);
    });
});
