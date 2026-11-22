import { readFileSync } from 'fs';
import { join } from 'path';

import { SAVE_TIMEOUT_MS, shutdownHandler } from './shutdown';

describe('shutdownHandler', () => {
    beforeEach(() => {
        jest.spyOn(console, 'log').mockImplementation(() => undefined);
        jest.spyOn(console, 'error').mockImplementation(() => undefined);
    });
    afterEach(() => jest.restoreAllMocks());

    it('stops intake, saves everything, and only then exits', async () => {
        const order: string[] = [];
        const save = (name: string) => async () => {
            await new Promise(resolve => setTimeout(resolve, 5));
            order.push(name);
        };
        await shutdownHandler(() => order.push('stop'), [save('window'), save('tank')], code => order.push(`exit ${code}`))();
        expect(order).toEqual(['stop', 'window', 'tank', 'exit 0']);
    });

    it('a second signal does not cut the save short', async () => {
        const exit = jest.fn();
        const save = jest.fn(() => new Promise<void>(resolve => setTimeout(resolve, 20)));
        const stop = shutdownHandler(() => undefined, [save], exit);
        const first = stop();
        await stop();
        expect(exit).not.toHaveBeenCalled();
        await first;
        expect(save).toHaveBeenCalledTimes(1);
        expect(exit).toHaveBeenCalledTimes(1);
    });

    it('still runs the other saves when one fails', async () => {
        const exit = jest.fn();
        const second = jest.fn(async () => undefined);
        await shutdownHandler(() => { throw new Error('x'); }, [async () => { throw new Error('y'); }, second], exit)();
        expect(second).toHaveBeenCalled();
        expect(exit).toHaveBeenCalledWith(1);
    });

    it('exits anyway when a save hangs', async () => {
        const exit = jest.fn();
        void shutdownHandler(() => undefined, [() => new Promise<void>(() => undefined)], exit, 20)();
        await new Promise(resolve => setTimeout(resolve, 80));
        expect(exit).toHaveBeenCalledWith(1);
    });

    it.each(['docker-compose.yml', 'full-setup/docker-compose-mainnet.yml', 'full-setup/docker-compose-regtest.yml', 'full-setup/docker-compose-testnet.yml'])(
        '%s waits longer than the save can take', (file) => {
            const text = readFileSync(join(__dirname, '../..', file), 'utf8');
            const service = text.split(/^  (?=public-pool[\w-]*:)/m)[1].split(/\n\S/)[0];
            const seconds = Number(/^ +stop_grace_period: (\d+)s$/m.exec(service)?.[1] ?? 10);
            expect(seconds * 1000).toBeGreaterThan(SAVE_TIMEOUT_MS + 5000);
        });
});
