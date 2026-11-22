import { BlockList, isIPv4 } from 'net';

// Per-IP rules for the Stratum port, kept in memory.
//
// Connections are judged one by one: StratumV1Client closes one that is mostly
// junk (SPLASH_REJECT_LIMIT / SPLASH_REJECT_RATIO) and reports it here. A whole
// IP is banned only if it is clearly all bad: banConnections of its connections
// closed for junk within banWindowMinutes, and not one valid share from that IP
// in that time. A newly seen IP, or one just out of a ban, first gets
// banGraceSeconds to produce that share: after a restart a farm's bad rig can
// fail five times before its good rigs have found their first one.
// Bans escalate 1, 10, 60 minutes and reset after a clean day.
//
// In 'log' mode (the default) bans and the connect-rate limit only log what
// they would have done. The cap on open connections always applies.
//
// This host and the LAN are never limited. The LAN is also where a router's NAT
// loopback makes LAN miners appear from. SPLASH_IP_ALLOWLIST adds to that.

const MINUTE = 60_000;
const REPEAT_WINDOW = 24 * 60 * MINUTE;
const LOG_INTERVAL = 10_000;
const MIXED_LOG_INTERVAL = 10 * MINUTE;
const LAN = ['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'];

export interface IIpGuardOptions {
    mode: 'log' | 'enforce';
    maxConnections: number;
    connectsPerMinute: number;
    banConnections: number;
    banWindowMinutes: number;
    banMinutes: number[];
    banGraceSeconds: number;
    allowlist: string;
    exemptLan: boolean;
}

export const DEFAULT_OPTIONS: IIpGuardOptions = {
    mode: 'log',
    maxConnections: 1000,
    connectsPerMinute: 3000,
    banConnections: 5,
    banWindowMinutes: 5,
    banMinutes: [1, 10, 60],
    banGraceSeconds: 120,
    allowlist: '',
    exemptLan: true,
};

/** What a connection reports back about itself. */
export interface IConnectionReporter {
    /** It had a share accepted. */
    accepted(): void;
    /** It was closed for being mostly junk. */
    junk(): void;
}

interface IClosable {
    destroy(): unknown;
}

interface IState {
    sockets: Set<IClosable>;
    lastSeenAt: number;
    presentSince: number;
    connectWindowStart: number;
    connects: number;
    lastAcceptedAt: number;
    junkClosedAt: number[];
    bans: number;
    lastBanAt: number;
    bannedUntil: number; // In log mode: would have been banned until.
    loggedBlockedShare: boolean;
    nextMixedLogAt: number;
}

/** Options from SPLASH_IP_*. 0 turns a limit off. */
export function ipGuardOptions(get: (key: string) => string | undefined): IIpGuardOptions {
    const text = (key: string) => String(get(key) ?? '').trim();
    const number = (key: string, fallback: number) => {
        const value = text(key) === '' ? NaN : Number(text(key));
        return Number.isFinite(value) && value >= 0 ? value : fallback;
    };
    const d = DEFAULT_OPTIONS;
    const steps = text('SPLASH_IP_BAN_MINUTES').split(',').map(Number);
    return {
        // Only the exact word turns bans on, so a typo can't start banning miners.
        mode: text('SPLASH_IP_MODE').toLowerCase() === 'enforce' ? 'enforce' : 'log',
        maxConnections: number('SPLASH_IP_MAX_CONNECTIONS', d.maxConnections),
        connectsPerMinute: number('SPLASH_IP_CONNECTS_PER_MINUTE', d.connectsPerMinute),
        banConnections: Math.ceil(number('SPLASH_IP_BAN_CONNECTIONS', d.banConnections)),
        banWindowMinutes: number('SPLASH_IP_BAN_WINDOW_MINUTES', d.banWindowMinutes) || d.banWindowMinutes,
        banMinutes: steps.every(m => Number.isFinite(m) && m > 0) ? steps : d.banMinutes,
        banGraceSeconds: number('SPLASH_IP_BAN_GRACE_SECONDS', d.banGraceSeconds),
        allowlist: text('SPLASH_IP_ALLOWLIST'),
        exemptLan: text('SPLASH_IP_EXEMPT_LAN').toLowerCase() !== 'false',
    };
}

export class IpGuard {

    private readonly states = new Map<string, IState>();
    private readonly exempt = new BlockList();
    private readonly enforce: boolean;
    private readonly logs = new Map<string, { nextAt: number, suppressed: number }>();
    private nextPruneAt = 0;

    constructor(
        private readonly options: IIpGuardOptions,
        private readonly now: () => number = Date.now,
    ) {
        this.enforce = options.mode === 'enforce';
        const allowed = options.allowlist.split(',').map(e => e.trim()).filter(e => e !== '');
        for (const entry of [...(options.exemptLan ? LAN : []), ...allowed]) {
            const [network, bits, extra] = entry.split('/');
            const prefix = bits == null ? 32 : /^\d{1,2}$/.test(bits) ? Number(bits) : NaN;
            // /0 would exempt everyone.
            if (extra != null || !isIPv4(network) || !(prefix >= 1 && prefix <= 32)) {
                console.error(`Splash: ignoring bad SPLASH_IP_ALLOWLIST entry "${entry}"`);
                continue;
            }
            this.exempt.addSubnet(network, prefix, 'ipv4');
        }
    }

    public describe(): string {
        const o = this.options;
        return `Splash IP guard: bans ${this.enforce ? 'ENFORCED' : 'log-only'}, ${o.maxConnections} connections per IP (always enforced), `
            + `ban at ${o.banConnections} junk connections and no valid share in ${o.banWindowMinutes} min for ${o.banMinutes.join('/')} min (not in an IP's first ${o.banGraceSeconds} s), `
            + `allowlist [${o.allowlist}]`;
    }

    /** A reporter for an admitted connection, or null: refuse it. */
    public open(remoteAddress: string | undefined, socket: IClosable): IConnectionReporter | null {
        if (remoteAddress == null) {
            return null; // Already gone.
        }
        const ip = remoteAddress.replace(/^::ffff:/i, '');
        if (isIPv4(ip) && this.exempt.check(ip, 'ipv4')) {
            return { accepted: () => undefined, junk: () => undefined };
        }

        const now = this.now();
        this.prune(now);
        const state = this.stateFor(ip, now);
        // Back after being away: as good as new.
        if (state.sockets.size === 0 && now - state.lastSeenAt >= this.options.banWindowMinutes * MINUTE) {
            state.presentSince = now;
        }
        state.lastSeenAt = now;
        if (this.enforce && state.bannedUntil > now) {
            return null;
        }

        const { maxConnections, connectsPerMinute } = this.options;
        if (maxConnections > 0 && state.sockets.size >= maxConnections) {
            this.logSometimes('cap', now, `refused connection, ${ip} already has ${maxConnections} open`);
            return null;
        }
        if (now - state.connectWindowStart >= MINUTE) {
            state.connectWindowStart = now;
            state.connects = 0;
        }
        if (connectsPerMinute > 0 && state.connects >= connectsPerMinute) {
            const what = `${ip} opened ${connectsPerMinute} connections this minute`;
            this.logSometimes('rate', now, this.enforce ? `refused connection, ${what}` : `[log-only] would refuse connection, ${what}`);
            if (this.enforce) {
                return null;
            }
        }
        state.connects++;
        state.sockets.add(socket);

        let reportedJunk = false;
        return {
            accepted: () => this.accept(ip, state),
            junk: () => {
                // Messages in flight can report one connection twice.
                if (!reportedJunk) {
                    reportedJunk = true;
                    this.junkClosed(ip, state);
                }
            },
        };
    }

    public close(remoteAddress: string | undefined, socket: IClosable) {
        if (remoteAddress == null) {
            return;
        }
        const state = this.states.get(remoteAddress.replace(/^::ffff:/i, ''));
        if (state?.sockets.delete(socket)) {
            state.lastSeenAt = this.now();
        }
    }

    public trackedIps(): number {
        return this.states.size;
    }

    private stateFor(ip: string, now: number): IState {
        let state = this.states.get(ip);
        if (state == null) {
            state = {
                sockets: new Set(), lastSeenAt: now, presentSince: now, connectWindowStart: now, connects: 0,
                lastAcceptedAt: -Infinity, junkClosedAt: [], bans: 0, lastBanAt: -Infinity,
                bannedUntil: 0, loggedBlockedShare: false, nextMixedLogAt: 0,
            };
            this.states.set(ip, state);
        }
        return state;
    }

    private accept(ip: string, state: IState) {
        const now = this.now();
        state.lastAcceptedAt = now;
        // The number to watch while tuning: a ban that would have hurt a real miner.
        if (!this.enforce && state.bannedUntil > now && !state.loggedBlockedShare) {
            state.loggedBlockedShare = true;
            console.warn(`Splash IP guard: [log-only] MISTAKE? ${ip} sent a valid share while it would have been banned`);
        }
    }

    private junkClosed(ip: string, state: IState) {
        const now = this.now();
        const { banConnections, banWindowMinutes, banMinutes } = this.options;
        if (banConnections <= 0 || state.bannedUntil > now) {
            return;
        }
        const since = now - banWindowMinutes * MINUTE;
        state.junkClosedAt = state.junkClosedAt.filter(t => t > since);
        state.junkClosedAt.push(now);
        if (state.junkClosedAt.length < banConnections) {
            return;
        }
        // Keep only what the decision needs, however fast junk arrives.
        state.junkClosedAt = state.junkClosedAt.slice(-banConnections);

        if (state.lastAcceptedAt > since) {
            // Shared IP or a farm with some bad rigs: closing those rigs is enough.
            state.junkClosedAt.shift();
            if (now >= state.nextMixedLogAt) {
                state.nextMixedLogAt = now + MIXED_LOG_INTERVAL;
                console.warn(`Splash IP guard: not banning ${ip}, it has junk connections but also valid shares`);
            }
            return;
        }

        if (now - Math.max(state.presentSince, state.bannedUntil) < this.options.banGraceSeconds * 1000) {
            return; // Too soon to say there are no valid shares.
        }

        state.bans = now - state.lastBanAt < REPEAT_WINDOW ? state.bans + 1 : 1;
        const minutes = banMinutes[Math.min(state.bans, banMinutes.length) - 1];
        state.lastBanAt = now;
        state.bannedUntil = now + minutes * MINUTE;
        state.loggedBlockedShare = false;
        state.junkClosedAt = [];
        const facts = `${ip} for ${minutes} min (ban ${state.bans}): ${banConnections} junk connections, no valid share in ${banWindowMinutes} min, ${state.sockets.size} open`;
        if (!this.enforce) {
            console.warn(`Splash IP guard: [log-only] would ban ${facts}`);
            return;
        }
        console.warn(`Splash IP guard: banned ${facts}`);
        const sockets = [...state.sockets];
        state.sockets.clear();
        sockets.forEach(socket => socket.destroy());
    }

    private prune(now: number) {
        if (now < this.nextPruneAt) {
            return;
        }
        this.nextPruneAt = now + MINUTE;
        const idle = Math.max(2, this.options.banWindowMinutes) * MINUTE;
        for (const [ip, s] of this.states) {
            if (s.sockets.size === 0 && s.bannedUntil <= now && now - s.lastSeenAt >= idle && now - s.lastBanAt >= REPEAT_WINDOW) {
                this.states.delete(ip);
            }
        }
    }

    private logSometimes(kind: string, now: number, message: string) {
        const log = this.logs.get(kind) ?? { nextAt: 0, suppressed: 0 };
        this.logs.set(kind, log);
        if (now < log.nextAt) {
            log.suppressed++;
            return;
        }
        console.warn(`Splash IP guard: ${message}${log.suppressed > 0 ? ` (+${log.suppressed} similar not logged)` : ''}`);
        log.nextAt = now + LOG_INTERVAL;
        log.suppressed = 0;
    }
}
