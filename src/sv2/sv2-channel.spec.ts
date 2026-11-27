import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { mkdtempSync, rmSync } from 'fs';
import { Socket } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { BehaviorSubject } from 'rxjs';
import { DataSource } from 'typeorm';

import { MockRecording1 } from '../../test/models/MockRecording1';
import { IMiningInfo } from '../models/bitcoin-rpc/IMiningInfo';
import { AddressSettingsModule } from '../ORM/address-settings/address-settings.module';
import { AddressSettingsService } from '../ORM/address-settings/address-settings.service';
import { BlocksEntity } from '../ORM/blocks/blocks.entity';
import { ClientStatisticsEntity } from '../ORM/client-statistics/client-statistics.entity';
import { ClientStatisticsModule } from '../ORM/client-statistics/client-statistics.module';
import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { ClientEntity } from '../ORM/client/client.entity';
import { ClientModule } from '../ORM/client/client.module';
import { ClientService } from '../ORM/client/client.service';
import { BitcoinRpcService } from '../services/bitcoin-rpc.service';
import { StratumV1JobsService } from '../services/stratum-v1-jobs.service';
import { FoundBlocksService } from '../splash/found-blocks';
import { dec, difficultyToTarget, MSG, targetToDifficulty } from './codec';
import { TRUE_DIFF_ONE } from '../models/MinerSession';
import { STANDARD_REFRESH_MAX_SECONDS, standardRefreshSeconds, SV2_MAX_DIFFICULTY, Sv2Channel, Sv2ChannelType, sv2Difficulty } from './sv2-channel';

jest.mock('../services/bitcoin-rpc.service');

// Vardiff changing the difficulty while a miner still holds an earlier job.
// What real Bitaxe firmware (ESP-Miner v2.14/v2.15) does, from its source:
// create_jobs_task.c reads the pool difficulty only when it takes a NEW job
// off its queue and stamps it on that job (generate_work_sv2: pool_diff =
// difficulty); asic_result_task.c submits a result only if it meets that
// job's own pool_diff. A future job is queued when SetNewPrevHash activates
// it. So after SetTarget, the job the ASIC is on keeps the OLD difficulty
// until the next job (the pool's refresh job) arrives, and shares found on it
// meanwhile, or in flight, meet only the old difficulty.

const ADDRESS = 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4';
const NETWORK_DIFFICULTY_HIGH = 1e12; // never a block in these tests

interface Sent { type: number, payload: Buffer }

describe('Sv2Channel: vardiff mid-job', () => {
    let moduleRef: TestingModule;
    let configService: ConfigService;
    let foundBlocks: FoundBlocksService;
    let foundDir: string;
    let shareWindowService: { recordShare: jest.Mock };
    let channel: Sv2Channel;
    let sent: Sent[];
    let nonce = 1;
    let logSpies: jest.SpyInstance[];

    beforeAll(async () => {
        moduleRef = await Test.createTestingModule({
            imports: [
                TypeOrmModule.forRoot({
                    type: 'sqlite', database: ':memory:', synchronize: true, autoLoadEntities: true, cache: true, logging: false,
                    entities: [ClientEntity, ClientStatisticsEntity, BlocksEntity],
                }),
                ClientModule, ClientStatisticsModule, AddressSettingsModule,
            ],
            providers: [{ provide: ConfigService, useValue: { get: jest.fn((key: string) => (key === 'NETWORK' ? 'testnet' : null)) } }],
        }).compile();
    });

    afterAll(async () => {
        await moduleRef.close();
    });

    function makeChannel(type: Sv2ChannelType, template: any = MockRecording1.BLOCK_TEMPLATE): Sv2Channel {
        const bitcoinRpcService = new BitcoinRpcService(configService, null);
        jest.spyOn(bitcoinRpcService, 'getBlockTemplate').mockResolvedValue(template);
        bitcoinRpcService.newBlock$ = new BehaviorSubject({ blocks: MockRecording1.BLOCK_TEMPLATE.height } as IMiningInfo).asObservable();
        const jobs = new StratumV1JobsService(bitcoinRpcService);

        // The app flushes client inserts on a timer; here they land at once.
        const clientService = moduleRef.get(ClientService);
        jest.spyOn(clientService, 'insert').mockImplementation(async (c: any) => ({ ...c, id: 1 }) as any);

        const socket = new Socket();
        jest.spyOn(socket, 'destroy').mockImplementation(() => socket);
        socket.end = jest.fn();

        channel = new Sv2Channel(1, type, {
            send: async (frame: Buffer) => { sent.push({ type: frame.readUInt8(2), payload: frame.subarray(6) }); return true; },
            remoteAddress: '127.0.0.1',
            logShares: false,
        }, socket, jobs, bitcoinRpcService, moduleRef.get(ClientService), moduleRef.get(ClientStatisticsService), foundBlocks,
            configService, moduleRef.get(AddressSettingsService), { submitShare: jest.fn().mockResolvedValue(undefined) } as any,
            shareWindowService as any);
        jest.spyOn(channel as any, 'getRandomHexString').mockReturnValue(MockRecording1.EXTRA_NONCE);

        return channel;
    }

    async function openChannel(type: Sv2ChannelType, startDifficulty: number, template?: any) {
        makeChannel(type, template);
        // nominal hash rate for one share per 10 s at startDifficulty.
        const target = channel.open(ADDRESS, 'bitaxe', 'bitaxe/BM1370 (SV2)', startDifficulty * 2 ** 32 / 10, Buffer.alloc(32, 0xff));
        expect(targetToDifficulty(target)).toBeCloseTo(startDifficulty, 6);
        channel.start();
        await waitFor(() => sent.some(s => s.type === MSG.SetNewPrevHash));
    }

    async function waitFor(cond: () => boolean) {
        for (let i = 0; i < 200 && !cond(); i++) await new Promise(r => setTimeout(r, 5));
        expect(cond()).toBe(true);
    }

    /** Latest job frame with this SV2 id, decoded. */
    function jobs() {
        return sent.filter(s => s.type === MSG.NewMiningJob).map(s => dec.newMiningJob(s.payload));
    }

    function prevHashNtime(): number {
        return dec.setNewPrevHash(sent.find(s => s.type === MSG.SetNewPrevHash).payload).minNtime;
    }

    /** Submits a share on an SV2 job whose hash has exactly `difficulty`. */
    async function submit(jobId: number, ntime: number, version: number, difficulty: number) {
        jest.spyOn(channel as any, 'calculateDifficulty').mockReturnValueOnce({ submissionDifficulty: difficulty, submissionHash: '' });
        const before = sent.length;
        const sequenceNumber = nonce;
        await channel.submit({ channelId: 1, sequenceNumber, jobId, nonce: nonce++, ntime, version }, false);
        const reply = sent.slice(before).find(s => s.type === MSG.SubmitSharesSuccess || s.type === MSG.SubmitSharesError);
        if (reply == null) return { ok: false, code: 'no reply' };
        if (reply.type === MSG.SubmitSharesError) return { ok: false, code: dec.submitSharesError(reply.payload).errorCode };
        const s = dec.submitSharesSuccess(reply.payload);
        expect(s.lastSequenceNumber).toBe(sequenceNumber);
        return { ok: true, sum: Number(s.newSharesSum) };
    }

    async function vardiffTo(difficulty: number) {
        jest.spyOn((channel as any).statistics, 'getSuggestedDifficulty').mockReturnValueOnce(difficulty);
        const before = sent.length;
        await (channel as any).checkDifficulty();
        const after = sent.slice(before);
        // SetTarget first, then a fresh job with ntime_start (applies at once).
        expect(after.map(s => s.type)).toEqual([MSG.SetTarget, MSG.NewMiningJob]);
        expect(targetToDifficulty(dec.setTarget(after[0].payload).maximumTarget)).toBeCloseTo(difficulty, 6);
        const job = dec.newMiningJob(after[1].payload);
        expect(job.minNtime).not.toBeNull();
        return job;
    }

    beforeEach(() => {
        (moduleRef.get(ConfigService).get as jest.Mock).mockImplementation((key: string) => (key === 'NETWORK' ? 'testnet' : null));
        logSpies = ['log', 'warn', 'error'].map(m => jest.spyOn(console, m as any).mockImplementation(() => undefined));
        configService = moduleRef.get(ConfigService);
        foundDir = mkdtempSync(join(tmpdir(), 'splash-sv2-'));
        foundBlocks = new FoundBlocksService(null, null, null, { get: key => (key === 'SPLASH_FOUND_BLOCKS_DIR' ? foundDir : 'testnet') } as any);
        shareWindowService = { recordShare: jest.fn() };
        sent = [];
        nonce = 1;
    });

    afterEach(async () => {
        await channel?.close();
        await foundBlocks.stop();
        rmSync(foundDir, { recursive: true, force: true });
        logSpies.forEach(s => s.mockRestore());
        await moduleRef.get(DataSource).getRepository(ClientEntity).clear();
    });

    function credited(): number[] {
        return shareWindowService.recordShare.mock.calls.map(c => c[1]);
    }

    it('sanity: the block\'s first job is a future job activated by SetNewPrevHash at the starting difficulty', async () => {
        await openChannel('standard', 1024);
        const [first] = jobs();
        expect(first.minNtime).toBeNull();
        expect(dec.setNewPrevHash(sent.find(s => s.type === MSG.SetNewPrevHash).payload).jobId).toBe(first.jobId);
        expect(await submit(first.jobId, prevHashNtime(), first.version, 1100)).toEqual({ ok: true, sum: 1024 });
        expect(credited()).toEqual([1024]);
        expect(NETWORK_DIFFICULTY_HIGH).toBeGreaterThan(1024);
    });

    it('vardiff RAISES difficulty: a Bitaxe share on the earlier (future-activated) job that meets only the old difficulty is accepted and credited at the old one', async () => {
        await openChannel('standard', 1024);
        const [first] = jobs();
        const ntime = prevHashNtime();
        const refresh = await vardiffTo(4096);

        // Found on the old job before (or while) the firmware switched to the refresh job.
        expect(await submit(first.jobId, ntime, first.version, 2000)).toEqual({ ok: true, sum: 1024 });
        // Still below the old difficulty: a real reject.
        expect(await submit(first.jobId, ntime, first.version, 1000)).toEqual({ ok: false, code: 'difficulty-too-low' });
        // A lucky share on the old job is still credited at the old difficulty, never more.
        expect(await submit(first.jobId, ntime, first.version, 50000)).toEqual({ ok: true, sum: 1024 });
        // The refresh job carries the new difficulty.
        expect(await submit(refresh.jobId, refresh.minNtime, refresh.version, 2000)).toEqual({ ok: false, code: 'difficulty-too-low' });
        expect(await submit(refresh.jobId, refresh.minNtime, refresh.version, 5000)).toEqual({ ok: true, sum: 4096 });
        expect(credited()).toEqual([1024, 1024, 4096]);
    });

    it('vardiff RAISES difficulty: the same holds for an earlier job sent with ntime_start', async () => {
        await openChannel('standard', 1024);
        const mid = await vardiffTo(2048);
        const refresh = await vardiffTo(8192);
        expect(await submit(mid.jobId, mid.minNtime, mid.version, 3000)).toEqual({ ok: true, sum: 2048 });
        expect(await submit(refresh.jobId, refresh.minNtime, refresh.version, 9000)).toEqual({ ok: true, sum: 8192 });
        expect(credited()).toEqual([2048, 8192]);
    });

    it('vardiff LOWERS difficulty: shares on the earlier job are credited at the difficulty the miner was given', async () => {
        await openChannel('standard', 4096);
        const [first] = jobs();
        const ntime = prevHashNtime();
        const mid = await vardiffTo(2048);
        const refresh = await vardiffTo(512);

        // Future-activated job: the spec moves it to the new target, so a client that
        // reads the spec literally may submit at 512; accepted and credited at 512.
        expect(await submit(first.jobId, ntime, first.version, 600)).toEqual({ ok: true, sum: 512 });
        // A Bitaxe still on it only submits >= 4096; credited at the lower 512 (never over-credited).
        expect(await submit(first.jobId, ntime, first.version, 5000)).toEqual({ ok: true, sum: 512 });
        // A job sent with ntime_start keeps its target (spec 5.3.21), as the firmware does.
        expect(await submit(mid.jobId, mid.minNtime, mid.version, 600)).toEqual({ ok: false, code: 'difficulty-too-low' });
        expect(await submit(mid.jobId, mid.minNtime, mid.version, 2100)).toEqual({ ok: true, sum: 2048 });
        // New work at the new difficulty.
        expect(await submit(refresh.jobId, refresh.minNtime, refresh.version, 600)).toEqual({ ok: true, sum: 512 });
        expect(credited()).toEqual([512, 512, 2048, 512]);
    });

    it('extended channels follow the same rules', async () => {
        await openChannel('extended', 1024);
        const first = dec.newExtendedMiningJob(sent.find(s => s.type === MSG.NewExtendedMiningJob).payload);
        const ntime = prevHashNtime();
        jest.spyOn((channel as any).statistics, 'getSuggestedDifficulty').mockReturnValueOnce(4096);
        await (channel as any).checkDifficulty();
        jest.spyOn(channel as any, 'calculateDifficulty').mockReturnValueOnce({ submissionDifficulty: 2000, submissionHash: '' });
        const before = sent.length;
        await channel.submit({ channelId: 1, sequenceNumber: 7, jobId: first.jobId, nonce: 99, ntime, version: first.version, extranonce: Buffer.alloc(8, 1) }, true);
        const reply = sent.slice(before).find(s => s.type === MSG.SubmitSharesSuccess || s.type === MSG.SubmitSharesError);
        expect(reply.type).toBe(MSG.SubmitSharesSuccess);
        expect(Number(dec.submitSharesSuccess(reply.payload).newSharesSum)).toBe(1024);
        expect(credited()).toEqual([1024]);
        expect(difficultyToTarget(4096).length).toBe(32);
    });

    describe('difficulties are whole powers of two (AxeOS v2.14 truncates the target to a uint32 difficulty)', () => {
        // ESP-Miner v2.14.0 sv2_protocol.c sv2_target_to_pdiff().
        function firmwareDifficulty(target: Buffer): number {
            const t = Number(BigInt('0x' + Buffer.from(target).reverse().toString('hex')));
            if (t === 0) return 2 ** 32 - 1;
            const pdiff = TRUE_DIFF_ONE / t;
            if (pdiff > 2 ** 32 - 1) return 2 ** 32 - 1;
            if (pdiff < 1) return 1;
            return Math.trunc(pdiff);
        }
        const isPowerOfTwo = (d: number) => Number.isInteger(d) && d >= 1 && Number.isInteger(Math.log2(d));

        function withConfig(values: Record<string, string>) {
            (configService.get as jest.Mock).mockImplementation((key: string) => (key in values ? values[key] : key === 'NETWORK' ? 'testnet' : null));
        }

        it('why: a fractional difficulty is read lower by the firmware, so shares in between would be rejected', () => {
            expect(firmwareDifficulty(difficultyToTarget(2328.3))).toBe(2328);
            expect(firmwareDifficulty(difficultyToTarget(2048))).toBe(2048);
        });

        it('sv2Difficulty rounds to the nearest power of two within the bounds, rounded inward', () => {
            expect(sv2Difficulty(2328.3, 0, Infinity)).toBe(2048); // 1 TH/s at one share per 10 s
            expect(sv2Difficulty(3100, 0, Infinity)).toBe(4096);
            expect(sv2Difficulty(0.3, 0, Infinity)).toBe(1); // the firmware can't go below 1
            expect(sv2Difficulty(100, 600.5, Infinity)).toBe(1024); // a fractional floor rounds up
            expect(sv2Difficulty(5e6, 0, 1e6)).toBe(2 ** 19); // a fractional cap rounds down
            expect(sv2Difficulty(1e15, 0, 2 ** 53)).toBe(SV2_MAX_DIFFICULTY); // the firmware's uint32 limit
            expect(sv2Difficulty(NaN, 512, Infinity)).toBe(512);
            expect(sv2Difficulty(10, 4096, 100)).toBe(4096); // crossed bounds: the floor wins
        });

        it('the starting difficulty from nominal_hash_rate is one the firmware reads back exactly', () => {
            const rates = [1e12 /* what ESP-Miner sends */, 1.2e12, 4.9e11, 6.5e12, 2.3e13, 1e9, 1, 0, -5, NaN, 1e20];
            const configs = [{}, { SPLASH_MIN_DIFFICULTY: '512' }, { SPLASH_MIN_DIFFICULTY: '600.5', SPLASH_MAX_DIFFICULTY: '1e6' }];
            for (const config of configs) {
                for (const rate of rates) {
                    withConfig(config);
                    const ch = makeChannel('standard');
                    const target = ch.open(ADDRESS, 'w', 'bitaxe/BM1370 (SV2)', rate, Buffer.alloc(32, 0xff));
                    expect({ rate, config, d: ch.difficulty, pow2: isPowerOfTwo(ch.difficulty) }).toEqual({ rate, config, d: ch.difficulty, pow2: true });
                    expect(firmwareDifficulty(target)).toBe(ch.difficulty);
                    expect(targetToDifficulty(target)).toBe(ch.difficulty);
                }
            }
            withConfig({});
            const bitaxe = makeChannel('standard');
            bitaxe.open(ADDRESS, 'w', 'bitaxe/BM1370 (SV2)', 1e12, Buffer.alloc(32, 0xff));
            expect(bitaxe.difficulty).toBe(2048);
        });

        it('a miner max_target that is not a power of two rounds the difficulty up, never easier than asked', () => {
            const ch = makeChannel('standard');
            ch.open(ADDRESS, 'w', 'bitaxe', 1e9, difficultyToTarget(3000.5));
            expect(ch.difficulty).toBe(4096);
        });

        it('every SetTarget vardiff sends is a power of two the firmware reads back exactly', async () => {
            await openChannel('standard', 2048);
            let checked = 0;
            for (const suggested of [3000.7, 2328.3, 0.3, 777.77, 5e12, 12345.6]) {
                jest.spyOn((channel as any).statistics, 'getSuggestedDifficulty').mockReturnValueOnce(suggested);
                const before = sent.length;
                await (channel as any).checkDifficulty();
                const setTargets = sent.slice(before).filter(m => m.type === MSG.SetTarget);
                expect(isPowerOfTwo(channel.difficulty)).toBe(true);
                for (const m of setTargets) {
                    expect(firmwareDifficulty(dec.setTarget(m.payload).maximumTarget)).toBe(channel.difficulty);
                    checked++;
                }
            }
            expect(checked).toBeGreaterThanOrEqual(4);
        });
    });

    describe('Standard channels get new work before the miner runs out (no duplicate shares)', () => {
        // The miner rolls nothing but nonce and version bits: one job is 2^32 x 2^16
        // hashes, a few minutes for a 2 TH/s Bitaxe, after which it re-finds the same
        // shares. testnet4 can go many minutes without a template change.
        const warnSpy = () => logSpies[1];
        // Like testnet4: mintime ahead of the clock, so the pool's 60 s template poll
        // sees identical work and sends nothing (on mainnet the timestamp moves).
        const quietTemplate = () => ({ ...MockRecording1.BLOCK_TEMPLATE, mintime: Math.floor(Date.now() / 1000) + 3600 });
        const newJobs = (from: number) => jobs().slice(from);

        async function submitFixedNonce(jobId: number, ntime: number, version: number, headers: Buffer[]) {
            jest.spyOn(channel as any, 'calculateDifficulty').mockImplementationOnce((h: Buffer) => {
                headers.push(Buffer.from(h));
                return { submissionDifficulty: 1e6, submissionHash: '' };
            });
            const before = sent.length;
            await channel.submit({ channelId: 1, sequenceNumber: nonce++, jobId, nonce: 0x12345678, ntime, version }, false);
            const reply = sent.slice(before).find(m => m.type === MSG.SubmitSharesSuccess || m.type === MSG.SubmitSharesError);
            return reply.type === MSG.SubmitSharesSuccess ? 'ok' : dec.submitSharesError(reply.payload).errorCode;
        }

        it('refresh interval: from the hashrate, at most 30 s, with a warning above about 70 TH/s', () => {
            expect(standardRefreshSeconds(1.2e12)).toEqual({ seconds: STANDARD_REFRESH_MAX_SECONDS, tooFast: false }); // Bitaxe Gamma
            expect(standardRefreshSeconds(2.1e12)).toEqual({ seconds: 30, tooFast: false }); // ~34 s wanted, capped
            expect(standardRefreshSeconds(1e13).seconds).toBeCloseTo(2 ** 48 / 1e13 / 4, 6); // ~7 s
            expect(standardRefreshSeconds(7e13)).toEqual({ seconds: 2 ** 48 / 7e13 / 4, tooFast: false }); // ~1.005 s
            expect(standardRefreshSeconds(2e14)).toEqual({ seconds: 1, tooFast: true }); // S21-class: Extended territory
            expect(standardRefreshSeconds(0)).toEqual({ seconds: 10, tooFast: false }); // nothing known yet
            expect(standardRefreshSeconds(NaN)).toEqual({ seconds: 10, tooFast: false });
        });

        it('template unchanged for 5 minutes: a Bitaxe-size miner keeps getting new, unique work, and its shares stay valid', async () => {
            jest.useFakeTimers({ advanceTimers: true });
            try {
                await openChannel('standard', 4096, quietTemplate()); // ~1.8 TH/s claimed
                jest.spyOn((channel as any).statistics, 'getSuggestedDifficulty').mockReturnValue(null); // no vardiff jobs
                const rpc = (channel as any).bitcoinRpcService;
                const polls = (rpc.getBlockTemplate as jest.Mock).mock.calls.length;
                const before = jobs().length;

                await jest.advanceTimersByTimeAsync(5 * 60_000);

                const fresh = newJobs(before);
                // The template was polled and never changed: every job here is a refresh.
                expect((rpc.getBlockTemplate as jest.Mock).mock.calls.length).toBeGreaterThan(polls);
                expect(sent.filter(m => m.type === MSG.SetNewPrevHash)).toHaveLength(1);
                expect(fresh.length).toBeGreaterThanOrEqual(10); // 300 s at <= 30 s
                expect(fresh.every(j => j.minNtime !== null)).toBe(true); // current jobs: switch now
                // Every job is different work, even with the same template and ntime.
                const roots = jobs().map(j => j.merkleRoot.toString('hex'));
                expect(new Set(roots).size).toBe(roots.length);
                expect(new Set(fresh.map(j => j.minNtime)).size).toBe(1); // the ntime did NOT change: the coinbase did
            } finally {
                jest.useRealTimers();
            }
            const fresh = jobs();
            const [a, b] = fresh.slice(-2);
            const headers: Buffer[] = [];
            // The same nonce/ntime/version on two refresh jobs is two different shares...
            expect(await submitFixedNonce(a.jobId, a.minNtime, a.version, headers)).toBe('ok');
            expect(await submitFixedNonce(b.jobId, b.minNtime, b.version, headers)).toBe('ok');
            // ...and the pool judged exactly the work it sent (its header carries that job's merkle root).
            expect(headers[0].subarray(36, 68).equals(a.merkleRoot)).toBe(true);
            expect(headers[1].subarray(36, 68).equals(b.merkleRoot)).toBe(true);
            // Repeating one is still a duplicate.
            expect(await submitFixedNonce(a.jobId, a.minNtime, a.version, headers)).toBe('duplicate-share');
            expect(warnSpy().mock.calls.filter(c => `${c[0]}`.includes('Extended'))).toHaveLength(0);
        });

        it('paces refreshes by the MEASURED hashrate once there is one', async () => {
            jest.useFakeTimers({ advanceTimers: true });
            try {
                await openChannel('standard', 4096, quietTemplate()); // claims ~1.8 TH/s -> 30 s
                jest.spyOn((channel as any).statistics, 'getSuggestedDifficulty').mockReturnValue(null);
                (channel as any).statistics.hashRate = 1e13; // but really does 10 TH/s -> ~7 s
                let before = jobs().length;
                await jest.advanceTimersByTimeAsync(30_500); // the first timer was set from the claimed rate
                expect(newJobs(before)).toHaveLength(1);
                before = jobs().length;
                await jest.advanceTimersByTimeAsync(7_500); // from now on, from the measured one
                expect(newJobs(before)).toHaveLength(1);
            } finally {
                jest.useRealTimers();
            }
        });

        it('large-miner hashrate: refreshes once a second and warns once to use Extended; an Extended channel needs none', async () => {
            jest.useFakeTimers({ advanceTimers: true });
            try {
                await openChannel('standard', 2 ** 19, quietTemplate()); // ~225 TH/s claimed
                jest.spyOn((channel as any).statistics, 'getSuggestedDifficulty').mockReturnValue(null);
                const before = jobs().length;
                await jest.advanceTimersByTimeAsync(10_000);
                const fresh = newJobs(before);
                expect(fresh.length).toBeGreaterThanOrEqual(9);
                expect(fresh.length).toBeLessThanOrEqual(11);
                const roots = jobs().map(j => j.merkleRoot.toString('hex'));
                expect(new Set(roots).size).toBe(roots.length);
                const warnings = warnSpy().mock.calls.filter(c => `${c[0]}`.includes('use an Extended channel'));
                expect(warnings).toHaveLength(1);
                expect(warnings[0][0]).toContain(`${ADDRESS}.bitaxe`);
                await channel.close();

                // Extended: the miner rolls its own extranonce, so no refreshes and no warning.
                sent = [];
                warnSpy().mockClear();
                await openChannel('extended', 2 ** 19, quietTemplate());
                jest.spyOn((channel as any).statistics, 'getSuggestedDifficulty').mockReturnValue(null);
                const ext = sent.filter(m => m.type === MSG.NewExtendedMiningJob).length;
                await jest.advanceTimersByTimeAsync(60_000);
                expect(sent.filter(m => m.type === MSG.NewExtendedMiningJob).length).toBe(ext);
                expect(warnSpy().mock.calls.filter(c => `${c[0]}`.includes('Extended'))).toHaveLength(0);
            } finally {
                jest.useRealTimers();
            }
        });
    });
});
