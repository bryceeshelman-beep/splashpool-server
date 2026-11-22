import { DataSource } from 'typeorm';

import { AddressSettingsEntity } from './address-settings/address-settings.entity';
import { AddressSettingsService } from './address-settings/address-settings.service';
import { BlocksEntity } from './blocks/blocks.entity';
import { BlocksService } from './blocks/blocks.service';
import { RpcBlockEntity } from './rpc-block/rpc-block.entity';
import { RpcBlockService } from './rpc-block/rpc-block.service';
import { ShareBucketEntity } from './share-window/share-bucket.entity';
import { ShareWindowService } from './share-window/share-window.service';
import { TelegramSubscriptionsEntity } from './telegram-subscriptions/telegram-subscriptions.entity';
import { TelegramSubscriptionsService } from './telegram-subscriptions/telegram-subscriptions.service';

// SQLite gives the whole process one connection. A transaction around one
// write collides with, or swallows, every write that overlaps it.
describe('writes that overlap on the one SQLite connection', () => {
    const NOW = Date.UTC(2026, 10, 22, 12, 0, 0);
    let dataSource: DataSource;
    let window: ShareWindowService;

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'sqlite',
            database: ':memory:',
            entities: [AddressSettingsEntity, BlocksEntity, RpcBlockEntity, ShareBucketEntity, TelegramSubscriptionsEntity],
            synchronize: true,
        });
        await dataSource.initialize();
        window = new ShareWindowService(dataSource.getRepository(ShareBucketEntity), { get: () => undefined } as any);
    });
    afterEach(async () => {
        await dataSource.destroy();
    });

    const writers: [string, (ds: DataSource) => Promise<any>, any][] = [
        ['found block', ds => new BlocksService(ds, ds.getRepository(BlocksEntity))
            .save({ height: 100, minerAddress: 'finder', worker: 'w', sessionId: 'aabbccdd', blockData: '00' }), BlocksEntity],
        ['template lock', ds => new RpcBlockService(ds.getRepository(RpcBlockEntity)).lockBlock(100, '0'), RpcBlockEntity],
        ['new address', ds => (new (AddressSettingsService as any)(ds.getRepository(AddressSettingsEntity))).createNew('someone'), AddressSettingsEntity],
        ['subscription', ds => new TelegramSubscriptionsService(ds.getRepository(TelegramSubscriptionsEntity)).saveSubscription(1, 'someone'), TelegramSubscriptionsEntity],
    ];

    // The collision needs the second BEGIN to land while the first is in flight,
    // so start the two writes at every nearby offset, in both orders.
    const OFFSETS = [...Array.from({ length: 30 }, (_, i) => [i, 0]), ...Array.from({ length: 12 }, (_, i) => [0, i + 1])];
    const wait = async ([microtasks, ticks]: number[]) => {
        for (let i = 0; i < microtasks; i++) {
            await Promise.resolve();
        }
        for (let i = 0; i < ticks; i++) {
            await new Promise(resolve => setImmediate(resolve));
        }
    };

    describe.each(writers)('%s', (name, write, entity) => {
        it.each(['write first', 'flush first'])(`${name}: stored, and every share once, %s`, async (order) => {
            const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
            const problems: string[] = [];
            for (const offset of OFFSETS) {
                await dataSource.query('DELETE FROM share_bucket_entity');
                await dataSource.getRepository(entity).clear();
                (window as any).pending.clear();
                for (let i = 0; i < 20; i++) {
                    window.recordShare(`miner${i}`, 1000, NOW);
                }
                error.mockClear();
                let flush: Promise<void>;
                let saved: Promise<string>;
                const save = () => write(dataSource).then(() => 'stored', e => String(e));
                if (order === 'write first') {
                    saved = save();
                    await wait(offset);
                    flush = window.flush();
                } else {
                    flush = window.flush();
                    await wait(offset);
                    saved = save();
                }
                await flush;
                const result = await saved;
                const flushErrors = error.mock.calls.length;
                await window.flush();
                const count = await dataSource.getRepository(entity).count();
                const [{ total }] = await dataSource.query('SELECT SUM(difficulty) AS total FROM share_bucket_entity');
                if (result !== 'stored' || flushErrors > 0 || count !== 1 || total !== 20_000) {
                    problems.push(`offset ${offset}: ${result}, flush errors ${flushErrors}, rows ${count}, work ${total}`);
                }
            }
            expect(problems).toEqual([]);
            error.mockRestore();
        }, 60_000);
    });
});
