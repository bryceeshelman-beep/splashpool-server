import { DataSource } from 'typeorm';

import { BlocksEntity } from '../../ORM/blocks/blocks.entity';
import { headerHash } from '../block-submission';
import { SplashRoundEntity } from './round.entity';
import { RoundService } from './round.service';

describe('tank chain check', () => {
    let db: DataSource;
    let tank: RoundService;
    let chain: Map<number, string>;
    let tip: number;
    let down: boolean;

    const hex = (n: number) => String(n).padStart(2, '0').repeat(100);
    const add = (n: number) => db.getRepository(BlocksEntity)
        .insert({ height: 100 + n, minerAddress: 'm', worker: 'w', sessionId: '00000000', blockData: hex(n) });
    const closed = async () => [...(await tank.closedByHeight()).keys()];

    beforeEach(async () => {
        for (const m of ['log', 'error'] as const) {
            jest.spyOn(console, m).mockImplementation(() => undefined);
        }
        db = new DataSource({ type: 'sqlite', database: ':memory:', entities: [BlocksEntity, SplashRoundEntity], synchronize: true });
        await db.initialize();
        chain = new Map();
        tip = 101;
        down = false;
        tank = new RoundService(db.getRepository(SplashRoundEntity), db.getRepository(BlocksEntity),
            { workSince: async () => 0, takeRoundWork: () => 0, peekRoundWork: () => 0 } as any,
            {
                getMiningInfo: async () => (down ? null : { blocks: tip }),
                getBlockHash: async (h: number) => {
                    if (down || !chain.has(h)) {
                        throw new Error('no answer');
                    }
                    return chain.get(h);
                },
            } as any);
        await tank.onModuleInit();
        await add(1);
    });
    afterEach(async () => {
        await db.destroy();
        jest.restoreAllMocks();
    });

    it('closes once the node can answer again', async () => {
        chain.set(101, headerHash(hex(1)));
        down = true;
        await tank.tick();
        expect(await closed()).toEqual([]);
        down = false;
        await tank.tick();
        expect(await closed()).toEqual([101]);
    });

    it('closes once a node that lost the block has it back', async () => {
        await tank.tick();
        chain.set(101, headerHash(hex(1)));
        await tank.tick();
        expect(await closed()).toEqual([101]);
    });

    it('closes when a reorg brings the block back', async () => {
        chain.set(101, 'someone else');
        await tank.tick();
        chain.set(101, headerHash(hex(1)));
        await tank.tick();
        expect(await closed()).toEqual([101]);
    });

    it('closes only once', async () => {
        chain.set(101, headerHash(hex(1)));
        await tank.tick();
        await tank.tick();
        expect(await closed()).toEqual([101]);
        expect(await db.getRepository(SplashRoundEntity).count()).toBe(2);
    });

    it('passes over a block only when another is buried there', async () => {
        chain.set(101, 'someone else');
        tip = 200;
        await tank.tick();
        chain.set(101, headerHash(hex(1)));
        await tank.tick();
        expect(await closed()).toEqual([]);
    });

    it('an undecided block does not hold up a later one', async () => {
        await add(2);
        chain.set(102, headerHash(hex(2)));
        await tank.tick();
        expect(await closed()).toEqual([102]);
    });

    it('a buried orphan does not move the mark past an undecided block', async () => {
        await add(2);
        chain.set(102, 'someone else');
        tip = 250;
        await tank.tick();
        chain.set(101, headerHash(hex(1)));
        await tank.tick();
        expect(await closed()).toEqual([101]);
    });
});
