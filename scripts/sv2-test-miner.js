#!/usr/bin/env node
// A minimal Stratum V2 miner for regtest tests (scripts/regtest-payout-test.py
// case J). Connects, checks the pool's certificate against the authority key,
// opens a standard or extended channel, waits for a job on the given tip and
// mines a BLOCK for it (on regtest a CPU finds one in a few hashes), submits
// it, and prints one JSON line with the outcome.
//
// It hashes to the network target, not the channel target: the channel
// difficulty is at least 1, far above regtest's ~4.7e-10, so on regtest every
// accepted SV2 share is a block anyway.
//
//   node scripts/sv2-test-miner.js --dist <pool dist dir> --port <sv2 port>
//       --authority <base58 key> --user <address.worker>
//       --channel standard|extended --tip <block hash hex> [--timeout 30]
'use strict';
const crypto = require('crypto');
const net = require('net');
const path = require('path');

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
for (const k of ['dist', 'port', 'authority', 'user', 'channel', 'tip']) {
    if (!args[k]) { console.error(`missing --${k}`); process.exit(2); }
}
const dist = path.resolve(args.dist);
const { NoiseInitiator, ACT2_SIZE } = require(path.join(dist, 'sv2', 'noise'));
const { enc, dec, MSG } = require(path.join(dist, 'sv2', 'codec'));
const { decodeAuthorityPublicKey } = require(path.join(dist, 'sv2', 'authority'));

const extended = args.channel === 'extended';
const wantPrev = Buffer.from(args.tip, 'hex').reverse(); // header (internal) byte order
const dsha = b => crypto.createHash('sha256').update(crypto.createHash('sha256').update(b).digest()).digest();
const out = r => { console.log(JSON.stringify(r)); process.exit(r.result === 'ok' ? 0 : 1); };
setTimeout(() => out({ result: 'timeout' }), 1000 * Number(args.timeout || 30)).unref();

const noise = new NoiseInitiator();
const sock = net.connect(Number(args.port), args.host || '127.0.0.1');
let buf = Buffer.alloc(0), handshaken = false;
const send = f => sock.write(noise.encryptFrame(f));

let channelId = null, enPrefix = null, enSize = 0, userAgentSent = null;
const jobs = new Map();
let submitted = null;

sock.on('connect', () => sock.write(noise.act1()));
sock.on('error', e => out({ result: 'socket-error', error: e.message }));
sock.on('close', () => out({ result: 'closed' }));
sock.on('data', d => {
    buf = Buffer.concat([buf, d]);
    if (!handshaken) {
        if (buf.length < ACT2_SIZE) return;
        try {
            noise.act2(buf.subarray(0, ACT2_SIZE), decodeAuthorityPublicKey(args.authority));
        } catch (e) {
            return out({ result: 'handshake-failed', error: e.message });
        }
        handshaken = true;
        const rest = buf.subarray(ACT2_SIZE);
        buf = Buffer.alloc(0);
        userAgentSent = 'splash-regtest/sv2-test-miner';
        send(enc.setupConnection({
            protocol: 0, minVersion: 2, maxVersion: 2, flags: extended ? 0 : 1, endpointHost: '127.0.0.1', endpointPort: Number(args.port),
            vendor: 'splash-regtest', hardwareVersion: 'sv2-test-miner', firmware: '', deviceId: '',
        }));
        if (rest.length === 0) return;
        d = rest;
    } else {
        d = buf; buf = Buffer.alloc(0);
    }
    for (const f of noise.push(d)) handle(f.header.msgType, f.payload);
});

function handle(type, p) {
    switch (type) {
        case MSG.SetupConnectionSuccess: {
            const m = { requestId: 1, userIdentity: args.user, nominalHashRate: 1e9, maxTarget: Buffer.alloc(32, 0xff) };
            send(extended ? enc.openExtendedMiningChannel({ ...m, minExtranonceSize: 8 }) : enc.openStandardMiningChannel(m));
            break;
        }
        case MSG.SetupConnectionError: return out({ result: 'setup-error', code: dec.setupConnectionError(p).errorCode });
        case MSG.OpenMiningChannelError: return out({ result: 'open-error', code: dec.openMiningChannelError(p).errorCode });
        case MSG.OpenStandardMiningChannelSuccess: {
            const m = dec.openStandardMiningChannelSuccess(p);
            channelId = m.channelId; enPrefix = m.extranoncePrefix;
            break;
        }
        case MSG.OpenExtendedMiningChannelSuccess: {
            const m = dec.openExtendedMiningChannelSuccess(p);
            channelId = m.channelId; enPrefix = m.extranoncePrefix; enSize = m.extranonceSize;
            break;
        }
        case MSG.NewMiningJob: { const j = dec.newMiningJob(p); jobs.set(j.jobId, j); break; }
        case MSG.NewExtendedMiningJob: { const j = dec.newExtendedMiningJob(p); jobs.set(j.jobId, j); break; }
        case MSG.SetNewPrevHash: {
            const m = dec.setNewPrevHash(p);
            if (submitted || !m.prevHash.equals(wantPrev)) break; // not the tip we were asked to mine on yet
            const job = jobs.get(m.jobId);
            if (job) mine(job, m);
            break;
        }
        case MSG.SubmitSharesSuccess: {
            const m = dec.submitSharesSuccess(p);
            return out({ result: 'ok', blockHash: submitted.hash, channel: args.channel, channelId, credited: Number(m.newSharesSum),
                extranoncePrefix: enPrefix.toString('hex'), extranonceSize: enSize, userAgent: userAgentSent });
        }
        case MSG.SubmitSharesError: return out({ result: 'rejected', code: dec.submitSharesError(p).errorCode, blockHash: submitted?.hash });
        default: break;
    }
}

function mine(job, prev) {
    let root;
    let extranonce = null;
    if (extended) {
        extranonce = crypto.randomBytes(enSize);
        root = dsha(Buffer.concat([job.coinbaseTxPrefix, enPrefix, extranonce, job.coinbaseTxSuffix]));
        for (const b of job.merklePath) root = dsha(Buffer.concat([root, b]));
    } else {
        root = job.merkleRoot;
    }
    const bits = prev.nbits >>> 0;
    const target = BigInt(bits & 0xffffff) << BigInt(8 * ((bits >>> 24) - 3));
    const ntime = prev.minNtime;
    const h = Buffer.alloc(80);
    h.writeUInt32LE(job.version >>> 0, 0); prev.prevHash.copy(h, 4); root.copy(h, 36);
    h.writeUInt32LE(ntime, 68); h.writeUInt32LE(bits, 72);
    for (let nonce = 0; nonce < 0xffffffff; nonce++) {
        h.writeUInt32LE(nonce, 76);
        const hash = dsha(h);
        if (BigInt('0x' + Buffer.from(hash).reverse().toString('hex')) <= target) {
            submitted = { hash: Buffer.from(hash).reverse().toString('hex') };
            const m = { channelId, sequenceNumber: 1, jobId: job.jobId, nonce, ntime, version: job.version >>> 0 };
            send(extended ? enc.submitSharesExtended({ ...m, extranonce }) : enc.submitSharesStandard(m));
            return;
        }
    }
}
