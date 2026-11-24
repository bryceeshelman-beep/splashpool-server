#!/usr/bin/env python3
"""Regtest end-to-end payout test: mines real blocks through a real pool and
checks the coinbase the node ACCEPTED against an independent implementation of
the Splash payout rules (docs/SPLASH-PAYOUTS.md).

usage: regtest-payout-test.py <empty work dir> [pool dir with dist/ and node_modules/]

Starts its own throwaway bitcoind -regtest (RPC 28543, ZMQ 28545) and pool
(stratum 23435, API 23436); touches nothing else. Needs bitcoind/bitcoin-cli
(BITCOIN_BIN dir, or on PATH) and node.

Cases:
  A  normal reward, three miners 3:2:1, the smallest one finds the block
  B  minimum payout raised so the smallest miner is dropped and redistributed
  C  block reward smaller than the Splash Bonus (after regtest halvings)
  D  reward just above the bonus: tiny shared part, 6-sat fee, split to finder
"""
import calendar, hashlib, json, os, shutil, socket, struct, subprocess, sys, time, urllib.request, secrets

WORK = os.path.abspath(sys.argv[1])
POOL_SRC = os.path.abspath(sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), '..'))
BIN = os.environ.get('BITCOIN_BIN', '')
RPC, ZMQ, STRATUM, API = 28543, 28545, 23435, 23436
PW = secrets.token_hex(12)
fails = 0

def ok(name, cond, extra=''):
    global fails
    fails += not cond
    print('PASS' if cond else 'FAIL', name, extra, flush=True)

def cli(*a):
    return subprocess.check_output([os.path.join(BIN, 'bitcoin-cli'), '-regtest', f'-datadir={WORK}/node', f'-rpcport={RPC}',
                                    '-rpcuser=t', f'-rpcpassword={PW}', *a], text=True).strip()

dsha = lambda b: hashlib.sha256(hashlib.sha256(b).digest()).digest()

class Miner:
    def __init__(self, addr, agent='payout-test/1'):
        self.addr, self.s, self.b, self.q, self.closed, self.i = addr, socket.create_connection(('127.0.0.1', STRATUM)), b'', [], False, 10
        self.send('mining.subscribe', [agent], 1)
        self.en1 = self.wait(lambda m: m.get('id') == 1)['result'][1]
        # Below regtest's block difficulty (~4.7e-10), so non-block shares exist,
        # and above 0, so each share is credited work.
        self.send('mining.suggest_difficulty', [1e-10], 2)
        self.send('mining.authorize', [addr + '.w', 'x'], 3)
        assert self.wait(lambda m: m.get('id') == 3)['result'], 'login refused'
        self.n2 = 0

    def send(self, m, p, i):
        self.s.sendall((json.dumps({'id': i, 'method': m, 'params': p}) + '\n').encode())

    def wait(self, f, t=10):
        end = time.time() + t
        while True:
            for m in list(self.q):
                if f(m):
                    self.q.remove(m)
                    return m
            if self.closed or time.time() > end:
                return None
            self.s.settimeout(max(.05, end - time.time()))
            try:
                r = self.s.recv(65536)
                if not r:
                    self.closed = True
                    continue
            except socket.timeout:
                continue
            self.b += r
            *ls, self.b = self.b.split(b'\n')
            self.q += [json.loads(l) for l in ls if l]

    def job_on(self, tip, t=20):
        """Wait for a job built on block `tip` (older queued jobs are skipped)."""
        want = bytes.fromhex(tip)[::-1]
        def on_tip(m):
            if m.get('method') != 'mining.notify':
                return False
            p = bytes.fromhex(m['params'][1])
            return b''.join(p[i:i + 4][::-1] for i in range(0, 32, 4)) == want
        m = self.wait(on_tip, t)
        self.q = [x for x in self.q if x.get('method') != 'mining.notify']
        return m and m['params']

    def latest_job(self, t=10):
        """The newest mining.notify (waits for one if none is queued)."""
        last = None
        while True:
            m = self.wait(lambda m: m.get('method') == 'mining.notify', 0.3 if last else t)
            if m is None:
                return last
            last = m['params']

    def solve(self, job, block):
        """A nonce for `job` that is (block=True) or is not (False) a block. Unique extranonce2 each call."""
        self.n2 += 1
        en2 = '%016x' % (0xab00000000000000 + self.n2)
        _, prev, a, b, br, v, bits, t = job[:8]
        root = dsha(bytes.fromhex(a + self.en1 + en2 + b))
        for x in br:
            root = dsha(root + bytes.fromhex(x))
        p = bytes.fromhex(prev)
        p = b''.join(p[i:i + 4][::-1] for i in range(0, 32, 4))
        n = int(bits, 16)
        target = (n & 0xffffff) << (8 * ((n >> 24) - 3))
        for k in range(0, 0xffffffff):
            h = struct.pack('<I', int(v, 16)) + p + root + struct.pack('<III', int(t, 16), n, k)
            if (int.from_bytes(dsha(h), 'little') <= target) == block:
                return en2, t, '%08x' % k, dsha(h)[::-1].hex()

    def submit(self, job, en2, t, nonce):
        self.i += 1
        self.send('mining.submit', [self.addr + '.w', job[0], en2, t, nonce], self.i)
        m = self.wait(lambda m: m.get('id') == self.i)
        return 'closed' if not m else 'ok' if m.get('result') else m['error'][1]

def expected_payouts(reward, finder, fee_addr, window, bonus_sats, fee_ppm, min_payout):
    """Independent implementation of docs/SPLASH-PAYOUTS.md (no count/byte limits)."""
    bonus = min(bonus_sats, reward)
    shared = reward - bonus
    fee = shared * fee_ppm // 1_000_000
    pool = shared - fee
    work = {}
    for a, d in window.items():
        if d > 0:
            work[a] = work.get(a, 0) + d
    ranked = sorted(work.items(), key=lambda x: (-x[1], x[0]))
    paid = {}
    k = len(ranked)
    while k > 0:  # drop the smallest until the k-th largest reaches the minimum
        top = ranked[:k]
        total = sum(d for _, d in top)
        if pool > 0 and int(pool * (top[-1][1] / total)) >= max(1, min_payout):
            paid = {a: int(pool * (d / total)) for a, d in top}
            break
        k -= 1
    out = {}
    def add(a, v):
        if v > 0:
            out[a] = out.get(a, 0) + v
    add(fee_addr, fee)
    add(finder, bonus)
    add(finder, pool - sum(paid.values()))
    for a, v in paid.items():
        add(a, v)
    assert sum(out.values()) == reward
    return out, dict(bonus=bonus, shared=shared, fee=fee, pool=pool, dropped=len(work) - len(paid))

def api(path):
    return json.load(urllib.request.urlopen(f'http://127.0.0.1:{API}{path}', timeout=10))

def write_env(fee_addr, bonus=112_500_000, min_payout=10_000):
    open(f'{WORK}/pool/.env', 'w').write(f'''BITCOIN_RPC_URL=http://127.0.0.1
BITCOIN_RPC_USER=t
BITCOIN_RPC_PASSWORD={PW}
BITCOIN_RPC_PORT={RPC}
BITCOIN_RPC_TIMEOUT=10000
BITCOIN_ZMQ_HOST="tcp://127.0.0.1:{ZMQ}"
API_PORT={API}
API_HOST=127.0.0.1
STRATUM_PORT={STRATUM}
NETWORK=regtest
API_SECURE=false
POOL_IDENTIFIER="-=+SplashPool+=-"
SPLASH_PAYOUTS=true
SPLASH_FEE_ADDRESS={fee_addr}
SPLASH_FEE_PPM=1250
SPLASH_BONUS_SATS={bonus}
SPLASH_MIN_PAYOUT_SATS={min_payout}
SPLASH_FOUND_BLOCKS_DIR={WORK}/found-blocks
''')

pool = None
def start_pool():
    global pool
    log = open(f'{WORK}/pool.log', 'a')
    pool = subprocess.Popen(['node', 'dist/main'], cwd=f'{WORK}/pool', stdout=log, stderr=log)
    for _ in range(90):
        try:
            socket.create_connection(('127.0.0.1', STRATUM)).close()
            return
        except OSError:
            time.sleep(1)
    raise RuntimeError('pool did not start')

def stop_pool():
    if pool and pool.poll() is None:
        pool.terminate()
        pool.wait(60)

def wait_snapshot(after, miners):
    """Wait for a payout snapshot taken after `after` that has `miners` addresses."""
    for _ in range(80):
        st = api('/api/splash/payouts/status')
        at = st.get('snapshotAt')
        if at and calendar.timegm(time.strptime(at[:19], '%Y-%m-%dT%H:%M:%S')) > after and st['snapshotMiners'] == miners:
            return True
        time.sleep(1)
    return False

def mine_case(name, finder, miners, fee_addr, bonus, min_payout, burn):
    """Make a new template so jobs use the current snapshot, mine a block as `finder`, check its coinbase."""
    window = {w['address']: w['difficulty'] for w in api('/api/splash/window')['miners']}
    cli('generatetoaddress', '1', burn)  # new block -> fresh jobs from the current snapshot
    job = finder.job_on(cli('getbestblockhash'))
    assert job, 'no job on the new tip'
    en2, t, nonce, h = finder.solve(job, True)
    before = int(cli('getblockcount'))
    res = finder.submit(job, en2, t, nonce)
    for _ in range(40):
        if int(cli('getblockcount')) > before:
            break
        time.sleep(.25)
    tip = cli('getbestblockhash')
    ok(f'{name}: node accepted the block (valid coinbase)', tip == h and res == 'ok', f'submit={res}')
    blk = json.loads(cli('getblock', tip, '2'))
    cb = blk['tx'][0]
    got = {}
    for o in cb['vout']:
        a = o['scriptPubKey'].get('address')
        v = round(o['value'] * 1e8)
        if a is None:
            ok(f'{name}: only the witness commitment has no address', v == 0 and o['scriptPubKey']['hex'].startswith('6a24aa21a9ed'))
            continue
        got[a] = got.get(a, 0) + v
    reward = sum(got.values())
    subsidy = json.loads(cli('getblockstats', str(blk['height']), '["subsidy","totalfee"]'))
    ok(f'{name}: outputs sum to subsidy + fees', reward == subsidy['subsidy'] + subsidy['totalfee'], f'{reward} sats')
    exp, parts = expected_payouts(reward, finder.addr, fee_addr, window, bonus, 1250, min_payout)
    ok(f'{name}: coinbase matches the payout rules exactly', got == exp,
       '' if got == exp else f'\n   got {json.dumps(got)}\n   exp {json.dumps(exp)}')
    ok(f'{name}: tag in coinbase', b'-=+SplashPool+=-' in bytes.fromhex(cb['vin'][0]['coinbase']))
    ok(f'{name}: no zero or negative payouts', all(v > 0 for v in got.values()))
    return got, parts, reward

node = None
try:
    if os.path.exists(WORK) and os.listdir(WORK):
        sys.exit(f'{WORK} must be empty or missing')
    os.makedirs(f'{WORK}/node'); os.makedirs(f'{WORK}/pool/DB')
    shutil.copytree(f'{POOL_SRC}/dist', f'{WORK}/pool/dist')
    os.symlink(os.path.realpath(f'{POOL_SRC}/node_modules'), f'{WORK}/pool/node_modules')
    node = subprocess.Popen([os.path.join(BIN, 'bitcoind'), '-regtest', f'-datadir={WORK}/node', f'-rpcport={RPC}',
                             '-rpcbind=127.0.0.1', '-rpcallowip=127.0.0.1', '-rpcuser=t', f'-rpcpassword={PW}',
                             '-listen=0', '-dnsseed=0', '-connect=0', f'-zmqpubrawblock=tcp://127.0.0.1:{ZMQ}',
                             '-printtoconsole=0', '-fallbackfee=0.0001'])
    cli('-rpcwait', 'getblockcount')
    js = ("const b=require('bitcoinjs-lib');const n=b.networks.regtest;"
          "console.log(JSON.stringify([1,2,3,4,5].map(j=>b.payments.p2wpkh({hash:b.crypto.sha256(Buffer.from('payout'+j)).subarray(0,20),network:n}).address)))")
    fee_addr, alice, bob, carol, burn = json.loads(subprocess.check_output(['node', '-e', js], cwd=POOL_SRC))
    cli('generatetoaddress', '20', burn)  # past the BIP34 1-byte heights; reward 50 BTC

    write_env(fee_addr)
    start_pool()
    A, B, C = Miner(alice), Miner(bob), Miner(carol)
    for m, n in ((A, 3), (B, 2), (C, 1)):
        job = m.latest_job()
        for _ in range(n):
            r = m.submit(job, *m.solve(job, False)[:3])
            assert r == 'ok', f'share refused: {r}'
    t_last = time.time()
    ok('setup: window has three miners in 3:2:1', wait_snapshot(t_last, 3))
    w = {x['address']: x['difficulty'] for x in api('/api/splash/window')['miners']}
    ok('setup: work ratio 3:2:1', abs(w[alice] / w[carol] - 3) < 1e-9 and abs(w[bob] / w[carol] - 2) < 1e-9)

    # A: normal reward, smallest miner finds it
    got, parts, reward = mine_case('A normal', C, [A, B, C], fee_addr, 112_500_000, 10_000, burn)
    ok('A: finder gets the full Splash Bonus on top of its slice', got[carol] >= 112_500_000 + parts['pool'] // 6)
    ok('A: fee is 0.125% of the shared part only', got[fee_addr] == (reward - 112_500_000) * 1250 // 1_000_000, f"fee={got[fee_addr]}")
    ok('A: all three miners paid', parts['dropped'] == 0 and {alice, bob, carol} <= set(got))

    # B: minimum payout 1 sat above the smallest slice: the smallest miner(s) are dropped
    w = sorted(((x['difficulty'], x['address']) for x in api('/api/splash/window')['miners']))
    total = sum(d for d, _ in w)
    split_pool = (reward - 112_500_000) - (reward - 112_500_000) * 1250 // 1_000_000
    slices = [int(split_pool * (d / total)) for d, _ in w]
    min_b = slices[0] + 1
    smallest_set = {a for d, a in w if d == w[0][0]}
    smallest = w[0][1]
    finder_b = [m for m in (A, B, C) if m.addr not in smallest_set][0]
    stop_pool(); write_env(fee_addr, min_payout=min_b); start_pool()
    A, B, C = Miner(alice), Miner(bob), Miner(carol)
    finder_b = {alice: A, bob: B, carol: C}[finder_b.addr]
    wait_snapshot(time.time(), 3)
    got, parts, reward = mine_case('B min payout', finder_b, [A, B, C], fee_addr, 112_500_000, min_b, burn)
    dropped_addrs = {a for _, a in w} - set(got)
    # Dropping goes one at a time from the bottom (ties by address); each drop
    # raises everyone else's slice, so a tied miner can survive.
    ok('B: smallest miner dropped, not paid', len(dropped_addrs) >= 1 and dropped_addrs <= smallest_set
       and parts['dropped'] == len(dropped_addrs), f'min={min_b} dropped={len(dropped_addrs)} of tied {len(smallest_set)}')
    ok('B: their portion went to the others', sum(got.values()) == reward and len(got) >= 2)

    # C: reward smaller than the bonus (6 halvings: 0.78125 BTC)
    stop_pool(); write_env(fee_addr); start_pool()
    height = int(cli('getblockcount'))
    cli('generatetoaddress', str(905 - height), burn)
    A, B, C = Miner(alice), Miner(bob), Miner(carol)
    wait_snapshot(time.time(), 3)
    got, parts, reward = mine_case('C reward < bonus', B, [A, B, C], fee_addr, 112_500_000, 10_000, burn)
    ok('C: reward really is below the bonus', reward < 112_500_000, f'{reward} sats')
    ok('C: whole reward to the finder, nothing else', got == {bob: reward})
    ok('C: no fee output when there is no shared part', fee_addr not in got)

    # D: reward just above the bonus: shared part 5,000 sats
    subsidy = reward
    stop_pool(); write_env(fee_addr, bonus=subsidy - 5_000); start_pool()
    A, B, C = Miner(alice), Miner(bob), Miner(carol)
    wait_snapshot(time.time(), 3)
    got, parts, reward = mine_case('D tiny shared part', A, [A, B, C], fee_addr, subsidy - 5_000, 10_000, burn)
    ok('D: 6-sat fee from the 5,000-sat shared part', got.get(fee_addr) == 6, f"fee={got.get(fee_addr)}")
    ok('D: split under the minimum goes to the finder', got == {fee_addr: 6, alice: reward - 6})

    ok('pool still running', pool.poll() is None)
finally:
    stop_pool()
    if node:
        try:
            cli('stop')
        except Exception:
            pass
        node.wait()
    print('FAILURES', fails)
sys.exit(1 if fails else 0)
