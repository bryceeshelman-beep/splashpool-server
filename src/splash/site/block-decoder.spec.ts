import * as bitcoinjs from 'bitcoinjs-lib';

import { decodeBlock, subsidyAt } from './block-decoder';
import { hashrateFromWork } from './site.service';

describe('Splash site block decoder', () => {

    it('halves the subsidy every interval', () => {
        expect(subsidyAt(0)).toBe(5_000_000_000);
        expect(subsidyAt(209_999)).toBe(5_000_000_000);
        expect(subsidyAt(840_000)).toBe(312_500_000);
        expect(subsidyAt(976_654)).toBe(312_500_000);
        expect(subsidyAt(1_050_000)).toBe(156_250_000);
        expect(subsidyAt(300, 150)).toBe(1_250_000_000);
        expect(subsidyAt(64 * 210_000)).toBe(0);
    });

    it('decodes coinbase outputs to addresses and totals', () => {
        const net = bitcoinjs.networks.regtest;
        const a = bitcoinjs.payments.p2wpkh({ hash: Buffer.alloc(20, 1), network: net }).address;
        const b = bitcoinjs.payments.p2wpkh({ hash: Buffer.alloc(20, 2), network: net }).address;
        const cb = new bitcoinjs.Transaction();
        cb.addInput(Buffer.alloc(32, 0), 0xffffffff, 0xffffffff, Buffer.from('0151', 'hex'));
        cb.addOutput(bitcoinjs.address.toOutputScript(a, net), 3_000_000_000);
        cb.addOutput(bitcoinjs.address.toOutputScript(b, net), 2_000_100_000);
        cb.addOutput(Buffer.from('6a24aa21a9ed' + '00'.repeat(32), 'hex'), 0);
        const block = new bitcoinjs.Block();
        block.version = 0x20000000;
        block.prevHash = Buffer.alloc(32, 0);
        block.merkleRoot = Buffer.alloc(32, 0);
        block.timestamp = 1_700_000_000;
        block.bits = 0x207fffff;
        block.nonce = 0;
        block.transactions = [cb];
        const d = decodeBlock(block.toHex(), 1, net);
        expect(d.hash).toBe(block.getId());
        expect(d.reward).toBe(5_000_100_000);
        expect(d.txFees).toBe(100_000);
        expect(d.outputs.map(o => o.address)).toEqual([a, b, null]);
    });

    it('converts share work to hashrate', () => {
        // 600 difficulty-1 shares in 600 s = 2^32 H/s
        expect(hashrateFromWork(600, 600_000)).toBe(4294967296);
        expect(hashrateFromWork(1, 0)).toBe(0);
    });
});
