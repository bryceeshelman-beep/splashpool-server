// Noise_NX_Secp256k1+EllSwift_ChaChaPoly_SHA256, as Stratum V2 uses it
// (sv2-spec 04 "Protocol Security"), and the encrypted frame transport.
//
// Written from the spec and checked step by step against ESP-Miner's
// components/stratum_v2/sv2_noise.c (the Bitaxe initiator) and the lido
// public-pool fork's sv2-noise.ts (github.com/KevinGuest/lido, GPL-3.0).
// Unlike lido, nothing here ever logs key material.
//
//   -> e                       initiator ephemeral, 64 bytes
//   <- e, ee, s, es, payload   234 bytes: e (64) + enc(s) (64+16) + enc(cert) (74+16)
//
// Hashing, HMAC and ChaCha20-Poly1305 are Node's crypto; the curve work is
// ellswift.ts; certificate signatures are BIP340 via tiny-secp256k1.

import * as crypto from 'crypto';
import * as ecc from 'tiny-secp256k1';

import { decodeFrameHeader, IFrameHeader, SV2_FRAME_HEADER_SIZE } from './codec';
import { ELLSWIFT_KEY_SIZE, ellswiftDecode, ellswiftKeygen, ellswiftXdh, IEllSwiftKeypair } from './ellswift';

export const NOISE_PROTOCOL_NAME = 'Noise_NX_Secp256k1+EllSwift_ChaChaPoly_SHA256';
export const MAC_SIZE = 16;
export const CERT_SIZE = 74;                                          // version 2 + valid_from 4 + not_valid_after 4 + sig 64
export const ACT1_SIZE = ELLSWIFT_KEY_SIZE;                           // 64
export const ACT2_SIZE = ELLSWIFT_KEY_SIZE + (ELLSWIFT_KEY_SIZE + MAC_SIZE) + (CERT_SIZE + MAC_SIZE); // 234
export const ENCRYPTED_HEADER_SIZE = SV2_FRAME_HEADER_SIZE + MAC_SIZE; // 22
export const MAX_CT_LEN = 65535;
export const MAX_PT_CHUNK = MAX_CT_LEN - MAC_SIZE;                    // 65519

export class Sv2NoiseError extends Error { }

// ── Primitives ───────────────────────────────────────────────────────

export function sha256(...parts: Buffer[]): Buffer {
    const h = crypto.createHash('sha256');
    parts.forEach(p => h.update(p));
    return h.digest();
}

function hmac(key: Buffer, ...parts: Buffer[]): Buffer {
    const h = crypto.createHmac('sha256', key);
    parts.forEach(p => h.update(p));
    return h.digest();
}

/** Noise HKDF with two outputs. */
export function hkdf2(ck: Buffer, ikm: Buffer): [Buffer, Buffer] {
    const prk = hmac(ck, ikm);
    const out1 = hmac(prk, Buffer.from([0x01]));
    const out2 = hmac(prk, out1, Buffer.from([0x02]));
    return [out1, out2];
}

/** A ChaCha20-Poly1305 key with its nonce counter (4 zero bytes + u64 LE). */
export class CipherState {
    private n = 0n;
    constructor(private readonly k: Buffer) {
        if (k.length !== 32) throw new Error('cipher key must be 32 bytes');
    }

    private nonce(): Buffer {
        // 2^64 - 1 is reserved by Noise; nobody gets anywhere near it.
        if (this.n >= 0xffffffffffffffffn) throw new Sv2NoiseError('nonce exhausted');
        const b = Buffer.alloc(12);
        b.writeBigUInt64LE(this.n, 4);
        this.n++;
        return b;
    }

    encrypt(ad: Buffer, plaintext: Buffer): Buffer {
        const c = crypto.createCipheriv('chacha20-poly1305', this.k, this.nonce(), { authTagLength: MAC_SIZE });
        c.setAAD(ad, { plaintextLength: plaintext.length });
        return Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()]);
    }

    decrypt(ad: Buffer, ciphertext: Buffer): Buffer {
        if (ciphertext.length < MAC_SIZE) throw new Sv2NoiseError('ciphertext shorter than its MAC');
        const body = ciphertext.subarray(0, ciphertext.length - MAC_SIZE);
        const tag = ciphertext.subarray(ciphertext.length - MAC_SIZE);
        const d = crypto.createDecipheriv('chacha20-poly1305', this.k, this.nonce(), { authTagLength: MAC_SIZE });
        d.setAAD(ad, { plaintextLength: body.length });
        d.setAuthTag(tag);
        try {
            return Buffer.concat([d.update(body), d.final()]);
        } catch {
            throw new Sv2NoiseError('MAC check failed');
        }
    }
}

/** Noise SymmetricState (h, ck, and the handshake cipher). */
class SymmetricState {
    h: Buffer;
    ck: Buffer;
    private k: CipherState | null = null;

    constructor() {
        const name = Buffer.from(NOISE_PROTOCOL_NAME, 'ascii');
        // Longer than 32 bytes, so h = SHA-256(name).
        this.h = sha256(name);
        this.ck = Buffer.from(this.h);
        // MixHash(prologue): SV2's prologue is empty.
        this.mixHash(Buffer.alloc(0));
    }
    mixHash(data: Buffer) { this.h = sha256(this.h, data); }
    mixKey(ikm: Buffer) {
        const [ck, k] = hkdf2(this.ck, ikm);
        this.ck = ck;
        this.k = new CipherState(k);
    }
    encryptAndHash(pt: Buffer): Buffer {
        if (this.k == null) { this.mixHash(pt); return pt; }
        const ct = this.k.encrypt(this.h, pt);
        this.mixHash(ct);
        return ct;
    }
    decryptAndHash(ct: Buffer): Buffer {
        if (this.k == null) { this.mixHash(ct); return ct; }
        const pt = this.k.decrypt(this.h, ct);
        this.mixHash(ct);
        return pt;
    }
    /** (initiator->responder, responder->initiator) */
    split(): [Buffer, Buffer] {
        return hkdf2(this.ck, Buffer.alloc(0));
    }
}

// ── Certificate (SIGNATURE_NOISE_MESSAGE) ────────────────────────────

export interface ICertificate {
    version: number;
    validFrom: number;
    notValidAfter: number;
    signature: Buffer;
}

function certSigningHash(version: number, validFrom: number, notValidAfter: number, staticXOnly: Buffer): Buffer {
    const head = Buffer.alloc(10);
    head.writeUInt16LE(version, 0);
    head.writeUInt32LE(validFrom >>> 0, 2);
    head.writeUInt32LE(notValidAfter >>> 0, 6);
    return sha256(head, staticXOnly);
}

/** m = SHA-256(version || valid_from || not_valid_after || server_static_xonly), signed BIP340 by the authority. */
export function signCertificate(authoritySecret: Buffer, staticPublicEllSwift: Buffer, validFrom: number, notValidAfter: number): Buffer {
    const xonly = ellswiftDecode(staticPublicEllSwift);
    const m = certSigningHash(0, validFrom, notValidAfter, xonly);
    const sig = Buffer.from(ecc.signSchnorr(m, authoritySecret, crypto.randomBytes(32)));
    return serializeCertificate({ version: 0, validFrom, notValidAfter, signature: sig });
}

export function serializeCertificate(c: ICertificate): Buffer {
    const b = Buffer.alloc(CERT_SIZE);
    b.writeUInt16LE(c.version, 0);
    b.writeUInt32LE(c.validFrom >>> 0, 2);
    b.writeUInt32LE(c.notValidAfter >>> 0, 6);
    c.signature.copy(b, 10);
    return b;
}

export function parseCertificate(b: Buffer): ICertificate {
    if (b.length !== CERT_SIZE) throw new Sv2NoiseError(`certificate must be ${CERT_SIZE} bytes`);
    return { version: b.readUInt16LE(0), validFrom: b.readUInt32LE(2), notValidAfter: b.readUInt32LE(6), signature: Buffer.from(b.subarray(10)) };
}

/** What an SRI-style client checks: version 0, signature by the authority, and the validity window. */
export function verifyCertificate(cert: ICertificate, staticPublicEllSwift: Buffer, authorityXOnly: Buffer, nowSeconds: number): void {
    if (cert.version !== 0) throw new Sv2NoiseError(`unknown certificate version ${cert.version}`);
    const m = certSigningHash(cert.version, cert.validFrom, cert.notValidAfter, ellswiftDecode(staticPublicEllSwift));
    if (!ecc.verifySchnorr(m, authorityXOnly, cert.signature)) throw new Sv2NoiseError('certificate signature invalid');
    if (nowSeconds < cert.validFrom || nowSeconds > cert.notValidAfter) throw new Sv2NoiseError('certificate outside its validity window');
}

// ── Encrypted transport (both directions after the handshake) ────────

export interface IDecryptedFrame {
    header: IFrameHeader;
    payload: Buffer;
}

/** Ciphertext length of a payload: chunks of up to 65519 bytes, each with its MAC. */
export function encryptedPayloadLength(plaintextLength: number): number {
    if (plaintextLength === 0) return 0;
    return plaintextLength + MAC_SIZE * Math.ceil(plaintextLength / MAX_PT_CHUNK);
}

export class NoiseTransport {
    private buf: Buffer = Buffer.alloc(0);
    private pendingHeader: IFrameHeader | null = null;

    constructor(private readonly send: CipherState, private readonly recv: CipherState, private readonly maxPayload: number) { }

    /** Encrypts one plaintext frame (6-byte header + payload). */
    encryptFrame(plain: Buffer): Buffer {
        if (plain.length < SV2_FRAME_HEADER_SIZE) throw new Error('frame shorter than its header');
        const out: Buffer[] = [this.send.encrypt(Buffer.alloc(0), plain.subarray(0, SV2_FRAME_HEADER_SIZE))];
        const payload = plain.subarray(SV2_FRAME_HEADER_SIZE);
        for (let i = 0; i < payload.length; i += MAX_PT_CHUNK) {
            out.push(this.send.encrypt(Buffer.alloc(0), payload.subarray(i, i + MAX_PT_CHUNK)));
        }
        return Buffer.concat(out);
    }

    /** Adds received bytes; returns every frame now complete. Throws Sv2NoiseError on tampering or oversize. */
    push(data: Buffer): IDecryptedFrame[] {
        this.buf = this.buf.length === 0 ? data : Buffer.concat([this.buf, data]);
        const frames: IDecryptedFrame[] = [];
        for (; ;) {
            if (this.pendingHeader == null) {
                if (this.buf.length < ENCRYPTED_HEADER_SIZE) break;
                const header = decodeFrameHeader(this.recv.decrypt(Buffer.alloc(0), this.buf.subarray(0, ENCRYPTED_HEADER_SIZE)));
                this.buf = this.buf.subarray(ENCRYPTED_HEADER_SIZE);
                if (header.msgLength > this.maxPayload) {
                    throw new Sv2NoiseError(`frame payload ${header.msgLength} bytes > limit ${this.maxPayload}`);
                }
                this.pendingHeader = header;
            }
            const ctLen = encryptedPayloadLength(this.pendingHeader.msgLength);
            if (this.buf.length < ctLen) break;
            const parts: Buffer[] = [];
            let off = 0;
            while (off < ctLen) {
                const n = Math.min(MAX_CT_LEN, ctLen - off);
                parts.push(this.recv.decrypt(Buffer.alloc(0), this.buf.subarray(off, off + n)));
                off += n;
            }
            this.buf = this.buf.subarray(ctLen);
            frames.push({ header: this.pendingHeader, payload: Buffer.concat(parts) });
            this.pendingHeader = null;
        }
        return frames;
    }

    /** Bytes received but not yet a whole frame. */
    get buffered(): number {
        return this.buf.length;
    }
}

// ── Responder (the pool) ──────────────────────────────────────────────

/**
 * The pool's side. Feed it bytes; the first 64 are the initiator's ephemeral
 * key, after which it returns the 234-byte reply once, then frames.
 */
export class NoiseResponder {
    private act1: Buffer = Buffer.alloc(0);
    private transport: NoiseTransport | null = null;

    constructor(
        private readonly staticKey: IEllSwiftKeypair,
        private readonly certificate: Buffer,
        private readonly maxPayload: number
    ) {
        if (certificate.length !== CERT_SIZE) throw new Error(`certificate must be ${CERT_SIZE} bytes`);
    }

    get handshakeComplete(): boolean {
        return this.transport != null;
    }

    push(data: Buffer): { reply: Buffer | null, frames: IDecryptedFrame[] } {
        if (this.transport != null) {
            return { reply: null, frames: this.transport.push(data) };
        }
        this.act1 = Buffer.concat([this.act1, data]);
        if (this.act1.length < ACT1_SIZE) {
            return { reply: null, frames: [] };
        }
        const rest = this.act1.subarray(ACT1_SIZE);
        const reply = this.respond(this.act1.subarray(0, ACT1_SIZE));
        this.act1 = Buffer.alloc(0);
        // An initiator can't send a frame before it has our reply, so these are
        // junk at best; let the transport judge them (they fail the MAC).
        const frames = rest.length > 0 ? this.transport.push(rest) : [];
        return { reply, frames };
    }

    encryptFrame(plain: Buffer): Buffer {
        if (this.transport == null) throw new Error('handshake not complete');
        return this.transport.encryptFrame(plain);
    }

    private respond(re: Buffer): Buffer {
        const ss = new SymmetricState();
        // <- e (and its empty payload; no key yet, so just MixHash)
        ss.mixHash(re);
        ss.decryptAndHash(Buffer.alloc(0));
        // -> e
        const e = ellswiftKeygen();
        ss.mixHash(e.publicKey);
        // -> ee
        ss.mixKey(ellswiftXdh(e.privateKey, e.publicKey, re, false));
        // -> s
        const encStatic = ss.encryptAndHash(this.staticKey.publicKey);
        // -> es (our static with their ephemeral)
        ss.mixKey(ellswiftXdh(this.staticKey.privateKey, this.staticKey.publicKey, re, false));
        // -> payload: the certificate
        const encCert = ss.encryptAndHash(this.certificate);
        const [c1, c2] = ss.split();
        e.privateKey.fill(0);
        this.transport = new NoiseTransport(new CipherState(c2), new CipherState(c1), this.maxPayload);
        const reply = Buffer.concat([e.publicKey, encStatic, encCert]);
        if (reply.length !== ACT2_SIZE) throw new Error(`internal: reply is ${reply.length} bytes`);
        return reply;
    }
}

// ── Initiator (tests and the SV2 test client; mirrors the Bitaxe) ─────

export class NoiseInitiator {
    private readonly ss = new SymmetricState();
    private readonly e = ellswiftKeygen();
    private transport: NoiseTransport | null = null;
    public certificate: ICertificate | null = null;
    public serverStatic: Buffer | null = null;

    constructor(private readonly maxPayload = 1 << 20) { }

    act1(): Buffer {
        this.ss.mixHash(this.e.publicKey);
        this.ss.encryptAndHash(Buffer.alloc(0));
        return Buffer.from(this.e.publicKey);
    }

    /**
     * Processes the 234-byte reply. With an authority key, checks the
     * certificate as SRI does (signature and validity window); without one,
     * accepts any server, as AxeOS does when the key field is empty.
     */
    act2(reply: Buffer, authorityXOnly: Buffer | null, nowSeconds = Math.floor(Date.now() / 1000)): void {
        if (reply.length !== ACT2_SIZE) throw new Sv2NoiseError(`reply must be ${ACT2_SIZE} bytes, got ${reply.length}`);
        const re = reply.subarray(0, 64);
        this.ss.mixHash(re);
        this.ss.mixKey(ellswiftXdh(this.e.privateKey, this.e.publicKey, re, true));
        const rs = this.ss.decryptAndHash(reply.subarray(64, 144));
        this.ss.mixKey(ellswiftXdh(this.e.privateKey, this.e.publicKey, rs, true));
        const cert = parseCertificate(this.ss.decryptAndHash(reply.subarray(144, 234)));
        if (authorityXOnly != null) {
            verifyCertificate(cert, rs, authorityXOnly, nowSeconds);
        }
        const [c1, c2] = this.ss.split();
        this.e.privateKey.fill(0);
        this.certificate = cert;
        this.serverStatic = Buffer.from(rs);
        this.transport = new NoiseTransport(new CipherState(c1), new CipherState(c2), this.maxPayload);
    }

    encryptFrame(plain: Buffer): Buffer {
        if (this.transport == null) throw new Error('handshake not complete');
        return this.transport.encryptFrame(plain);
    }

    push(data: Buffer): IDecryptedFrame[] {
        if (this.transport == null) throw new Error('handshake not complete');
        return this.transport.push(data);
    }
}

/** For tests: the handshake hash right after initialisation, which the Bitaxe firmware checks. */
export function _initialHandshakeHash(): Buffer {
    return sha256(Buffer.from(NOISE_PROTOCOL_NAME, 'ascii'));
}
