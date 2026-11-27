import { dec, decodeFrameHeader, difficultyToTarget, enc, frame, MSG, Reader, Sv2DecodeError, targetToDifficulty } from './codec';

// Frames built by, and parse results from, ESP-Miner v2.14.0's own
// components/stratum_v2/sv2_protocol.c, compiled on the host (see
// testdata/README.md). Firmware is GPL-3.0; only its outputs are kept here.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fw = require('./testdata/esp-miner-v2.14.0-codec.json');

const revive = (o: any): any => {
    if (typeof o === 'string' && /^[0-9a-f]*$/.test(o) && o.length % 2 === 0 && o.length > 0) return Buffer.from(o, 'hex');
    if (Array.isArray(o)) return o.map(revive);
    if (o && typeof o === 'object') return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, revive(v)]));
    return o;
};
const toJson = (o: any) => JSON.parse(JSON.stringify(o, (_k, v) => v && v.type === 'Buffer' ? Buffer.from(v.data).toString('hex') : typeof v === 'bigint' ? v.toString() : v));

describe('SV2 codec vs ESP-Miner v2.14.0', () => {
    it.each(Object.entries(fw.firmwareBuilt))('decodes the firmware-built %s and re-encodes it byte for byte', (type: string, v: any) => {
        const bytes = Buffer.from(v.frame, 'hex');
        const header = decodeFrameHeader(bytes.subarray(0, 6));
        expect(header).toEqual(v.header);
        expect(header.msgLength).toBe(bytes.length - 6);
        const msg = (dec as any)[type](bytes.subarray(6));
        expect(toJson(msg)).toEqual(v.decoded);
        expect((enc as any)[type](msg).toString('hex')).toBe(v.frame);
    });

    it.each(fw.firmwareParsed.map((c: any, i: number) => [i, c.type, c]))('frame %i (%s) is what the firmware parsed correctly', (_i, type: string, c: any) => {
        const input = revive(c.input);
        if (type === 'submitSharesSuccess') input.newSharesSum = BigInt(c.input.newSharesSum);
        if (type === 'submitSharesError') input.errorCode = c.input.errorCode;
        const bytes: Buffer = (enc as any)[type](input);
        expect(bytes.toString('hex')).toBe(c.frame);
        expect(c.firmware.ok).toBe(1);
        // Every field the firmware reports matches what we encoded.
        for (const [k, v] of Object.entries(c.firmware)) {
            if (['ok', 'pdiff', '_x'].includes(k)) continue;
            const ours = toJson(input)[k];
            if (k === 'minNtime' && type === 'newExtendedMiningJob') {
                // The firmware stores a missing ntime_start (future job) as 0.
                expect(v).toBe(c.input.minNtime ?? 0);
            } else if (k === 'minNtime' && c.input.minNtime == null) {
                expect(v).toBeNull();
            } else {
                expect(v).toEqual(ours);
            }
        }
        if (c.firmware.pdiff != null) {
            const t = Buffer.from(c.firmware.target ?? c.firmware.maximumTarget, 'hex');
            expect(c.firmware.pdiff).toBe(Math.floor(targetToDifficulty(t)));
        }
    });
});

describe('SV2 codec', () => {
    it('sets the channel_msg bit only on channel messages', () => {
        expect(decodeFrameHeader(enc.setTarget({ channelId: 1, maximumTarget: Buffer.alloc(32) }).subarray(0, 6)).extensionType).toBe(0x8000);
        expect(decodeFrameHeader(enc.setupConnectionSuccess({ usedVersion: 2, flags: 0 }).subarray(0, 6)).extensionType).toBe(0);
        expect(decodeFrameHeader(enc.openMiningChannelError({ requestId: 1, errorCode: 'x' }).subarray(0, 6)).extensionType).toBe(0);
    });

    it('round-trips every message', () => {
        const t = difficultyToTarget(1000);
        const samples: [keyof typeof enc, any][] = [
            ['setupConnection', { protocol: 0, minVersion: 2, maxVersion: 2, flags: 5, endpointHost: 'h', endpointPort: 3337, vendor: 'v', hardwareVersion: 'hw', firmware: 'fw', deviceId: 'id' }],
            ['setupConnectionError', { flags: 2, errorCode: 'unsupported-feature-flags' }],
            ['openStandardMiningChannel', { requestId: 9, userIdentity: 'a.b', nominalHashRate: Math.fround(1.5e12), maxTarget: t }],
            ['openExtendedMiningChannel', { requestId: 9, userIdentity: 'a.b', nominalHashRate: Math.fround(1.5e12), maxTarget: t, minExtranonceSize: 6 }],
            ['updateChannel', { channelId: 3, nominalHashRate: Math.fround(2e12), maxTarget: t }],
            ['updateChannelError', { channelId: 3, errorCode: 'invalid-channel-id' }],
            ['closeChannel', { channelId: 3, reasonCode: 'bye' }],
            ['submitSharesStandard', { channelId: 1, sequenceNumber: 2, jobId: 3, nonce: 0xffffffff, ntime: 5, version: 0x20000000 }],
            ['submitSharesExtended', { channelId: 1, sequenceNumber: 2, jobId: 3, nonce: 4, ntime: 5, version: 6, extranonce: Buffer.alloc(32, 7) }],
            ['submitSharesSuccess', { channelId: 1, lastSequenceNumber: 2, newSubmitsAcceptedCount: 3, newSharesSum: 2n ** 63n }],
        ];
        for (const [type, msg] of samples) {
            const f = (enc as any)[type](msg) as Buffer;
            const back = (dec as any)[type](f.subarray(6));
            expect(back).toEqual(msg);
        }
    });

    it('rejects malformed payloads', () => {
        const good = enc.submitSharesStandard({ channelId: 1, sequenceNumber: 2, jobId: 3, nonce: 4, ntime: 5, version: 6 }).subarray(6);
        expect(() => dec.submitSharesStandard(good.subarray(0, 23))).toThrow(Sv2DecodeError);          // short
        expect(() => dec.submitSharesStandard(Buffer.concat([good, Buffer.from([0])]))).toThrow(Sv2DecodeError); // trailing
        const ext = enc.submitSharesExtended({ channelId: 1, sequenceNumber: 2, jobId: 3, nonce: 4, ntime: 5, version: 6, extranonce: Buffer.alloc(8) }).subarray(6);
        const bad = Buffer.from(ext); bad[24] = 33;                                                       // B0_32 length 33
        expect(() => dec.submitSharesExtended(Buffer.concat([bad, Buffer.alloc(25)]))).toThrow(Sv2DecodeError);
        const job = enc.newMiningJob({ channelId: 1, jobId: 2, minNtime: null, version: 3, merkleRoot: Buffer.alloc(32) }).subarray(6);
        const badOpt = Buffer.from(job); badOpt[8] = 2;                                                     // OPTION tag 2
        expect(() => dec.newMiningJob(badOpt)).toThrow(Sv2DecodeError);
        const ej = enc.newExtendedMiningJob({ channelId: 1, jobId: 2, minNtime: null, version: 3, versionRollingAllowed: true, merklePath: [], coinbaseTxPrefix: Buffer.alloc(0), coinbaseTxSuffix: Buffer.alloc(0) }).subarray(6);
        const badBool = Buffer.from(ej); badBool[13] = 2;                                                   // BOOL 2
        expect(() => dec.newExtendedMiningJob(badBool)).toThrow(Sv2DecodeError);
        const oc = enc.openStandardMiningChannel({ requestId: 1, userIdentity: 'ab', nominalHashRate: 1, maxTarget: Buffer.alloc(32) }).subarray(6);
        const badUtf = Buffer.from(oc); badUtf[5] = 0xff;                                                   // invalid UTF-8
        expect(() => dec.openStandardMiningChannel(badUtf)).toThrow(Sv2DecodeError);
        expect(() => decodeFrameHeader(Buffer.alloc(5))).toThrow(Sv2DecodeError);
        expect(() => new Reader(Buffer.alloc(0)).u8()).toThrow(Sv2DecodeError);
    });

    it('refuses to encode values that do not fit', () => {
        expect(() => enc.submitSharesExtended({ channelId: 1, sequenceNumber: 2, jobId: 3, nonce: 4, ntime: 5, version: 6, extranonce: Buffer.alloc(33) })).toThrow();
        expect(() => enc.setupConnectionError({ flags: 0, errorCode: 'x'.repeat(256) })).toThrow();
        expect(() => frame(MSG.SetTarget, Buffer.alloc(0x1000000))).toThrow();
    });

    it('converts difficulty and target both ways', () => {
        // Difficulty 1 is the Bitcoin diff-1 target.
        expect(Buffer.from(difficultyToTarget(1)).reverse().toString('hex')).toBe('00000000ffff' + '0'.repeat(52));
        for (const d of [1e-9, 0.001, 1, 512, 1000, 65536, 1.5e9, 2 ** 53]) {
            expect(targetToDifficulty(difficultyToTarget(d)) / d).toBeCloseTo(1, 9);
        }
        // A target never gets easier than asked (higher target = easier).
        expect(targetToDifficulty(difficultyToTarget(512))).toBeGreaterThanOrEqual(512 * (1 - 1e-12));
        // Below ~2.33e-10 the target would pass 2^256: it is clamped to the maximum.
        expect(difficultyToTarget(1e-10).equals(Buffer.alloc(32, 0xff))).toBe(true);
        expect(() => difficultyToTarget(0)).toThrow();
        expect(() => difficultyToTarget(NaN)).toThrow();
    });
});
