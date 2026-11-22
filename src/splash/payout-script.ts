import { AddressType, getAddressInfo } from 'bitcoin-address-validation';
import * as bitcoinjs from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';

// Taproot addresses need the ECC library to check the key is on the curve.
bitcoinjs.initEccLib(ecc);

/**
 * The one address -> output script function, used at login, in the window
 * filter, for sizing and in the coinbase. Throws for anything we can't pay.
 */
export function payoutScript(address: string, network: bitcoinjs.networks.Network): Buffer {
    switch (getAddressInfo(address).type) {
        case AddressType.p2wpkh: return bitcoinjs.payments.p2wpkh({ address, network }).output;
        case AddressType.p2pkh: return bitcoinjs.payments.p2pkh({ address, network }).output;
        case AddressType.p2sh: return bitcoinjs.payments.p2sh({ address, network }).output;
        case AddressType.p2tr: return bitcoinjs.payments.p2tr({ address, network }).output;
        case AddressType.p2wsh: return bitcoinjs.payments.p2wsh({ address, network }).output;
        // Never pay an empty script: anyone could spend it.
        default: throw new Error(`Unsupported payout address type for ${address}`);
    }
}
