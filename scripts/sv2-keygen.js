#!/usr/bin/env node
// Makes the pool's Stratum V2 authority key (sv2-spec 4.7).
//
//   npm run build && node scripts/sv2-keygen.js <key file>
//
// Writes the secret to <key file> (mode 0600; never overwrites an existing
// file) and prints only the public key, in the base58-check form miners paste
// into AxeOS ("Authority Public Key") and the pool publishes. Keep the key
// file out of git (*.key is ignored) and back it up: a new key means every
// miner must update theirs. Use a separate key per network.
'use strict';
const fs = require('fs');
const path = require('path');

const file = process.argv[2];
if (!file) {
    console.error('usage: node scripts/sv2-keygen.js <key file>');
    process.exit(2);
}
const { generateAuthority, serializeAuthorityFile, loadAuthorityFile } = require(path.join(__dirname, '..', 'dist', 'sv2', 'authority'));

const key = generateAuthority();
let fd;
try {
    fd = fs.openSync(file, 'wx', 0o600);
} catch (e) {
    console.error(e.code === 'EEXIST' ? `${file} already exists; not overwriting it.` : `cannot create ${file}: ${e.message}`);
    process.exit(1);
}
fs.writeSync(fd, serializeAuthorityFile(key));
fs.fsyncSync(fd);
fs.closeSync(fd);
// Read it back the way the pool will.
const check = loadAuthorityFile(file);
if (check.base58 !== key.base58) {
    console.error('internal error: key file does not read back');
    process.exit(1);
}
console.log(`Secret key written to ${path.resolve(file)} (mode 600). Do not share or commit it.`);
console.log('SV2 authority public key (publish this; miners paste it into AxeOS):');
console.log(key.base58);
