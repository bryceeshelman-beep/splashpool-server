# Splashpool

A Bitcoin mining pool server that pays miners **inside the block**. There are no
balances, no payout runs and no accounts: every block the pool finds pays
everyone straight from its coinbase. It powers [Splash Pool](https://splashpool.us).

Splashpool is a fork of
[**public-pool**](https://github.com/benjamin-wilson/public-pool) by Benjamin
Wilson, a NestJS/TypeScript Bitcoin stratum server. Almost all the stratum work
is his. See [CHANGES.md](CHANGES.md) for what Splashpool changes.

## How the Splash Bonus works

When the pool finds a block, the coinbase pays out like this:

1. **Splash Bonus**: the miner whose share found the block gets **1.125 BTC**
   (`SPLASH_BONUS_SATS`). No fee is taken from it.
2. **Pool fee**: **0.125%** (`SPLASH_FEE_PPM=1250`) of the rest, the *shared
   reward*. The fee is never taken from the bonus.
3. **Split**: what's left is shared by work among everyone who mined in the
   last **3 days** (`SHARE_WINDOW_HOURS=72`), the finder included.

Example: 3.125 BTC subsidy + 0.02 BTC fees = 314,500,000 sats

| | sats |
|---|---|
| Splash Bonus to the finder | 112,500,000 |
| Shared reward | 202,000,000 |
| Fee (0.125% of shared) | 252,500 |
| Split by work | 201,747,500 |

Averaged over many blocks, each miner earns its share of the pool hashrate times
(reward − fee). The bonus changes the shape of payouts, not the average.
Full rules: [docs/SPLASH-PAYOUTS.md](docs/SPLASH-PAYOUTS.md).

### Small miners: read this

- **Slices under 10,000 sats aren't paid** (`SPLASH_MIN_PAYOUT_SATS`). Their
  portion goes to the block's paid miners.
- **There is no balance.** An unpaid slice isn't saved or carried over. Your
  shares do stay in the 3-day window, so they count again for every block the
  pool finds in that time.
- **A coinbase only has room for so many payouts.** All outputs must fit in
  5,000 bytes (some miner firmware crashes on bigger coinbases): about 159 split
  payouts to `bc1q…` addresses, about 114 to `bc1p…` (taproot), and never more
  than 250. When more miners qualify, the smallest slices are dropped first.
- Rough guide: with a 3.145 BTC block, a slice reaches 10,000 sats at about
  1/20,000 of the pool's work over 3 days. If the pool runs 1 PH/s, that's about
  50 GH/s of steady mining.
- **The Splash Bonus has no minimum.** No matter how small your miner is, if it
  finds a block, you get the full 1.125 BTC Splash Bonus, with no fee taken.

## Testnet instance

A public **testnet4** Splashpool instance is live, so you can point a miner at it
without risking real coins:

```
stratum+tcp://testnet.splashpool.us:3335
username: your testnet4 tb1… address (optionally .workername)
password: anything
```

It's for testing: coins have no value, the pool may be reset, and abuse limits
are strict (temporary bans are expected). See [TESTING.md](TESTING.md) for what
to try.

## Stratum V2

Splashpool can also take **Stratum V2** miners (Mining Protocol, encrypted,
Standard and Extended channels) on a port of its own, beside Stratum V1. It's
off by default. SV2 miners get exactly the same rules and payouts as V1
miners. Operator setup, and which channel type to choose in AxeOS, are in
[docs/STRATUM-V2.md](docs/STRATUM-V2.md).

## Setup

You need:
- A synced **Bitcoin Core** node with RPC enabled (`server=1`) and, ideally,
  ZMQ block notifications (`zmqpubrawblock=tcp://*:3000`)
- **Node.js 22.12 or later** (the Docker image uses Node 24)

```bash
git clone https://github.com/<you>/splashpool.git
cd splashpool
npm ci

cp .env.example .env
# Edit .env. At least:
#   BITCOIN_RPC_URL / BITCOIN_RPC_PORT
#   BITCOIN_RPC_USER + BITCOIN_RPC_PASSWORD  (or BITCOIN_RPC_COOKIEFILE)
#   NETWORK              mainnet | testnet | regtest
#   POOL_IDENTIFIER      your pool's coinbase tag
#   SPLASH_FEE_ADDRESS   where the pool fee goes (valid for NETWORK)
#   SPLASH_FEE_PPM, SPLASH_BONUS_SATS  if you want different numbers

npm run build
npm run start:prod
```

Miners connect to `stratum+tcp://<your-host>:3333` with a Bitcoin address as the
username (optionally `address.workername`) and any password.

Every setting is documented in [`.env.example`](.env.example). A few to know:
- **`SPLASH_PAYOUTS=true`** turns on the coinbase payouts above. Without it the
  pool behaves like upstream (solo payouts to the finder).
- The pool **refuses to start** if `SPLASH_FEE_ADDRESS` isn't valid for
  `NETWORK`, rather than mine blocks that pay a bad script.
- The API listens on **localhost** only (`API_HOST`). Put a reverse proxy in front
  of it if you want it public.
- The per-IP guard starts in **log-only** mode (`SPLASH_IP_MODE=log`). Watch its
  log lines before switching to `enforce`.

Docker and regtest/testnet setups from upstream still work: see
[docs/PUBLIC-POOL-README.md](docs/PUBLIC-POOL-README.md) and `full-setup/`.

### Checking a live pool

```bash
# Connect as a miner, rebuild the coinbase and check it against the rules
# (needs bitcoin-cli on PATH, or BITCOIN_CLI=/path/to/bitcoin-cli)
python3 scripts/check-coinbase.py <your-btc-address>

# Audit blocks the pool has found
python3 scripts/audit-blocks.py
```

### Tests

```bash
npm test          # unit tests
npm run test:e2e  # end-to-end
```

## Tested miners

Confirmed to mine and get shares accepted, with the coinbase sizes this pool
builds:

| Miner | Firmware | Reports as | Where |
|---|---|---|---|
| Hammer | 3.0.5 | `THOR` | Mainnet since 2026-11-20 (needed the BIP310 version-rolling fix in [CHANGES.md](CHANGES.md)) |
| Bitaxe (602) | OSM 2.15.4 | `bitaxe` | Mainnet since 2026-11-20 |
| Bitaxe Hex | AxeOS 2.11.1 | `bitaxe` | Testnet, 2026-11-19 |

Your miner isn't listed? Try it on the testnet and tell us how it went: see
[TESTING.md](TESTING.md).

## Thanks to our testers

Everyone who finds a bug, breaks something, or tests new firmware gets listed here.

Be the first: see [TESTING.md](TESTING.md).

## License

GPL-3.0, the same as upstream public-pool. See [LICENSE.txt](LICENSE.txt).
Splashpool's changes are listed in [CHANGES.md](CHANGES.md).
