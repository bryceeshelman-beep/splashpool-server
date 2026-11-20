# Splash Pool payouts

Every block the pool mines pays everyone directly from the coinbase. All
amounts are integer satoshis.

| Step | Rule |
|---|---|
| Splash Bonus | `min(SPLASH_BONUS_SATS, reward)` to the block finder. No fee is taken from it. |
| Shared reward | `reward - Splash Bonus` |
| Pool fee | `floor(shared * SPLASH_FEE_PPM / 1,000,000)` to `SPLASH_FEE_ADDRESS` |
| Split | `shared - fee`, split by work in the `SHARE_WINDOW_HOURS` window (finder included) |

Slices under `SPLASH_MIN_PAYOUT_SATS` are dropped and their portion is shared
among the rest. Rounding leftovers (a few sats) go to the finder. Outputs to the
same address are merged. Output order: fee, finder, then everyone else by amount.

## Worked example

3.125 BTC subsidy + 0.02 BTC fees = 314,500,000 sats.

| | sats |
|---|---|
| Splash Bonus | 112,500,000 |
| Shared reward | 202,000,000 |
| Fee (0.125%) | 252,500 |
| Split by work | 201,747,500 |

Averaged over many blocks, each miner earns its share of the pool hashrate
times (reward - fee): the bonus changes the shape of payouts, not the average.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `SPLASH_BONUS_SATS` | 112500000 | The Splash Bonus (1.125 BTC) |
| `SPLASH_FEE_PPM` | 1250 | Fee on the shared reward, parts per million (1250 = 0.125%) |
| `POOL_IDENTIFIER` | Public-Pool | Coinbase tag; Splash uses `/Splashpool/` |

The old names `SPLASH_FEE_BPS` (fee on the whole reward) and
`SPLASH_FINDER_BONUS_SATS` are refused at startup so an old config can't
silently apply the old rules.

## Checking

- `scripts/check-coinbase.py <addr>` connects as a miner, decodes the live
  coinbase, compares it with the API and checks the rules and tag on its own.
- `scripts/audit-blocks.py` checks mined blocks against the same rules.
