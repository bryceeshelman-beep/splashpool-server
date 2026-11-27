# Changes from upstream public-pool

Splashpool is a modified version of
[public-pool](https://github.com/benjamin-wilson/public-pool) by Benjamin Wilson,
licensed under the GNU General Public License v3.0 (see `LICENSE.txt`). This file
lists what Splashpool changes, as GPL-3.0 section 5(a) requires.

It is based on upstream commit
[`96a9202`](https://github.com/benjamin-wilson/public-pool/commit/96a9202c11de2c6fc8d41155e2e779912a476dc7)
("Sync package lock for Node 24", 2026-06-05). Upstream's full history is kept
in this repository, and Splashpool's changes are the commits after it.

All dates are UTC.

## Payouts

**2026-11-19: Share window and coinbase payouts**
- Shares are credited over a rolling window (`SHARE_WINDOW_HOURS`, default 72 = 3 days)
  instead of upstream's per-session statistics. New: `src/ORM/share-window/`.
- Every block pays miners directly from the coinbase: no balances and no
  payout runs. New: `src/splash/payout.service.ts`, `payout-builder.ts`,
  `payout-script.ts`.
- Slices under `SPLASH_MIN_PAYOUT_SATS` are dropped and shared among the rest.
  Outputs to the same address are merged. Output order: fee, finder, then
  everyone else by amount.

**2026-11-20: Splash Bonus**
- **Splash Bonus**: the miner whose share finds the block receives
  `SPLASH_BONUS_SATS` (default 1.125 BTC), with **no fee taken from it**.
- **Fee from the shared portion only**: the pool fee (`SPLASH_FEE_PPM`, default
  1250 = 0.125%) is taken from the reward minus the Splash Bonus, never from the
  bonus. The remainder is split by work over the share window, finder included.
- The old setting names `SPLASH_FEE_BPS` and `SPLASH_FINDER_BONUS_SATS` are
  refused at startup, so an old config can't silently apply old rules.
- See `docs/SPLASH-PAYOUTS.md` for the exact rules and a worked example.

**2026-11-22: Payout correctness**
- Fixed duplicate shares, payout-address handling, the finder cutoff and the
  split at startup.
- Shares are credited at the difficulty their job was issued at, not the
  connection's current difficulty.

## Coinbase tag

- **2026-11-20**: The `POOL_IDENTIFIER` tag is written into every coinbase. A tag
  too long to fit is a configuration error (the job is refused) rather than
  being silently dropped. Upstream removes it when space runs out.
- **2026-11-22**: The Splash Pool deployment uses the tag `-=+SplashPool+=-`.
  The default is still `Public-Pool`, and `.env.example` uses a placeholder.

## Miner compatibility

**2026-11-19**
- Coinbase output size is capped (`SPLASH_MAX_COINBASE_OUTPUT_BYTES`, default
  5000; `SPLASH_MAX_SPLIT_OUTPUTS`, default 250) because some miner firmware
  crashes on large coinbases (AxeOS 2.11 and OSM 2.15 at about 6,000 bytes).
- BIP310 version rolling (`mining.configure`) is accepted.
- Vardiff fixed above 2^31. Per-miner job building is about 6x cheaper.
- Minimum share difficulty (`SPLASH_MIN_DIFFICULTY`; 512 on mainnet by default).
  Block solutions are always accepted, whatever their share difficulty.

**2026-11-22**
- The stratum server listens on IPv4 only.

## Abuse limits and robustness

**2026-11-19**
- Connections that flood rejected shares are disconnected
  (`SPLASH_REJECT_LIMIT`, `SPLASH_REJECT_RATIO`).

**2026-11-20**
- No "ghost" miners shown after a restart.

**2026-11-22**
- Per-IP guard (`src/splash/ip-guard.ts`): a connection cap per IP, plus bans for
  IPs that send only junk. Bans log only by default (`SPLASH_IP_MODE=log`), and
  LAN addresses are exempt.
- A block is recorded as found only if the node accepted it.
- Found blocks are written to fsynced files (`SPLASH_FOUND_BLOCKS_DIR`) before the
  miner is answered, and resubmitted until 100 blocks deep.
- New clients are saved in batches of 250. Upstream inserted the whole queue at
  once, which fails at about 1,000 rows (SQLite's expression-depth limit) and
  disconnected every one of those miners.
- Each class-validator rule is looked up once instead of on every share
  (`src/models/validators/validator-container.ts`), saving roughly half the CPU
  under load.
- Database writes no longer collide on the single SQLite connection.
  SQLite runs with `synchronous=NORMAL` plus a WAL checkpoint every 10 s.
- Credited shares are saved when the pool stops (SIGTERM, 15 s limit).

**2026-11-24**
- Bad JSON (or a non-object message) and oversized lines close the connection
  and count as junk for the per-IP guard. Upstream closed them silently.
- Unknown methods: ten in a row with no accepted share between them close the
  connection as junk. Known-harmless methods (`mining.extranonce.subscribe`,
  `mining.multi_version`, `mining.ping`) and replies never count.
- `SPLASH_AUTH_TIMEOUT_SECONDS` (default off): close connections that don't
  subscribe and authorize in time.
- `SPLASH_CONN_LOG` (default off): one log line per closed connection with the
  reason (`bad-json`, `oversize`, `unknown-method`, `auth-timeout`, `rejects`,
  `bad-submit`, `blocked-agent`, `idle`, `pool-stopping`, `error`,
  `client-closed`). Miner-supplied text is limited to printable ASCII.
- `SPLASH_MAX_DIFFICULTY` (default 2^53): a miner's share difficulty is capped,
  whether it comes from `suggest_difficulty`, `d=` or vardiff. Credit was
  already capped at the network difficulty, so this only stops huge values
  like `1e308` being sent to firmware.

## API

**2026-11-20**
- The API listens on `127.0.0.1` by default (`API_HOST` to override). Upstream
  listens on every interface.
- New read-only endpoints for the website:
  - `GET /api/splash/window`, `/api/splash/payouts`, `/api/splash/payouts/status`
  - `GET /api/site/summary`: pool tank (round progress), hashrate, status
  - `GET /api/site/blocks`, `/api/site/block/:height`: found blocks with
    decoded coinbase payouts
  - `GET /api/site/address/:address`: per-address stats
- Read-only gatekeeper in front of the public site API.

**2026-11-21**
- `GET /api/site/poolstats` for pool-listing sites.
- CORS preflight allows common request headers.

## Stratum V2

**2026-11-27**
- Optional **Stratum V2 Mining Protocol** listener on its own port, off unless
  `SV2_ENABLED=true` (see `docs/STRATUM-V2.md`). V1 is unchanged.
- Upstream's per-connection pool logic (jobs, share checks, vardiff, payouts,
  statistics) moved from `StratumV1Client` into a protocol-neutral
  `src/models/MinerSession.ts`, which both V1 and SV2 use. So an SV2 miner gets
  exactly the same Splash Bonus, fee and split as a V1 miner.
- New in `src/sv2/`:
  - `ellswift.ts`: BIP324 ElligatorSwift, on `@scure/btc-signer` (MIT), checked against the BIP324 test vectors.
  - `noise.ts`: Noise_NX_Secp256k1+EllSwift_ChaChaPoly_SHA256 responder, with a signed certificate.
  - `codec.ts`: frames and messages.
  - `authority.ts` and `scripts/sv2-keygen.js`: the authority key file and its base58-check public key.
  - `sv2-channel.ts`, `sv2-connection.ts`, `stratum-v2.service.ts`: Standard and Extended channels, SetTarget vardiff, per-IP limits.
- Channel difficulties are whole powers of two, so Bitaxe firmware reads
  them exactly. Vardiff never makes an already-sent future job harder.
- Standard channels get a new job before the miner can run out of work, so
  no duplicate shares.
- `MiningJob`: coinbase halves and a merkle-root helper. `@scure/btc-signer`
  added as a dependency.
- Codec test vectors come from ESP-Miner v2.14.0's `sv2_protocol.c`
  (https://github.com/bitaxeorg/ESP-Miner, GPL-3.0): outputs only. BIP324
  test vectors are unchanged (BSD-3-Clause). See `src/sv2/testdata/README.md`.
- Not included: Job Declaration, Template Distribution, group channels.

## Tools and docs

- **2026-11-19**: `scripts/check-coinbase.py` connects as a miner, decodes the
  live coinbase and checks it against the payout rules and the API.
  `scripts/audit-blocks.py` checks mined blocks against the same rules.
  `scripts/verify-share-window.js` checks share-window consistency.
- **2026-11-20**: `scripts/site-proxy.js` is a small local proxy for previewing a
  website against the API.
- **2026-11-24**: `README.md` replaced. Upstream's README is kept at
  `docs/PUBLIC-POOL-README.md`. `.env.example` is rewritten with every setting
  documented. `.gitignore` covers local data. In `full-setup/*.env` the example
  ZMQ host now reads `your-node-ip`.
- **2026-11-24**: Removed upstream's bundled self-signed test certificate and
  key (`secrets/cert.pem`, `secrets/key.pem`). The key has been public since
  2023, so `API_SECURE=true` now needs your own. Removed upstream's GitHub
  Actions workflows (`.github/workflows/`), which publish Docker images with
  upstream's registry credentials. `package.json` license set to `GPL-3.0` to
  match `LICENSE.txt` (upstream had the npm default `UNLICENSED`). Added
  `.gitleaksignore` for three known false positives in upstream's history.

- **2026-11-24**: `scripts/regtest-payout-test.py` mines real blocks through a
  real pool on a throwaway regtest node and checks each accepted coinbase
  against an independent implementation of the payout rules: a normal split,
  the minimum-payout drop, a reward smaller than the Splash Bonus, a tiny
  shared part, a single miner, a block found in a miner's first second,
  shares arriving at the moment of the block, and a block with real
  transaction fees. **2026-11-27**: case J has Stratum V2 miners (Standard
  and Extended channels) find blocks, using `scripts/sv2-test-miner.js`. `TESTING.md` lists what we want
  testers to try.

Many tests were added alongside these changes (`*.spec.ts` under `src/`).
