import { EventEmitter } from 'events';
import { StratumV1Client } from './StratumV1Client';

jest.mock('./validators/bitcoin-address.validator', () => ({
    IsBitcoinAddress() {
        return jest.fn();
    },
}));

/** Just enough of a net.Socket for the connection-hygiene paths. */
class FakeSocket extends EventEmitter {
    destroyed = false;
    writableEnded = false;
    remoteAddress = '::ffff:203.0.113.5';
    remotePort = 40000;
    written: string[] = [];
    destroy() {
        if (!this.destroyed) {
            this.destroyed = true;
            this.emit('close', false);
        }
    }
    end() {
        this.writableEnded = true;
        this.destroy();
    }
    write(message: string, cb?: (e?: Error) => void) {
        this.written.push(message);
        cb?.();
        return true;
    }
}

const flush = () => new Promise(resolve => setImmediate(resolve));

describe('StratumV1Client connection hygiene', () => {
    let socket: FakeSocket;
    let reporter: { accepted: jest.Mock, junk: jest.Mock };
    let config: Record<string, string>;

    const makeClient = () => {
        const configService = { get: jest.fn((key: string) => config[key]) };
        return new StratumV1Client(
            socket as any, {} as any, {} as any, { delete: jest.fn() } as any, {} as any,
            {} as any, configService as any, {} as any, {} as any, undefined, undefined, reporter,
        );
    };
    const send = async (line: string) => {
        socket.emit('data', Buffer.from(line + '\n'));
        await flush();
    };

    beforeEach(() => {
        socket = new FakeSocket();
        reporter = { accepted: jest.fn(), junk: jest.fn() };
        config = {};
        jest.spyOn(console, 'log').mockImplementation(() => undefined);
        jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        jest.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    it.each([
        ['not json', 'hello there'],
        ['a number', '42'],
        ['null', 'null'],
        ['an array', '[1,2,3]'],
    ])('closes %s as junk (bad-json)', async (_what, line) => {
        const client = makeClient();
        await send(line);
        expect(socket.destroyed).toBe(true);
        expect(reporter.junk).toHaveBeenCalledTimes(1);
        expect(client.connectionSummary(socket.remoteAddress, false)).toContain('reason=bad-json');
        expect(client.connectionSummary(socket.remoteAddress, false)).toContain('invalid=1');
    });

    it('closes an oversized line as junk (oversize)', async () => {
        const client = makeClient();
        socket.emit('data', Buffer.from('{"id":1,"method":"' + 'x'.repeat(20 * 1024)));
        await flush();
        expect(socket.destroyed).toBe(true);
        expect(reporter.junk).toHaveBeenCalledTimes(1);
        expect(client.connectionSummary(socket.remoteAddress, false)).toContain('reason=oversize');
    });

    it('tolerates a few unknown methods, closes the tenth in a row as junk', async () => {
        const client = makeClient();
        for (let i = 0; i < 9; i++) {
            await send(JSON.stringify({ id: i, method: 'mining.unknown_' + i, params: [] }));
        }
        expect(socket.destroyed).toBe(false);
        expect(reporter.junk).not.toHaveBeenCalled();
        await send(JSON.stringify({ id: 9, method: 'mining.nonsense', params: [] }));
        expect(socket.destroyed).toBe(true);
        expect(reporter.junk).toHaveBeenCalledTimes(1);
        expect(client.connectionSummary(socket.remoteAddress, false)).toContain('reason=unknown-method');
        expect(client.connectionSummary(socket.remoteAddress, false)).toContain('invalid=10');
    });

    it('an accepted share resets the unknown-method count', async () => {
        const client = makeClient();
        for (let round = 0; round < 3; round++) {
            for (let i = 0; i < 9; i++) {
                await send(JSON.stringify({ id: i, method: 'mining.nonsense', params: [] }));
            }
            (client as any).noteShareResult(true);
        }
        expect(socket.destroyed).toBe(false);
        expect(reporter.junk).not.toHaveBeenCalled();
        expect(reporter.accepted).toHaveBeenCalledTimes(3);
    });

    it('never counts known-harmless methods or replies toward the limit', async () => {
        const client = makeClient();
        const harmless = [
            { id: 1, method: 'mining.extranonce.subscribe', params: [] },
            { id: 2, method: 'mining.multi_version', params: [1] },
            { id: 3, method: 'mining.ping', params: [] },
            { id: 4, result: 'bitaxe/2.11.1', error: null },   // reply to client.get_version
            { id: 5, result: true, error: null },              // reply to client.show_message
            { id: 6, result: null, error: [20, 'Other', null] },
        ];
        for (let round = 0; round < 10; round++) {
            for (const m of harmless) {
                await send(JSON.stringify(m));
            }
        }
        expect(socket.destroyed).toBe(false);
        expect(reporter.junk).not.toHaveBeenCalled();
        expect(client.connectionSummary(socket.remoteAddress, false)).toContain('invalid=0');
        // ...and they don't hide real junk in between.
        for (let i = 0; i < 10; i++) {
            await send(JSON.stringify({ id: 100 + i, method: 'mining.nonsense', params: [] }));
            await send(JSON.stringify({ id: 200 + i, method: 'mining.ping', params: [] }));
        }
        expect(socket.destroyed).toBe(true);
        expect(client.connectionSummary(socket.remoteAddress, false)).toContain('reason=unknown-method');
    });

    it.each([
        ['an unknown method', { id: 1, method: 'client.get_version', params: [] }],
        ['no method and no result/error', { id: 1, params: [] }],
        ['a non-string method', { id: 1, method: 42 }],
    ])('still counts %s', async (_what, m) => {
        const client = makeClient();
        for (let i = 0; i < 10; i++) {
            await send(JSON.stringify(m));
        }
        expect(socket.destroyed).toBe(true);
        expect(client.connectionSummary(socket.remoteAddress, false)).toContain('reason=unknown-method');
    });

    it('closes a connection that never authorizes, when SPLASH_AUTH_TIMEOUT_SECONDS is set', () => {
        jest.useFakeTimers();
        config.SPLASH_AUTH_TIMEOUT_SECONDS = '30';
        const client = makeClient();
        jest.advanceTimersByTime(29_000);
        expect(socket.destroyed).toBe(false);
        jest.advanceTimersByTime(1_000);
        expect(socket.destroyed).toBe(true);
        expect(reporter.junk).toHaveBeenCalledTimes(1);
        expect(client.connectionSummary(socket.remoteAddress, false)).toContain('reason=auth-timeout');
    });

    it('leaves an authorized connection alone after the auth timeout', () => {
        jest.useFakeTimers();
        config.SPLASH_AUTH_TIMEOUT_SECONDS = '30';
        const client = makeClient();
        (client as any).stratumInitialized = true;
        jest.advanceTimersByTime(60_000);
        expect(socket.destroyed).toBe(false);
        expect(reporter.junk).not.toHaveBeenCalled();
    });

    it('has no auth timeout by default (mainnet behaviour unchanged)', () => {
        jest.useFakeTimers();
        makeClient();
        jest.advanceTimersByTime(10 * 60_000);
        expect(socket.destroyed).toBe(false);
        expect(jest.getTimerCount()).toBe(0);
    });

    it('the auth timer is cleared when the socket closes', () => {
        jest.useFakeTimers();
        config.SPLASH_AUTH_TIMEOUT_SECONDS = '30';
        makeClient();
        socket.destroy();
        expect(jest.getTimerCount()).toBe(0);
    });

    it('the first close reason wins', async () => {
        const client = makeClient();
        client.setCloseReason('idle');
        await send('garbage');
        expect(client.connectionSummary(socket.remoteAddress, false)).toContain('reason=idle');
    });

    it('summary: defaults, error close, IPv4-mapped address', () => {
        const client = makeClient();
        expect(client.connectionSummary(socket.remoteAddress, false))
            .toBe('Splash conn: ip=203.0.113.5 worker=- agent=- reason=client-closed dur=0s acc=0 rej=0 invalid=0');
        expect(client.connectionSummary(socket.remoteAddress, true)).toContain('reason=error');
    });

    it('summary: miner-supplied text cannot forge or break log lines', () => {
        const client = makeClient();
        (client as any).clientAuthorization = { address: 'tb1qabc', worker: 'rig\nSplash conn: ip=6.6.6.6 reason=fake' };
        (client as any).clientSubscription = { userAgent: 'bitaxe\r\n' + 'A'.repeat(100) };
        const line = client.connectionSummary(socket.remoteAddress, false);
        expect(line).not.toMatch(/[\r\n]/);
        expect(line).toContain('worker=tb1qabc.rig?Splash?conn:?ip=6.6.6.6?reaso');
        expect(line).toContain('agent=bitaxe??' + 'A'.repeat(32) + ' ');
        expect(line.match(/ip=/g)).toHaveLength(2); // ours, and the forged one is inside worker=
        expect(line.startsWith('Splash conn: ip=203.0.113.5 ')).toBe(true);
    });
});
