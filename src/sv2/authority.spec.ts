import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { authorityFromSecret, decodeAuthorityPublicKey, encodeAuthorityPublicKey, generateAuthority, loadAuthorityFile, serializeAuthorityFile } from './authority';

describe('SV2 authority key', () => {
    // sv2-spec 4.7.1 test vector.
    const RAW = Buffer.from([118, 99, 112, 0, 151, 156, 28, 17, 175, 12, 48, 11, 205, 140, 127, 228, 134, 16, 252, 233, 185, 193, 30, 61, 174, 227, 90, 224, 176, 138, 116, 85]);
    const B58 = '9bXiEd8boQVhq7WddEcERUL5tyyJVFYdU8th3HfbNXK3Yw6GRXh';

    it('encodes the spec test vector', () => {
        expect(encodeAuthorityPublicKey(RAW)).toBe(B58);
        expect(decodeAuthorityPublicKey(B58).equals(RAW)).toBe(true);
    });

    it('decodes to exactly what the Bitaxe firmware expects: 38 bytes, prefix 01 00', () => {
        const k = generateAuthority();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const raw = Buffer.from(require('bs58').decode(k.base58));
        expect(raw.length).toBe(38);
        expect(raw[0]).toBe(1);
        expect(raw[1]).toBe(0);
        expect(raw.subarray(2, 34).equals(k.xonly)).toBe(true);
        // Fits AxeOS's 52-character field.
        expect(k.base58.length).toBeLessThanOrEqual(52);
    });

    it('rejects bad checksums, prefixes and lengths', () => {
        const flipped = B58.slice(0, -1) + (B58.endsWith('h') ? 'g' : 'h');
        expect(() => decodeAuthorityPublicKey(flipped)).toThrow();
        expect(() => decodeAuthorityPublicKey('1111')).toThrow('38');
        expect(() => authorityFromSecret(Buffer.alloc(32))).toThrow();
    });

    it('round-trips a key file, refuses one others can read, and catches a mismatched public key', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv2auth-'));
        try {
            const k = generateAuthority();
            const f = path.join(dir, 'a.key');
            fs.writeFileSync(f, serializeAuthorityFile(k), { mode: 0o600 });
            expect(loadAuthorityFile(f).base58).toBe(k.base58);
            fs.chmodSync(f, 0o644);
            expect(() => loadAuthorityFile(f)).toThrow('readable by others');
            fs.chmodSync(f, 0o600);
            const j = JSON.parse(fs.readFileSync(f, 'utf8'));
            j.public_key_base58 = generateAuthority().base58;
            fs.writeFileSync(f, JSON.stringify(j));
            expect(() => loadAuthorityFile(f)).toThrow('does not match');
            // The secret never appears in the public part.
            expect(serializeAuthorityFile(k)).toContain(k.secret.toString('hex'));
            expect(k.base58).not.toContain(k.secret.toString('hex'));
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
