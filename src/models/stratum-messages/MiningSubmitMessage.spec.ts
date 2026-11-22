import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { MiningSubmitMessage } from './MiningSubmitMessage';

describe('MiningSubmitMessage', () => {


    beforeEach(async () => {



    });

    describe('test message parsing', () => {

        const MINING_SUBMIT_MESSAGE = ' {"id": 5, "method": "mining.submit", "params": ["tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4.bitaxe3", "1", "9902000000000000", "64b1f10f", "2402812d", "00006000"]}'

        const message = plainToInstance(
            MiningSubmitMessage,
            JSON.parse(MINING_SUBMIT_MESSAGE),
        );

        it('should parse message', () => {
            expect(message.id).toEqual(5);
            expect(message.userId).toEqual('tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4.bitaxe3');
            expect(message.jobId).toEqual('1');
            expect(message.extraNonce2).toEqual('9902000000000000');
            expect(message.ntime).toEqual('64b1f10f');
            expect(message.nonce).toEqual('2402812d');
            expect(message.versionMask).toEqual('00006000');
        });

        it('should validate 8-byte extranonce2 submissions', async () => {
            const errors = await validate(message);

            expect(errors).toEqual([]);
        });

        it('should reject short extranonce2 submissions', async () => {
            const shortMessage = plainToInstance(
                MiningSubmitMessage,
                JSON.parse(' {"id": 5, "method": "mining.submit", "params": ["tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4.bitaxe3", "1", "99020000", "64b1f10f", "2402812d", "00006000"]}'),
            );

            const errors = await validate(shortMessage);

            expect(errors.some(error => error.property === 'extraNonce2')).toBe(true);
        });

        const valid = ['user', '1', '9902000000000000', '64b1f10f', '2402812d', '00006000'];
        const badForms: [string, (s: string) => any][] = [
            ['leading zero', s => `0${s}`], ['short', s => s.slice(1)], ['0x prefix', s => `0x${s.slice(2)}`],
            ['leading space', s => ` ${s.slice(1)}`], ['trailing space', s => `${s.slice(1)} `],
            ['newline', s => `${s.slice(1)}\n`], ['sign', s => `+${s.slice(1)}`],
            ['trailing junk', s => `${s.slice(1)}z`], ['empty', () => ''], ['number', () => 12345678],
        ];
        const cases = [[2, 'extraNonce2'], [3, 'ntime'], [4, 'nonce'], [5, 'versionMask']]
            .flatMap(([i, field]) => badForms.map(([form, change]) => [field, form, i, change] as const));
        it.each(cases)('rejects %s: %s', async (field, _, i, change) => {
            const params: any[] = [...valid];
            params[i] = change(valid[i]);
            const errors = await validate(plainToInstance(MiningSubmitMessage, { id: 5, method: 'mining.submit', params }));
            expect(errors.map(e => e.property)).toContain(field);
        });

        it('should reject long extranonce2 submissions', async () => {
            const longMessage = plainToInstance(
                MiningSubmitMessage,
                JSON.parse(' {"id": 5, "method": "mining.submit", "params": ["tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4.bitaxe3", "1", "990200000000000000", "64b1f10f", "2402812d", "00006000"]}'),
            );

            const errors = await validate(longMessage);

            expect(errors.some(error => error.property === 'extraNonce2')).toBe(true);
        });
    });


});
