import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { validate } from 'bitcoin-address-validation';
import { registerDecorator, ValidationOptions, ValidatorConstraint, ValidatorConstraintInterface } from 'class-validator';

import { isPayableAddress, networkFromConfig } from '../../splash/payout.service';

@ValidatorConstraint({ name: 'bitcoinAddress', async: false })
@Injectable()
export class BitcoinAddressValidator implements ValidatorConstraintInterface {

    constructor(
        private configService: ConfigService
    ) { }

    validate(value: string): boolean {
        const network = this.configService.get('NETWORK');
        // A good checksum isn't enough: the coinbase must be able to pay it.
        return validate(value, network) && isPayableAddress(value, networkFromConfig(network));
    }

    defaultMessage(): string {
        return 'Must be a bitcoin address';
    }
}

export function IsBitcoinAddress(validationOptions?: ValidationOptions) {
    return function (object: Object, propertyName: string) {
        registerDecorator({
            name: 'isBitcoinAddress',
            target: object.constructor,
            propertyName: propertyName,
            constraints: [],
            options: validationOptions,
            validator: BitcoinAddressValidator,
        });
    };
}