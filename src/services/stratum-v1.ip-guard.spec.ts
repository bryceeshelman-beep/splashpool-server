import { AddressInfo, connect, Server, Socket } from 'net';

import { StratumV1Client } from '../models/StratumV1Client';
import { StratumV1Service } from './stratum-v1.service';

jest.mock('../models/StratumV1Client', () => ({ StratumV1Client: jest.fn(() => ({ destroy: jest.fn() })) }));

// Real sockets. Loopback is normally exempt, so it's un-exempted here.
describe('StratumV1Service IP guard', () => {
    let server: Server;
    let sockets: Socket[];
    let warn: jest.SpyInstance;
    let service: StratumV1Service;

    const start = async (settings: Record<string, string>) => {
        const none = {} as any;
        service = new StratumV1Service(none, none, none, none,
            { get: (key: string) => settings[key] } as any, none, none, none, none, none);
        server = (service as any).createSocketServer();
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    };
    const dial = async () => {
        const socket = connect((server.address() as AddressInfo).port, '127.0.0.1');
        sockets.push(socket);
        socket.on('error', () => undefined);
        const state = { closed: false };
        socket.on('close', () => state.closed = true);
        socket.resume();
        await new Promise(resolve => setTimeout(resolve, 50));
        return { socket, state };
    };
    const reporters = () => (StratumV1Client as unknown as jest.Mock).mock.calls.map(args => args[args.length - 1]);

    beforeEach(() => {
        sockets = [];
        (StratumV1Client as unknown as jest.Mock).mockClear();
        warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        jest.spyOn(console, 'log').mockImplementation(() => undefined);
    });
    afterEach(async () => {
        sockets.forEach(socket => socket.destroy());
        await new Promise(resolve => server.close(resolve));
        warn.mockRestore();
    });

    it('refuses over the limit before creating a client, and frees the place on close', async () => {
        await start({ SPLASH_IP_EXEMPT_LAN: 'false', SPLASH_IP_MAX_CONNECTIONS: '2' });
        const first = await dial();
        await dial();
        const third = await dial();
        expect(third.state.closed).toBe(true);
        expect(StratumV1Client).toHaveBeenCalledTimes(2);

        first.socket.destroy();
        await new Promise(resolve => setTimeout(resolve, 50));
        expect((await dial()).state.closed).toBe(false);
    });

    it.each(['enforce', 'log'])('two junk connections in %s mode', async (mode) => {
        await start({ SPLASH_IP_EXEMPT_LAN: 'false', SPLASH_IP_MODE: mode, SPLASH_IP_BAN_CONNECTIONS: '2', SPLASH_IP_BAN_GRACE_SECONDS: '0' });
        const a = await dial();
        const b = await dial();
        reporters().slice(0, 2).forEach(reporter => reporter.junk());
        await new Promise(resolve => setTimeout(resolve, 50));
        const banned = mode === 'enforce';
        expect([a.state.closed, b.state.closed]).toEqual([banned, banned]);
        expect((await dial()).state.closed).toBe(banned);
    });

    it('stopping closes every connection and takes no new one', async () => {
        await start({});
        const open = await dial();
        service.stopIntake();
        await new Promise(resolve => setTimeout(resolve, 50));
        expect(open.state.closed).toBe(true);
        expect((await dial()).state.closed).toBe(true);
        expect(StratumV1Client).toHaveBeenCalledTimes(1);
    });

    it('does not limit this host by default', async () => {
        await start({ SPLASH_IP_MAX_CONNECTIONS: '1' });
        await dial();
        expect((await dial()).state.closed).toBe(false);
    });
});
