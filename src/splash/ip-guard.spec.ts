import { DEFAULT_OPTIONS, IIpGuardOptions, IpGuard, ipGuardOptions } from './ip-guard';

describe('IpGuard', () => {
    const MINUTE = 60_000;
    const IP = '203.0.113.7';
    let now: number;
    let warn: jest.SpyInstance;
    let error: jest.SpyInstance;

    beforeEach(() => {
        now = 1_700_000_000_000;
        warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    });
    afterEach(() => {
        warn.mockRestore();
        error.mockRestore();
    });

    const guard = (options: Partial<IIpGuardOptions> = {}) =>
        new IpGuard({ ...DEFAULT_OPTIONS, mode: 'enforce', banGraceSeconds: 0, ...options }, () => now);
    const connect = (g: IpGuard, ip = IP) => {
        const socket = { destroy: jest.fn() };
        return { socket, reporter: g.open(ip, socket) };
    };
    const times = (n: number, f: () => void) => { for (let i = 0; i < n; i++) { f(); } };
    const junk = (g: IpGuard, n: number, ip = IP) => times(n, () => {
        const c = connect(g, ip);
        c.reporter.junk();
        g.close(ip, c.socket);
    });
    const logged = () => warn.mock.calls.map(args => args[0]).join('\n');

    describe('connection cap', () => {
        it('allows 1000 at once from one IP and refuses the 1001st', () => {
            const g = guard();
            times(1000, () => expect(connect(g).reporter).not.toBeNull());
            expect(connect(g).reporter).toBeNull();
        });

        it('applies in log-only mode too', () => {
            const g = guard({ mode: 'log', maxConnections: 1 });
            connect(g);
            expect(connect(g).reporter).toBeNull();
        });

        it('frees the place on close', () => {
            const g = guard({ maxConnections: 1 });
            const first = connect(g);
            g.close(IP, first.socket);
            expect(connect(g).reporter).not.toBeNull();
        });

        it('counts each IP separately', () => {
            const g = guard({ maxConnections: 1 });
            connect(g);
            expect(connect(g, '198.51.100.9').reporter).not.toBeNull();
        });

        it('treats ::ffff:a.b.c.d as a.b.c.d', () => {
            const g = guard({ maxConnections: 1 });
            const first = connect(g, `::ffff:${IP}`);
            expect(connect(g).reporter).toBeNull();
            g.close(`::ffff:${IP}`, first.socket);
            expect(connect(g).reporter).not.toBeNull();
        });

        it('a refusal never closes open connections', () => {
            const g = guard({ maxConnections: 1 });
            const first = connect(g);
            times(5000, () => connect(g));
            expect(first.socket.destroy).not.toHaveBeenCalled();
        });

        it('refuses a socket that has lost its address', () => {
            expect(guard().open(undefined, { destroy: jest.fn() })).toBeNull();
        });
    });

    describe('connect rate', () => {
        it('refuses after 3000 a minute when enforced, until the next minute', () => {
            const g = guard();
            times(3000, () => g.close(IP, connect(g).socket));
            expect(connect(g).reporter).toBeNull();
            now += MINUTE;
            expect(connect(g).reporter).not.toBeNull();
        });

        it('only logs in log-only mode', () => {
            const g = guard({ mode: 'log' });
            times(3000, () => g.close(IP, connect(g).socket));
            expect(connect(g).reporter).not.toBeNull();
            expect(logged()).toContain('[log-only] would refuse');
        });
    });

    describe('IP bans', () => {
        it('not at 4 junk connections, at 5', () => {
            const g = guard();
            junk(g, 4);
            const open = connect(g);
            expect(open.socket.destroy).not.toHaveBeenCalled();
            junk(g, 1);
            expect(open.socket.destroy).toHaveBeenCalled();
            expect(connect(g).reporter).toBeNull();
        });

        it('one connection reporting repeatedly is one junk connection', () => {
            const g = guard();
            const c = connect(g);
            times(50, () => c.reporter.junk());
            expect(connect(g).reporter).not.toBeNull();
        });

        it('never bans a farm with bad rigs among good ones', () => {
            const g = guard();
            const good = connect(g);
            good.reporter.accepted();
            junk(g, 200);
            expect(good.socket.destroy).not.toHaveBeenCalled();
            expect(connect(g).reporter).not.toBeNull();
            expect(logged()).toContain('not banning');
        });

        it('a valid share stops protecting the IP after 5 minutes', () => {
            const g = guard();
            connect(g).reporter.accepted();
            now += 5 * MINUTE;
            junk(g, 5);
            expect(connect(g).reporter).toBeNull();
        });

        it('slow junk connections never add up', () => {
            const g = guard();
            times(20, () => {
                junk(g, 1);
                now += 2 * MINUTE;
            });
            expect(connect(g).reporter).not.toBeNull();
        });

        it('leaves other IPs alone', () => {
            const g = guard();
            const other = connect(g, '198.51.100.9');
            junk(g, 5);
            expect(other.socket.destroy).not.toHaveBeenCalled();
            expect(connect(g, '198.51.100.9').reporter).not.toBeNull();
        });

        it('lasts 1, then 10, then 60 minutes', () => {
            const g = guard();
            for (const minutes of [1, 10, 60, 60]) {
                junk(g, 5);
                now += minutes * MINUTE - 1;
                expect(connect(g).reporter).toBeNull();
                now += 1;
                expect(connect(g).reporter).not.toBeNull();
            }
        });

        it('starts again at 1 minute after a clean day', () => {
            const g = guard();
            junk(g, 5);
            now += 25 * 60 * MINUTE;
            junk(g, 5);
            now += MINUTE;
            expect(connect(g).reporter).not.toBeNull();
        });
    });

    describe('grace period', () => {
        const graced = () => guard({ banGraceSeconds: 120 });

        it('after a restart, a farm\'s bad rig cannot ban it before its first valid share', () => {
            const g = graced();
            const good = connect(g);
            junk(g, 50);
            expect(good.socket.destroy).not.toHaveBeenCalled();
            now += 30_000;
            good.reporter.accepted();
            now += 2 * MINUTE;
            junk(g, 50);
            expect(good.socket.destroy).not.toHaveBeenCalled();
        });

        it('an all-bad IP is banned once the grace is over', () => {
            const g = graced();
            connect(g);
            junk(g, 50);
            now += 2 * MINUTE;
            junk(g, 1);
            expect(connect(g).reporter).toBeNull();
        });

        it('an IP out of a ban gets it again', () => {
            const g = graced();
            connect(g);
            now += 2 * MINUTE;
            junk(g, 5);
            now += MINUTE;
            const back = connect(g);
            junk(g, 5);
            expect(back.socket.destroy).not.toHaveBeenCalled();
            now += 2 * MINUTE;
            junk(g, 1);
            expect(back.socket.destroy).toHaveBeenCalled();
        });

        it('an IP back after being away gets it again', () => {
            const g = graced();
            const first = connect(g);
            now += 2 * MINUTE;
            g.close(IP, first.socket);
            now += 5 * MINUTE;
            const back = connect(g);
            junk(g, 5);
            expect(back.socket.destroy).not.toHaveBeenCalled();
        });
    });

    describe('log-only mode', () => {
        it('is the default', () => {
            expect(DEFAULT_OPTIONS.mode).toBe('log');
        });

        it('records the ban and closes nothing', () => {
            const g = guard({ mode: 'log' });
            const open = connect(g);
            junk(g, 5);
            expect(open.socket.destroy).not.toHaveBeenCalled();
            expect(connect(g).reporter).not.toBeNull();
            expect(logged()).toContain('[log-only] would ban 203.0.113.7 for 1 min');
        });

        it('logs one would-be ban per period, escalating like real ones', () => {
            const g = guard({ mode: 'log' });
            junk(g, 100);
            expect(warn).toHaveBeenCalledTimes(1);
            now += MINUTE;
            junk(g, 100);
            expect(logged()).toContain('for 10 min (ban 2)');
        });

        it('flags a would-be ban that would have blocked a valid share', () => {
            const g = guard({ mode: 'log' });
            junk(g, 5);
            times(3, () => connect(g).reporter.accepted());
            expect(warn.mock.calls.filter(args => args[0].includes('MISTAKE?'))).toHaveLength(1);
        });
    });

    describe('exempt', () => {
        it.each(['127.0.0.1', '192.168.0.10', '192.168.255.254', '10.0.0.5', '172.17.0.2', '172.31.255.255', '::ffff:192.168.0.20'])(
            'never limits %s', (ip) => {
                const g = guard({ maxConnections: 1 });
                junk(g, 20, ip);
                connect(g, ip);
                expect(connect(g, ip).reporter).not.toBeNull();
            });

        it.each(['8.8.8.8', '172.32.0.1', '192.169.0.1', '11.0.0.1', '100.64.0.1', '203.0.113.10'])('limits %s', (ip) => {
            const g = guard();
            junk(g, 5, ip);
            expect(connect(g, ip).reporter).toBeNull();
        });

        it.each(['203.0.113.7', '198.51.100.1, 203.0.113.0/24'])('allowlist "%s" exempts the farm and keeps the LAN', (allowlist) => {
            const g = guard({ allowlist, maxConnections: 1 });
            junk(g, 20);
            connect(g);
            expect(connect(g).reporter).not.toBeNull();
            connect(g, '192.168.0.10');
            expect(connect(g, '192.168.0.10').reporter).not.toBeNull();
        });

        it.each(['0.0.0.0/0', '203.0.113.7/', '203.0.113.0/33', 'nonsense', '203.0.113.0/24/8'])('ignores the bad entry %s', (allowlist) => {
            const g = guard({ allowlist, maxConnections: 1 });
            connect(g);
            expect(connect(g).reporter).toBeNull();
            expect(error).toHaveBeenCalled();
        });
    });

    it('forgets idle IPs', () => {
        const g = guard();
        for (let i = 0; i < 5000; i++) {
            const ip = `198.18.${i >> 8}.${i & 255}`;
            g.close(ip, connect(g, ip).socket);
        }
        now += 6 * MINUTE;
        connect(g);
        expect(g.trackedIps()).toBe(1);
    });

    describe('settings', () => {
        const read = (env: Record<string, string>) => ipGuardOptions(key => env[key]);

        it('has defaults', () => {
            expect(read({})).toEqual(DEFAULT_OPTIONS);
        });

        it.each(['', 'on', 'enforced', 'true'])('mode "%s" is log-only', (value) => {
            expect(read({ SPLASH_IP_MODE: value }).mode).toBe('log');
        });

        it('mode "enforce" enforces', () => {
            expect(read({ SPLASH_IP_MODE: 'enforce' }).mode).toBe('enforce');
        });

        it.each(['', 'abc', '-1'])('cap "%s" falls back to 1000', (value) => {
            expect(read({ SPLASH_IP_MAX_CONNECTIONS: value }).maxConnections).toBe(1000);
        });

        it.each(['', '1,x', '0,10', '1,,60'])('ban steps "%s" fall back', (value) => {
            expect(read({ SPLASH_IP_BAN_MINUTES: value }).banMinutes).toEqual([1, 10, 60]);
        });

        it('0 turns each limit off', () => {
            const g = guard({ maxConnections: 0, connectsPerMinute: 0, banConnections: 0 });
            times(4000, () => connect(g));
            junk(g, 20);
            expect(connect(g).reporter).not.toBeNull();
        });
    });
});
