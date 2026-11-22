import * as bitcoinjs from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';

import { BitcoinAddressValidator } from '../models/validators/bitcoin-address.validator';
import { isPayableAddress, PayoutService } from './payout.service';

bitcoinjs.initEccLib(ecc);
const net = bitcoinjs.networks.bitcoin;
const hash = Buffer.alloc(20, 7);
const p2wpkh = bitcoinjs.payments.p2wpkh({ hash }).address;
const FEE = bitcoinjs.payments.p2wpkh({ hash: Buffer.alloc(20, 9) }).address;
let onCurve: Buffer = Buffer.alloc(32, 1);
while (!ecc.isXOnlyPoint(onCurve)) onCurve = bitcoinjs.crypto.sha256(onCurve);
let offCurve: Buffer = Buffer.alloc(32, 2);
while (ecc.isXOnlyPoint(offCurve)) offCurve = bitcoinjs.crypto.sha256(offCurve);
const config = { get: (k: string) => ({ NETWORK: 'mainnet', SPLASH_PAYOUTS: 'true', SPLASH_FEE_ADDRESS: FEE })[k] } as any;

describe('payout addresses', () => {
    const validator = new BitcoinAddressValidator(config);
    it.each([
        ['p2wpkh', p2wpkh],
        ['uppercase p2wpkh', p2wpkh.toUpperCase()],
        ['p2pkh', bitcoinjs.payments.p2pkh({ hash }).address],
        ['p2sh', bitcoinjs.payments.p2sh({ hash }).address],
        ['p2wsh', bitcoinjs.payments.p2wsh({ hash: Buffer.alloc(32, 7) }).address],
        ['p2tr', bitcoinjs.address.toBech32(onCurve, 1, 'bc')],
    ])('accepts %s at login and in jobs', (_, address) => {
        expect(validator.validate(address)).toBe(true);
        expect(isPayableAddress(address, net)).toBe(true);
    });

    it.each([
        ['off-curve taproot', bitcoinjs.address.toBech32(offCurve, 1, 'bc')],
        ['v1 with 20 bytes', bitcoinjs.address.toBech32(hash, 1, 'bc')],
        ['v0 with 2 bytes', bitcoinjs.address.toBech32(Buffer.alloc(2, 7), 0, 'bc')],
        ['future witness v2', bitcoinjs.address.toBech32(Buffer.alloc(32, 7), 2, 'bc')],
        ['uppercase taproot (no job builder support)', bitcoinjs.address.toBech32(onCurve, 1, 'bc').toUpperCase()],
        ['testnet', bitcoinjs.payments.p2wpkh({ hash, network: bitcoinjs.networks.testnet }).address],
        ['garbage', 'garbage'],
        ['missing', undefined],
    ])('refuses %s at login and in jobs', (_, address) => {
        expect(validator.validate(address)).toBe(false);
        expect(isPayableAddress(address, net)).toBe(false);
    });
});

describe('share window reads', () => {
    beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => undefined));
    afterEach(() => jest.restoreAllMocks());

    it('issues nothing until a read succeeds, then keeps the last good split', async () => {
        const getWindow = jest.fn().mockRejectedValue(new Error('db down'));
        const s: any = new PayoutService(config, { getWindow, windowHours: 72 } as any);
        let released = 0;
        s.ready$?.subscribe(() => released++);
        jest.spyOn(console, 'log').mockImplementation(() => undefined);

        await s.onModuleInit();
        expect(() => s.outputsFor(p2wpkh, 314_500_000)).toThrow(/not ready/);
        expect(() => s.build(p2wpkh, 314_500_000)).toThrow(/not ready/);
        expect(s.status()).toMatchObject({ ready: false, lastReward: null });
        expect(released).toBe(0);

        const other = bitcoinjs.payments.p2pkh({ hash }).address;
        getWindow.mockResolvedValue({ miners: [{ address: other, difficulty: 5 }] });
        await s.refresh();
        await s.refresh();
        expect(released).toBe(1);
        const good = s.outputsFor(p2wpkh, 314_500_000);
        expect(good.find(o => o.address === other).value).toBe(201_747_500);

        getWindow.mockRejectedValue(new Error('db down again'));
        await s.refresh();
        expect(s.ready).toBe(true);
        expect(s.outputsFor(p2wpkh, 314_500_000)).toEqual(good);
    });

    it('treats a successful empty read as ready', async () => {
        const s = new PayoutService(config, { getWindow: async () => ({ miners: [] }) } as any);
        await s.refresh();
        expect(s.build(p2wpkh, 314_500_000).paidMiners).toBe(0);
    });
});
