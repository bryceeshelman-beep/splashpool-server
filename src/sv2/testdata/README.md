# SV2 test data

- `ellswift_decode_test_vectors.csv`, `xswiftec_inv_test_vectors.csv`,
  `packet_encoding_test_vectors.csv`: unchanged from BIP324,
  https://github.com/bitcoin/bips/tree/master/bip-0324 (BSD-3-Clause).
- `esp-miner-v2.14.0-codec.json`: frames built by, and parse results from,
  ESP-Miner v2.14.0's `components/stratum_v2/sv2_protocol.c`
  (https://github.com/bitaxeorg/ESP-Miner, GPL-3.0), compiled on a PC with
  stub headers for `utils.h`/`stdlib.h`. Only the outputs are kept here, so the
  codec stays checked against real Bitaxe firmware without a C toolchain.
  `firmwareBuilt`: messages the Bitaxe sends, which we must decode and
  re-encode byte for byte. `firmwareParsed`: messages we send, with what the
  firmware read back from them.
