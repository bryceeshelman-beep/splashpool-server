// The pool's Stratum V2 authority key: the long-lived key miners pin (AxeOS
// "Authority Public Key"), which signs the certificate for the server's Noise
// static key. sv2-spec 4.7: base58check( [1, 0] || 32-byte x-only key ).
//
// The secret lives in a key file (mode 0600, git-ignored), made by
// scripts/sv2-keygen.js. It is never logged.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as ecc from 'tiny-secp256k1';

// bs58 v5 is CommonJS.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const bs58: { encode(b: Uint8Array): string, decode(s: string): Uint8Array } = require('bs58');

const KEY_VERSION_PREFIX = Buffer.from([1, 0]);

export interface IAuthorityKey {
    secret: Buffer;
    /** 32-byte x-only public key. */
    xonly: Buffer;
    /** What miners paste: base58check of the version-prefixed x-only key. */
    base58: string;
}

function checksum(b: Buffer): Buffer {
    const h = crypto.createHash('sha256').update(crypto.createHash('sha256').update(b).digest()).digest();
    return h.subarray(0, 4);
}

export function encodeAuthorityPublicKey(xonly: Buffer): string {
    if (xonly.length !== 32) throw new Error('authority public key must be 32 bytes (x-only)');
    const body = Buffer.concat([KEY_VERSION_PREFIX, xonly]);
    return bs58.encode(Buffer.concat([body, checksum(body)]));
}

export function decodeAuthorityPublicKey(text: string): Buffer {
    const raw = Buffer.from(bs58.decode(text.trim()));
    if (raw.length !== 38) throw new Error(`authority public key decodes to ${raw.length} bytes, expected 38`);
    const body = raw.subarray(0, 34);
    if (!checksum(body).equals(raw.subarray(34))) throw new Error('authority public key checksum mismatch');
    if (!body.subarray(0, 2).equals(KEY_VERSION_PREFIX)) throw new Error('authority public key has an unknown version prefix');
    const xonly = Buffer.from(body.subarray(2));
    if (!ecc.isXOnlyPoint(xonly)) throw new Error('authority public key is not a valid secp256k1 x-only key');
    return xonly;
}

export function authorityFromSecret(secret: Buffer): IAuthorityKey {
    if (secret.length !== 32 || !ecc.isPrivate(secret)) throw new Error('authority secret is not a valid secp256k1 private key');
    const xonly = Buffer.from(ecc.xOnlyPointFromScalar(secret));
    return { secret: Buffer.from(secret), xonly, base58: encodeAuthorityPublicKey(xonly) };
}

export function generateAuthority(): IAuthorityKey {
    for (; ;) {
        const s = crypto.randomBytes(32);
        if (ecc.isPrivate(s)) return authorityFromSecret(s);
    }
}

/** Key file contents: JSON with the secret (hex) and, for reference, the public key. */
export function serializeAuthorityFile(k: IAuthorityKey): string {
    return JSON.stringify({ format: 'splash-sv2-authority-v1', secret_key_hex: k.secret.toString('hex'), public_key_base58: k.base58 }, null, 2) + '\n';
}

/**
 * Loads the key file. Refuses a file others can read or write, and checks the
 * stored public key matches the secret.
 */
export function loadAuthorityFile(path: string): IAuthorityKey {
    const st = fs.statSync(path);
    if ((st.mode & 0o077) !== 0) {
        throw new Error(`SV2 authority key file ${path} is readable by others (mode ${(st.mode & 0o777).toString(8)}); run chmod 600 on it`);
    }
    const j = JSON.parse(fs.readFileSync(path, 'utf8'));
    if (j.format !== 'splash-sv2-authority-v1' || typeof j.secret_key_hex !== 'string' || !/^[0-9a-f]{64}$/.test(j.secret_key_hex)) {
        throw new Error(`SV2 authority key file ${path} is not a splash-sv2-authority-v1 key file`);
    }
    const k = authorityFromSecret(Buffer.from(j.secret_key_hex, 'hex'));
    if (j.public_key_base58 != null && j.public_key_base58 !== k.base58) {
        throw new Error(`SV2 authority key file ${path}: public key does not match the secret`);
    }
    return k;
}
