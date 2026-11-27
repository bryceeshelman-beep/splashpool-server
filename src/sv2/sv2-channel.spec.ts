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
import { Sv2Channel, Sv2ChannelType } from './sv2-channel';

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

    async function openChannel(type: Sv2ChannelType, startDifficulty: number) {
        const bitcoinRpcService = new BitcoinRpcService(configService, null);
        jest.spyOn(bitcoinRpcService, 'getBlockTemplate').mockResolvedValue(MockRecording1.BLOCK_TEMPLATE);
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
});
