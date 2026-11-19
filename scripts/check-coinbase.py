#!/usr/bin/env python3
"""Connect to the pool as a miner, take the first mining.notify, rebuild the
coinbase and decode it with bitcoin-cli. Compare with /api/splash/payouts.
usage: check-coinbase.py <miner address> [--port 3333] [--api http://127.0.0.1:3334]
                         [--datadir ~/.bitcoin] [--quiet]"""
import os, argparse, json, socket, subprocess, sys, urllib.request

ap = argparse.ArgumentParser()
ap.add_argument('addr')
ap.add_argument('--host', default='127.0.0.1')
ap.add_argument('--port', type=int, default=3333)
ap.add_argument('--api', default='http://127.0.0.1:3334')
ap.add_argument('--datadir', default=os.environ.get('BITCOIN_DATADIR', os.path.expanduser('~/.bitcoin')))
ap.add_argument('--quiet', action='store_true', help='do not list every output')
args = ap.parse_args()
addr, host, port = args.addr, args.host, args.port
CLI = [os.environ.get('BITCOIN_CLI', 'bitcoin-cli'), f'-datadir={args.datadir}']

s = socket.create_connection((host, port), timeout=60)
f = s.makefile('rw')
def send(o): f.write(json.dumps(o) + '\n'); f.flush()
send({"id": 1, "method": "mining.subscribe", "params": ["cgminer/4.11.1"]})
send({"id": 2, "method": "mining.authorize", "params": [addr + ".checker", "x"]})
en1 = en2size = notify = None
while notify is None:
    m = json.loads(f.readline())
    if m.get('id') == 1:
        en1, en2size = m['result'][1], m['result'][2]
    elif m.get('id') == 2 and m.get('result') is not True:
        sys.exit(f'authorize failed: {m}')
    elif m.get('method') == 'mining.notify':
        notify = m['params']
s.close()
coinbase = notify[2] + en1 + '00' * en2size + notify[3]
tx = json.loads(subprocess.check_output(CLI + ['decoderawtransaction', coinbase]))
outs = [(o['scriptPubKey'].get('address', o['scriptPubKey']['type']), round(o['value'] * 1e8)) for o in tx['vout']]
reward = sum(v for _, v in outs)
api = json.load(urllib.request.urlopen(f'{args.api}/api/splash/payouts?finder={addr}&reward={reward}'))
expected = [(o['address'], o['value']) for o in api['outputs']]
print(f'coinbase {len(coinbase)//2} bytes, weight {tx["weight"]}, {len(outs)} outputs, reward {reward} sats, coinb2 {len(notify[3])} hex chars')
for a, v in (outs if not args.quiet else outs[:3] + [('...', 0)] + outs[-2:]):
    print(f'  {v:>12}  {a}')
paid = [o for o in outs if o[0] != 'nulldata']
ok = paid == expected and outs[-1][0] == 'nulldata' and outs[-1][1] == 0
print('MATCH' if ok else f'MISMATCH\n expected {expected}')
sys.exit(0 if ok else 1)
