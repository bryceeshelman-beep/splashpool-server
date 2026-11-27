# Stratum V2

The pool can take Stratum V2 miners (Mining Protocol only) on a port of its
own, beside Stratum V1. Every SV2 channel is an ordinary pool session: the
same jobs, share checks, vardiff, Splash Bonus, fee and payout split as V1
(docs/SPLASH-PAYOUTS.md). Identity is `address.worker`, as in V1.

Not offered: Job Declaration, Template Distribution, group channels.

## Pool operator

1. Make the authority key (keep the file out of git and back it up; a new key
   means every miner must update theirs; use one key per network):

   ```
   npm run build
   node scripts/sv2-keygen.js /path/to/sv2-authority.key
   ```

   It writes the secret (mode 600, never overwrites) and prints the public key.
   Publish that public key: miners paste it into their firmware.

2. In `.env`:

   ```
   SV2_ENABLED=true
   SV2_PORT=3336
   SV2_AUTHORITY_KEY_FILE=/path/to/sv2-authority.key
   # optional
   SV2_CERT_VALIDITY_SECONDS=86400
   SV2_LOG_SHARES=false
   ```

   A missing or unreadable key, or a key file others can read, disables SV2
   (logged) and never stops V1.

3. Open the port. Restart. The log shows `Stratum V2: authority public key ...`
   and `Stratum V2 server is listening on port ...`.

## Miners

### Which channel type

| Miner | Channel |
|---|---|
| Bitaxe on AxeOS **v2.15 or newer** | **Extended** |
| Anything larger than a Bitaxe (any firmware or proxy) | **Extended** |
| Bitaxe on AxeOS **v2.14.x** | Standard (or update to v2.15+ and use Extended) |
| Bitaxe with a BM1397 chip | Extended only, so AxeOS v2.15+ |

Why:

- On an **Extended** channel the miner gets the whole coinbase (so it can check
  it) and makes its own new work. This is the better choice whenever it works.
- AxeOS **v2.14** drops any message over 2 KB. An Extended job carries the
  coinbase, which grows with the number of miners paid in a block, so on
  v2.14 Extended jobs stop arriving once the coinbase gets large. v2.15
  accepts 8 KB. The pool logs a warning the first time it sends a v2.14-style
  miner an Extended job over 2 KB.
- On a **Standard** channel the miner can only search one job (2^32 nonces x
  2^16 version bits), so the pool sends a new job before it can run out,
  every 30 s or sooner, paced by the channel's hashrate. Above roughly
  70 TH/s that would be more than once a second, and the pool logs a warning
  recommending Extended.

### Bitaxe (AxeOS) settings

Pool page:

- **Stratum Host**: the pool's host name
- **Stratum Port**: the SV2 port
- **Stratum Protocol**: Stratum V2
- **SV2 Channel Type**: see the table above
- **SV2 Authority Pubkey**: the pool's published public key. Without it the
  connection is still encrypted, but the miner can't tell it is talking to
  the real pool.
- **User**: `yourBitcoinAddress.workerName` (the password is not used)

Save and restart. In the pool's log the worker shows up as
`agent=bitaxe/<ASIC> (SV2)` with `proto=sv2 channel=<type>`.

### Stratum V1 miners through a proxy

Miners that only speak V1 can reach the SV2 port through the SRI Translator
Proxy (stratum-mining/sv2-apps, `translator_sv2`), with `aggregate_channels =
false` so each miner is its own `address.worker`. It opens Extended channels.
