// ElligatorSwift (BIP324) for the Stratum V2 Noise handshake.
//
// The curve work is done by @scure/btc-signer (paulmillr, built on
// @noble/curves); using it rather than hand-written field arithmetic follows
// the approach of the lido public-pool fork (github.com/KevinGuest/lido,
// GPL-3.0). This file only wraps it for SV2: 64-byte encodings on the wire,
// BIP324's tagged-hash x-only ECDH, and the responder side of the exchange.
// Tested against the BIP324 test vectors (ellswift.spec.ts).

// The package is ESM-only; Node 22.12+ loads it with require().
import { elligatorSwift } from '@scure/btc-signer/p2p.js';

export const ELLSWIFT_KEY_SIZE = 64;

export interface IEllSwiftKeypair {
    /** 32-byte secret scalar. */
    privateKey: Buffer;
    /** 64-byte ElligatorSwift encoding of the public key. */
    publicKey: Buffer;
}

/** A fresh random keypair, with its public key ElligatorSwift-encoded. */
export function ellswiftKeygen(): IEllSwiftKeypair {
    const kp = elligatorSwift.keygen();
    return { privateKey: Buffer.from(kp.privateKey), publicKey: Buffer.from(kp.publicKey) };
}

/** The x coordinate (32 bytes, big-endian) a 64-byte encoding stands for. */
export function ellswiftDecode(encoded: Uint8Array): Buffer {
    if (encoded.length !== ELLSWIFT_KEY_SIZE) {
        throw new Error(`ElligatorSwift key must be ${ELLSWIFT_KEY_SIZE} bytes, got ${encoded.length}`);
    }
    return Buffer.from(elligatorSwift.decode(encoded));
}

/**
 * BIP324 x-only ECDH: tagged_hash("bip324_ellswift_xonly_ecdh",
 * ell_initiator || ell_responder || x(priv * their_point)).
 * Both sides get the same 32 bytes; `initiating` says which side we are.
 */
export function ellswiftXdh(privOurs: Uint8Array, ellOurs: Uint8Array, ellTheirs: Uint8Array, initiating: boolean): Buffer {
    if (ellOurs.length !== ELLSWIFT_KEY_SIZE || ellTheirs.length !== ELLSWIFT_KEY_SIZE) {
        throw new Error('ElligatorSwift keys must be 64 bytes');
    }
    if (privOurs.length !== 32) {
        throw new Error('Private key must be 32 bytes');
    }
    return Buffer.from(elligatorSwift.getSharedSecretBip324(privOurs, ellTheirs, ellOurs, initiating));
}

/** For the BIP324 inverse-map test vectors only. */
export const _ellswiftInternals = {
    inv: (x: bigint, u: bigint, ellCase: number) => elligatorSwift._inv(x, u, ellCase),
};
