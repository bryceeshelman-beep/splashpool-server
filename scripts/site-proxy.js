#!/usr/bin/env node
// Splash Pool site gatekeeper.
//
// The Cloudflare tunnel points here, never at the pool API directly. Only
// read-only GET requests to the website endpoints pass through:
//   /api/site/summary  /api/site/blocks  /api/site/block/<height>  /api/site/address/<addr>
// Everything else (the pool's write endpoints, other read endpoints) gets 404.
//
// Env: LISTEN_PORT (3340), LISTEN_HOST (127.0.0.1), UPSTREAM (http://127.0.0.1:3334),
//      ALLOW_ORIGIN (*), RATE_PER_MIN (120 per client IP).
'use strict';

const http = require('http');

const LISTEN_PORT = Number(process.env.LISTEN_PORT || 3340);
const LISTEN_HOST = process.env.LISTEN_HOST || '127.0.0.1';
const UPSTREAM = new URL(process.env.UPSTREAM || 'http://127.0.0.1:3334');
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '*';
const RATE_PER_MIN = Number(process.env.RATE_PER_MIN || 120);
const MAX_BODY = 8 * 1024 * 1024;

const ROUTES = [
    { re: /^\/api\/site\/summary$/, maxAge: 15 },
    { re: /^\/api\/site\/blocks$/, maxAge: 30 },
    { re: /^\/api\/site\/block\/[0-9]{1,8}$/, maxAge: 60 },
    { re: /^\/api\/site\/address\/[A-Za-z0-9]{14,90}$/, maxAge: 20 },
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
            const body = Buffer.concat(chunks);
            const ok = upRes.statusCode === 200;
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
    console.log(`Splash site proxy on ${LISTEN_HOST}:${LISTEN_PORT} -> ${UPSTREAM.origin} (/api/site only)`);
});
