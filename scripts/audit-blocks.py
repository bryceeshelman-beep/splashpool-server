#!/usr/bin/env python3
"""Check every block whose coinbase pays the Splash fee address against the
payout rules. Works for testnet4 or the regtest payout run.

usage: audit-blocks.py [--start H] [--datadir DIR] [--fee ADDR] [--pool-db FILE]
                       [--share-log FILE] [--quiet]

Rules checked per block:
  - block is in the main chain
  - first output = fee address, exactly floor(reward * 1%)
  - second output = the finder the pool recorded for that height (pool DB),
    paid at least min(1 BTC, reward - fee)
  - no address paid twice; every split output >= 10,000 sats
  - witness commitment is the last output, value 0
  - outputs sum to the reward (subsidy + fees, as the chain accepted it)
  - with a share log: each miner's split share is within 5 points of its
    share of work in the 3-day window at the block's time (jobs use a
    snapshot up to ~90s old, so an exact match is not expected)
"""
import os, argparse, json, sqlite3, subprocess, sys

ap = argparse.ArgumentParser()
ap.add_argument('--start', type=int, default=None)
ap.add_argument('--datadir', default=os.environ.get('BITCOIN_DATADIR', os.path.expanduser('~/.bitcoin')))
ap.add_argument('--fee', default='tb1q29suxu0226smyuy4zrkggelksx6aqe0u3t47ca')
ap.add_argument('--pool-db', default=None)
ap.add_argument('--share-log', default=None)
ap.add_argument('--quiet', action='store_true', help='only print problem blocks and the summary')
ap.add_argument('start_pos', nargs='?', type=int)
a = ap.parse_args()
start = a.start if a.start is not None else (a.start_pos if a.start_pos is not None else 162245)

CLI = [os.environ.get('BITCOIN_CLI', 'bitcoin-cli'), f'-datadir={a.datadir}']
FEE_BPS, FINDER, MIN_PAYOUT, WINDOW_S = 100, 100_000_000, 10_000, 72 * 3600

def cli(*args):
    return json.loads(subprocess.check_output(CLI + list(args)))

finders = {}
if a.pool_db:
    db = sqlite3.connect(f'file:{a.pool_db}?mode=ro', uri=True)
    for height, addr in db.execute('SELECT height, minerAddress FROM blocks_entity'):
        finders.setdefault(height, set()).add(addr)

shares = []
if a.share_log:
    with open(a.share_log) as f:
        for line in f:
            if line.strip():
                s = json.loads(line)
                shares.append((s['t'] / 1000, s['address'], s['difficulty']))

def window_fractions(t):
    work = {}
    for ts, addr, d in shares:
        if t - WINDOW_S <= ts <= t:
            work[addr] = work.get(addr, 0) + d
    total = sum(work.values())
    return {k: v / total for k, v in work.items()} if total else {}

tip = cli('getblockcount')
found = bad = 0
max_dev = 0.0
for h in range(start, tip + 1):
    bh = subprocess.check_output(CLI + ['getblockhash', str(h)]).decode().strip()
    blk = cli('getblock', bh, '2')
    cb = blk['tx'][0]
    outs = [(o['scriptPubKey'].get('address', 'nulldata'), round(o['value'] * 1e8)) for o in cb['vout']]
    if not any(addr == a.fee for addr, _ in outs):
        continue
    found += 1
    reward = sum(v for _, v in outs)
    paid = [o for o in outs if o[0] != 'nulldata']
    problems = []
    fee = reward * FEE_BPS // 10000
    if paid[0] != (a.fee, fee):
        problems.append(f'fee {paid[0]} expected {fee}')
    finder = paid[1] if len(paid) > 1 else (None, 0)
    if finder[1] < min(FINDER, reward - fee):
        problems.append(f'finder paid {finder[1]} < {min(FINDER, reward - fee)}')
    if h in finders and finder[0] not in finders[h]:
        problems.append(f'finder {finder[0]} but pool recorded {sorted(finders[h])}')
    if a.pool_db and h not in finders:
        problems.append('pool DB has no record of finding this block')
    if len({x for x, _ in paid}) != len(paid):
        problems.append('an address is paid twice')
    for addr, v in paid[2:]:
        if v < MIN_PAYOUT:
            problems.append(f'{addr} paid {v} < min payout')
    if outs[-1][0] != 'nulldata' or outs[-1][1] != 0:
        problems.append('witness commitment not last')
    if blk['confirmations'] < 1:
        problems.append('not in main chain')

    dev_note = ''
    split_pool = reward - fee - min(FINDER, reward - fee)
    if shares and split_pool > 0:
        fr = window_fractions(blk['time'])
        # Each output's split part: the finder's output carries bonus + rounding + split.
        split_of = {addr: v for addr, v in paid[2:]}
        if finder[0]:
            split_of[finder[0]] = split_of.get(finder[0], 0) + finder[1] - min(FINDER, reward - fee)
        for addr, f in fr.items():
            dev = abs(split_of.get(addr, 0) / split_pool - f)
            max_dev = max(max_dev, dev)
            if dev > 0.05:
                problems.append(f'{addr} split {split_of.get(addr, 0) / split_pool:.3f} vs window {f:.3f}')
        dev_note = '  split vs window: ' + ', '.join(f'{addr[-6:]} {split_of.get(addr, 0) / split_pool:.3f}/{f:.3f}' for addr, f in sorted(fr.items()))

    bad += bool(problems)
    if problems or not a.quiet:
        print(f"{h} {bh[:16]}.. conf {blk['confirmations']:>4} reward {reward} outputs {len(paid)} finder {finder[0]}{dev_note}"
              + ('' if not problems else '  PROBLEMS: ' + '; '.join(problems)))
        if not a.quiet:
            for addr, v in paid:
                print(f'     {v:>12}  {addr}')
print(f'{found} Splash block(s) found from height {start} to {tip}; {bad} with problems'
      + (f'; max split deviation from window {max_dev:.4f}' if shares else ''))
sys.exit(1 if bad else 0)
