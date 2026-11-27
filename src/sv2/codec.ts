// Stratum V2 binary encoding (sv2-spec 03 "Data Types" and "Framing", 05
// Mining Protocol). Little-endian throughout. Decoding is strict: running
// past the end, a length over the type's limit, a BOOL or OPTION tag other
// than 0/1, and trailing bytes are all errors, since no honest client sends
// them.

export const SV2_FRAME_HEADER_SIZE = 6;
export const CHANNEL_MSG_BIT = 0x8000;

export const MSG = {
    SetupConnection: 0x00,
    SetupConnectionSuccess: 0x01,
    SetupConnectionError: 0x02,
    OpenStandardMiningChannel: 0x10,
    OpenStandardMiningChannelSuccess: 0x11,
    OpenMiningChannelError: 0x12,
    OpenExtendedMiningChannel: 0x13,
    OpenExtendedMiningChannelSuccess: 0x14,
    NewMiningJob: 0x15,
    UpdateChannel: 0x16,
    UpdateChannelError: 0x17,
    CloseChannel: 0x18,
    SetExtranoncePrefix: 0x19,
    SubmitSharesStandard: 0x1a,
    SubmitSharesExtended: 0x1b,
    SubmitSharesSuccess: 0x1c,
    SubmitSharesError: 0x1d,
    NewExtendedMiningJob: 0x1f,
    SetNewPrevHash: 0x20,
    SetTarget: 0x21,
    SetCustomMiningJob: 0x22,
} as const;

// sv2-spec 08: messages sent over a channel carry the channel_msg bit.
const CHANNEL_MESSAGES = new Set<number>([
    MSG.NewMiningJob, MSG.UpdateChannel, MSG.UpdateChannelError, MSG.CloseChannel,
    MSG.SetExtranoncePrefix, MSG.SubmitSharesStandard, MSG.SubmitSharesExtended,
    MSG.SubmitSharesSuccess, MSG.SubmitSharesError, MSG.NewExtendedMiningJob,
    MSG.SetNewPrevHash, MSG.SetTarget, MSG.SetCustomMiningJob,
]);

export function isChannelMessage(msgType: number): boolean {
    return CHANNEL_MESSAGES.has(msgType);
}

export class Sv2DecodeError extends Error { }

// ── Primitive writer / reader ───────────────────────────────────────

export class Writer {
    private parts: Buffer[] = [];

    u8(v: number) { const b = Buffer.alloc(1); b.writeUInt8(v); this.parts.push(b); return this; }
    u16(v: number) { const b = Buffer.alloc(2); b.writeUInt16LE(v); this.parts.push(b); return this; }
    u24(v: number) { const b = Buffer.alloc(3); b.writeUIntLE(v, 0, 3); this.parts.push(b); return this; }
    u32(v: number) { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); this.parts.push(b); return this; }
    u64(v: bigint) { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); this.parts.push(b); return this; }
    f32(v: number) { const b = Buffer.alloc(4); b.writeFloatLE(v); this.parts.push(b); return this; }
    bool(v: boolean) { return this.u8(v ? 1 : 0); }
    u256(v: Buffer) {
        if (v.length !== 32) throw new Error(`U256 must be 32 bytes, got ${v.length}`);
        this.parts.push(Buffer.from(v));
        return this;
    }
    private bytes(v: Buffer, lenBytes: 1 | 2, max: number, type: string) {
        if (v.length > max) throw new Error(`${type} too long: ${v.length} > ${max}`);
        if (lenBytes === 1) this.u8(v.length); else this.u16(v.length);
        this.parts.push(Buffer.from(v));
        return this;
    }
    str0_255(s: string) { return this.bytes(Buffer.from(s, 'utf8'), 1, 255, 'STR0_255'); }
    b0_32(v: Buffer) { return this.bytes(v, 1, 32, 'B0_32'); }
    b0_255(v: Buffer) { return this.bytes(v, 1, 255, 'B0_255'); }
    b0_64k(v: Buffer) { return this.bytes(v, 2, 65535, 'B0_64K'); }
    seq0_255_u256(list: Buffer[]) {
        if (list.length > 255) throw new Error(`SEQ0_255 too long: ${list.length}`);
        this.u8(list.length);
        list.forEach(x => this.u256(x));
        return this;
    }
    optionU32(v: number | null) {
        if (v == null) return this.u8(0);
        return this.u8(1).u32(v);
    }
    build(): Buffer { return Buffer.concat(this.parts); }
}

export class Reader {
    private pos = 0;
    constructor(private readonly buf: Buffer) { }

    private take(n: number): Buffer {
        if (this.pos + n > this.buf.length) {
            throw new Sv2DecodeError(`message too short: need ${n} bytes at offset ${this.pos}, have ${this.buf.length - this.pos}`);
        }
        const out = this.buf.subarray(this.pos, this.pos + n);
        this.pos += n;
        return out;
    }
    u8() { return this.take(1).readUInt8(0); }
    u16() { return this.take(2).readUInt16LE(0); }
    u24() { return this.take(3).readUIntLE(0, 3); }
    u32() { return this.take(4).readUInt32LE(0); }
    u64() { return this.take(8).readBigUInt64LE(0); }
    f32() { return this.take(4).readFloatLE(0); }
    bool() {
        const v = this.u8();
        if (v > 1) throw new Sv2DecodeError(`invalid BOOL ${v}`);
        return v === 1;
    }
    u256() { return Buffer.from(this.take(32)); }
    private bytes(lenBytes: 1 | 2, max: number, type: string) {
        const n = lenBytes === 1 ? this.u8() : this.u16();
        if (n > max) throw new Sv2DecodeError(`${type} length ${n} > ${max}`);
        return Buffer.from(this.take(n));
    }
    str0_255() {
        const b = this.bytes(1, 255, 'STR0_255');
        const s = b.toString('utf8');
        // Must be valid UTF-8 (spec); reject replacement-char round trips.
        if (!Buffer.from(s, 'utf8').equals(b)) throw new Sv2DecodeError('STR0_255 is not valid UTF-8');
        return s;
    }
    b0_32() { return this.bytes(1, 32, 'B0_32'); }
    b0_255() { return this.bytes(1, 255, 'B0_255'); }
    b0_64k() { return this.bytes(2, 65535, 'B0_64K'); }
    seq0_255_u256() {
        const n = this.u8();
        const out: Buffer[] = [];
        for (let i = 0; i < n; i++) out.push(this.u256());
        return out;
    }
    optionU32(): number | null {
        const tag = this.u8();
        if (tag === 0) return null;
        if (tag !== 1) throw new Sv2DecodeError(`invalid OPTION tag ${tag}`);
        return this.u32();
    }
    end() {
        if (this.pos !== this.buf.length) {
            throw new Sv2DecodeError(`${this.buf.length - this.pos} trailing bytes`);
        }
    }
}

// ── Frame header ─────────────────────────────────────────────────────

export interface IFrameHeader {
    extensionType: number;
    msgType: number;
    msgLength: number;
}

export function encodeFrameHeader(h: IFrameHeader): Buffer {
    if (h.msgLength > 0xffffff) throw new Error(`message too long: ${h.msgLength}`);
    return new Writer().u16(h.extensionType).u8(h.msgType).u24(h.msgLength).build();
}

export function decodeFrameHeader(b: Buffer): IFrameHeader {
    if (b.length !== SV2_FRAME_HEADER_SIZE) throw new Sv2DecodeError(`frame header must be 6 bytes, got ${b.length}`);
    const r = new Reader(b);
    return { extensionType: r.u16(), msgType: r.u8(), msgLength: r.u24() };
}

/** A whole plaintext frame: header + payload, channel_msg bit set as the spec says. */
export function frame(msgType: number, payload: Buffer): Buffer {
    const extensionType = isChannelMessage(msgType) ? CHANNEL_MSG_BIT : 0;
    return Buffer.concat([encodeFrameHeader({ extensionType, msgType, msgLength: payload.length }), payload]);
}

// ── Messages ─────────────────────────────────────────────────────────

export interface SetupConnection {
    protocol: number; minVersion: number; maxVersion: number; flags: number;
    endpointHost: string; endpointPort: number;
    vendor: string; hardwareVersion: string; firmware: string; deviceId: string;
}
export interface SetupConnectionSuccess { usedVersion: number; flags: number; }
export interface SetupConnectionError { flags: number; errorCode: string; }
export interface OpenStandardMiningChannel { requestId: number; userIdentity: string; nominalHashRate: number; maxTarget: Buffer; }
export interface OpenExtendedMiningChannel extends OpenStandardMiningChannel { minExtranonceSize: number; }
export interface OpenStandardMiningChannelSuccess { requestId: number; channelId: number; target: Buffer; extranoncePrefix: Buffer; groupChannelId: number; }
export interface OpenExtendedMiningChannelSuccess { requestId: number; channelId: number; target: Buffer; extranonceSize: number; extranoncePrefix: Buffer; groupChannelId: number; }
export interface OpenMiningChannelError { requestId: number; errorCode: string; }
export interface UpdateChannel { channelId: number; nominalHashRate: number; maxTarget: Buffer; }
export interface UpdateChannelError { channelId: number; errorCode: string; }
export interface CloseChannel { channelId: number; reasonCode: string; }
export interface SubmitSharesStandard { channelId: number; sequenceNumber: number; jobId: number; nonce: number; ntime: number; version: number; }
export interface SubmitSharesExtended extends SubmitSharesStandard { extranonce: Buffer; }
export interface SubmitSharesSuccess { channelId: number; lastSequenceNumber: number; newSubmitsAcceptedCount: number; newSharesSum: bigint; }
export interface SubmitSharesError { channelId: number; sequenceNumber: number; errorCode: string; }
export interface NewMiningJob { channelId: number; jobId: number; minNtime: number | null; version: number; merkleRoot: Buffer; }
export interface NewExtendedMiningJob {
    channelId: number; jobId: number; minNtime: number | null; version: number; versionRollingAllowed: boolean;
    merklePath: Buffer[]; coinbaseTxPrefix: Buffer; coinbaseTxSuffix: Buffer;
}
export interface SetNewPrevHash { channelId: number; jobId: number; prevHash: Buffer; minNtime: number; nbits: number; }
export interface SetTarget { channelId: number; maximumTarget: Buffer; }

export const enc = {
    setupConnection: (m: SetupConnection) => frame(MSG.SetupConnection, new Writer()
        .u8(m.protocol).u16(m.minVersion).u16(m.maxVersion).u32(m.flags)
        .str0_255(m.endpointHost).u16(m.endpointPort)
        .str0_255(m.vendor).str0_255(m.hardwareVersion).str0_255(m.firmware).str0_255(m.deviceId).build()),
    setupConnectionSuccess: (m: SetupConnectionSuccess) => frame(MSG.SetupConnectionSuccess, new Writer().u16(m.usedVersion).u32(m.flags).build()),
    setupConnectionError: (m: SetupConnectionError) => frame(MSG.SetupConnectionError, new Writer().u32(m.flags).str0_255(m.errorCode).build()),
    openStandardMiningChannel: (m: OpenStandardMiningChannel) => frame(MSG.OpenStandardMiningChannel, new Writer()
        .u32(m.requestId).str0_255(m.userIdentity).f32(m.nominalHashRate).u256(m.maxTarget).build()),
    openExtendedMiningChannel: (m: OpenExtendedMiningChannel) => frame(MSG.OpenExtendedMiningChannel, new Writer()
        .u32(m.requestId).str0_255(m.userIdentity).f32(m.nominalHashRate).u256(m.maxTarget).u16(m.minExtranonceSize).build()),
    openStandardMiningChannelSuccess: (m: OpenStandardMiningChannelSuccess) => frame(MSG.OpenStandardMiningChannelSuccess, new Writer()
        .u32(m.requestId).u32(m.channelId).u256(m.target).b0_32(m.extranoncePrefix).u32(m.groupChannelId).build()),
    openExtendedMiningChannelSuccess: (m: OpenExtendedMiningChannelSuccess) => frame(MSG.OpenExtendedMiningChannelSuccess, new Writer()
        .u32(m.requestId).u32(m.channelId).u256(m.target).u16(m.extranonceSize).b0_32(m.extranoncePrefix).u32(m.groupChannelId).build()),
    openMiningChannelError: (m: OpenMiningChannelError) => frame(MSG.OpenMiningChannelError, new Writer().u32(m.requestId).str0_255(m.errorCode).build()),
    updateChannel: (m: UpdateChannel) => frame(MSG.UpdateChannel, new Writer().u32(m.channelId).f32(m.nominalHashRate).u256(m.maxTarget).build()),
    updateChannelError: (m: UpdateChannelError) => frame(MSG.UpdateChannelError, new Writer().u32(m.channelId).str0_255(m.errorCode).build()),
    closeChannel: (m: CloseChannel) => frame(MSG.CloseChannel, new Writer().u32(m.channelId).str0_255(m.reasonCode).build()),
    submitSharesStandard: (m: SubmitSharesStandard) => frame(MSG.SubmitSharesStandard, new Writer()
        .u32(m.channelId).u32(m.sequenceNumber).u32(m.jobId).u32(m.nonce).u32(m.ntime).u32(m.version).build()),
    submitSharesExtended: (m: SubmitSharesExtended) => frame(MSG.SubmitSharesExtended, new Writer()
        .u32(m.channelId).u32(m.sequenceNumber).u32(m.jobId).u32(m.nonce).u32(m.ntime).u32(m.version).b0_32(m.extranonce).build()),
    submitSharesSuccess: (m: SubmitSharesSuccess) => frame(MSG.SubmitSharesSuccess, new Writer()
        .u32(m.channelId).u32(m.lastSequenceNumber).u32(m.newSubmitsAcceptedCount).u64(m.newSharesSum).build()),
    submitSharesError: (m: SubmitSharesError) => frame(MSG.SubmitSharesError, new Writer()
        .u32(m.channelId).u32(m.sequenceNumber).str0_255(m.errorCode).build()),
    newMiningJob: (m: NewMiningJob) => frame(MSG.NewMiningJob, new Writer()
        .u32(m.channelId).u32(m.jobId).optionU32(m.minNtime).u32(m.version).u256(m.merkleRoot).build()),
    newExtendedMiningJob: (m: NewExtendedMiningJob) => frame(MSG.NewExtendedMiningJob, new Writer()
        .u32(m.channelId).u32(m.jobId).optionU32(m.minNtime).u32(m.version).bool(m.versionRollingAllowed)
        .seq0_255_u256(m.merklePath).b0_64k(m.coinbaseTxPrefix).b0_64k(m.coinbaseTxSuffix).build()),
    setNewPrevHash: (m: SetNewPrevHash) => frame(MSG.SetNewPrevHash, new Writer()
        .u32(m.channelId).u32(m.jobId).u256(m.prevHash).u32(m.minNtime).u32(m.nbits).build()),
    setTarget: (m: SetTarget) => frame(MSG.SetTarget, new Writer().u32(m.channelId).u256(m.maximumTarget).build()),
};

function decodeWith<T>(payload: Buffer, f: (r: Reader) => T): T {
    const r = new Reader(payload);
    const out = f(r);
    r.end();
    return out;
}

export const dec = {
    setupConnection: (p: Buffer): SetupConnection => decodeWith(p, r => ({
        protocol: r.u8(), minVersion: r.u16(), maxVersion: r.u16(), flags: r.u32(),
        endpointHost: r.str0_255(), endpointPort: r.u16(),
        vendor: r.str0_255(), hardwareVersion: r.str0_255(), firmware: r.str0_255(), deviceId: r.str0_255(),
    })),
    setupConnectionSuccess: (p: Buffer): SetupConnectionSuccess => decodeWith(p, r => ({ usedVersion: r.u16(), flags: r.u32() })),
    setupConnectionError: (p: Buffer): SetupConnectionError => decodeWith(p, r => ({ flags: r.u32(), errorCode: r.str0_255() })),
    openStandardMiningChannel: (p: Buffer): OpenStandardMiningChannel => decodeWith(p, r => ({
        requestId: r.u32(), userIdentity: r.str0_255(), nominalHashRate: r.f32(), maxTarget: r.u256(),
    })),
    openExtendedMiningChannel: (p: Buffer): OpenExtendedMiningChannel => decodeWith(p, r => ({
        requestId: r.u32(), userIdentity: r.str0_255(), nominalHashRate: r.f32(), maxTarget: r.u256(), minExtranonceSize: r.u16(),
    })),
    openStandardMiningChannelSuccess: (p: Buffer): OpenStandardMiningChannelSuccess => decodeWith(p, r => ({
        requestId: r.u32(), channelId: r.u32(), target: r.u256(), extranoncePrefix: r.b0_32(), groupChannelId: r.u32(),
    })),
    openExtendedMiningChannelSuccess: (p: Buffer): OpenExtendedMiningChannelSuccess => decodeWith(p, r => ({
        requestId: r.u32(), channelId: r.u32(), target: r.u256(), extranonceSize: r.u16(), extranoncePrefix: r.b0_32(), groupChannelId: r.u32(),
    })),
    openMiningChannelError: (p: Buffer): OpenMiningChannelError => decodeWith(p, r => ({ requestId: r.u32(), errorCode: r.str0_255() })),
    updateChannel: (p: Buffer): UpdateChannel => decodeWith(p, r => ({ channelId: r.u32(), nominalHashRate: r.f32(), maxTarget: r.u256() })),
    updateChannelError: (p: Buffer): UpdateChannelError => decodeWith(p, r => ({ channelId: r.u32(), errorCode: r.str0_255() })),
    closeChannel: (p: Buffer): CloseChannel => decodeWith(p, r => ({ channelId: r.u32(), reasonCode: r.str0_255() })),
    submitSharesStandard: (p: Buffer): SubmitSharesStandard => decodeWith(p, r => ({
        channelId: r.u32(), sequenceNumber: r.u32(), jobId: r.u32(), nonce: r.u32(), ntime: r.u32(), version: r.u32(),
    })),
    submitSharesExtended: (p: Buffer): SubmitSharesExtended => decodeWith(p, r => ({
        channelId: r.u32(), sequenceNumber: r.u32(), jobId: r.u32(), nonce: r.u32(), ntime: r.u32(), version: r.u32(), extranonce: r.b0_32(),
    })),
    submitSharesSuccess: (p: Buffer): SubmitSharesSuccess => decodeWith(p, r => ({
        channelId: r.u32(), lastSequenceNumber: r.u32(), newSubmitsAcceptedCount: r.u32(), newSharesSum: r.u64(),
    })),
    submitSharesError: (p: Buffer): SubmitSharesError => decodeWith(p, r => ({ channelId: r.u32(), sequenceNumber: r.u32(), errorCode: r.str0_255() })),
    newMiningJob: (p: Buffer): NewMiningJob => decodeWith(p, r => ({
        channelId: r.u32(), jobId: r.u32(), minNtime: r.optionU32(), version: r.u32(), merkleRoot: r.u256(),
    })),
    newExtendedMiningJob: (p: Buffer): NewExtendedMiningJob => decodeWith(p, r => ({
        channelId: r.u32(), jobId: r.u32(), minNtime: r.optionU32(), version: r.u32(), versionRollingAllowed: r.bool(),
        merklePath: r.seq0_255_u256(), coinbaseTxPrefix: r.b0_64k(), coinbaseTxSuffix: r.b0_64k(),
    })),
    setNewPrevHash: (p: Buffer): SetNewPrevHash => decodeWith(p, r => ({
        channelId: r.u32(), jobId: r.u32(), prevHash: r.u256(), minNtime: r.u32(), nbits: r.u32(),
    })),
    setTarget: (p: Buffer): SetTarget => decodeWith(p, r => ({ channelId: r.u32(), maximumTarget: r.u256() })),
};

// ── Difficulty <-> target ───────────────────────────────────────────

// Bitcoin "difficulty 1" target: 0xffff * 2^208 (the pool's TRUE_DIFF_ONE).
const DIFF1_TARGET = 0xffffn << 208n;
const MAX_U256 = (1n << 256n) - 1n;

/** U256 little-endian target for a share difficulty (floor(diff1 / diff)). */
export function difficultyToTarget(difficulty: number): Buffer {
    if (!(difficulty > 0) || !Number.isFinite(difficulty)) throw new Error(`invalid difficulty ${difficulty}`);
    // Exact for any double: scale to an integer ratio with 2^64 headroom.
    const SCALE = 1n << 64n;
    const scaled = BigInt(Math.round(difficulty * Number(SCALE)));
    let t = scaled === 0n ? MAX_U256 : (DIFF1_TARGET * SCALE) / scaled;
    if (t > MAX_U256) t = MAX_U256;
    return bigToLe32(t);
}

/** Share difficulty a U256 little-endian target stands for (diff1 / target). */
export function targetToDifficulty(target: Buffer): number {
    const t = le32ToBig(target);
    if (t === 0n) return Number.POSITIVE_INFINITY;
    return Number(DIFF1_TARGET * (1n << 64n) / t) / Number(1n << 64n);
}

export function le32ToBig(b: Buffer): bigint {
    if (b.length !== 32) throw new Error('U256 must be 32 bytes');
    return BigInt('0x' + Buffer.from(b).reverse().toString('hex'));
}

export function bigToLe32(v: bigint): Buffer {
    return Buffer.from(v.toString(16).padStart(64, '0'), 'hex').reverse();
}
