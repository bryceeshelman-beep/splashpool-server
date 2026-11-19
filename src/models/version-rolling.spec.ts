import { bip310XorMask, VERSION_ROLLING_MASK } from './StratumV1Client';

describe('version rolling', () => {
    it('matches plain XOR when the job version has no bits inside the mask', () => {
        for (const bits of [0x0005c000, 0x1fffe000, 0x00002000]) {
            expect(bip310XorMask(0x20000000, bits)).toBe(bits);
        }
    });

    it('reads BIP310 bits as replacements when the job is signalling', () => {
        // Real Hammer share on a regtest job with version 0x30000000 (bit 28 signalling).
        const job = 0x30000000;
        const mask = bip310XorMask(job, 0x1005c000);
        expect(((job ^ mask) >>> 0).toString(16)).toBe('3005c000');
        // The XOR reading would have cleared bit 28 and hashed a different header.
        expect(((job ^ 0x1005c000) >>> 0).toString(16)).toBe('2005c000');
    });

    it('never changes bits outside the negotiated mask', () => {
        const job = 0x3fffffff;
        const v = (job ^ bip310XorMask(job, 0xffffffff)) >>> 0;
        expect((v & ~VERSION_ROLLING_MASK) >>> 0).toBe((job & ~VERSION_ROLLING_MASK) >>> 0);
    });
});
