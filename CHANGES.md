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

Many tests were added alongside these changes (`*.spec.ts` under `src/`).
