#!/usr/bin/env node
// Splash Pool phase 2 check: replay the raw share log and compare it with the
// live 3-day window from the pool API. Exits non-zero on any mismatch.
//
// usage: node scripts/verify-share-window.js <shares.jsonl> [api base, default http://127.0.0.1:3334]

const fs = require('fs');
const http = require('http');

const MINUTE_MS = 60 * 1000;
const [logPath, apiBase = 'http://127.0.0.1:3334'] = process.argv.slice(2);
if (!logPath) {
    console.error('usage: verify-share-window.js <shares.jsonl> [api base]');
    process.exit(2);
}

function getJson(url) {
    return new Promise((resolve, reject) => {
        http.get(url, res => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => {
                try { resolve(JSON.parse(body)); } catch (e) { reject(new Error(`bad JSON from ${url}: ${body.slice(0, 200)}`)); }
            });
        }).on('error', reject);
    });
}

(async () => {
    const live = await getJson(`${apiBase}/api/splash/window`);
    const now = Date.parse(live.to);
    const fromBucket = live.fromBucket;
    const nowBucket = Math.floor(now / MINUTE_MS);

    const expected = new Map();
    let lines = 0, used = 0;
    for (const line of fs.readFileSync(logPath, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        lines++;
        const s = JSON.parse(line);
        const bucket = Math.floor(s.t / MINUTE_MS);
        if (s.t > now || bucket < fromBucket || bucket > nowBucket) continue;
        used++;
        const e = expected.get(s.address) ?? { difficulty: 0, shares: 0 };
        e.difficulty += s.difficulty;
        e.shares += 1;
        expected.set(s.address, e);
    }

    const liveMap = new Map(live.miners.map(m => [m.address, m]));
    const addresses = new Set([...expected.keys(), ...liveMap.keys()]);
    let bad = 0;
    for (const a of addresses) {
        const e = expected.get(a) ?? { difficulty: 0, shares: 0 };
        const l = liveMap.get(a) ?? { difficulty: 0, shares: 0 };
        const relErr = Math.abs(e.difficulty - l.difficulty) / Math.max(1, e.difficulty);
        const ok = e.shares === l.shares && relErr < 1e-9;
        if (!ok) bad++;
        console.log(`${ok ? 'OK  ' : 'DIFF'} ${a}  replay ${e.shares} shares / ${e.difficulty}  live ${l.shares} shares / ${l.difficulty}`);
    }
    console.log(`window ${live.from} -> ${live.to} (${live.windowHours}h), log lines ${lines}, in window ${used}, live total ${live.totalShares} shares`);
    if (bad) {
        console.log(`MISMATCH on ${bad} address(es)`);
        process.exit(1);
    }
    console.log('MATCH');
})().catch(e => { console.error(e); process.exit(2); });
