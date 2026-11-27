import * as crypto from 'crypto';
import * as ecc from 'tiny-secp256k1';

import { enc, frame, MSG } from './codec';
import { ellswiftDecode, ellswiftKeygen } from './ellswift';
import {
    _initialHandshakeHash, ACT1_SIZE, ACT2_SIZE, CERT_SIZE, CipherState, encryptedPayloadLength, MAX_PT_CHUNK, NoiseInitiator, NoiseResponder,
    parseCertificate, serializeCertificate, signCertificate, Sv2NoiseError, verifyCertificate,
} from './noise';

function authority() {
    let secret: Buffer;
    do { secret = crypto.randomBytes(32); } while (!ecc.isPrivate(secret));
    return { secret, xonly: Buffer.from(ecc.xOnlyPointFromScalar(secret)) };
}

const NOW = 1_800_000_000;

function setup(opts: { validFrom?: number, notValidAfter?: number, maxPayload?: number } = {}) {
    const auth = authority();
    const staticKey = ellswiftKeygen();
    const cert = signCertificate(auth.secret, staticKey.publicKey, opts.validFrom ?? NOW - 3600, opts.notValidAfter ?? NOW + 3600);
    const responder = new NoiseResponder(staticKey, cert, opts.maxPayload ?? 16384);
    const initiator = new NoiseInitiator();
    return { auth, staticKey, cert, responder, initiator };
}

function handshake(opts = {}) {
    const s = setup(opts);
    const { reply, frames } = s.responder.push(s.initiator.act1());
    expect(frames).toEqual([]);
    s.initiator.act2(reply, s.auth.xonly, NOW);
    return s;
}

describe('Noise NX handshake', () => {
    it('starts from the hash the Bitaxe firmware hard-codes', () => {
        // ESP-Miner sv2_noise.c expected_h, for SHA-256 of the protocol name.
        const expected = Buffer.from([46, 180, 120, 129, 32, 142, 158, 238, 31, 102, 159, 103, 198, 110, 231, 14,
            169, 234, 136, 9, 13, 80, 63, 232, 48, 220, 75, 200, 62, 41, 191, 16]);
        expect(_initialHandshakeHash().equals(expected)).toBe(true);
    });

    it('completes, with a 234-byte reply, and both directions work', () => {
        const s = setup();
        const act1 = s.initiator.act1();
        expect(act1.length).toBe(ACT1_SIZE);
        const { reply } = s.responder.push(act1);
        expect(reply.length).toBe(ACT2_SIZE);
        s.initiator.act2(reply, s.auth.xonly, NOW);
        expect(s.responder.handshakeComplete).toBe(true);
        expect(s.initiator.serverStatic.equals(s.staticKey.publicKey)).toBe(true);

        const up = enc.setupConnection({ protocol: 0, minVersion: 2, maxVersion: 2, flags: 1, endpointHost: 'h', endpointPort: 3337, vendor: 'bitaxe', hardwareVersion: 'BM1370', firmware: '', deviceId: '' });
        const got = s.responder.push(s.initiator.encryptFrame(up)).frames;
        expect(got).toHaveLength(1);
        expect(got[0].header.msgType).toBe(MSG.SetupConnection);
        expect(got[0].payload.equals(up.subarray(6))).toBe(true);

        const down = enc.setupConnectionSuccess({ usedVersion: 2, flags: 0 });
        const back = s.initiator.push(s.responder.encryptFrame(down));
        expect(back).toHaveLength(1);
        expect(back[0].payload.equals(down.subarray(6))).toBe(true);
    });

    it('takes the ephemeral key in pieces, then frames delivered one byte at a time', () => {
        const s = setup();
        const act1 = s.initiator.act1();
        let reply: Buffer = null;
        for (let i = 0; i < act1.length; i++) {
            const r = s.responder.push(act1.subarray(i, i + 1));
            if (i < act1.length - 1) expect(r.reply).toBeNull(); else reply = r.reply;
        }
        s.initiator.act2(reply, s.auth.xonly, NOW);
        const msgs = [1, 2, 3].map(i => enc.closeChannel({ channelId: i, reasonCode: 'x'.repeat(i) }));
        const wire = Buffer.concat(msgs.map(m => s.initiator.encryptFrame(m)));
        const got = [];
        for (let i = 0; i < wire.length; i++) got.push(...s.responder.push(wire.subarray(i, i + 1)).frames);
        expect(got.map(f => f.payload.toString('hex'))).toEqual(msgs.map(m => m.subarray(6).toString('hex')));
    });

    it('verifies without an authority key too (AxeOS with the key field empty)', () => {
        const s = setup();
        s.initiator.act2(s.responder.push(s.initiator.act1()).reply, null, NOW);
        expect(s.initiator.certificate.version).toBe(0);
    });

    it('signs the certificate the way the firmware checks it', () => {
        const { cert, staticKey, auth } = setup();
        const c = parseCertificate(cert);
        expect(cert.length).toBe(CERT_SIZE);
        expect(c.version).toBe(0);
        // Firmware: sha256(first 10 bytes of the message || xonly(decoded static key)), BIP340 by the authority.
        const m = crypto.createHash('sha256').update(cert.subarray(0, 10)).update(ellswiftDecode(staticKey.publicKey)).digest();
        expect(ecc.verifySchnorr(m, auth.xonly, c.signature)).toBe(true);
    });
});

describe('Noise tampering', () => {
    it('rejects a reply with ANY single byte changed (all 234 positions)', () => {
        const s = setup();
        const act1 = s.initiator.act1();
        const reply = s.responder.push(act1).reply;
        for (let i = 0; i < ACT2_SIZE; i++) {
            // A fresh initiator with the same ephemeral each time.
            const tampered = Buffer.from(reply);
            tampered[i] ^= 0x01;
            // Rebuild an initiator state that has sent the same act1.
            const ini = new NoiseInitiator();
            (ini as any).e = { privateKey: Buffer.from((s.initiator as any).e.privateKey), publicKey: Buffer.from((s.initiator as any).e.publicKey) };
            ini.act1();
            expect(() => ini.act2(tampered, s.auth.xonly, NOW)).toThrow(Sv2NoiseError);
        }
        // And the untampered reply still works with that same ephemeral.
        const ok = new NoiseInitiator();
        (ok as any).e = { privateKey: Buffer.from((s.initiator as any).e.privateKey), publicKey: Buffer.from((s.initiator as any).e.publicKey) };
        ok.act1();
        expect(() => ok.act2(reply, s.auth.xonly, NOW)).not.toThrow();
    });

    it('a changed ephemeral key (act 1) leaves the client unable to read the reply', () => {
        const s = setup();
        const act1 = s.initiator.act1();
        const bad = Buffer.from(act1); bad[10] ^= 0x80;
        const reply = s.responder.push(bad).reply;
        expect(() => s.initiator.act2(reply, s.auth.xonly, NOW)).toThrow(Sv2NoiseError);
    });

    it('rejects a certificate from another authority, of the wrong version, or outside its window', () => {
        expect(() => { const s = setup(); s.initiator.act2(s.responder.push(s.initiator.act1()).reply, authority().xonly, NOW); }).toThrow('certificate signature invalid');
        expect(() => handshake({ validFrom: NOW + 10, notValidAfter: NOW + 100 })).toThrow('validity window');
        expect(() => handshake({ validFrom: NOW - 100, notValidAfter: NOW - 1 })).toThrow('validity window');
        const { staticKey, auth } = setup();
        const c = parseCertificate(signCertificate(auth.secret, staticKey.publicKey, NOW - 1, NOW + 1));
        expect(() => verifyCertificate({ ...c, version: 1 }, staticKey.publicKey, auth.xonly, NOW)).toThrow('version');
        // A valid signature, but over a different static key.
        expect(() => verifyCertificate(c, ellswiftKeygen().publicKey, auth.xonly, NOW)).toThrow('signature invalid');
        // Changing the window after signing breaks the signature.
        expect(() => verifyCertificate({ ...c, notValidAfter: c.notValidAfter + 1 }, staticKey.publicKey, auth.xonly, NOW)).toThrow('signature invalid');
        expect(serializeCertificate(c).length).toBe(CERT_SIZE);
    });

    it('rejects a frame with any byte changed, header or payload', () => {
        const msg = enc.submitSharesStandard({ channelId: 1, sequenceNumber: 2, jobId: 3, nonce: 4, ntime: 5, version: 6 });
        const probe = handshake();
        const len = probe.initiator.encryptFrame(msg).length;
        for (let i = 0; i < len; i++) {
            const s = handshake();
            const wire = s.initiator.encryptFrame(msg);
            wire[i] ^= 0x01;
            expect(() => s.responder.push(wire)).toThrow(Sv2NoiseError);
        }
    });

    it('rejects replayed, reordered and dropped frames', () => {
        const a = enc.closeChannel({ channelId: 1, reasonCode: 'a' });
        const b = enc.closeChannel({ channelId: 2, reasonCode: 'b' });
        let s = handshake();
        const wa = s.initiator.encryptFrame(a);
        s.responder.push(wa);
        expect(() => s.responder.push(wa)).toThrow(Sv2NoiseError);               // replay
        s = handshake();
        const wa2 = s.initiator.encryptFrame(a);
        const wb2 = s.initiator.encryptFrame(b);
        expect(() => s.responder.push(wb2)).toThrow(Sv2NoiseError);              // reordered / a dropped
        void wa2;
    });

    it('rejects a frame from another session (wrong keys)', () => {
        const s1 = handshake();
        const s2 = handshake();
        expect(() => s2.responder.push(s1.initiator.encryptFrame(enc.setTarget({ channelId: 1, maximumTarget: Buffer.alloc(32) })))).toThrow(Sv2NoiseError);
    });

    it('refuses a declared payload over the limit before reading it', () => {
        const s = handshake({ maxPayload: 100 });
        const big = frame(MSG.CloseChannel, Buffer.alloc(101));
        const wire = s.initiator.encryptFrame(big);
        // Just the 22-byte header is enough to refuse it.
        expect(() => s.responder.push(wire.subarray(0, 22))).toThrow('limit');
    });

    it('rejects random junk instead of a handshake reply, and junk after the ephemeral key', () => {
        const s = setup();
        s.initiator.act1();
        expect(() => s.initiator.act2(crypto.randomBytes(ACT2_SIZE), s.auth.xonly, NOW)).toThrow(Sv2NoiseError);
        expect(() => s.initiator.act2(crypto.randomBytes(ACT2_SIZE - 1), s.auth.xonly, NOW)).toThrow(Sv2NoiseError);
        const s2 = setup();
        expect(() => s2.responder.push(Buffer.concat([s2.initiator.act1(), crypto.randomBytes(40)]))).toThrow(Sv2NoiseError);
    });
});

describe('Noise transport details', () => {
    it('splits payloads over 65519 bytes into chunks, each with a MAC', () => {
        expect(encryptedPayloadLength(0)).toBe(0);
        expect(encryptedPayloadLength(1)).toBe(17);
        expect(encryptedPayloadLength(MAX_PT_CHUNK)).toBe(65535);
        expect(encryptedPayloadLength(MAX_PT_CHUNK + 1)).toBe(65535 + 17);
        const s = handshake({ maxPayload: 200000 });
        const payload = crypto.randomBytes(150000);
        const big = Buffer.concat([Buffer.from([0, 0, MSG.CloseChannel, 150000 & 0xff, (150000 >> 8) & 0xff, 150000 >> 16]), payload]);
        const wire = s.responder.encryptFrame(big);
        expect(wire.length).toBe(22 + encryptedPayloadLength(150000));
        const got = s.initiator.push(wire);
        expect(got[0].payload.equals(payload)).toBe(true);
    });

    it('uses the 4-zero-byte + little-endian counter nonce', () => {
        const key = crypto.randomBytes(32);
        const cs = new CipherState(key);
        cs.encrypt(Buffer.alloc(0), Buffer.from('a'));
        const second = cs.encrypt(Buffer.alloc(0), Buffer.from('hello'));
        const nonce = Buffer.alloc(12); nonce.writeBigUInt64LE(1n, 4);
        const c = crypto.createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
        const expected = Buffer.concat([c.update(Buffer.from('hello')), c.final(), c.getAuthTag()]);
        expect(second.equals(expected)).toBe(true);
    });
});
