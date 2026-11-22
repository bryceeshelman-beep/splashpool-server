import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Socket } from 'net';
import { BehaviorSubject, ReplaySubject } from 'rxjs';
import { DataSource } from 'typeorm';

import { MockRecording1 } from '../../test/models/MockRecording1';
import { AddressSettingsModule } from '../ORM/address-settings/address-settings.module';
import { AddressSettingsService } from '../ORM/address-settings/address-settings.service';
import { BlocksEntity } from '../ORM/blocks/blocks.entity';
import { BlocksService } from '../ORM/blocks/blocks.service';
import { ClientStatisticsEntity } from '../ORM/client-statistics/client-statistics.entity';
import { ClientStatisticsModule } from '../ORM/client-statistics/client-statistics.module';
import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { ClientEntity } from '../ORM/client/client.entity';
import { ClientModule } from '../ORM/client/client.module';
import { ClientService } from '../ORM/client/client.service';
import { BitcoinRpcService as MockBitcoinRpcService } from '../services/bitcoin-rpc.service';
import { NotificationService } from '../services/notification.service';
import { StratumV1JobsService } from '../services/stratum-v1-jobs.service';
import { IBlockTemplate } from './bitcoin-rpc/IBlockTemplate';
import { IMiningInfo } from './bitcoin-rpc/IMiningInfo';
import { MiningJob } from './MiningJob';
import { StratumV1Client } from './StratumV1Client';
import { MiningSubmitMessage } from './stratum-messages/MiningSubmitMessage';
import * as blockSubmission from '../splash/block-submission';





jest.mock('../services/bitcoin-rpc.service')

jest.mock('./validators/bitcoin-address.validator', () => ({
    IsBitcoinAddress() {
        return jest.fn();
    },
}));


describe('StratumV1Client', () => {


    let socket: Socket;
    let stratumV1JobsService: StratumV1JobsService;
    let bitcoinRpcService: MockBitcoinRpcService;

    let clientService: ClientService;
    let clientStatisticsService: ClientStatisticsService;
    let notificationService: NotificationService;
    let blocksService: BlocksService;
    let externalSharesService;
    let shareWindowService;
    let configService: ConfigService;

    let client: StratumV1Client;

    let socketEmitter: (...args: any[]) => void;
    const emitMessage = (message: string) => socketEmitter(Buffer.from(`${message}\n`));
    let consoleLogSpy: jest.SpyInstance;
    let consoleErrorSpy: jest.SpyInstance;
    let consoleWarnSpy: jest.SpyInstance;

    let newBlockEmitter: BehaviorSubject<IMiningInfo> = new BehaviorSubject({
        blocks: MockRecording1.BLOCK_TEMPLATE.height
    } as IMiningInfo);

    let moduleRef: TestingModule;

    beforeAll(async () => {
        moduleRef = await Test.createTestingModule({
            imports: [
                TypeOrmModule.forRoot({
                    type: 'sqlite',
                    database: ':memory:',
                    synchronize: true,
                    autoLoadEntities: true,
                    cache: true,
                    logging: false,
                    entities: [ClientEntity, ClientStatisticsEntity, BlocksEntity]
                }),
                ClientModule,
                ClientStatisticsModule,
                AddressSettingsModule
            ],
            providers: [
                {
                    provide: ConfigService,
                    useValue: {
                        get: jest.fn((key: string) => {
                            switch (key) {
                                case 'DEV_FEE_ADDRESS':
                                    return 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4';
                                case 'NETWORK':
                                    return 'testnet';
                            }
                            return null;
                        })
                    }
                }
            ],
        }).compile();


    })


    beforeEach(async () => {

        jest.useFakeTimers({ advanceTimers: true })
        jest.setSystemTime(new Date(parseInt(MockRecording1.TIME, 16) * 1000));
        consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
        consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

        clientService = moduleRef.get<ClientService>(ClientService);
        clientService.insertQueue = [];

        const dataSource = moduleRef.get<DataSource>(DataSource);

        await dataSource.getRepository(ClientStatisticsEntity).clear();
        await dataSource.getRepository(ClientEntity).clear();
        await dataSource.getRepository(BlocksEntity).clear();


        clientStatisticsService = moduleRef.get<ClientStatisticsService>(ClientStatisticsService);

        configService = moduleRef.get<ConfigService>(ConfigService);
        (configService.get as jest.Mock).mockImplementation((key: string) => {
            switch (key) {
                case 'DEV_FEE_ADDRESS':
                    return 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4';
                case 'NETWORK':
                    return 'testnet';
            }
            return null;
        });
        (StratumV1Client as any).blockedUserAgentLogState.clear();
        (StratumV1Client as any).validationErrorLogState.clear();

        bitcoinRpcService = new MockBitcoinRpcService(configService,null);
        jest.spyOn(bitcoinRpcService, 'getBlockTemplate').mockReturnValue(Promise.resolve(MockRecording1.BLOCK_TEMPLATE));
        bitcoinRpcService.newBlock$ = newBlockEmitter.asObservable();


        stratumV1JobsService = new StratumV1JobsService(bitcoinRpcService);

        socket = new Socket();
        // jest.spyOn(socket, 'on').mockImplementation((event: string, fn: (data: Buffer) => void) => {
        //     socketEmitter = fn;
        // });

        jest.spyOn(socket, 'on').mockImplementation((event: string, listener: (...args: any[]) => void) => {
            socketEmitter = listener;
            return socket;
        });

        socket.end = jest.fn();
        jest.spyOn(socket, 'destroy').mockImplementation(() => socket);

        const addressSettings = moduleRef.get<AddressSettingsService>(AddressSettingsService);
        notificationService = {
            notifySubscribersBlockFound: jest.fn().mockResolvedValue(undefined)
        } as any;
        blocksService = {
            save: jest.fn().mockResolvedValue(undefined)
        } as any;
        externalSharesService = {
            submitShare: jest.fn().mockResolvedValue(undefined)
        };
        shareWindowService = {
            recordShare: jest.fn()
        };


        client = new StratumV1Client(
            socket,
            stratumV1JobsService,
            bitcoinRpcService,
            clientService,
            clientStatisticsService,
            notificationService,
            blocksService,
            configService,
            addressSettings,
            externalSharesService,
            shareWindowService
        );

        client.extraNonceAndSessionId = MockRecording1.EXTRA_NONCE;
        jest.spyOn(client as any, 'getRandomHexString').mockReturnValue(MockRecording1.EXTRA_NONCE);

    });

    afterEach(async () => {
        client.destroy();
        consoleLogSpy.mockRestore();
        consoleErrorSpy.mockRestore();
        consoleWarnSpy.mockRestore();
        jest.useRealTimers();
    })


    it('should subscribe to socket', () => {
        expect(socket.on).toHaveBeenCalled();
    });

    it('should close socket on invalid JSON', () => {
        emitMessage('INVALID');
        jest.spyOn(socket, 'destroy');
        expect(socket.on).toHaveBeenCalled();
    });

    it('should respond to mining.subscribe', async () => {
        jest.spyOn(socket, 'write').mockImplementation((data) => true);

        expect(socket.on).toHaveBeenCalled();
        emitMessage(MockRecording1.MINING_SUBSCRIBE);

        await new Promise((r) => setTimeout(r, 1));

        expect(socket.write).toHaveBeenCalledWith(`{"id":1,"error":null,"result":[[["mining.notify","${client.extraNonceAndSessionId}"]],"${client.extraNonceAndSessionId}",8]}\n`, expect.any(Function));

    });

    it('should block non-compliant user agents on subscribe without allocating a session', async () => {
        (configService.get as jest.Mock).mockImplementation((key: string) => {
            switch (key) {
                case 'NON_COMPLIANT_USER_AGENTS':
                    return 'NMMiner';
                case 'DEV_FEE_ADDRESS':
                    return 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4';
                case 'NETWORK':
                    return 'testnet';
            }
            return null;
        });
        jest.spyOn(socket, 'write').mockImplementation((data) => true);

        emitMessage(`{"id":1,"method":"mining.subscribe","params":["NMMiner/1.0"]}`);
        await new Promise((r) => setTimeout(r, 1));

        expect(socket.destroy).toHaveBeenCalled();
        expect(socket.write).not.toHaveBeenCalled();
        expect((client as any).statistics).toBeUndefined();
        expect(consoleLogSpy).toHaveBeenCalledWith('Blocked non-compliant connection from userAgent: NMMiner');
    });

    it('should throttle repeated non-compliant user agent logs', async () => {
        (configService.get as jest.Mock).mockImplementation((key: string) => {
            switch (key) {
                case 'NON_COMPLIANT_USER_AGENTS':
                    return 'NMMiner';
                case 'DEV_FEE_ADDRESS':
                    return 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4';
                case 'NETWORK':
                    return 'testnet';
            }
            return null;
        });
        jest.spyOn(socket, 'write').mockImplementation((data) => true);

        emitMessage(`{"id":1,"method":"mining.subscribe","params":["NMMiner/1.0"]}`);
        await new Promise((r) => setTimeout(r, 1));

        const secondSocket = new Socket();
        jest.spyOn(secondSocket, 'on').mockImplementation((event: string, listener: (...args: any[]) => void) => {
            socketEmitter = listener;
            return secondSocket;
        });
        secondSocket.end = jest.fn();
        jest.spyOn(secondSocket, 'destroy').mockImplementation(() => secondSocket);
        const secondClient = new StratumV1Client(
            secondSocket,
            stratumV1JobsService,
            bitcoinRpcService,
            clientService,
            clientStatisticsService,
            notificationService,
            blocksService,
            configService,
            moduleRef.get<AddressSettingsService>(AddressSettingsService),
            externalSharesService
        );

        socketEmitter(Buffer.from(`{"id":1,"method":"mining.subscribe","params":["NMMiner/1.0"]}\n`));
        await new Promise((r) => setTimeout(r, 1));

        expect(secondSocket.destroy).toHaveBeenCalled();
        expect(consoleLogSpy.mock.calls.filter(call => call[0]?.startsWith('Blocked non-compliant connection'))).toHaveLength(1);
        await secondClient.destroy();
    });


    it('should respond to mining.configure', async () => {

        jest.spyOn(socket, 'write').mockImplementation((data) => true);

        expect(socket.on).toHaveBeenCalled();
        emitMessage(MockRecording1.MINING_CONFIGURE);
        await new Promise((r) => setTimeout(r, 1));
        expect(socket.write).toHaveBeenCalledWith(`{"id":2,"error":null,"result":{"version-rolling":true,"version-rolling.mask":"1fffe000"}}\n`, expect.any(Function));
    });

    it('should respond to mining.authorize', async () => {

        jest.spyOn(socket, 'write').mockImplementation((data) => true);

        expect(socket.on).toHaveBeenCalled();
        emitMessage(MockRecording1.MINING_AUTHORIZE);
        await new Promise((r) => setTimeout(r, 1));
        expect(socket.write).toHaveBeenCalledWith('{"id":3,"error":null,"result":true}\n', expect.any(Function));
    });

    it('should respond to mining.suggest_difficulty', async () => {
        jest.spyOn(socket, 'write').mockImplementation((data) => true);

        expect(socket.on).toHaveBeenCalled();
        emitMessage(MockRecording1.MINING_SUGGEST_DIFFICULTY);
        await new Promise((r) => setTimeout(r, 1));
        expect(socket.write).toHaveBeenCalledWith(`{"id":null,"method":"mining.set_difficulty","params":[512]}\n`, expect.any(Function));
    });

    it('should set difficulty', async () => {
        jest.spyOn(client as any, 'write').mockImplementation((data) => Promise.resolve(true));

        emitMessage(MockRecording1.MINING_SUBSCRIBE);
        emitMessage(MockRecording1.MINING_AUTHORIZE);
        await new Promise((r) => setTimeout(r, 100));

        expect((client as any).write).toHaveBeenCalledWith(`{"id":null,"method":"mining.set_difficulty","params":[100000]}\n`);

    });

    it('should save client', async () => {
        jest.spyOn(client as any, 'write').mockImplementation((data) => Promise.resolve(true));

        emitMessage(MockRecording1.MINING_SUBSCRIBE);
        emitMessage(`{"id": 4, "method": "mining.suggest_difficulty", "params": [0]}`);
        emitMessage(MockRecording1.MINING_AUTHORIZE);
        await new Promise((r) => setTimeout(r, 100));
        emitMessage(MockRecording1.MINING_SUBMIT);
        await new Promise((r) => setTimeout(r, 100));
        await clientService.insertClients();
        await new Promise((r) => setTimeout(r, 100));

        const clientCount = await clientService.connectedClientCount();
        expect(clientCount).toBe(1);

    });




    it('should send job and accept submission', async () => {



        const date = new Date(parseInt(MockRecording1.TIME, 16) * 1000);


        jest.setSystemTime(date);

        jest.spyOn(client as any, 'write').mockImplementation((data) => Promise.resolve(true));


        emitMessage(MockRecording1.MINING_SUBSCRIBE);
        emitMessage(`{"id": 4, "method": "mining.suggest_difficulty", "params": [0]}`);
        emitMessage(MockRecording1.MINING_AUTHORIZE);



        await new Promise((r) => setTimeout(r, 100));

        const notifyCall = (client as any).write.mock.calls
            .map(call => call[0])
            .find((message: string) => message.includes('"method":"mining.notify"'));
        const notify = JSON.parse(notifyCall);

        expect(notify.params[0]).toBe('1');
        expect(notify.params[5]).toBe('20000000');
        expect(notify.params[6]).toBe('192495f8');
        expect(notify.params[7]).toBe(MockRecording1.TIME);
        expect(notify.params[8]).toBe(true);


        emitMessage(MockRecording1.MINING_SUBMIT);

        jest.useRealTimers();
        await new Promise((r) => setTimeout(r, 1000));

        expect((client as any).write).lastCalledWith(`{\"id\":5,\"error\":null,\"result\":true}\n`);
        expect(shareWindowService.recordShare).toHaveBeenCalledTimes(1);
        expect(shareWindowService.recordShare).toHaveBeenCalledWith(
            'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4',
            (client as any).sessionDifficulty,
            expect.any(Number),
            'bitaxe3'
        );


    });

    it('should use the header-only fast path for non-block submissions', async () => {
        jest.spyOn(client as any, 'write').mockImplementation((data) => Promise.resolve(true));
        const buildHeaderSpy = jest.spyOn(MiningJob.prototype, 'buildHeaderBuffer');
        const fullBlockSpy = jest.spyOn(MiningJob.prototype, 'copyAndUpdateBlock');

        emitMessage(MockRecording1.MINING_SUBSCRIBE);
        emitMessage(`{"id": 4, "method": "mining.suggest_difficulty", "params": [0]}`);
        emitMessage(MockRecording1.MINING_AUTHORIZE);
        await new Promise((r) => setTimeout(r, 100));

        emitMessage(MockRecording1.MINING_SUBMIT);
        await new Promise((r) => setTimeout(r, 100));
        await clientService.insertClients();
        jest.useRealTimers();
        await new Promise((r) => setTimeout(r, 1000));

        expect(buildHeaderSpy).toHaveBeenCalled();
        expect(fullBlockSpy).not.toHaveBeenCalled();
    });

    it('should write accepted response before share accounting finishes', async () => {
        jest.spyOn(client as any, 'write').mockImplementation((data) => Promise.resolve(true));

        emitMessage(MockRecording1.MINING_SUBSCRIBE);
        emitMessage(`{"id": 4, "method": "mining.suggest_difficulty", "params": [0]}`);
        emitMessage(MockRecording1.MINING_AUTHORIZE);
        await new Promise((r) => setTimeout(r, 100));

        let finishAccounting: () => void;
        const accountingPromise = new Promise<void>((resolve) => {
            finishAccounting = resolve;
        });
        jest.spyOn((client as any).statistics, 'addShares').mockReturnValue(accountingPromise);

        emitMessage(MockRecording1.MINING_SUBMIT);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect((client as any).write).toHaveBeenCalledWith(`{"id":5,"error":null,"result":true}\n`);

        finishAccounting();
        jest.useRealTimers();
        await new Promise((r) => setTimeout(r, 100));
    });

    it('should update address best difficulty through the atomic path', async () => {
        jest.spyOn(client as any, 'write').mockImplementation((data) => Promise.resolve(true));
        jest.spyOn(client as any, 'calculateDifficulty').mockReturnValue({
            submissionDifficulty: 1024,
            submissionHash: 'share'
        });
        const addressSettings = moduleRef.get<AddressSettingsService>(AddressSettingsService);
        const getSettingsSpy = jest.spyOn(addressSettings, 'getSettings');
        const updateIfHigherSpy = jest.spyOn(addressSettings as any, 'updateBestDifficultyIfHigher').mockResolvedValue({ affected: 1 });
        const clientUpdateIfHigherSpy = jest.spyOn(clientService as any, 'updateBestDifficultyIfHigher').mockResolvedValue({ affected: 1 });

        emitMessage(MockRecording1.MINING_SUBSCRIBE);
        emitMessage(`{"id": 4, "method": "mining.suggest_difficulty", "params": [0]}`);
        emitMessage(MockRecording1.MINING_AUTHORIZE);
        await new Promise((r) => setTimeout(r, 100));

        emitMessage(MockRecording1.MINING_SUBMIT);
        await new Promise((r) => setTimeout(r, 100));
        await clientService.insertClients();
        jest.useRealTimers();
        await new Promise((r) => setTimeout(r, 1000));

        expect(updateIfHigherSpy).toHaveBeenCalledWith(
            'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4',
            1024,
            expect.any(String)
        );
        expect(clientUpdateIfHigherSpy).toHaveBeenCalledWith(expect.any(String), 1024);
        expect(getSettingsSpy).not.toHaveBeenCalled();
    });

    it('should reject duplicate submissions', async () => {
        jest.spyOn(client as any, 'write').mockImplementation((data) => Promise.resolve(true));

        emitMessage(MockRecording1.MINING_SUBSCRIBE);
        emitMessage(`{"id": 4, "method": "mining.suggest_difficulty", "params": [0]}`);
        emitMessage(MockRecording1.MINING_AUTHORIZE);
        await new Promise((r) => setTimeout(r, 100));

        emitMessage(MockRecording1.MINING_SUBMIT);
        await new Promise((r) => setTimeout(r, 100));
        emitMessage(MockRecording1.MINING_SUBMIT);
        await new Promise((r) => setTimeout(r, 100));

        expect((client as any).write).lastCalledWith(`{"id":5,"result":null,"error":[22,"Duplicate share",""]}\n`);
        expect(shareWindowService.recordShare).toHaveBeenCalledTimes(1);
    });

    it('should reject submissions for unknown jobs', async () => {
        jest.spyOn(client as any, 'write').mockImplementation((data) => Promise.resolve(true));
        const hashSpy = jest.spyOn(MiningSubmitMessage.prototype, 'hash');

        emitMessage(MockRecording1.MINING_SUBSCRIBE);
        emitMessage(`{"id": 4, "method": "mining.suggest_difficulty", "params": [0]}`);
        emitMessage(MockRecording1.MINING_AUTHORIZE);
        await new Promise((r) => setTimeout(r, 100));

        emitMessage(`{"id": 5, "method": "mining.submit", "params": ["tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4.bitaxe3", "ff", "c708000000000000", "64b3f3ec", "ed460d91", "00002000"]}`);
        await new Promise((r) => setTimeout(r, 100));

        expect((client as any).write).lastCalledWith(`{"id":5,"result":null,"error":[21,"Job not found",""]}\n`);
        expect(await clientService.connectedClientCount()).toBe(0);
        expect(hashSpy).not.toHaveBeenCalled();
    });

    it('should reject submissions when the job template has expired', async () => {
        jest.spyOn(client as any, 'write').mockImplementation((data) => Promise.resolve(true));

        emitMessage(MockRecording1.MINING_SUBSCRIBE);
        emitMessage(`{"id": 4, "method": "mining.suggest_difficulty", "params": [0]}`);
        emitMessage(MockRecording1.MINING_AUTHORIZE);
        await new Promise((r) => setTimeout(r, 100));
        stratumV1JobsService.blocks = {};

        emitMessage(MockRecording1.MINING_SUBMIT);
        await new Promise((r) => setTimeout(r, 100));

        expect((client as any).write).lastCalledWith(`{"id":5,"result":null,"error":[21,"Job Template not found",""]}\n`);
    });

    it('should reject low difficulty shares', async () => {
        jest.spyOn(client as any, 'write').mockImplementation((data) => Promise.resolve(true));

        emitMessage(MockRecording1.MINING_SUBSCRIBE);
        emitMessage(MockRecording1.MINING_SUGGEST_DIFFICULTY);
        emitMessage(MockRecording1.MINING_AUTHORIZE);
        await new Promise((r) => setTimeout(r, 100));

        emitMessage(MockRecording1.MINING_SUBMIT);
        await new Promise((r) => setTimeout(r, 100));

        expect((client as any).write).lastCalledWith(`{"id":5,"result":null,"error":[23,"Difficulty too low",""]}\n`);
        expect(await clientService.connectedClientCount()).toBe(0);
        expect(shareWindowService.recordShare).not.toHaveBeenCalled();
    });

    it('should reject submissions with short extranonce2 values', async () => {
        jest.spyOn(client as any, 'write').mockImplementation((data) => Promise.resolve(true));

        emitMessage(MockRecording1.MINING_SUBSCRIBE);
        emitMessage(MockRecording1.MINING_AUTHORIZE);
        await new Promise((r) => setTimeout(r, 100));

        emitMessage(`{"id": 5, "method": "mining.submit", "params": ["tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4.bitaxe3", "1", "c7080000", "64b3f3ec", "ed460d91", "00002000"]}`);
        await new Promise((r) => setTimeout(r, 100));

        expect((client as any).write).lastCalledWith(expect.stringContaining(`"error":[20,"Mining Submit validation error"`));
        expect(socket.destroy).toHaveBeenCalled();
        expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('Mining Submit validation error: extraNonce2:isLength'));
    });

    it('should throttle repeated mining submit validation logs', async () => {
        jest.spyOn(client as any, 'write').mockImplementation((data) => Promise.resolve(true));

        emitMessage(MockRecording1.MINING_SUBSCRIBE);
        emitMessage(MockRecording1.MINING_AUTHORIZE);
        await new Promise((r) => setTimeout(r, 100));

        emitMessage(`{"id": 5, "method": "mining.submit", "params": ["tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4.bitaxe3", "1", "c7080000", "64b3f3ec", "ed460d91", "00002000"]}`);
        await new Promise((r) => setTimeout(r, 100));

        const secondSocket = new Socket();
        jest.spyOn(secondSocket, 'on').mockImplementation((event: string, listener: (...args: any[]) => void) => {
            socketEmitter = listener;
            return secondSocket;
        });
        secondSocket.end = jest.fn();
        jest.spyOn(secondSocket, 'destroy').mockImplementation(() => secondSocket);
        const secondClient = new StratumV1Client(
            secondSocket,
            stratumV1JobsService,
            bitcoinRpcService,
            clientService,
            clientStatisticsService,
            notificationService,
            blocksService,
            configService,
            moduleRef.get<AddressSettingsService>(AddressSettingsService),
            externalSharesService
        );
        jest.spyOn(secondClient as any, 'write').mockImplementation((data) => Promise.resolve(true));
        jest.spyOn(secondClient as any, 'getRandomHexString').mockReturnValue(MockRecording1.EXTRA_NONCE);

        socketEmitter(Buffer.from(`${MockRecording1.MINING_SUBSCRIBE}\n`));
        socketEmitter(Buffer.from(`${MockRecording1.MINING_AUTHORIZE}\n`));
        await new Promise((r) => setTimeout(r, 100));
        socketEmitter(Buffer.from(`{"id": 5, "method": "mining.submit", "params": ["tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4.bitaxe3", "1", "c7080000", "64b3f3ec", "ed460d91", "00002000"]}\n`));
        await new Promise((r) => setTimeout(r, 100));

        expect(consoleWarnSpy.mock.calls.filter(call => call[0]?.startsWith('Mining Submit validation error'))).toHaveLength(1);
        await secondClient.destroy();
    });

    it('should close socket when a submit arrives before stratum is initialized', async () => {
        const endSpy = jest.spyOn(socket, 'end');

        emitMessage(MockRecording1.MINING_SUBMIT);
        await new Promise((r) => setTimeout(r, 100));

        expect(endSpy).toHaveBeenCalled();
    });

    it('should submit and persist found blocks', async () => {
        jest.spyOn(client as any, 'write').mockImplementation((data) => Promise.resolve(true));
        jest.spyOn(client as any, 'calculateDifficulty').mockReturnValue({
            submissionDifficulty: Number.MAX_SAFE_INTEGER,
            submissionHash: 'block-share'
        });
        const addressSettings = moduleRef.get<AddressSettingsService>(AddressSettingsService);
        jest.spyOn(addressSettings, 'resetBestDifficultyAndShares').mockResolvedValue(undefined);

        emitMessage(MockRecording1.MINING_SUBSCRIBE);
        emitMessage(`{"id": 4, "method": "mining.suggest_difficulty", "params": [0]}`);
        emitMessage(MockRecording1.MINING_AUTHORIZE);
        await new Promise((r) => setTimeout(r, 100));

        emitMessage(MockRecording1.MINING_SUBMIT);
        jest.useRealTimers();
        await new Promise((r) => setTimeout(r, 1000));

        expect(bitcoinRpcService.SUBMIT_BLOCK).toHaveBeenCalledWith(expect.any(String));
        expect(blocksService.save).toHaveBeenCalledWith(expect.objectContaining({
            height: MockRecording1.BLOCK_TEMPLATE.height,
            minerAddress: 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4',
            worker: 'bitaxe3',
            sessionId: MockRecording1.EXTRA_NONCE,
            blockData: expect.any(String)
        }));
        expect(notificationService.notifySubscribersBlockFound).toHaveBeenCalled();
        expect(addressSettings.resetBestDifficultyAndShares).toHaveBeenCalled();
        expect((client as any).write).lastCalledWith(`{"id":5,"error":null,"result":true}\n`);
    });

    it.each([
        ['high-hash', false],
        ['RPC_ERROR: timeout', false],
        ['inconclusive', false],
        ['SUCCESS!', true],
    ])('node answers %s: recorded as found = %s', async (answer, found) => {
        (bitcoinRpcService.SUBMIT_BLOCK as jest.Mock).mockResolvedValue(answer);
        (bitcoinRpcService.getBlockHash as jest.Mock).mockResolvedValue('someone else');
        jest.spyOn(blockSubmission, 'settleBlock').mockResolvedValue({ outcome: 'unknown', response: answer as string });
        jest.spyOn(client as any, 'write').mockImplementation((data) => Promise.resolve(true));
        jest.spyOn(client as any, 'calculateDifficulty').mockReturnValue({
            submissionDifficulty: Number.MAX_SAFE_INTEGER,
            submissionHash: 'block-share'
        });
        const addressSettings = moduleRef.get<AddressSettingsService>(AddressSettingsService);
        jest.spyOn(addressSettings, 'resetBestDifficultyAndShares').mockResolvedValue(undefined);

        emitMessage(MockRecording1.MINING_SUBSCRIBE);
        emitMessage(`{"id": 4, "method": "mining.suggest_difficulty", "params": [0]}`);
        emitMessage(MockRecording1.MINING_AUTHORIZE);
        await new Promise((r) => setTimeout(r, 100));

        emitMessage(MockRecording1.MINING_SUBMIT);
        jest.useRealTimers();
        await new Promise((r) => setTimeout(r, 1000));

        expect(blocksService.save).toHaveBeenCalledTimes(found ? 1 : 0);
        expect(notificationService.notifySubscribersBlockFound).toHaveBeenCalledTimes(found ? 1 : 0);
        expect(shareWindowService.recordShare).toHaveBeenCalledTimes(1);
    });

    it('records a block that is accepted on a retry', async () => {
        (bitcoinRpcService.SUBMIT_BLOCK as jest.Mock).mockResolvedValue('RPC_ERROR: timeout');
        (bitcoinRpcService.getBlockHash as jest.Mock).mockResolvedValue('someone else');
        jest.spyOn(blockSubmission, 'settleBlock').mockResolvedValue({ outcome: 'accepted', response: 'SUCCESS!' });
        jest.spyOn(client as any, 'write').mockImplementation((data) => Promise.resolve(true));
        jest.spyOn(client as any, 'calculateDifficulty').mockReturnValue({
            submissionDifficulty: Number.MAX_SAFE_INTEGER,
            submissionHash: 'block-share'
        });
        const addressSettings = moduleRef.get<AddressSettingsService>(AddressSettingsService);
        jest.spyOn(addressSettings, 'resetBestDifficultyAndShares').mockResolvedValue(undefined);

        emitMessage(MockRecording1.MINING_SUBSCRIBE);
        emitMessage(`{"id": 4, "method": "mining.suggest_difficulty", "params": [0]}`);
        emitMessage(MockRecording1.MINING_AUTHORIZE);
        await new Promise((r) => setTimeout(r, 100));

        emitMessage(MockRecording1.MINING_SUBMIT);
        jest.useRealTimers();
        await new Promise((r) => setTimeout(r, 1000));

        expect(blocksService.save).toHaveBeenCalledTimes(1);
        expect(notificationService.notifySubscribersBlockFound).toHaveBeenCalledTimes(1);
    });




    describe('Splash minimum difficulty', () => {
        const withConfig = (extra: Record<string, string>) => {
            (configService.get as jest.Mock).mockImplementation((key: string) => {
                if (key in extra) {
                    return extra[key];
                }
                switch (key) {
                    case 'DEV_FEE_ADDRESS':
                        return 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4';
                    case 'NETWORK':
                        return 'testnet';
                }
                return null;
            });
            (client as any).minDifficultyCache = undefined;
        };

        it('raises a too-low suggest_difficulty to the floor', async () => {
            withConfig({ SPLASH_MIN_DIFFICULTY: '512' });
            jest.spyOn(socket, 'write').mockImplementation((data) => true);
            emitMessage(`{"id": 4, "method": "mining.suggest_difficulty", "params": [0.00001]}`);
            await new Promise((r) => setTimeout(r, 1));
            expect((client as any).sessionDifficulty).toBe(512);
            expect(socket.write).toHaveBeenCalledWith(`{"id":null,"method":"mining.set_difficulty","params":[512]}\n`, expect.any(Function));
        });

        it('keeps a suggestion above the floor', async () => {
            withConfig({ SPLASH_MIN_DIFFICULTY: '512' });
            jest.spyOn(socket, 'write').mockImplementation((data) => true);
            emitMessage(`{"id": 4, "method": "mining.suggest_difficulty", "params": [4096]}`);
            await new Promise((r) => setTimeout(r, 1));
            expect((client as any).sessionDifficulty).toBe(4096);
        });

        it('defaults to 512 on mainnet and off elsewhere; ignores invalid values', () => {
            withConfig({ NETWORK: 'mainnet' });
            expect((client as any).minDifficulty).toBe(512);
            withConfig({});
            expect((client as any).minDifficulty).toBe(0);
            withConfig({ NETWORK: 'mainnet', SPLASH_MIN_DIFFICULTY: 'abc' });
            expect((client as any).minDifficulty).toBe(512);
            withConfig({ NETWORK: 'mainnet', SPLASH_MIN_DIFFICULTY: '0' });
            expect((client as any).minDifficulty).toBe(0);
        });

        it('does not let vardiff decay below the floor', async () => {
            withConfig({ SPLASH_MIN_DIFFICULTY: '512' });
            jest.spyOn(client as any, 'write').mockImplementation((data) => Promise.resolve(true));
            const socketWrite = jest.spyOn(socket, 'write').mockImplementation((data) => true);
            emitMessage(MockRecording1.MINING_SUBSCRIBE);
            emitMessage(`{"id": 4, "method": "mining.suggest_difficulty", "params": [512]}`);
            emitMessage(MockRecording1.MINING_AUTHORIZE);
            await new Promise((r) => setTimeout(r, 100));
            jest.spyOn((client as any).statistics, 'getSuggestedDifficulty').mockReturnValue(0.5);
            socketWrite.mockClear();
            await (client as any).checkDifficulty();
            expect((client as any).sessionDifficulty).toBe(512);
            expect(socketWrite).not.toHaveBeenCalledWith(expect.stringContaining('set_difficulty'));
        });

        it('accepts a block solution below the session difficulty', async () => {
            jest.spyOn(client as any, 'write').mockImplementation((data) => Promise.resolve(true));
            const addressSettings = moduleRef.get<AddressSettingsService>(AddressSettingsService);
            jest.spyOn(addressSettings, 'resetBestDifficultyAndShares').mockResolvedValue(undefined);
            emitMessage(MockRecording1.MINING_SUBSCRIBE);
            emitMessage(`{"id": 4, "method": "mining.suggest_difficulty", "params": [${Number.MAX_SAFE_INTEGER}]}`);
            emitMessage(MockRecording1.MINING_AUTHORIZE);
            await new Promise((r) => setTimeout(r, 100));
            jest.spyOn(client as any, 'calculateDifficulty').mockReturnValue({
                submissionDifficulty: Number.MAX_SAFE_INTEGER - 1,
                submissionHash: 'block-share'
            });
            emitMessage(MockRecording1.MINING_SUBMIT);
            jest.useRealTimers();
            await new Promise((r) => setTimeout(r, 1000));
            expect((client as any).sessionDifficulty).toBe(Number.MAX_SAFE_INTEGER);
            expect(bitcoinRpcService.SUBMIT_BLOCK).toHaveBeenCalled();
            expect((client as any).write).lastCalledWith(`{"id":5,"error":null,"result":true}\n`);
        });
    });


    describe('duplicate shares', () => {
        const [user, jobId, en2, ntime, nonce, version] = JSON.parse(MockRecording1.MINING_SUBMIT).params;
        const submit = async (...fields: any[]) => {
            emitMessage(JSON.stringify({ id: 5, method: 'mining.submit', params: [user, ...fields] }));
            await new Promise((r) => setTimeout(r, 100));
        };
        const replies = () => (client as any).write.mock.calls.map(c => c[0]).join('');
        beforeEach(async () => {
            jest.spyOn(client as any, 'write').mockResolvedValue(true);
            emitMessage(MockRecording1.MINING_SUBSCRIBE);
            emitMessage('{"id":4,"method":"mining.suggest_difficulty","params":[0]}');
            emitMessage(MockRecording1.MINING_AUTHORIZE);
            await new Promise((r) => setTimeout(r, 100));
        });

        const up = (s: string) => s.toUpperCase();
        it.each([
            ['uppercase extranonce2', [en2, ntime, nonce, version], [up(en2), ntime, nonce, version]],
            ['uppercase ntime', [en2, ntime, nonce, version], [en2, up(ntime), nonce, version]],
            ['uppercase nonce', [en2, ntime, nonce, version], [en2, ntime, up(nonce), version]],
            ['uppercase version', [en2, ntime, nonce, '0000a000'], [en2, ntime, nonce, '0000A000']],
            ['mixed case', [en2, ntime, nonce, version], [en2, ntime, 'Ed460D91', version]],
            ['omitted, then zero version', [en2, ntime, nonce], [en2, ntime, nonce, '00000000']],
            ['zero, then omitted version', [en2, ntime, nonce, '00000000'], [en2, ntime, nonce]],
            ['omitted, then null version', [en2, ntime, nonce], [en2, ntime, nonce, null]],
        ])('credits once: %s', async (_, first, second) => {
            await submit(jobId, ...first);
            await submit(jobId, ...second);
            expect(shareWindowService.recordShare).toHaveBeenCalledTimes(1);
            expect(replies()).toContain('Duplicate share');
        });

        it('credits once: the same header under two job ids', async () => {
            stratumV1JobsService.jobs['2'] = stratumV1JobsService.jobs[jobId];
            await submit(jobId, en2, ntime, nonce, version);
            await submit('2', en2, ntime, nonce, version);
            expect(shareWindowService.recordShare).toHaveBeenCalledTimes(1);
        });

        it('credits once: XOR and BIP310 encodings of one version', async () => {
            const template = stratumV1JobsService.getJobTemplateById('1');
            // A signalling bit inside the mask is where the two readings differ.
            template.block.version ^= 0x10000000;
            template.blockData.networkDifficulty = 100;
            const spy = jest.spyOn(client as any, 'calculateDifficulty').mockReturnValue({ submissionDifficulty: 10 });
            await submit(jobId, en2, ntime, nonce, version);
            const real = spy.mock.calls[0][0] as Buffer;
            // Only the real header meets the difficulty, so the BIP310 fallback must find it.
            spy.mockImplementation((h: Buffer) => ({ submissionDifficulty: h.equals(real) ? 10 : 1 }));
            (client as any).sessionDifficulty = 5;
            (client as any).issuedJobs?.set(jobId, 5);
            await submit(jobId, en2, ntime, nonce, '10002000');
            expect(shareWindowService.recordShare).toHaveBeenCalledTimes(1);
            expect(replies()).toContain('Duplicate share');
        });

        it.each([0, 1, 2, 3])('refuses a padded copy of field %i', async (i) => {
            const fields = [en2, ntime, nonce, version];
            await submit(jobId, ...fields);
            fields[i] = `0${fields[i]}`;
            await submit(jobId, ...fields);
            expect(shareWindowService.recordShare).toHaveBeenCalledTimes(1);
            expect(replies()).toContain('Mining Submit validation error');
        });

        it('still credits a different nonce', async () => {
            await submit(jobId, en2, ntime, nonce, version);
            await submit(jobId, en2, ntime, 'ed460d92', version);
            expect(shareWindowService.recordShare).toHaveBeenCalledTimes(2);
        });

        it('submits exactly the header it checked', async () => {
            const spy = jest.spyOn(client as any, 'calculateDifficulty')
                .mockReturnValue({ submissionDifficulty: Number.MAX_SAFE_INTEGER, submissionHash: 'block' });
            jest.spyOn(moduleRef.get<AddressSettingsService>(AddressSettingsService), 'resetBestDifficultyAndShares').mockResolvedValue(undefined);
            await submit(jobId, up(en2), up(ntime), up(nonce), version);
            const blockHex = (bitcoinRpcService.SUBMIT_BLOCK as jest.Mock).mock.calls.slice(-1)[0][0];
            expect(blockHex.slice(0, 160)).toBe((spy.mock.calls[0][0] as Buffer).toString('hex'));
        });
    });

    describe('share credit', () => {
        const [user, , en2, ntime, nonce, version] = JSON.parse(MockRecording1.MINING_SUBMIT).params;
        const address = user.split('.')[0];
        const tick = () => new Promise((r) => setTimeout(r, 100));
        const send = async (method: string, ...params: any[]) => {
            emitMessage(JSON.stringify({ id: method === 'mining.submit' ? 5 : 3, method, params }));
            await tick();
        };
        const submit = (id = '1', t = ntime, n = nonce, v = version) => send('mining.submit', user, id, en2, t, n, v);
        const login = async (password = 'x') => {
            emitMessage(MockRecording1.MINING_SUBSCRIBE);
            await send('mining.authorize', user, password);
            stratumV1JobsService.getJobTemplateById('1').blockData.networkDifficulty = 1e14;
        };
        const credits = () => shareWindowService.recordShare.mock.calls.map(c => c[1]);
        const replies = () => (client as any).write.mock.calls.map(c => c[0]).join('');
        const notifies = () => (client as any).write.mock.calls.filter(c => c[0].includes('"method":"mining.notify"')).length;
        let difficulty: jest.SpyInstance;
        beforeEach(() => {
            jest.spyOn(client as any, 'write').mockResolvedValue(true);
            jest.spyOn(socket, 'write').mockImplementation(() => true);
            difficulty = jest.spyOn(client as any, 'calculateDifficulty').mockReturnValue({ submissionDifficulty: 1e6 });
            const settings = moduleRef.get<AddressSettingsService>(AddressSettingsService);
            jest.spyOn(settings, 'updateBestDifficultyIfHigher').mockResolvedValue(undefined);
            jest.spyOn(settings, 'resetBestDifficultyAndShares').mockResolvedValue(undefined);
        });

        it('honours d= at the first login', async () => {
            await login('d=200000');
            await submit();
            expect(credits()).toEqual([200000]);
        });

        it.each(['1000000', '1000000000000000', '9'.repeat(60)])('ignores d=%s on a later login', async (d) => {
            await login();
            await send('mining.authorize', user, `d=${d}`);
            await submit();
            expect(credits()).toEqual([100000]);
            expect((client as any).sessionDifficulty).toBe(100000);
        });

        it('credits the issued difficulty when it changes during the reply write', async () => {
            await login();
            let release: () => void;
            (client as any).write.mockImplementation((m: string) => m.startsWith('{"id":5,')
                ? new Promise(r => release = () => r(true)) : Promise.resolve(true));
            await submit();
            (client as any).sessionDifficulty = 1e15;
            release();
            await tick();
            expect(credits()).toEqual([100000]);
        });

        it('keeps each job at its own difficulty across a retarget', async () => {
            await login();
            jest.spyOn((client as any).statistics, 'getSuggestedDifficulty').mockReturnValue(400000);
            await (client as any).checkDifficulty();
            await submit('1');
            await submit('2');
            expect(credits()).toEqual([100000, 400000]);
        });

        it('applies a lower retarget only to the new job', async () => {
            await login();
            jest.spyOn((client as any).statistics, 'getSuggestedDifficulty').mockReturnValue(4096);
            await (client as any).checkDifficulty();
            difficulty.mockReturnValue({ submissionDifficulty: 50000 });
            await submit('1');
            expect(replies()).toContain('Difficulty too low');
            await submit('2');
            expect(credits()).toEqual([4096]);
        });

        it('makes every job different work, so one hash has one difficulty', async () => {
            await login();
            jest.spyOn((client as any).statistics, 'getSuggestedDifficulty').mockReturnValue(400000);
            await (client as any).checkDifficulty();
            await submit('1');
            await submit('2');
            const [a, b] = difficulty.mock.calls.map(c => c[0] as Buffer);
            expect(a.equals(b)).toBe(false);
        });

        it('sends a new job for a suggestion that follows the first job', async () => {
            await login();
            expect(notifies()).toBe(1);
            await send('mining.suggest_difficulty', 512);
            expect(notifies()).toBe(2);
            await submit('2');
            expect(credits()).toEqual([512]);
        });

        it('takes one suggestion even when two arrive together', async () => {
            await login();
            emitMessage('{"id":8,"method":"mining.suggest_difficulty","params":[512]}');
            emitMessage('{"id":9,"method":"mining.suggest_difficulty","params":[9000000]}');
            await tick();
            expect((client as any).sessionDifficulty).toBe(512);
        });

        it('credits a block at no more than the network difficulty', async () => {
            await login('d=1000000000000000');
            difficulty.mockReturnValue({ submissionDifficulty: 2e14 });
            await submit();
            expect(credits()).toEqual([1e14]);
        });

        it('refuses a job issued to another connection', async () => {
            await login();
            stratumV1JobsService.jobs['abc'] = stratumV1JobsService.jobs['1'];
            await submit('abc');
            expect(credits()).toEqual([]);
            expect(replies()).toContain('Job not found');
        });

        it('forgets issued jobs on a new block', async () => {
            await login();
            expect([...((client as any).issuedJobs?.keys() ?? [])]).toEqual(['1']);
            newBlockEmitter.next({ blocks: MockRecording1.BLOCK_TEMPLATE.height + 1 } as IMiningInfo);
            await tick();
            const held = [...((client as any).issuedJobs?.keys() ?? [])];
            newBlockEmitter.next({ blocks: MockRecording1.BLOCK_TEMPLATE.height } as IMiningInfo);
            expect(held).toEqual(['2']);
        });

        const hex = (n: number) => n.toString(16).padStart(8, '0');
        it.each([
            ['before mintime', (min: number) => min - 1, false],
            ['at mintime', (min: number) => min, true],
            ['two hours ahead', (_, now: number) => now + 7199, true],
            ['over two hours ahead', (_, now: number) => now + 7210, false],
            ['year 2106', () => 0xffffffff, false],
        ])('ntime %s', async (_, pick: (min: number, now: number) => number, accepted) => {
            await login();
            await submit('1', hex(pick(MockRecording1.BLOCK_TEMPLATE.mintime, Math.floor(Date.now() / 1000))));
            expect(credits()).toHaveLength(accepted ? 1 : 0);
            if (!accepted) expect(replies()).toContain('Invalid ntime');
        });

        it.each([
            ['00002000', true], ['1fffe000', true], ['1005c000', true],
            ['00001000', false], ['00000001', false], ['20000000', false], ['80000000', false], ['ffffffff', false],
        ])('version bits %s accepted=%s', async (bits, accepted) => {
            await login();
            await submit('1', ntime, nonce, bits);
            expect(credits()).toHaveLength(accepted ? 1 : 0);
            if (!accepted) expect(replies()).toContain('Invalid version bits');
        });
    });

    describe('input limits', () => {
        beforeEach(() => jest.spyOn(client as any, 'write').mockResolvedValue(true));

        it('closes on a partial line over 16 KiB, even in small chunks', () => {
            for (let i = 0; i < 17; i++) socketEmitter(Buffer.alloc(1024, 'x'));
            expect(socket.destroy).toHaveBeenCalled();
            expect((client as any).buffer).toBe('');
        });

        it('closes on a complete line over 16 KiB', () => {
            emitMessage(JSON.stringify({ method: 'none', pad: 'x'.repeat(17000) }));
            expect(socket.destroy).toHaveBeenCalled();
        });

        it('closes when over 1 MiB is waiting to be processed', () => {
            jest.spyOn(client as any, 'handleMessage').mockReturnValue(new Promise(() => undefined));
            const chunk = Buffer.from(`${'x'.repeat(1023)}\n`.repeat(64));
            for (let i = 0; i < 17; i++) socketEmitter(chunk);
            expect(socket.destroy).toHaveBeenCalled();
        });

        it('leaves a normal split message alone', async () => {
            const m = `${MockRecording1.MINING_SUBSCRIBE}\n`;
            socketEmitter(Buffer.from(m.slice(0, 10)));
            socketEmitter(Buffer.from(m.slice(10)));
            await new Promise((r) => setTimeout(r, 50));
            expect(socket.destroy).not.toHaveBeenCalled();
            expect((client as any).write).toHaveBeenCalled();
        });
    });

    describe('payout safety', () => {
        let ready$: ReplaySubject<void>;
        let payouts: any;
        const notified = () => (client as any).write.mock.calls.some(c => c[0].includes('"method":"mining.notify"'));
        const connect = async () => {
            emitMessage(MockRecording1.MINING_SUBSCRIBE);
            emitMessage(MockRecording1.MINING_AUTHORIZE);
            await new Promise((r) => setTimeout(r, 100));
        };
        beforeEach(() => {
            ready$ = new ReplaySubject<void>(1);
            payouts = {
                enabled: true, ready: false, ready$,
                outputsFor: jest.fn((address, value) => [{ address, value }]),
            };
            (client as any).payoutService = payouts;
            jest.spyOn(client as any, 'write').mockResolvedValue(true);
        });

        it('holds jobs until the first window read, then sends one', async () => {
            await connect();
            jest.spyOn((client as any).statistics, 'getSuggestedDifficulty').mockReturnValue(4096);
            jest.spyOn(socket, 'write').mockImplementation(() => true);
            await (client as any).checkDifficulty(); // a retarget must not slip a job out
            expect(notified()).toBe(false);
            expect(payouts.outputsFor).not.toHaveBeenCalled();
            expect(socket.destroy).not.toHaveBeenCalled();
            payouts.ready = true;
            ready$.next();
            await new Promise((r) => setTimeout(r, 100));
            expect(notified()).toBe(true);
        });

        it.each(['output building', 'coinbase building'])('closes only this connection when %s throws', async (stage) => {
            payouts.ready = true;
            ready$.next();
            payouts.outputsFor.mockImplementation((_, value) => {
                if (stage === 'output building') throw new Error('bad');
                return [{ address: 'not-an-address', value }];
            });
            await connect();
            expect(notified()).toBe(false);
            expect(socket.destroy).toHaveBeenCalled();
            expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('no job built'), expect.anything());
        });
    });

    describe('Splash reject limit', () => {
        const withConfig = (extra: Record<string, string>) => {
            (configService.get as jest.Mock).mockImplementation((key: string) => {
                if (key in extra) {
                    return extra[key];
                }
                switch (key) {
                    case 'DEV_FEE_ADDRESS':
                        return 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4';
                    case 'NETWORK':
                        return 'testnet';
                }
                return null;
            });
        };
        const note = (accepted: boolean, n: number) => {
            let closed = false;
            for (let i = 0; i < n; i++) {
                closed = (client as any).noteShareResult(accepted) || closed;
            }
            return closed;
        };

        beforeEach(() => {
            jest.spyOn(console, 'warn').mockImplementation(() => undefined);
            (StratumV1Client as any).rejectKickLog.nextLogAt = 0;
        });

        it('disconnects at 200 rejects when nearly everything is rejected', () => {
            withConfig({});
            expect(note(false, 199)).toBe(false);
            expect(socket.destroy).not.toHaveBeenCalled();
            expect(note(false, 1)).toBe(true);
            expect(socket.destroy).toHaveBeenCalled();
        });

        it('keeps a connection whose rejects are a minority', () => {
            withConfig({});
            note(true, 1000);
            expect(note(false, 300)).toBe(false);
            expect(socket.destroy).not.toHaveBeenCalled();
        });

        it('starts counting again each minute', () => {
            withConfig({});
            const now = jest.spyOn(Date, 'now');
            now.mockReturnValue(1_000_000);
            note(false, 150);
            now.mockReturnValue(1_000_000 + 60_000);
            expect(note(false, 150)).toBe(false);
            expect(socket.destroy).not.toHaveBeenCalled();
            now.mockRestore();
        });

        it('honours SPLASH_REJECT_LIMIT and SPLASH_REJECT_RATIO; 0 turns it off', () => {
            withConfig({ SPLASH_REJECT_LIMIT: '0' });
            expect(note(false, 5000)).toBe(false);
            (client as any).rejectWindowStart = 0;
            withConfig({ SPLASH_REJECT_LIMIT: '10', SPLASH_REJECT_RATIO: '0.5' });
            note(true, 10);
            expect(note(false, 10)).toBe(true);
        });

        it('disconnects a client that floods duplicate shares', async () => {
            withConfig({});
            jest.spyOn(client as any, 'write').mockImplementation((data) => Promise.resolve(true));
            emitMessage(MockRecording1.MINING_SUBSCRIBE);
            emitMessage(`{"id": 4, "method": "mining.suggest_difficulty", "params": [0]}`);
            emitMessage(MockRecording1.MINING_AUTHORIZE);
            await new Promise((r) => setTimeout(r, 100));
            for (let i = 0; i < 201; i++) {
                emitMessage(MockRecording1.MINING_SUBMIT);
            }
            jest.useRealTimers();
            await new Promise((r) => setTimeout(r, 1500));
            expect(socket.destroy).toHaveBeenCalled();
            expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('200 rejected / 201 shares'));
        });
    });

});
