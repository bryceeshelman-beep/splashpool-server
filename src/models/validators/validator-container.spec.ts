import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { plainToInstance } from 'class-transformer';
import { useContainer, validate } from 'class-validator';

import { AuthorizationMessage } from '../stratum-messages/AuthorizationMessage';
import { MiningSubmitMessage } from '../stratum-messages/MiningSubmitMessage';
import { BitcoinAddressValidator } from './bitcoin-address.validator';
import { validatorContainer } from './validator-container';

describe('validatorContainer', () => {
    let module: TestingModule;
    let lookups: jest.SpyInstance;

    beforeEach(async () => {
        module = await Test.createTestingModule({
            providers: [BitcoinAddressValidator, { provide: ConfigService, useValue: { get: () => 'mainnet' } }],
        }).compile();
        lookups = jest.spyOn(module, 'get');
        useContainer(validatorContainer(module), { fallback: true, fallbackOnErrors: true });
    });

    afterEach(async () => {
        await module.close();
    });

    const submit = (nonce: string) => plainToInstance(MiningSubmitMessage, {
        id: 5, method: 'mining.submit', params: ['a.worker', '1', '0000000000000001', '64b3f3ec', nonce, '00002000'],
    });
    const login = (address: string) => plainToInstance(AuthorizationMessage, {
        id: 2, method: 'mining.authorize', params: [`${address}.worker`, 'x'],
    });

    it('asks Nest once per validator, however many shares come in', async () => {
        await validate(submit('ed460d91'));
        const first = lookups.mock.calls.length;
        expect(first).toBeGreaterThan(0);
        for (let i = 0; i < 100; i++) {
            await validate(submit('ed460d91'));
        }
        expect(lookups).toHaveBeenCalledTimes(first);
    });

    it('still applies the built-in validators', async () => {
        expect(await validate(submit('ed460d91'))).toHaveLength(0);
        expect(await validate(submit('0xed4609'))).not.toHaveLength(0);
        expect(await validate(submit('0ed460d91'))).not.toHaveLength(0);
    });

    it('still uses the address validator Nest configured', async () => {
        expect(await validate(login('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'))).toHaveLength(0);
        // Right checksum, wrong network: only the configured instance can tell.
        expect(await validate(login('tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4'))).not.toHaveLength(0);
        expect(await validate(login('not-an-address'))).not.toHaveLength(0);
    });
});
