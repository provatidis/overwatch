// A small, consistent fake of everything the snapshot job talks to: DefiLlama, CoinGecko,
// the chains (RPC), Blockscout, DexScreener, Snapshot and GitHub. Tests change its fields
// between runs to stage failures, cuts, raises and treasury movements.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OVER, DEAD } from '../lib/config.js';
import { run } from '../scripts/snapshot.mjs';

export const DAY = 86400;
export const T0 = Date.UTC(2026, 10, 20, 4, 17) / 1000; // a normal 04:17 UTC run
const lc = a => a.toLowerCase();
const SAFE = '0xdac09f37e132d91b962f30e6ec40d2d08b82b0fa';
const TRE = '0x1777c6d588fd931751762836811529c0073d6376';
const BRIDGE = lc(OVER.locked.ethereum[0]);
const roundPool = (kind, chain) => '0x' + (kind === 'usdc' ? 'a' : 'b') + String(Object.keys(OVER.tokens).indexOf(chain)).padStart(39, '0');
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
    if (method === 'POST' && opts.body && opts.body.includes('eth_call')) return chain(JSON.parse(opts.body).params[0], url);
    return new Response(`not faked: ${url}`, { status: 404 });
  };

  function chainOf(url) {
    return url.includes('optimism') ? 'optimism' : url.includes('arb') ? 'arbitrum' : url.includes('base') ? 'base' : 'ethereum';
  }

  function chain({ to, data }, url) {
    to = lc(to);
    const c = chainOf(url);
    // Betting pools: round() and roundPools(round)
    const usdcPool = lc(OVER.bettingPools[c] ? OVER.bettingPools[c].pool : '');
    const overPool = lc(OVER.overPools[c] || '');
    if (to === usdcPool || to === overPool) {
      if (to === usdcPool && w.fail.has('pool-usdc')) return json({ jsonrpc: '2.0', id: 1, error: { message: 'execution reverted' } });
      if (data === '0x146ca531') return rpc(word(57));
      if (data.startsWith('0x4651f080')) return rpc('0x' + roundPool(to === usdcPool ? 'usdc' : 'over', c).slice(2).padStart(64, '0'));
    }
    const who = '0x' + data.slice(-40);
    if (OVER.bettingPools[c] && to === lc(OVER.bettingPools[c].usdc)) return rpc(units(who === roundPool('usdc', c) ? w.poolUsdc[c] : 0, 6));
    if (to === lc(OVER.tokens[c])) {
      if (data === '0x18160ddd') return rpc(units(w.supply[c], 18));
      if (who === roundPool('over', c)) return rpc(units(w.overPool[c], 18));
      if (c === 'ethereum' && who === BRIDGE) return rpc(units(w.locked + (w.fail.has('bridge') ? 1_000_000 : 0), 18));
      if (c === 'ethereum' && who === lc(DEAD[1])) return rpc(units(w.dead, 18));
      return rpc(units((w.wallets[c] || {})[who] || 0, 18));
    }
    return json({ jsonrpc: '2.0', id: 1, error: { message: `unknown call to ${to}` } });
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
