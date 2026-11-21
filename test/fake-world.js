// A small, consistent fake of everything the snapshot job talks to: DefiLlama, CoinGecko,
// the chains (RPC), Blockscout, DexScreener, Snapshot and GitHub. Tests change its fields
// between runs to stage failures, cuts, raises and treasury movements.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OVER, DEAD } from '../lib/config.js';
import { run } from '../scripts/snapshot.mjs';
import { MULTICALL3, decodeAggregate3Calls, encodeAggregate3Results } from '../lib/multicall.js';

export const DAY = 86400;
export const T0 = Date.UTC(2026, 10, 20, 4, 17) / 1000; // a normal 04:17 UTC run
const lc = a => a.toLowerCase();
const SAFE = '0xdac09f37e132d91b962f30e6ec40d2d08b82b0fa';
const TRE = '0x1777c6d588fd931751762836811529c0073d6376';
const BRIDGE = lc(OVER.locked.ethereum[0]);
const idx = chain => Object.keys(OVER.tokens).indexOf(chain);
const roundPool = (kind, chain) => '0x' + (kind === 'usdc' ? 'a' : 'b') + String(idx(chain)).padStart(39, '0');
const defaultPool = (kind, chain) => '0x' + (kind === 'usdc' ? 'd' : 'e') + String(idx(chain)).padStart(39, '0');
const proxyAdmin = (kind, chain) => '0x' + (kind === 'usdc' ? 'ad1' : 'ad2') + String(idx(chain)).padStart(37, '0');
const ticket = (kind, chain, round, i) => '0x' + (kind === 'usdc' ? 'f1' : 'f2') + String(idx(chain)) + String(round).padStart(3, '0') + String(i).padStart(34, '0');
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const ADMIN_SLOT = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';
const ROUND = 57;
const word = n => '0x' + BigInt(n).toString(16).padStart(64, '0');
const units = (n, decimals) => word(BigInt(Math.round(n * 1e6)) * 10n ** BigInt(decimals - 6));

export function makeWorld(over = {}) {
  const w = {
    now: T0,
    revenuePerDay: 6000,
    buyback: t => 2300,              // daily buyback for the day starting at t
    treasuryStable: 2_450_000,
    poolUsdc: { optimism: 173_000, arbitrum: 186_000, base: 144_000 },
    overPool: { optimism: 233_000, arbitrum: 217_000, base: 295_000 },
    supply: { ethereum: 69_420_000, optimism: 26_170_173, arbitrum: 4_749_427, base: 7_453_454 },
    locked: 38_373_054,
    dead: 15_486_938,
    wallets: { ethereum: { [SAFE]: 13_362_150, [TRE]: 1_250_000 }, optimism: { [TRE]: 374_394 }, arbitrum: { [TRE]: 362_273 }, base: { [TRE]: 305_500 } },
    proposals: [
      { id: '0xp265', title: 'OIP-265: Wind down public liquidity provision', created: T0 - 150 * DAY, start: T0 - 150 * DAY, end: T0 - 146 * DAY, state: 'closed', choices: ['For', 'Against'], scores: [4, 0], scores_total: 4, votes: 4, symbol: 'TC-NFT', strategies: [{ name: 'erc20-balance-of' }] },
      { id: '0xp263', title: 'OIP-263: Dissolve council', created: T0 - 170 * DAY, start: T0 - 170 * DAY, end: T0 - 165 * DAY, state: 'closed', choices: ['YES', 'NO'], scores: [5, 0], scores_total: 5, votes: 5, symbol: 'TC-NFT', strategies: [{ name: 'erc20-balance-of' }] }
    ],
    impl: (kind, chain) => '0x' + (kind === 'usdc' ? '1a' : '2b') + '0'.repeat(38),  // pool code (EIP-1967 implementation)
    adminOwner: '0xef2b0a2ffcdcd3b53d81800d19a543136f26a6b8',
    defaultUsdc: 50_000,             // per chain, in the default pool (round 1)
    defaultBets: 1234,               // bets listed in the default round, all settled
    openBets: [{ held: 1_000, stake: 300 }, { held: 500, stake: 100 }, { held: 0, stake: 50 }], // current round, per chain and kind
    fail: new Set(),                 // e.g. 'buybacks', 'revenue-empty', 'revenue-stale', 'gov-empty', 'pool-usdc', 'bridge'
    issues: [],                      // what the job posted to GitHub
    ...over
  };

  const day0 = () => Math.floor(w.now / DAY) * DAY; // today, still in progress
  const days = n => Array.from({ length: n }, (_, i) => day0() - (n - 1 - i) * DAY);
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  const rpc = result => json({ jsonrpc: '2.0', id: 1, result });

  w.fetch = async (url, opts = {}) => {
    url = String(url);
    const method = opts.method || 'GET';
    if (url.includes('dataType=dailyRevenue')) {
      if (w.fail.has('revenue-empty')) return json({ totalDataChart: [] });
      const ds = w.fail.has('revenue-stale') ? days(200).slice(0, -5) : days(200);
      return json({ totalDataChart: ds.map(t => [t, w.revenuePerDay]) });
    }
    if (url.includes('dataType=dailyHoldersRevenue')) {
      if (w.fail.has('buybacks')) return new Response('down', { status: 503 });
      return json({ totalDataChart: days(200).map(t => [t, w.buyback(t)]) });
    }
    if (url.includes('/treasury/overtime')) {
      return json({
        mcap: 9_600_000,
        chainTvls: {
          Ethereum: { tvl: [], tokensInUsd: days(200).map(t => ({ date: t, tokens: { USDC: w.treasuryStable, WETH: 500_000, OVER: 2_600_000 } })) },
          'Ethereum-OwnTokens': { tvl: [], tokensInUsd: [] },
          OwnTokens: { tvl: days(200).map(t => ({ date: t, totalLiquidityUSD: 8_600_000 })), tokensInUsd: [{ date: day0(), tokens: { THALES: 8_600_000 } }] }
        }
      });
    }
    if (url.includes('coingecko')) return json({ overtime: { usd: 0.18, usd_market_cap: 9_700_000, usd_24h_change: 1.2 } });
    if (url.includes('blockscout')) {
      if (!url.includes('eth.blockscout')) return new Response('forbidden', { status: 403 });
      return json({ items: [{ address: { hash: BRIDGE, name: 'LockReleaseTokenPool', is_contract: true }, value: String(BigInt(w.locked) * 10n ** 18n) }] });
    }
    if (url.includes('dexscreener')) {
      return json({ pairs: [
        { chainId: 'optimism', dexId: 'uniswap', labels: ['v3'], pairAddress: '0xp1', baseToken: { address: OVER.tokens.optimism, symbol: 'OVER' }, quoteToken: { address: '0xusdc', symbol: 'USDC' }, liquidity: { usd: 120_000 }, volume: { h24: 5000 } },
        { chainId: 'base', dexId: 'aerodrome', labels: [], pairAddress: '0xp2', baseToken: { address: '0xweth', symbol: 'WETH' }, quoteToken: { address: OVER.tokens.base, symbol: 'OVER' }, liquidity: { usd: 30_000 }, volume: { h24: 400 } }
      ] });
    }
    if (url.includes('snapshot.org')) return json({ data: { proposals: w.fail.has('gov-empty') ? [] : w.proposals } });
    if (url.includes('api.github.com')) {
      if (method === 'GET') return json(w.issues.filter(i => i.state === 'open'));
      const body = JSON.parse(opts.body || '{}');
      if (url.endsWith('/issues')) { const issue = { number: w.issues.length + 1, state: 'open', ...body }; w.issues.push(issue); return json(issue, 201); }
      if (method === 'PATCH') { const n = Number(url.split('/').pop()); const i = w.issues.find(x => x.number === n); if (i) i.state = body.state; return json(i || {}); }
      return json({}, 201);
    }
    if (method === 'POST' && opts.body) {
      const req = JSON.parse(opts.body);
      if (req.method === 'eth_call' || req.method === 'eth_getStorageAt') return chain(req, url);
    }
    return new Response(`not faked: ${url}`, { status: 404 });
  };

  function chainOf(url) {
    return url.includes('optimism') ? 'optimism' : url.includes('arb') ? 'arbitrum' : url.includes('base') ? 'base' : 'ethereum';
  }

  // Answers one call; returns a 32-byte hex result, or throws to stand for a revert.
  function answer(c, to, data) {
    to = lc(to);
    const kindOf = a => (lc(OVER.bettingPools[c] ? OVER.bettingPools[c].pool : '') === a ? 'usdc' : lc(OVER.overPools[c] || '') === a ? 'over' : null);
    const kind = kindOf(to);
    if (kind) {
      if (kind === 'usdc' && w.fail.has('pool-usdc')) throw new Error('execution reverted');
      const arg = (n = 0) => BigInt('0x' + data.slice(10 + n * 64, 74 + n * 64));
      if (data === '0x146ca531') return word(ROUND);
      if (data.startsWith('0x4651f080')) {
        const r = Number(arg());
        const a = r === ROUND ? roundPool(kind, c) : r === 1 ? defaultPool(kind, c) : '0x0';
        return '0x' + a.slice(2).padStart(64, '0');
      }
      if (data.startsWith('0x145dee7d')) { const r = Number(arg()); return word(r === ROUND ? w.openBets.length : r === 1 ? w.defaultBets : 0); }
      if (data.startsWith('0x03d868db')) return '0x' + ticket(kind, c, Number(arg(0)), Number(arg(1))).slice(2).padStart(64, '0');
    }
    for (const kind of ['usdc', 'over']) {
      if (to === proxyAdmin(kind, c) && data === '0x8da5cb5b') return '0x' + w.adminOwner.slice(2).padStart(64, '0');
      const i = w.openBets.findIndex((_, k) => ticket(kind, c, ROUND, k) === to);
      if (i >= 0 && data === '0xd165dac2') return units(w.openBets[i].stake, kind === 'usdc' ? 6 : 18);
    }
    const who = '0x' + data.slice(-40);
    const held = kind => { const i = w.openBets.findIndex((_, k) => ticket(kind, c, ROUND, k) === who); return i >= 0 ? w.openBets[i].held : null; };
    if (OVER.bettingPools[c] && to === lc(OVER.bettingPools[c].usdc)) {
      if (who === roundPool('usdc', c)) return units(w.poolUsdc[c], 6);
      if (who === defaultPool('usdc', c)) return units(w.defaultUsdc, 6);
      return units(held('usdc') ?? 0, 6);
    }
    if (to === lc(OVER.tokens[c])) {
      if (data === '0x18160ddd') return units(w.supply[c], 18);
      if (who === roundPool('over', c)) return units(w.overPool[c], 18);
      if (who === defaultPool('over', c)) return units(10_000, 18);
      if (held('over') != null) return units(held('over'), 18);
      if (c === 'ethereum' && who === BRIDGE) return units(w.locked + (w.fail.has('bridge') ? 1_000_000 : 0), 18);
      if (c === 'ethereum' && who === lc(DEAD[1])) return units(w.dead, 18);
      return units((w.wallets[c] || {})[who] || 0, 18);
    }
    throw new Error(`unknown call to ${to}`);
  }

  function chain(req, url) {
    const c = chainOf(url);
    const fail = message => json({ jsonrpc: '2.0', id: 1, error: { message } });
    if (req.method === 'eth_getStorageAt') {
      if (w.fail.has('contracts')) return fail('storage read failed');
      const [addr, slot] = req.params;
      for (const kind of ['usdc', 'over']) {
        const proxy = lc(kind === 'usdc' ? (OVER.bettingPools[c] || {}).pool || '' : OVER.overPools[c] || '');
        if (lc(addr) !== proxy) continue;
        const a = slot === IMPL_SLOT ? w.impl(kind, c) : slot === ADMIN_SLOT ? proxyAdmin(kind, c) : '0x0';
        return rpc('0x' + a.slice(2).padStart(64, '0'));
      }
      return rpc(word(0));
    }
    const { to, data } = req.params[0];
    if (lc(to) === MULTICALL3) {
      return rpc(encodeAggregate3Results(decodeAggregate3Calls(data).map(call => {
        try { return { success: true, data: answer(c, call.to, call.data) }; } catch { return { success: false, data: '0x' }; }
      })));
    }
    try { return rpc(answer(c, to, data)); } catch (e) { return fail(e.message); }
  }

  return w;
}

// Runs the job once in the world's current state; dayOffset moves the clock from T0.
export async function runDay(w, outDir, dayOffset = 0) {
  w.now = T0 + dayOffset * DAY;
  return run({
    now: w.now,
    fetchImpl: w.fetch,
    env: { GITHUB_TOKEN: 'test', GITHUB_REPOSITORY: 'me/overwatch' },
    outDir,
    retryDelay: 0,
    log: () => {},
    logError: () => {}
  });
}

export const tempDir = () => mkdtemp(path.join(tmpdir(), 'overwatch-'));
export const ADDR = { SAFE, TRE };
