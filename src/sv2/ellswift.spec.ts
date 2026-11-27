import * as fs from 'fs';
import * as path from 'path';

import { _ellswiftInternals, ellswiftDecode, ellswiftKeygen, ellswiftXdh } from './ellswift';

// Test vectors from BIP324 (github.com/bitcoin/bips/tree/master/bip-0324),
// BSD-3-Clause, copied unchanged into ./testdata.
function csv(name: string): Record<string, string>[] {
    const [head, ...rows] = fs.readFileSync(path.join(__dirname, 'testdata', name), 'utf8').trim().split('\n');
    const cols = head.split(',');
    return rows.map(r => {
        const cells = r.split(',');
        return Object.fromEntries(cols.map((c, i) => [c, cells[i] ?? '']));
    });
}
const hex = (s: string) => Buffer.from(s, 'hex');

describe('ElligatorSwift (BIP324 vectors)', () => {
    const decodeVectors = csv('ellswift_decode_test_vectors.csv');
    const invVectors = csv('xswiftec_inv_test_vectors.csv');
    const packetVectors = csv('packet_encoding_test_vectors.csv');

    it('has every vector', () => {
        expect(decodeVectors).toHaveLength(76);
        expect(invVectors).toHaveLength(32);
        expect(packetVectors).toHaveLength(7);
    });

    it.each(decodeVectors.map((v, i) => [i, v]))('decode vector %i', (_i, v: Record<string, string>) => {
        expect(ellswiftDecode(hex(v.ellswift)).toString('hex')).toBe(v.x);
    });

    it.each(invVectors.map((v, i) => [i, v]))('inverse map vector %i (all 8 cases)', (_i, v: Record<string, string>) => {
        const u = BigInt('0x' + v.u);
        const x = BigInt('0x' + v.x);
        for (let c = 0; c < 8; c++) {
            const expected = v[`case${c}_t`];
            const t = _ellswiftInternals.inv(x, u, c);
            if (expected === '') {
                expect(t).toBeUndefined();
            } else {
                expect((t as bigint).toString(16).padStart(64, '0')).toBe(expected);
                // And it decodes back to x.
                const enc = Buffer.concat([hex(v.u), hex(expected)]);
                expect(ellswiftDecode(enc).toString('hex')).toBe(v.x);
            }
        }
    });

    it.each(packetVectors.map((v, i) => [i, v]))('x-only ECDH shared secret, packet vector %i', (_i, v: Record<string, string>) => {
        const initiating = v.in_initiating === '1';
        const secret = ellswiftXdh(hex(v.in_priv_ours), hex(v.in_ellswift_ours), hex(v.in_ellswift_theirs), initiating);
        expect(secret.toString('hex')).toBe(v.mid_shared_secret);
        // The decoded x of both keys matches the vector's intermediate values.
        expect(ellswiftDecode(hex(v.in_ellswift_ours)).toString('hex')).toBe(v.mid_x_ours);
        expect(ellswiftDecode(hex(v.in_ellswift_theirs)).toString('hex')).toBe(v.mid_x_theirs);
    });

    it('both sides of a fresh exchange agree, and the role bit matters', () => {
        for (let i = 0; i < 20; i++) {
            const a = ellswiftKeygen();
            const b = ellswiftKeygen();
            const sa = ellswiftXdh(a.privateKey, a.publicKey, b.publicKey, true);
            const sb = ellswiftXdh(b.privateKey, b.publicKey, a.publicKey, false);
            expect(sa.equals(sb)).toBe(true);
            // Same roles on both sides give different secrets (hash order differs).
            expect(ellswiftXdh(b.privateKey, b.publicKey, a.publicKey, true).equals(sa)).toBe(false);
        }
    });

    it('rejects wrong sizes', () => {
        const a = ellswiftKeygen();
        expect(() => ellswiftDecode(Buffer.alloc(63))).toThrow();
        expect(() => ellswiftXdh(a.privateKey, a.publicKey, Buffer.alloc(65), false)).toThrow();
        expect(() => ellswiftXdh(Buffer.alloc(31), a.publicKey, a.publicKey, false)).toThrow();
    });
});
