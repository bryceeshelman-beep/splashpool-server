import { useContainer } from 'class-validator';
import { EventEmitter } from 'events';

import { BitcoinAddressValidator } from '../models/validators/bitcoin-address.validator';

import { CHANNEL_MSG_BIT, dec, decodeTlvs, enc, encodeTlvs, EXT, EXT_NEGOTIATION_MSG, MSG, Sv2DecodeError } from './codec';
import { ChannelBudget } from './stratum-v2.service';
import { DEFAULT_MAX_CHANNELS_PER_CONNECTION, Sv2Connection } from './sv2-connection';

// Extension negotiation (0x0001), worker-specific hashrate tracking (0x0002)
// and the channel limits, at the message level. The Noise layer and the
// mining channels are stubbed: frames go straight to the connection's frame
// handler, as they would after decryption.

const ADDRESS = 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4';

interface Sent { extensionType: number, type: number, payload: Buffer }

class FakeSocket extends EventEmitter {
    remoteAddress = '192.0.2.7';
    destroyed = false;
    writableEnded = false;
    write = jest.fn();
    setTimeout = jest.fn();
    destroy = jest.fn(() => { this.destroyed = true; return this; });
}

function makeConnection(options: { maxChannelsPerConnection?: number, budget?: ChannelBudget, ip?: string } = {}) {
    const socket = new FakeSocket();
    if (options.ip) socket.remoteAddress = options.ip;
    const conn = new Sv2Connection(socket as any, {} as any, {
        staticKey: { secretKey: Buffer.alloc(32, 1), publicKey: Buffer.alloc(64, 2) } as any,
        certificate: () => Buffer.alloc(74),
        logShares: false,
        connLog: false,
        authTimeoutSeconds: 0,
        maxChannelsPerConnection: options.maxChannelsPerConnection,
        channelBudget: options.budget,
    });
    clearTimeout((conn as any).handshakeTimer);
    const sent: Sent[] = [];
    jest.spyOn(conn, 'send').mockImplementation(async (f: Buffer) => {
        sent.push({ extensionType: f.readUInt16LE(0), type: f.readUInt8(2), payload: f.subarray(6) });
        return true;
    });
    const channels: any[] = [];
    jest.spyOn(conn as any, 'newChannel').mockImplementation((id: number, type: string) => {
        const ch = {
            id, type,
            extranoncePrefix: '00000001', extranonceSize: 8, difficulty: 1024, extraNonceAndSessionId: 'abcd',
            isBlockedAgent: () => false,
            open: jest.fn(() => Buffer.alloc(32, 0xff)),
            start: jest.fn(),
            submit: jest.fn(async () => undefined),
            close: jest.fn(async () => undefined),
            setCloseReason: jest.fn(),
            connectionSummary: () => 'summary',
        };
        if (id > 0) channels.push(ch);
        return ch;
    });
    (conn as any).state = 'setup';
    return { conn, socket, sent, channels };
}

/** Runs one plaintext frame through the connection, as after Noise decryption. */
async function feed(conn: Sv2Connection, frame: Buffer) {
    const header = { extensionType: frame.readUInt16LE(0), msgType: frame.readUInt8(2), msgLength: frame.readUIntLE(3, 3) };
    await (conn as any).handleFrame({ header, payload: frame.subarray(6) });
}

async function setup(conn: Sv2Connection) {
    await feed(conn, enc.setupConnection({
        protocol: 0, minVersion: 2, maxVersion: 2, flags: 0, endpointHost: 'pool', endpointPort: 3336,
        vendor: 'SRI', hardwareVersion: 'Translator Proxy', firmware: '', deviceId: '',
    }));
}

async function openExtended(conn: Sv2Connection, requestId = 1, user = `${ADDRESS}.miner${requestId}`) {
    await feed(conn, enc.openExtendedMiningChannel({ requestId, userIdentity: user, nominalHashRate: 1e12, maxTarget: Buffer.alloc(32, 0xff), minExtranonceSize: 8 }));
}

const share = (channelId = 1) => ({ channelId, sequenceNumber: 5, jobId: 1, nonce: 2, ntime: 3, version: 4, extranonce: Buffer.alloc(8, 9) });
const workerTlv = (name: string | Buffer) => ({ extensionType: EXT.WorkerHashrateTracking, fieldType: 0x01, value: Buffer.isBuffer(name) ? name : Buffer.from(name, 'utf8') });

// As main.ts does: the address check needs its ConfigService (testnet here).
const testnetValidator = new BitcoinAddressValidator({ get: (k: string) => (k === 'NETWORK' ? 'testnet' : undefined) } as any);
useContainer({ get: (cls: any) => (cls === BitcoinAddressValidator ? testnetValidator : new cls()) }, { fallback: true, fallbackOnErrors: true });

describe('Sv2Connection: extensions and channel limits', () => {
    let logSpies: jest.SpyInstance[];
    beforeEach(() => {
        logSpies = ['log', 'warn', 'error'].map(m => jest.spyOn(console, m as any).mockImplementation(() => undefined));
    });
    afterEach(() => logSpies.forEach(s => s.mockRestore()));

    describe('codec', () => {
        it('RequestExtensions and its replies use extension_type 0x0001, U16 ids and SEQ0_64K[U16] lists', () => {
            // What SRI's translator sends with required_extensions = [2] (request_id 1).
            const req = enc.requestExtensions({ requestId: 1, requestedExtensions: [2] });
            expect(req.toString('hex')).toBe('0100' + '00' + '060000' + '0100' + '0100' + '0200');
            expect(dec.requestExtensions(req.subarray(6))).toEqual({ requestId: 1, requestedExtensions: [2] });

            const ok = enc.requestExtensionsSuccess({ requestId: 1, supportedExtensions: [2] });
            expect(ok.toString('hex')).toBe('0100' + '01' + '060000' + '0100' + '0100' + '0200');
            const err = enc.requestExtensionsError({ requestId: 7, unsupportedExtensions: [3, 5], requiredExtensions: [] });
            expect(err.toString('hex')).toBe('0100' + '02' + '0a0000' + '0700' + '0200' + '0300' + '0500' + '0000');
            expect(dec.requestExtensionsError(err.subarray(6))).toEqual({ requestId: 7, unsupportedExtensions: [3, 5], requiredExtensions: [] });
        });

        it('TLVs are little-endian like every SV2 U16 (as SRI encodes them): type 02 00 | 01, length 0a 00', () => {
            expect(encodeTlvs([workerTlv('Worker_001')]).toString('hex')).toBe('020001' + '0a00' + Buffer.from('Worker_001').toString('hex'));
            expect(decodeTlvs(Buffer.from('0200010a00' + Buffer.from('Worker_001').toString('hex'), 'hex'))).toEqual([workerTlv('Worker_001')]);
        });

        it('SubmitSharesExtended with TLVs: base fields as before, TLVs after; a cut-off TLV is an error', () => {
            const f = enc.submitSharesExtendedWithTlvs(share(), [workerTlv('bitaxe-hex'), { extensionType: 0x0009, fieldType: 3, value: Buffer.from([1, 2]) }]);
            expect(f.readUInt16LE(0)).toBe(CHANNEL_MSG_BIT); // extension_type unchanged by TLVs
            const back = dec.submitSharesExtendedWithTlvs(f.subarray(6));
            expect(back.share).toEqual(share());
            expect(back.tlvs).toEqual([workerTlv('bitaxe-hex'), { extensionType: 0x0009, fieldType: 3, value: Buffer.from([1, 2]) }]);
            expect(dec.submitSharesExtendedWithTlvs(enc.submitSharesExtended(share()).subarray(6)).tlvs).toEqual([]);
            expect(() => dec.submitSharesExtendedWithTlvs(f.subarray(6, f.length - 1))).toThrow();
            expect(() => dec.submitSharesExtendedWithTlvs(Buffer.concat([enc.submitSharesExtended(share()).subarray(6), Buffer.from([2, 0])]))).toThrow();
        });
    });

    describe('extension negotiation (0x0001)', () => {
        async function negotiate(requested: number[]) {
            const { conn, sent, socket } = makeConnection();
            await setup(conn);
            await feed(conn, enc.requestExtensions({ requestId: 1, requestedExtensions: requested }));
            const reply = sent[sent.length - 1];
            return { conn, sent, reply, socket };
        }

        it('[0x0002] -> Success [0x0002]', async () => {
            const { reply } = await negotiate([2]);
            expect(reply.extensionType).toBe(EXT.Negotiation);
            expect(reply.type).toBe(EXT_NEGOTIATION_MSG.RequestExtensionsSuccess);
            expect(dec.requestExtensionsSuccess(reply.payload)).toEqual({ requestId: 1, supportedExtensions: [2] });
        });

        it('[0x0002, 0x0003] -> Success with only [0x0002]', async () => {
            const { reply } = await negotiate([2, 3]);
            expect(dec.requestExtensionsSuccess(reply.payload).supportedExtensions).toEqual([2]);
        });

        it('none supported (or none asked) -> Error listing them, nothing required, and the connection carries on', async () => {
            for (const requested of [[3], [7, 3], []]) {
                const { conn, reply, socket } = await negotiate(requested);
                expect(reply.type).toBe(EXT_NEGOTIATION_MSG.RequestExtensionsError);
                expect(dec.requestExtensionsError(reply.payload)).toEqual({ requestId: 1, unsupportedExtensions: requested, requiredExtensions: [] });
                await openExtended(conn);
                expect(socket.destroyed).toBe(false);
            }
        });

        it('only once, and only before any channel: later requests get no reply and count as invalid', async () => {
            const { conn, sent } = await negotiate([2]);
            const n = sent.length;
            await feed(conn, enc.requestExtensions({ requestId: 2, requestedExtensions: [2] }));
            expect(sent.length).toBe(n);
            expect((conn as any).invalidSinceAccepted).toBe(1);

            const late = makeConnection();
            await setup(late.conn);
            await openExtended(late.conn);
            const m = late.sent.length;
            await feed(late.conn, enc.requestExtensions({ requestId: 1, requestedExtensions: [2] }));
            expect(late.sent.length).toBe(m);
            expect((late.conn as any).workerTracking).toBe(false);
        });

        it('before SetupConnection, an extension message is not a SetupConnection (its msg_type 0x00 notwithstanding)', async () => {
            const { conn, socket } = makeConnection();
            await feed(conn, enc.requestExtensions({ requestId: 1, requestedExtensions: [2] }));
            expect(socket.destroyed).toBe(true);
            expect((conn as any).closeReason).toBe('no-setup');
        });

        it('another extension\'s messages are not offered: invalid, no reply', async () => {
            const { conn, sent } = makeConnection();
            await setup(conn);
            const n = sent.length;
            const other = Buffer.from('0300' + '00' + '000000', 'hex');
            await feed(conn, other);
            expect(sent.length).toBe(n);
            expect((conn as any).invalidSinceAccepted).toBe(1);
        });
    });

    describe('worker names on shares (0x0002)', () => {
        async function connected(negotiated: boolean) {
            const c = makeConnection();
            await setup(c.conn);
            if (negotiated) await feed(c.conn, enc.requestExtensions({ requestId: 1, requestedExtensions: [2] }));
            await openExtended(c.conn);
            return c;
        }

        it('negotiated: each share\'s worker name reaches its channel', async () => {
            const { conn, channels } = await connected(true);
            await feed(conn, enc.submitSharesExtendedWithTlvs(share(), [workerTlv('bitaxe-hex')]));
            expect(channels[0].submit).toHaveBeenCalledWith(share(), true, 'bitaxe-hex');
        });

        it('not negotiated: TLVs are ignored (sv2-spec: MUST ignore), the share still counts', async () => {
            const { conn, channels } = await connected(false);
            await feed(conn, enc.submitSharesExtendedWithTlvs(share(), [workerTlv('bitaxe-hex')]));
            expect(channels[0].submit).toHaveBeenCalledWith(share(), true, null);
        });

        it('negotiated but a share without the TLV: no name, the share still counts; unknown TLVs are skipped', async () => {
            const { conn, channels } = await connected(true);
            await feed(conn, enc.submitSharesExtended(share()));
            await feed(conn, enc.submitSharesExtendedWithTlvs(share(), [{ extensionType: 0x0009, fieldType: 1, value: Buffer.from('x') }]));
            expect(channels[0].submit.mock.calls.map(c => c[2])).toEqual([null, null]);
        });

        it('a malformed TLV list, an empty or over-32-byte name, or invalid UTF-8 closes the connection as junk', async () => {
            const cases: Buffer[] = [
                Buffer.concat([enc.submitSharesExtended(share()), Buffer.from('02000105', 'hex')]), // cut off
                enc.submitSharesExtendedWithTlvs(share(), [workerTlv('x'.repeat(33))]),
                enc.submitSharesExtendedWithTlvs(share(), [workerTlv('')]),
                enc.submitSharesExtendedWithTlvs(share(), [workerTlv(Buffer.from([0xc3, 0x28]))]),
            ];
            for (const f of cases) {
                const { conn, channels } = await connected(true);
                // The appended bytes: fix the header's length so only the TLV is wrong.
                f.writeUIntLE(f.length - 6, 3, 3);
                // A decode error, which onData turns into closeAsJunk('bad-message').
                await expect(feed(conn, f)).rejects.toThrow(Sv2DecodeError);
                expect(channels[0].submit).not.toHaveBeenCalled();
            }
        });

        it('a 32-byte name is the limit and fine', async () => {
            const { conn, channels } = await connected(true);
            await feed(conn, enc.submitSharesExtendedWithTlvs(share(), [workerTlv('w'.repeat(32))]));
            expect(channels[0].submit.mock.calls[0][2]).toBe('w'.repeat(32));
        });
    });

    describe('channel limits', () => {
        it(`default per connection is ${DEFAULT_MAX_CHANNELS_PER_CONNECTION} (a proxy puts each miner on a channel)`, async () => {
            const { conn, sent, channels } = makeConnection();
            await setup(conn);
            for (let i = 1; i <= DEFAULT_MAX_CHANNELS_PER_CONNECTION + 1; i++) await openExtended(conn, i);
            expect(channels).toHaveLength(DEFAULT_MAX_CHANNELS_PER_CONNECTION);
            const last = sent[sent.length - 1];
            expect(last.type).toBe(MSG.OpenMiningChannelError);
            expect(dec.openMiningChannelError(last.payload)).toEqual({ requestId: DEFAULT_MAX_CHANNELS_PER_CONNECTION + 1, errorCode: 'max-channels-reached' });
        });

        it('per connection cap from config', async () => {
            const { conn, sent, channels } = makeConnection({ maxChannelsPerConnection: 3 });
            await setup(conn);
            for (let i = 1; i <= 4; i++) await openExtended(conn, i);
            expect(channels).toHaveLength(3);
            expect(dec.openMiningChannelError(sent[sent.length - 1].payload).errorCode).toBe('max-channels-reached');
        });

        it('per-IP budget across connections; CloseChannel and disconnects give channels back', async () => {
            const budget = new ChannelBudget(4);
            const a = makeConnection({ budget, ip: '198.51.100.9' });
            const b = makeConnection({ budget, ip: '198.51.100.9' });
            const other = makeConnection({ budget, ip: '203.0.113.5' });
            for (const c of [a, b, other]) await setup(c.conn);
            for (let i = 1; i <= 3; i++) await openExtended(a.conn, i);
            for (let i = 1; i <= 2; i++) await openExtended(b.conn, i);
            expect(a.channels.length + b.channels.length).toBe(4);
            expect(dec.openMiningChannelError(b.sent[b.sent.length - 1].payload).errorCode).toBe('max-channels-reached');
            expect(budget.count('198.51.100.9')).toBe(4);
            // Another IP has its own budget.
            await openExtended(other.conn, 1);
            expect(other.channels).toHaveLength(1);

            await feed(a.conn, enc.closeChannel({ channelId: 1, reasonCode: 'bye' }));
            expect(budget.count('198.51.100.9')).toBe(3);
            await openExtended(b.conn, 9);
            expect(b.channels).toHaveLength(2);
            expect(budget.count('198.51.100.9')).toBe(4);

            await a.conn.onClosed(false, false);
            await b.conn.onClosed(false, false);
            expect(budget.count('198.51.100.9')).toBe(0);
        });

        it('a refused channel open does not use up budget', async () => {
            const budget = new ChannelBudget(2);
            const c = makeConnection({ budget });
            await setup(c.conn);
            await openExtended(c.conn, 1, 'not-an-address.rig');
            expect(budget.count(c.socket.remoteAddress)).toBe(0);
        });
    });
});
