import * as bitcoinjs from 'bitcoinjs-lib';

import { IJobTemplate } from '../services/stratum-v1-jobs.service';
import { payoutScript } from '../splash/payout-script';
import { eResponseMethod } from './enums/eResponseMethod';
import { IMiningNotify } from './stratum-messages/IMiningNotify';
import { ConfigService } from '@nestjs/config';
import { TOTAL_EXTRANONCE_SIZE_BYTES } from './stratum.constants';

const MAX_BLOCK_WEIGHT = 4000000;

// Splash Pool: per-miner job building must stay cheap, because every miner gets
// its own coinbase on every new block. These caches hold work that is the same
// for everyone: an address's output script, and a template's block weight
// (keyed by its transactions array, which refreshed copies of a template share).
const scriptCache = new Map<string, Buffer>();
const templateWeightCache = new WeakMap<object, number>();
function templateWeight(block: bitcoinjs.Block): number {
    const key = block.transactions as object;
    if (key == null) {
        return block.weight();
    }
    let w = templateWeightCache.get(key);
    if (w == null) {
        w = block.weight();
        templateWeightCache.set(key, w);
    }
    return w;
}
const MAX_SCRIPT_SIZE = 100; //   https://github.com/bitcoin/bitcoin/blob/ffdc3d6060f6e65e69cf115a13b83e6eb4a0a0a8/src/consensus/tx_check.cpp#L49
interface AddressObject {
    address: string;
    percent: number;
}
// Splash Pool: an exact output amount in sats. When every entry has `value`,
// the outputs must sum to the block reward exactly.
interface ExactOutput {
    address: string;
    value: number;
}
export class MiningJob {

    private coinbaseTransaction: bitcoinjs.Transaction;
    private coinbasePart1: string;
    private coinbasePart2: string;
    private coinbasePart1Buffer: Buffer;
    private coinbasePart2Buffer: Buffer;
    private merkleBranchBuffers: Buffer[];

    public jobTemplateId: string;
    public networkDifficulty: number;
    public creation: number;

    constructor(
        configService: ConfigService,
        private network: bitcoinjs.networks.Network,
        public jobId: string,
        payoutInformation: AddressObject[] | ExactOutput[],
        jobTemplate: IJobTemplate
    ) {

        this.creation = new Date().getTime();
        this.jobTemplateId = jobTemplate.blockData.id;
        this.merkleBranchBuffers = jobTemplate.merkle_branch.map(branch => Buffer.from(branch, 'hex'));

        this.coinbaseTransaction = this.createCoinbaseTransaction(payoutInformation, jobTemplate.blockData.coinbasevalue);

        //The commitment is recorded in a scriptPubKey of the coinbase transaction. It must be at least 38 bytes, with the first 6-byte of 0x6a24aa21a9ed, that is:
        //     1-byte - OP_RETURN (0x6a)
        //     1-byte - Push the following 36 bytes (0x24)
        //     4-byte - Commitment header (0xaa21a9ed)
        const segwitMagicBits = Buffer.from('aa21a9ed', 'hex');
        //    32-byte - Commitment hash: Double-SHA256(witness root hash|witness reserved value)

        //    39th byte onwards: Optional data with no consensus meaning
        // Initial pool identifier
        let poolIdentifier = configService.get('POOL_IDENTIFIER') || 'Public-Pool';
        let extra = Buffer.from(poolIdentifier);

        // Encode the block height
        // https://github.com/bitcoin/bips/blob/master/bip-0034.mediawiki
        const blockHeightEncoded = bitcoinjs.script.number.encode(jobTemplate.blockData.height);

        // Get the length of the block height encoding
        const blockHeightLengthByte = Buffer.from([blockHeightEncoded.length]);

        // Generate padding and take length of encode blockHeight into account
        const padding = Buffer.alloc(TOTAL_EXTRANONCE_SIZE_BYTES + (3 - blockHeightEncoded.length), 0)

        // Build the script
        let script = Buffer.concat([blockHeightLengthByte, blockHeightEncoded, extra, padding]);
        // Splash Pool: the pool tag (-=+SplashPool+=-) is in EVERY coinbase. An
        // identifier that doesn't fit is a configuration error, so refuse the
        // job instead of silently mining an untagged block.
        if (script.length > MAX_SCRIPT_SIZE) {
            throw new Error(`Coinbase script ${script.length} bytes > ${MAX_SCRIPT_SIZE}: POOL_IDENTIFIER "${poolIdentifier}" is too long`);
        }

        this.coinbaseTransaction.ins[0].script = script;
        // Every job is different work, so one hash can't be claimed under two
        // jobs' difficulties. nSequence is free in a coinbase (nLockTime is 0).
        this.coinbaseTransaction.ins[0].sequence = parseInt(jobId, 16) >>> 0;
        this.coinbaseTransaction.addOutput(bitcoinjs.script.compile([bitcoinjs.opcodes.OP_RETURN, Buffer.concat([segwitMagicBits, jobTemplate.block.witnessCommit])]), 0);

        // Splash Pool: a large payout coinbase must still fit. Refuse the job
        // rather than hand out work for a block the network would reject. (The
        // tag is never dropped to make room: it is ~48 weight units, and the
        // node reserves 50,000 for the coinbase via blockreservedweight.)
        if ((this.coinbaseTransaction.weight() + templateWeight(jobTemplate.block)) > MAX_BLOCK_WEIGHT) {
            throw new Error(`Block weight ${this.coinbaseTransaction.weight() + templateWeight(jobTemplate.block)} exceeds ${MAX_BLOCK_WEIGHT} with ${this.coinbaseTransaction.outs.length} coinbase outputs`);
        }

        // get the non-witness coinbase tx
        //@ts-ignore
        const serializedCoinbaseTx = this.coinbaseTransaction.__toBuffer().toString('hex');

        const inputScript = this.coinbaseTransaction.ins[0].script.toString('hex');

        const partOneIndex = serializedCoinbaseTx.indexOf(inputScript) + inputScript.length;

        this.coinbasePart1 = serializedCoinbaseTx.slice(0, partOneIndex - (TOTAL_EXTRANONCE_SIZE_BYTES * 2));
        this.coinbasePart2 = serializedCoinbaseTx.slice(partOneIndex);
        this.coinbasePart1Buffer = Buffer.from(this.coinbasePart1, 'hex');
        this.coinbasePart2Buffer = Buffer.from(this.coinbasePart2, 'hex');


    }

    public cloneCoinbaseTransaction(): bitcoinjs.Transaction {
        return bitcoinjs.Transaction.fromBuffer(this.coinbaseTransaction.toBuffer());
    }

    public buildHeaderBuffer(jobTemplate: IJobTemplate, versionMask: number, nonce: number, extraNonce: string, extraNonce2: string, timestamp: number): Buffer {
        const coinbaseBuffer = Buffer.concat([
            this.coinbasePart1Buffer,
            Buffer.from(`${extraNonce}${extraNonce2}`, 'hex'),
            this.coinbasePart2Buffer,
        ]);
        const coinbaseHash = bitcoinjs.crypto.hash256(coinbaseBuffer);
        const merkleRoot = this.calculateMerkleRootHash(coinbaseHash, this.merkleBranchBuffers);

        let version = jobTemplate.block.version;
        if (versionMask !== undefined && versionMask != 0) {
            version = version ^ versionMask;
        }

        const header = Buffer.alloc(80);
        header.writeInt32LE(version, 0);
        jobTemplate.block.prevHash.copy(header, 4);
        merkleRoot.copy(header, 36);
        header.writeUInt32LE(timestamp, 68);
        header.writeUInt32LE(jobTemplate.block.bits, 72);
        header.writeUInt32LE(nonce, 76);

        return header;
    }

    public copyAndUpdateBlock(jobTemplate: IJobTemplate, versionMask: number, nonce: number, extraNonce: string, extraNonce2: string, timestamp: number): bitcoinjs.Block {

        const testBlock = Object.assign(new bitcoinjs.Block(), jobTemplate.block);
        testBlock.transactions = jobTemplate.block.transactions.map(tx => {
            return Object.assign(new bitcoinjs.Transaction(), tx);
        });

        testBlock.transactions[0] = this.cloneCoinbaseTransaction();

        testBlock.nonce = nonce;

        // recompute version mask
        if (versionMask !== undefined && versionMask != 0) {
            testBlock.version = (testBlock.version ^ versionMask);
        }

        // set the nonces
        const nonceScript = testBlock.transactions[0].ins[0].script.toString('hex');

        testBlock.transactions[0].ins[0].script = Buffer.from(`${nonceScript.substring(0, nonceScript.length - (TOTAL_EXTRANONCE_SIZE_BYTES * 2))}${extraNonce}${extraNonce2}`, 'hex');

        //recompute the root since we updated the coinbase script with the nonces
        testBlock.merkleRoot = this.calculateMerkleRootHash(testBlock.transactions[0].getHash(false), this.merkleBranchBuffers);


        testBlock.timestamp = timestamp;

        return testBlock;
    }


    private calculateMerkleRootHash(newRoot: Buffer, merkleBranches: Buffer[]): Buffer {

        const bothMerkles = Buffer.alloc(64);

        bothMerkles.set(newRoot);

        for (let i = 0; i < merkleBranches.length; i++) {
            bothMerkles.set(merkleBranches[i], 32);
            newRoot = bitcoinjs.crypto.hash256(bothMerkles);
            bothMerkles.set(newRoot);
        }

        return bothMerkles.subarray(0, 32)
    }


    private createCoinbaseTransaction(addresses: AddressObject[] | ExactOutput[], reward: number): bitcoinjs.Transaction {
        // Part 1
        const coinbaseTransaction = new bitcoinjs.Transaction();

        // Set the version of the transaction
        coinbaseTransaction.version = 2;

        // Add the coinbase input (input with no previous output)
        coinbaseTransaction.addInput(Buffer.alloc(32, 0), 0xffffffff, 0xffffffff);

        if (addresses.length > 0 && addresses.every(a => 'value' in a)) {
            // Splash Pool exact payouts.
            let total = 0;
            for (const out of addresses as ExactOutput[]) {
                if (!Number.isSafeInteger(out.value) || out.value <= 0) {
                    throw new Error(`Invalid coinbase output value ${out.value} for ${out.address}`);
                }
                total += out.value;
                coinbaseTransaction.addOutput(this.getPaymentScript(out.address), out.value);
            }
            if (total !== reward) {
                throw new Error(`Coinbase outputs sum to ${total}, expected reward ${reward}`);
            }
        } else {
            // Add an output
            let rewardBalance = reward;

            (addresses as AddressObject[]).forEach(recipientAddress => {
                const amount = Math.floor((recipientAddress.percent / 100) * reward);
                rewardBalance -= amount;
                coinbaseTransaction.addOutput(this.getPaymentScript(recipientAddress.address), amount);
            })

            //Add any remaining sats from the Math.floor
            coinbaseTransaction.outs[0].value += rewardBalance;
        }

        const segwitWitnessReservedValue = Buffer.alloc(32, 0);

        //and the coinbase's input's witness must consist of a single 32-byte array for the witness reserved value
        coinbaseTransaction.ins[0].witness = [segwitWitnessReservedValue];

        return coinbaseTransaction;
    }

    private getPaymentScript(address: string): Buffer {
        const key = `${this.network.bech32}|${address}`;
        let script = scriptCache.get(key);
        if (script == null) {
            script = payoutScript(address, this.network);
            if (scriptCache.size > 100_000) {
                scriptCache.clear();
            }
            scriptCache.set(key, script);
        }
        return script;
    }

    public response(jobTemplate: IJobTemplate): string {

        const job: IMiningNotify = {
            id: null,
            method: eResponseMethod.MINING_NOTIFY,
            params: [
                this.jobId,
                this.swapEndianWords(jobTemplate.block.prevHash).toString('hex'),
                this.coinbasePart1,
                this.coinbasePart2,
                jobTemplate.merkle_branch,
                jobTemplate.block.version.toString(16),
                jobTemplate.block.bits.toString(16),
                jobTemplate.block.timestamp.toString(16),
                jobTemplate.blockData.clearJobs
            ]
        };

        return JSON.stringify(job) + '\n';
    }


    private swapEndianWords(buffer: Buffer): Buffer {
        const swappedBuffer = Buffer.alloc(buffer.length);

        for (let i = 0; i < buffer.length; i += 4) {
            swappedBuffer[i] = buffer[i + 3];
            swappedBuffer[i + 1] = buffer[i + 2];
            swappedBuffer[i + 2] = buffer[i + 1];
            swappedBuffer[i + 3] = buffer[i];
        }

        return swappedBuffer;
    }


}
