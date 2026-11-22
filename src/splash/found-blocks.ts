import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Block } from 'bitcoinjs-lib';
import { promises as fs } from 'fs';
import { dirname, join, resolve } from 'path';

import { BlocksService } from '../ORM/blocks/blocks.service';
import { BitcoinRpcService } from '../services/bitcoin-rpc.service';
import { NotificationService } from '../services/notification.service';
import { chainState, headerHash, IFoundBlock, ISubmitResult, submitBlock } from './block-submission';

export interface IBlockFile extends IFoundBlock {
    network: string;
    address: string;
    worker: string;
    sessionId: string;
    foundAt: number;
}

interface IPending {
    block: IBlockFile;
    path: string;
    saved: boolean;
    writing?: Promise<void>;
    recorded: boolean;
    attempts: number;
    last?: string;
    timer?: NodeJS.Timeout;
}

const QUICK_RETRY_MS = [2_000, 5_000, 10_000];
const RETRY_MS = 30_000;
// After a refusal, or two hours without an answer that settles it.
const SLOW_RETRY_MS = 5 * 60_000;
const FAST_RETRIES = QUICK_RETRY_MS.length + 240;

export function retryDelay(attempts: number, outcome: ISubmitResult['outcome']): number {
    if (attempts < QUICK_RETRY_MS.length) {
        return QUICK_RETRY_MS[attempts];
    }
    return outcome === 'accepted' || (outcome === 'unknown' && attempts < FAST_RETRIES) ? RETRY_MS : SLOW_RETRY_MS;
}

async function syncDir(path: string) {
    const dir = await fs.open(path, 'r');
    try {
        await dir.sync();
    } finally {
        await dir.close();
    }
}

/**
 * Found blocks, one file each, kept until 100 blocks deep. The journal can drop
 * or cut the hex, and the node forgets a block it accepted just before a crash,
 * so every file is resubmitted until the chain has buried it:
 *
 *   found-blocks/<height>-<hash>.json         still being looked after
 *   found-blocks/done/<height>-<hash>.json    100 confirmations, recorded
 *   found-blocks/lost/<height>-<hash>.json    another block is 100 deep at that height
 *
 * Nothing is deleted. To stop retrying a block, move its file out and restart.
 */
@Injectable()
export class FoundBlocksService implements OnApplicationBootstrap {

    private readonly dir: string;
    private readonly network: string;
    private readonly pending = new Map<string, IPending>();
    private stopping = false;

    constructor(
        private readonly rpc: BitcoinRpcService,
        private readonly blocks: BlocksService,
        private readonly notifications: NotificationService,
        configService: ConfigService,
    ) {
        this.dir = resolve(configService.get('SPLASH_FOUND_BLOCKS_DIR') || join('..', 'data', 'found-blocks'));
        this.network = configService.get('NETWORK');
    }

    async onApplicationBootstrap(): Promise<void> {
        try {
            await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
            await syncDir(dirname(this.dir));
            // A complete .tmp is a write that was cut off before its rename.
            const names = (await fs.readdir(this.dir)).filter(n => /\.json(\.tmp)?$/.test(n)).sort();
            for (const name of names) {
                await this.load(name);
            }
            console.log(`Splash found blocks: ${this.dir}, ${this.pending.size} to look after`);
            // In height order, so a parent goes in before its child. Not awaited: miners don't wait for this.
            const waiting = [...this.pending.values()].sort((a, b) => a.block.height - b.block.height);
            void (async () => {
                for (const entry of waiting) {
                    await this.attempt(entry);
                }
            })();
        } catch (e) {
            // Mining goes on: found blocks are still submitted, and each write is tried again.
            console.error(`Splash found blocks: cannot use ${this.dir}`, e);
        }
    }

    private async load(name: string) {
        try {
            const block: IBlockFile = JSON.parse(await fs.readFile(join(this.dir, name), 'utf8'));
            if (headerHash(block.hex) !== block.hash || !Number.isSafeInteger(block.height) || !block.address) {
                throw new Error('contents do not check out');
            }
            if (block.network !== this.network || this.pending.has(block.hash)) {
                return;
            }
            const path = this.pathFor(block);
            if (name.endsWith('.tmp')) {
                // Renamed, not written again: it may be the only copy.
                await fs.rename(join(this.dir, name), path);
                await syncDir(this.dir);
            }
            this.pending.set(block.hash, { block, path, saved: true, recorded: false, attempts: 0 });
        } catch (e) {
            console.error(`Splash found blocks: left ${name} alone, unreadable`, e?.message ?? e);
        }
    }

    private pathFor(block: IBlockFile): string {
        return join(this.dir, `${block.height}-${block.hash}.json`);
    }

    /**
     * Starts the file write and the submission together, before returning: a slow
     * or full disk can't delay the block. Resolves after the first submission and
     * never rejects.
     */
    public found(found: Omit<IBlockFile, 'network'>): Promise<ISubmitResult> {
        if (this.pending.has(found.hash)) {
            return Promise.resolve({ outcome: 'unknown', response: 'already being submitted' });
        }
        const block = { ...found, network: this.network };
        const entry: IPending = { block, path: this.pathFor(block), saved: false, recorded: false, attempts: 0 };
        this.pending.set(block.hash, entry);
        const first = this.attempt(entry, true);
        void this.persist(entry);
        return first;
    }

    private persist(entry: IPending): Promise<void> {
        if (entry.saved) {
            return Promise.resolve();
        }
        entry.writing ??= this.write(entry)
            .then(() => {
                entry.saved = true;
                console.log(`Block ${entry.block.hash} saved to ${entry.path}`);
            })
            .catch(e => console.error(`Block ${entry.block.hash}: file write failed, will retry`, e?.message ?? e))
            .finally(() => entry.writing = undefined);
        return entry.writing;
    }

    private async write(entry: IPending) {
        await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
        const tmp = `${entry.path}.tmp`;
        const file = await fs.open(tmp, 'w', 0o600);
        try {
            await file.writeFile(JSON.stringify(entry.block));
            await file.sync();
        } finally {
            await file.close();
        }
        await fs.rename(tmp, entry.path);
        await syncDir(this.dir);
    }

    private async attempt(entry: IPending, isNew = false): Promise<ISubmitResult> {
        const { block } = entry;
        let result: ISubmitResult = { outcome: 'unknown', response: 'not submitted' };
        try {
            // A new block goes straight to the node. After that, ask the chain first.
            const state = isNew ? { inChain: null, buried: false } : await chainState(this.rpc, block);
            if (state.inChain === false && state.buried) {
                await this.retire(entry, 'lost');
                return { outcome: 'rejected', response: 'another block is buried at that height' };
            }
            result = state.inChain
                ? { outcome: 'accepted', response: 'in chain' }
                : await submitBlock(this.rpc, block);

            const now = `${result.outcome}: ${result.response}`;
            if (now !== entry.last) {
                (result.outcome === 'accepted' ? console.log : console.error)(`Block ${block.hash} ${now}`);
                entry.last = now;
            }
            if (result.outcome === 'accepted' && !entry.recorded) {
                await this.record(entry, result.response);
            }
            if (!isNew) {
                void this.persist(entry);
                // Startup doesn't read done/, so the row must be on disk before the file goes there.
                if (state.inChain && state.buried && entry.recorded && entry.saved && await this.blocks.checkpoint()) {
                    await this.retire(entry, 'done');
                }
            }
        } catch (e) {
            console.error(`Block ${block.hash}: attempt failed, will retry`, e);
        } finally {
            if (!this.stopping && this.pending.has(block.hash)) {
                entry.timer = setTimeout(() => void this.attempt(entry), retryDelay(entry.attempts++, result.outcome));
                entry.timer.unref();
            }
        }
        return result;
    }

    private async record(entry: IPending, response: string) {
        const { hash, height, address, worker, sessionId, foundAt, hex } = entry.block;
        const added = await this.blocks.saveOnce({
            height, minerAddress: address, worker, sessionId, blockData: hex, createdAt: new Date(foundAt),
        });
        entry.recorded = true;
        if (added) {
            // Not awaited: a slow Discord or Telegram must not hold up the retries.
            void (async () => this.notifications.notifySubscribersBlockFound(address, height, Block.fromHex(hex), response))()
                .catch(e => console.error(`Block ${hash}: notification failed`, e));
        }
    }

    private async retire(entry: IPending, folder: 'done' | 'lost') {
        await entry.writing;
        if (entry.saved) {
            const to = join(this.dir, folder);
            await fs.mkdir(to, { recursive: true, mode: 0o700 });
            await fs.rename(entry.path, join(to, `${entry.block.height}-${entry.block.hash}.json`));
            await syncDir(to);
            await syncDir(this.dir);
        }
        this.pending.delete(entry.block.hash);
        console.log(`Block ${entry.block.hash} finished: ${folder}`);
    }

    /** For shutdown: no more retries (the next start resumes them) and every file on disk. */
    public async stop(): Promise<void> {
        this.stopping = true;
        const entries = [...this.pending.values()];
        entries.forEach(entry => clearTimeout(entry.timer));
        await Promise.all(entries.map(entry => this.persist(entry)));
    }
}
