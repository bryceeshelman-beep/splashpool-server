#!/usr/bin/env node
// Splash Pool site gatekeeper.
//
// The Cloudflare tunnel points here, never at the pool API directly. Only
// read-only GET requests to the website endpoints pass through:
//   /api/site/summary  /api/site/poolstats  /api/site/blocks  /api/site/block/<height>  /api/site/address/<addr>
// plus the stock public-pool endpoints that pool trackers poll:
//   /api/pool  /api/network  /api/info
// /api/pool and /api/info are rebuilt from an allowlist of fields, so miner
// addresses, worker names and session ids never leave this box.
// Everything else (the pool's write endpoints, other read endpoints) gets 404.
//
// Env: LISTEN_PORT (3340), LISTEN_HOST (127.0.0.1), UPSTREAM (http://127.0.0.1:3334),
//      ALLOW_ORIGIN (*), RATE_PER_MIN (120 per client IP), POOL_FEE (0.125, reported in /api/pool).
'use strict';

const http = require('http');

const LISTEN_PORT = Number(process.env.LISTEN_PORT || 3340);
const LISTEN_HOST = process.env.LISTEN_HOST || '127.0.0.1';
const UPSTREAM = new URL(process.env.UPSTREAM || 'http://127.0.0.1:3334');
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '*';
const RATE_PER_MIN = Number(process.env.RATE_PER_MIN || 120);
const MAX_BODY = 8 * 1024 * 1024;
// Upstream /api/pool hard-codes fee: 0; report the real pool fee instead.
const POOL_FEE = Number(process.env.POOL_FEE || 0.125);

// Tracker endpoints: keep only known-safe fields (allowlist, not denylist, so a
// new upstream field is dropped rather than leaked).
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = v => (typeof v === 'string' ? v.slice(0, 128) : null);
const arr = v => (Array.isArray(v) ? v : []);
const safeBlocks = v => arr(v).map(b => ({ height: num(b && b.height) }));

function scrubPool(d) {
    return {
        totalHashRate: num(d.totalHashRate),
        blockHeight: num(d.blockHeight),
        totalMiners: num(d.totalMiners),
        blocksFound: safeBlocks(d.blocksFound),
        fee: POOL_FEE,
    };
}

function scrubInfo(d) {
    return {
        blockData: safeBlocks(d.blockData),
        userAgents: arr(d.userAgents).map(u => ({
            userAgent: str(u && u.userAgent),
            count: num(u && u.count) ?? (u && /^[0-9]+$/.test(String(u.count)) ? Number(u.count) : null),
            bestDifficulty: num(u && u.bestDifficulty),
            totalHashRate: num(u && u.totalHashRate) ?? (u && Number.isFinite(parseFloat(u.totalHashRate)) ? parseFloat(u.totalHashRate) : null),
        })),
        highScores: arr(d.highScores).map(h => ({
            updatedAt: str(h && h.updatedAt),
            bestDifficulty: num(h && h.bestDifficulty),
            bestDifficultyUserAgent: str(h && h.bestDifficultyUserAgent),
        })),
        uptime: str(d.uptime),
    };
}

const ROUTES = [
    { re: /^\/api\/site\/summary$/, maxAge: 15 },
    { re: /^\/api\/site\/poolstats$/, maxAge: 30 },
    { re: /^\/api\/site\/blocks$/, maxAge: 30 },
    { re: /^\/api\/site\/block\/[0-9]{1,8}$/, maxAge: 60 },
    { re: /^\/api\/site\/address\/[A-Za-z0-9]{14,90}$/, maxAge: 20 },
    { re: /^\/api\/pool$/, maxAge: 60, scrub: scrubPool },
    { re: /^\/api\/network$/, maxAge: 15 },
    { re: /^\/api\/info$/, maxAge: 60, scrub: scrubInfo },
];

// Per-IP fixed one-minute window.
const hits = new Map();
setInterval(() => hits.clear(), 60_000).unref();

function clientIp(req) {
    // Behind the tunnel, Cloudflare sets this; locally it is absent.
    const cf = req.headers['cf-connecting-ip'];
    return (typeof cf === 'string' && cf.length < 64 ? cf : req.socket.remoteAddress) || '?';
}

function send(res, status, body, extra = {}) {
    const data = Buffer.from(JSON.stringify(body));
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': data.length,
        'Access-Control-Allow-Origin': ALLOW_ORIGIN,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
        ...extra,
    });
    res.end(data);
}

const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': ALLOW_ORIGIN,
            'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
            // Read-only data, no credentials: allow the usual request headers
            // (Accept, Content-Type, Cache-Control...) so preflights never fail.
            'Access-Control-Allow-Headers': 'Accept, Accept-Language, Content-Type, Cache-Control, Pragma, X-Requested-With',
            'Access-Control-Max-Age': '86400',
        });
        return res.end();
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        return send(res, 405, { error: 'read-only' }, { Allow: 'GET, HEAD, OPTIONS' });
    }

    let path;
    try {
        const u = new URL(req.url, 'http://x');
        path = u.pathname; // query strings are dropped on purpose
    } catch {
        return send(res, 400, { error: 'bad url' });
    }
    const route = ROUTES.find(r => r.re.test(path));
    if (!route) {
        return send(res, 404, { error: 'not found' });
    }

    const ip = clientIp(req);
    const n = (hits.get(ip) || 0) + 1;
    hits.set(ip, n);
    if (n > RATE_PER_MIN) {
        return send(res, 429, { error: 'slow down' }, { 'Retry-After': '60' });
    }

    const up = http.request({
        hostname: UPSTREAM.hostname,
        port: UPSTREAM.port,
        path,
        method: req.method,
        headers: { Accept: 'application/json' }, // nothing from the client is forwarded
        timeout: 15_000,
    }, upRes => {
        const chunks = [];
        let size = 0;
        upRes.on('data', c => {
            size += c.length;
            if (size > MAX_BODY) {
                upRes.destroy();
                return;
            }
            chunks.push(c);
        });
        upRes.on('end', () => {
            if (size > MAX_BODY) {
                return send(res, 502, { error: 'upstream too large' });
            }
            let body = Buffer.concat(chunks);
            const ok = upRes.statusCode === 200;
            if (route.scrub) {
                if (!ok) {
                    // Don't relay upstream error bodies on scrubbed routes.
                    return send(res, 502, { error: 'pool unavailable' });
                }
                try {
                    const d = JSON.parse(body.toString('utf8'));
                    if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('shape');
                    body = Buffer.from(JSON.stringify(route.scrub(d)));
                } catch {
                    return send(res, 502, { error: 'upstream error' }); // fail closed
                }
            }
            res.writeHead(ok ? 200 : (upRes.statusCode >= 400 && upRes.statusCode < 500 ? upRes.statusCode : 502), {
                'Content-Type': 'application/json; charset=utf-8',
                'Content-Length': body.length,
                'Access-Control-Allow-Origin': ALLOW_ORIGIN,
                'X-Content-Type-Options': 'nosniff',
                'Cache-Control': ok ? `public, max-age=${route.maxAge}` : 'no-store',
            });
            res.end(req.method === 'HEAD' ? undefined : body);
        });
        upRes.on('error', () => send(res, 502, { error: 'upstream error' }));
    });
    up.on('timeout', () => up.destroy(new Error('timeout')));
    up.on('error', () => { if (!res.headersSent) send(res, 502, { error: 'pool unavailable' }); });
    up.end();
});

server.headersTimeout = 10_000;
server.requestTimeout = 15_000;
server.listen(LISTEN_PORT, LISTEN_HOST, () => {
    console.log(`Splash site proxy on ${LISTEN_HOST}:${LISTEN_PORT} -> ${UPSTREAM.origin} (/api/site + /api/pool,network,info)`);
});
