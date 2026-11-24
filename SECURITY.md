# Security

## Reporting a security problem

**Please don't open a public issue for security problems.** Report them
privately through GitHub: on this repository's **Security** tab, choose
**Report a vulnerability**. Only the maintainers can see the report.

Include:
- what you found and why it matters
- how to reproduce it (testnet steps are best)
- the commit or version, and the UTC time if it happened on a live pool

We'll confirm we got your report, work on a fix, and credit you in the README
(unless you'd rather stay anonymous) once the fix is live.

## What counts

Anything that could cost miners money or take the pool down, for example:
- a coinbase that pays the wrong amounts or the wrong addresses, or a block the
  network would reject
- a way to get more credit (or more of the Splash Bonus) than the work you did
- one connection or a few that can crash the pool, stall it, or use up its
  memory
- reading anything through the API that should be private
- getting around the per-IP limits at scale

Ordinary bugs, crashes from your own miner's firmware, and limits working as
designed (temporary bans, connection caps) are welcome as normal
[issues](../../issues) instead.

## Where to test

Use the **testnet** instance (`testnet.splashpool.us:3335`, see
[TESTING.md](TESTING.md)). Its coins have no value and breaking it is the
point.

**Please don't attack the mainnet pool** (`stratum.splashpool.us:3333`). Real
miners are paid from it. Volumetric attacks (floods from many machines) are out
of scope everywhere.
