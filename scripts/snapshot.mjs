// Daily snapshot for OVER watch. Runs in GitHub Actions on Node 20+ with no dependencies.
// Writes data/latest.json and data/history.json, then opens or closes GitHub issues
// when a thesis check changes state or a new governance vote appears.
//
// Env: GITHUB_TOKEN + GITHUB_REPOSITORY to send alerts, OUT_DIR to write somewhere else,
// NO_ALERTS=1 to skip alerts. Tests call run() with a fake fetch, clock and output folder.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { OVER, DEAD, LOCKED_NAME, HOLDER_VALUE, THRESHOLDS, CHAIN_NAMES } from '../lib/config.js';
import { dailySeries, parseTreasury, treasuryToRows, readingsFromHistory, overReadingsFromHistory, completeDays, computeStats, computeChecks, computeFlows, voterGroup, GRADE, RANK, DAY } from '../lib/metrics.js';
import { money, tokens, fmtDate, ok } from '../lib/format.js';
import { MULTICALL3, encodeAggregate3, decodeAggregate3 } from '../lib/multicall.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE_URL = 'https://overwatch.day/';
const UA = 'overwatch-snapshot (+https://github.com/provatidis/overwatch)';
// Per-run context, so tests can swap the network, environment and logging.
let ctx = { fetch: (...a) => globalThis.fetch(...a), env: process.env, errors: [], retryDelay: 1500, log: console.log, logError: console.error };

const RPCS = {
  ethereum: ['https://ethereum-rpc.publicnode.com', 'https://eth.llamarpc.com', 'https://cloudflare-eth.com'],
  optimism: ['https://optimism-rpc.publicnode.com', 'https://mainnet.optimism.io'],
  arbitrum: ['https://arbitrum-one-rpc.publicnode.com', 'https://arb1.arbitrum.io/rpc'],
  base:     ['https://base-rpc.publicnode.com', 'https://mainnet.base.org']
};
const BLOCKSCOUT = {
  ethereum: 'https://eth.blockscout.com',
  optimism: 'https://optimism.blockscout.com',
  arbitrum: 'https://arbitrum.blockscout.com',
  base:     'https://base.blockscout.com'
};

const EXPLORER_ADDR = {
  ethereum: 'https://etherscan.io/address/',
  optimism: 'https://optimistic.etherscan.io/address/',
  arbitrum: 'https://arbiscan.io/address/',
  base: 'https://basescan.org/address/'
};

const sleep = ms => ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve();

async function getJSON(url, opts = {}, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await ctx.fetch(url, {
        ...opts,
        headers: { 'user-agent': UA, accept: 'application/json', ...(opts.headers || {}) },
        signal: AbortSignal.timeout(60_000)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
      return await res.json();
    } catch (e) {
      last = e;
      if (i < tries - 1) await sleep(ctx.retryDelay * (i + 1));
    }
  }
  throw last;
}

async function step(name, fn) {
  try { return await fn(); }
  catch (e) { ctx.errors.push(`${name}: ${e.message}`); ctx.logError(`[${name}]`, e.message); return null; }
}

// A reply can succeed and still be wrong: empty, cut short, or stuck on an old day. Anything that
// looks like that is treated as a failed read, so the last good copy is kept instead.
function checkSeries(name, rows, prevRows, now) {
  if (!Array.isArray(rows) || rows.length < 30) throw new Error(`only ${rows ? rows.length : 0} days returned`);
  if (Array.isArray(prevRows) && prevRows.length && rows.length < prevRows.length * 0.95) {
    throw new Error(`${rows.length} days returned, down from ${prevRows.length}`);
  }
  const lastT = rows[rows.length - 1][0] ?? rows[rows.length - 1].t;
  if (now - lastT > 3 * DAY) throw new Error(`newest day is ${fmtDate(lastT)}`);
  return rows;
}

// ---------- Onchain reads ----------
async function rpcRaw(chain, method, params) {
  let last;
  for (const url of RPCS[chain]) {
    try {
      const j = await getJSON(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
      }, 2);
      if (j.error) throw new Error(j.error.message || 'RPC error');
      if (!j.result || j.result === '0x') throw new Error('empty RPC result');
      return j.result;
    } catch (e) { last = e; }
  }
  throw last;
}
const ethCall = async (chain, to, data) => BigInt(await rpcRaw(chain, 'eth_call', [{ to, data }, 'latest']));
const storageAt = async (chain, address, slot) => BigInt(await rpcRaw(chain, 'eth_getStorageAt', [address, slot, 'latest']));

// Many reads in a few requests through Multicall3. A call that fails comes back as null.
// Many reads in a few requests through Multicall3, four batches at a time. A call that fails
// comes back as null; a batch whose reply doesn't match what was asked fails the whole read.
async function readMany(chain, calls, size = 300, parallel = 4) {
  const batches = [];
  for (let i = 0; i < calls.length; i += size) batches.push(calls.slice(i, i + size));
  const results = new Array(batches.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(parallel, batches.length) }, async () => {
    while (next < batches.length) {
      const k = next++;
      const raw = await rpcRaw(chain, 'eth_call', [{ to: MULTICALL3, data: encodeAggregate3(batches[k]) }, 'latest']);
      const decoded = decodeAggregate3(raw);
      if (decoded.length !== batches[k].length) throw new Error(`batch reply had ${decoded.length} results for ${batches[k].length} calls`);
      results[k] = decoded.map(r => (r.success && r.data.length >= 66 ? BigInt(r.data.slice(0, 66)) : null));
    }
  }));
  return results.flat();
}

const UNIT = 10n ** BigInt(OVER.decimals - 6);
const toTokens = big => Number(big / UNIT) / 1e6;
const totalSupply = (chain, token) => ethCall(chain, token, '0x18160ddd').then(toTokens);
const balanceOf = (chain, token, who) =>
  ethCall(chain, token, '0x70a08231' + who.toLowerCase().replace(/^0x/, '').padStart(64, '0')).then(toTokens);

// Top holders come from Blockscout. Its public explorers block scripts more and more, so with a
// BLOCKSCOUT_API_KEY (free at dev.blockscout.com) the job uses Blockscout's keyed API first and the
// public explorer second. The key goes in a header and is scrubbed from any error message.
const CHAIN_ID = { ethereum: 1, optimism: 10, arbitrum: 42161, base: 8453 };
async function topHolders(chain, token) {
  const key = ctx.env.BLOCKSCOUT_API_KEY;
  const path = `/api/v2/tokens/${token}/holders`;
  const scrub = m => (key ? String(m).split(key).join('***') : String(m));
  let j = null, keyed = null;
  if (key) {
    try { j = await getJSON(`https://api.blockscout.com/${CHAIN_ID[chain]}${path}`, { headers: { authorization: `Bearer ${key}` } }, 2); }
    catch (e) { keyed = `keyed API: ${scrub(e.message)}`; }
  }
  if (!j) {
    try { j = await getJSON(`${BLOCKSCOUT[chain]}${path}`, {}, 2); }
    catch (e) { throw new Error([keyed, `public explorer: ${scrub(e.message)}`].filter(Boolean).join('; ')); }
  }
  return (j.items || []).slice(0, 15).map(h => {
    const a = h.address || {};
    const impl = Array.isArray(a.implementations) && a.implementations[0] ? a.implementations[0].name : null;
    return { address: (a.hash || '').toLowerCase(), name: a.name || impl || null, contract: !!a.is_contract, tokens: toTokens(BigInt(h.value || '0')) };
  });
}

// Every read must succeed: a failed balance read must never count as zero, or a missing bridge
// balance would show tens of millions of extra OVER in circulation.
async function supplySnapshot(price) {
  const chains = {};
  const lower = s => s.toLowerCase();
  const treasurySet = [...new Set(OVER.treasury.map(lower))];
  for (const [chain, token] of Object.entries(OVER.tokens)) {
    const c = { total: await totalSupply(chain, token), dead: 0, locked: 0, treasury: 0, treasuryBy: {}, lockedBy: [], holders: null };
    for (const d of DEAD) c.dead += await balanceOf(chain, token, d);
    for (const t of treasurySet) {
      const bal = await balanceOf(chain, token, t);
      c.treasuryBy[t] = bal;
      c.treasury += bal;
    }
    // Holders are needed on Ethereum to find the bridge pool; elsewhere they're a bonus.
    c.holders = chain === 'ethereum'
      ? await step(`holders ${chain}`, () => topHolders(chain, token))
      : await topHolders(chain, token).catch(e => { c.holdersError = e.message; return null; });
    const lockedAddrs = new Set((OVER.locked[chain] || []).map(lower));
    for (const h of c.holders || []) if (h.contract && h.name && LOCKED_NAME.test(h.name)) lockedAddrs.add(h.address);
    for (const a of lockedAddrs) {
      const bal = await balanceOf(chain, token, a);
      c.locked += bal;
      c.lockedBy.push({ address: a, tokens: bal });
    }
    chains[chain] = c;
  }
  // Sanity checks: the Ethereum bridge pool backs exactly the OVER on the other chains, and
  // circulating supply can't exceed the maximum.
  const l2 = Object.entries(chains).filter(([k]) => k !== 'ethereum').reduce((s, [, c]) => s + c.total, 0);
  const locked = chains.ethereum.locked;
  if (Math.abs(locked - l2) > Math.max(1000, l2 * 0.005)) {
    throw new Error(`bridge check failed: ${tokens(locked)} locked on Ethereum vs ${tokens(l2)} on the other chains`);
  }
  const circulating = Object.values(chains).reduce((s, c) => s + c.total - c.dead - c.locked, 0);
  if (!(circulating > 0) || circulating > OVER.maxSupply * 1.0001) throw new Error(`circulating supply ${tokens(circulating)} is outside 0–${tokens(OVER.maxSupply)}`);
  const treasury = Object.values(chains).reduce((s, c) => s + c.treasury, 0);
  return {
    max: OVER.maxSupply,
    circulating,
    burned: OVER.maxSupply - circulating,
    treasury,
    float: circulating - treasury,
    floatUsd: price ? (circulating - treasury) * price : null,
    chains
  };
}

// Idle USDC in each chain's sportsbook liquidity pool: the current round's pool contract.
async function poolSnapshot() {
  const out = { chains: {}, total: 0 };
  for (const [chain, cfg] of Object.entries(OVER.bettingPools)) {
    const round = await ethCall(chain, cfg.pool, '0x146ca531');
    const roundPool = '0x' + (await ethCall(chain, cfg.pool, '0x4651f080' + round.toString(16).padStart(64, '0'))).toString(16).padStart(40, '0');
    if (/^0x0+$/.test(roundPool)) throw new Error(`${chain}: no pool contract for round ${round}`);
    const usdc = Number(await ethCall(chain, cfg.usdc, '0x70a08231' + roundPool.slice(2).padStart(64, '0'))) / 1e6;
    out.chains[chain] = { round: Number(round), roundPool, usdc: Math.round(usdc) };
    out.total += usdc;
  }
  if (!(out.total > 0) || out.total > 50e6) throw new Error(`pool total ${money(out.total)} looks wrong`);
  out.total = Math.round(out.total);
  return out;
}

// ---------- Betting-pool contracts ----------
const SEL = {
  round: '0x146ca531',             // round()
  roundPools: '0x4651f080',        // roundPools(uint256)
  ticketCount: '0x145dee7d',       // getNumberOfTradingTicketsPerRound(uint256)
  ticketAt: '0x03d868db',          // tradingTicketsPerRound(uint256,uint256)
  buyIn: '0xd165dac2',             // buyInAmount() on a ticket
  balanceOf: '0x70a08231',         // balanceOf(address)
  owner: '0x8da5cb5b'              // owner()
};
const word = n => BigInt(n).toString(16).padStart(64, '0');
const addrWord = a => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const toAddr = big => '0x' + big.toString(16).padStart(40, '0').slice(-40);
const isZeroAddr = a => !a || /^0x0+$/.test(a);

// The pools are upgradeable proxies (EIP-1967). Their code and who can change it are read daily,
// so a change opens an issue.
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const ADMIN_SLOT = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';
async function contractWatch() {
  const targets = [
    ...Object.entries(OVER.bettingPools).map(([chain, cfg]) => ({ chain, kind: 'USDC pool', proxy: cfg.pool })),
    ...Object.entries(OVER.overPools).map(([chain, pool]) => ({ chain, kind: 'OVER pool', proxy: pool }))
  ];
  const out = [];
  for (const t of targets) {
    const implementation = toAddr(await storageAt(t.chain, t.proxy, IMPL_SLOT));
    const admin = toAddr(await storageAt(t.chain, t.proxy, ADMIN_SLOT));
    const adminOwner = isZeroAddr(admin) ? null : toAddr(await ethCall(t.chain, admin, SEL.owner));
    out.push({ ...t, proxy: t.proxy.toLowerCase(), implementation: isZeroAddr(implementation) ? null : implementation, admin: isZeroAddr(admin) ? null : admin, adminOwner });
  }
  return out;
}

// Keeps when each pool's code was first seen and last changed, across runs.
function carryContracts(prevList, list, now) {
  return list.map(c => {
    const p = (prevList || []).find(x => x.chain === c.chain && x.proxy === c.proxy);
    const firstSeen = p ? (p.firstSeen ?? p.since ?? now) : now;
    if (p && p.implementation === c.implementation) return { ...c, firstSeen, since: p.since ?? firstSeen, previous: p.previous ?? null };
    return { ...c, firstSeen, since: now, previous: p ? p.implementation : null };
  });
}

// Where the house's betting money sits: the current round's pool (what the pool reading counts),
// pools for later rounds, the default pool that takes futures and parlays spanning rounds (round 1),
// and money held by open bets in all of them. A bet's contract holds the bettor's stake plus the
// house's share until it settles, then pays out and empties, so an open bet is one with a balance.
// The default round's list goes back to launch and grows, so there's a ceiling on how many are read.
const ROUNDS_AHEAD = 6, MAX_TICKETS = 60000;
async function bettingCapital(chain, pool, token, decimals) {
  const scale = 10n ** BigInt(decimals - 6);
  const amount = b => (b == null ? null : Number(b / scale) / 1e6);
  const round = Number(await ethCall(chain, pool, SEL.round));
  const rounds = [1, ...Array.from({ length: ROUNDS_AHEAD + 1 }, (_, k) => round + k)];
  const addrs = await readMany(chain, rounds.map(r => ({ to: pool, data: SEL.roundPools + word(r) })));
  const counts = await readMany(chain, rounds.map(r => ({ to: pool, data: SEL.ticketCount + word(r) })));
  const pools = rounds.map((r, i) => ({ round: r, address: addrs[i] == null ? null : toAddr(addrs[i]), bets: counts[i] == null ? null : Number(counts[i]) }))
    .filter(p => !isZeroAddr(p.address));
  const bal = await readMany(chain, pools.map(p => ({ to: token, data: SEL.balanceOf + addrWord(p.address) })));
  pools.forEach((p, i) => { p.amount = amount(bal[i]); });

  const listed = pools.reduce((n, p) => n + (p.bets || 0), 0);
  if (pools.some(p => p.bets == null)) throw new Error('a round’s bet count didn’t load');
  if (listed > MAX_TICKETS) return { round, pools, open: { bets: listed, skipped: `more than ${MAX_TICKETS} bets listed` } };
  const refs = pools.flatMap(p => Array.from({ length: p.bets }, (_, i) => ({ round: p.round, i })));
  const tickets = await readMany(chain, refs.map(r => ({ to: pool, data: SEL.ticketAt + word(r.round) + word(r.i) })), 500);
  if (tickets.some(t => t == null)) throw new Error('some bet addresses didn’t load');
  const addrsT = tickets.map(toAddr);
  const held = await readMany(chain, addrsT.map(t => ({ to: token, data: SEL.balanceOf + addrWord(t) })), 500);
  if (held.some(b => b == null)) throw new Error('some bet balances didn’t load');
  const openIdx = held.map((b, i) => (b > 0n ? i : -1)).filter(i => i >= 0);
  const stakes = await readMany(chain, openIdx.map(i => ({ to: addrsT[i], data: SEL.buyIn })), 500);
  if (stakes.some(b => b == null)) throw new Error('some stakes didn’t load');
  const byRound = {};
  openIdx.forEach((i, k) => {
    const r = refs[i].round;
    const o = byRound[r] || (byRound[r] = { open: 0, held: 0n, stakes: 0n });
    o.open++; o.held += held[i]; o.stakes += stakes[k];
  });
  pools.forEach(p => {
    const o = byRound[p.round] || { open: 0, held: 0n, stakes: 0n };
    p.open = { bets: o.open, held: amount(o.held), stakes: amount(o.stakes) };
  });
  const sum = key => pools.reduce((s, p) => s + p.open[key], 0);
  return { round, pools, open: { bets: listed, open: sum('bets'), held: sum('held'), stakes: sum('stakes') } };
}

async function capitalSnapshot() {
  const out = { usdc: {}, over: {} };
  for (const [chain, cfg] of Object.entries(OVER.bettingPools)) {
    out.usdc[chain] = await bettingCapital(chain, cfg.pool, cfg.usdc, 6).catch(e => ({ error: e.message }));
  }
  for (const [chain, pool] of Object.entries(OVER.overPools)) {
    out.over[chain] = await bettingCapital(chain, pool, OVER.tokens[chain], OVER.decimals).catch(e => ({ error: e.message }));
  }
  const all = [...Object.values(out.usdc), ...Object.values(out.over)];
  if (all.every(c => c.error)) throw new Error(all[0].error);
  return out;
}

// One figure per currency for the house's betting money: what sits in every round's pool (current,
// later and default) plus the house's share of open bets (what they hold minus the bettors' stakes,
// which only become the house's if the bet loses). Null unless every chain was read in full.
function summarizeCapital(capital) {
  const sum = kind => {
    const chains = capital && capital[kind];
    if (!chains) return null;
    const out = { idle: 0, defaultPools: 0, onBets: 0, held: 0, stakes: 0, openBets: 0, chains: {} };
    for (const [c, v] of Object.entries(chains)) {
      if (!v || v.error || !v.open || v.open.skipped || !ok(v.open.held) || !ok(v.open.stakes)) return null;
      const idle = v.pools.reduce((a, p) => a + (p.amount || 0), 0);
      const dflt = (v.pools.find(p => p.round === 1) || {}).amount || 0;
      const onBets = Math.max(0, v.open.held - v.open.stakes);
      out.chains[c] = { idle: Math.round(idle), defaultPool: Math.round(dflt), onBets: Math.round(onBets), openBets: v.open.open };
      out.idle += idle; out.defaultPools += dflt; out.onBets += onBets; out.held += v.open.held; out.stakes += v.open.stakes; out.openBets += v.open.open;
    }
    for (const k of ['idle', 'defaultPools', 'onBets', 'held', 'stakes']) out[k] = Math.round(out[k]);
    out.total = out.idle + out.onBets;
    return out;
  };
  const usdc = sum('usdc'), over = sum('over');
  return usdc && over ? { usdc, over } : null;
}

// OVER held by the OVER-collateral betting pools (the current round's pool contract on each chain).
async function overPoolSnapshot() {
  const out = { chains: {}, total: 0 };
  for (const [chain, pool] of Object.entries(OVER.overPools)) {
    const round = await ethCall(chain, pool, '0x146ca531');
    const roundPool = '0x' + (await ethCall(chain, pool, '0x4651f080' + round.toString(16).padStart(64, '0'))).toString(16).padStart(40, '0');
    if (/^0x0+$/.test(roundPool)) throw new Error(`${chain}: no OVER pool contract for round ${round}`);
    const over = await balanceOf(chain, OVER.tokens[chain], roundPool);
    out.chains[chain] = { round: Number(round), roundPool, over: Math.round(over) };
    out.total += over;
  }
  if (out.total < 0 || out.total > OVER.maxSupply) throw new Error(`OVER pool total ${tokens(out.total)} looks wrong`);
  out.total = Math.round(out.total);
  return out;
}

// Treasury wallets whose OVER balance moved by 10K or more since the previous good reading.
// Overtime's admin multisigs: whoever holds each chain's betting-pool upgrade key (read onchain as
// the owner of the pools' ProxyAdmin). Their OVER counts as the house's: Overtime controls it.
async function adminSnapshot(contractsList) {
  const byChain = {};
  for (const c of contractsList || []) if (c.adminOwner) (byChain[c.chain] ||= new Set()).add(c.adminOwner.toLowerCase());
  if (!Object.keys(byChain).length) throw new Error('no upgrade-key owners known');
  const treasury = new Set(OVER.treasury.map(a => a.toLowerCase()));
  const out = { total: 0, chains: {} };
  for (const [chain, owners] of Object.entries(byChain)) {
    for (const a of owners) {
      if (treasury.has(a)) continue; // already counted as a treasury wallet
      const bal = await balanceOf(chain, OVER.tokens[chain], a);
      (out.chains[chain] ||= {})[a] = bal;
      out.total += bal;
    }
  }
  return out;
}

// Ordinary wallets (not contracts) on any chain's holder list, with their OVER on all four chains
// added up, Base included, read straight from each chain. The same address is the same owner on
// every chain for an ordinary wallet; for a contract it needn't be, so contracts aren't combined.
const isWallet = h => !h.contract || /7702|DeleGator/i.test(h.name || '');
async function walletTotals(chains, exclude) {
  const list = [...new Set(Object.values(chains).flatMap(c => (c.holders || []).filter(h => isWallet(h) && !exclude.has(h.address)).map(h => h.address)))];
  if (!list.length) return [];
  const out = list.map(address => ({ address, chains: {}, total: 0 }));
  for (const [chain, token] of Object.entries(OVER.tokens)) {
    const bals = await readMany(chain, list.map(a => ({ to: token, data: SEL.balanceOf + addrWord(a) })));
    if (bals.some(b => b == null)) throw new Error(`a wallet balance on ${chain} didn’t load`);
    bals.forEach((b, i) => { const v = toTokens(b); if (v >= 1) { out[i].chains[chain] = v; out[i].total += v; } }); // dust isn’t a holding
  }
  return out.sort((a, b) => b.total - a.total).slice(0, 20);
}

function walletMoves(prevSupply, supply, prevAdmin, admin) {
  if (!prevSupply || !supply) return [];
  const moves = [];
  for (const [chain, now] of Object.entries((admin && admin.chains) || {})) {
    const before = prevAdmin && prevAdmin.chains && prevAdmin.chains[chain];
    if (!before) continue;
    for (const [addr, bal] of Object.entries(now)) {
      if (!(addr in before)) continue;
      const d = bal - before[addr];
      if (Math.abs(d) >= 10_000) moves.push(`Admin multisig ${addr.slice(0, 6)}…${addr.slice(-4)} on ${CHAIN_NAMES[chain] || chain}: ${d > 0 ? '+' : '−'}${tokens(Math.abs(d))} OVER`);
    }
  }
  for (const [chain, c] of Object.entries(supply.chains || {})) {
    const before = prevSupply.chains && prevSupply.chains[chain] && prevSupply.chains[chain].treasuryBy;
    if (!before) continue;
    for (const [addr, bal] of Object.entries(c.treasuryBy || {})) {
      const d = bal - (before[addr] ?? 0);
      if (Math.abs(d) >= 10_000) moves.push(`${addr.slice(0, 6)}…${addr.slice(-4)} on ${CHAIN_NAMES[chain] || chain}: ${d > 0 ? '+' : '−'}${tokens(Math.abs(d))} OVER`);
    }
  }
  return moves;
}

// ---------- Market data ----------
async function liquiditySnapshot() {
  const addrs = Object.values(OVER.tokens);
  const isOver = a => addrs.includes(String(a || '').toLowerCase());
  let pairs = [];
  try {
    const j = await getJSON(`https://api.dexscreener.com/latest/dex/tokens/${addrs.join(',')}`, {}, 2);
    pairs = j.pairs || [];
  } catch { /* Fall through to the per-chain endpoint. */ }
  if (!pairs.length) {
    for (const [chain, token] of Object.entries(OVER.tokens)) {
      const list = await getJSON(`https://api.dexscreener.com/tokens/v1/${chain}/${token}`, {}, 2).catch(() => []);
      if (Array.isArray(list)) pairs.push(...list);
    }
  }
  if (!pairs.length) throw new Error('no DEX pairs returned');
  const seen = new Set();
  const pools = [];
  for (const p of pairs) {
    if (!isOver(p.baseToken && p.baseToken.address) && !isOver(p.quoteToken && p.quoteToken.address)) continue;
    const key = `${p.chainId}:${String(p.pairAddress).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const overIsBase = isOver(p.baseToken.address);
    pools.push({
      chain: p.chainId,
      dex: p.dexId,
      version: (p.labels || []).join(' ') || null,
      pair: overIsBase ? `OVER/${p.quoteToken.symbol}` : `OVER/${p.baseToken.symbol}`,
      liquidityUsd: Math.round((p.liquidity && p.liquidity.usd) || 0),
      volume24h: Math.round((p.volume && p.volume.h24) || 0),
      url: p.url || null
    });
  }
  pools.sort((a, b) => b.liquidityUsd - a.liquidityUsd);
  if (!pools.length || !(pools[0].liquidityUsd > 0)) throw new Error('no OVER pools with liquidity');
  return {
    totalUsd: pools.reduce((s, p) => s + p.liquidityUsd, 0),
    volume24h: pools.reduce((s, p) => s + p.volume24h, 0),
    pools: pools.slice(0, 20)
  };
}

async function governanceSnapshot() {
  const query = `query { proposals(first: 10, skip: 0, where: { space_in: ["${OVER.snapshotSpace}"] }, orderBy: "created", orderDirection: desc) { id title created start end state choices scores scores_total votes symbol quorum link strategies { name } } }`;
  const j = await getJSON('https://hub.snapshot.org/graphql', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query })
  });
  if (j.errors) throw new Error(j.errors.map(e => e.message).join('; '));
  if (!(j.data && Array.isArray(j.data.proposals) && j.data.proposals.length)) throw new Error('no proposals returned');
  return {
    space: OVER.snapshotSpace,
    proposals: ((j.data && j.data.proposals) || []).map(p => ({
      id: p.id, title: p.title, state: p.state, created: p.created, start: p.start, end: p.end,
      link: p.link || `https://snapshot.box/#/s:${OVER.snapshotSpace}/proposal/${p.id}`,
      choices: p.choices, scores: p.scores, total: p.scores_total,
      votes: typeof p.votes === 'number' ? p.votes : null,
      symbol: p.symbol || null,
      quorum: typeof p.quorum === 'number' ? p.quorum : null,
      strategies: Array.isArray(p.strategies) ? p.strategies.map(x => x.name) : [],
      holderValue: HOLDER_VALUE.test(p.title || '')
    }))
  };
}

async function priceSnapshot() {
  const j = await getJSON('https://api.coingecko.com/api/v3/simple/price?ids=overtime&vs_currencies=usd&include_market_cap=true&include_24hr_change=true');
  const o = j && j.overtime;
  if (!o || !(o.usd > 0)) throw new Error('no CoinGecko price');
  return { usd: o.usd, mcap: o.usd_market_cap || null, change24h: typeof o.usd_24h_change === 'number' ? o.usd_24h_change / 100 : null };
}

// ---------- Alerts ----------
async function gh(p, method = 'GET', body) {
  const res = await ctx.fetch(`https://api.github.com/repos/${ctx.env.GITHUB_REPOSITORY}${p}`, {
    method,
    headers: {
      authorization: `Bearer ${ctx.env.GITHUB_TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json',
      'user-agent': UA
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) throw new Error(`GitHub ${method} ${p}: HTTP ${res.status}`);
  return res.status === 204 ? null : res.json();
}

async function sendAlerts(prev, next) {
  if (!ctx.env.GITHUB_TOKEN || !ctx.env.GITHUB_REPOSITORY || ctx.env.NO_ALERTS === '1' || !prev) return [];
  const sent = [];
  const openIssues = await gh('/issues?state=open&per_page=100');
  const marker = id => `<!-- overwatch:${id} -->`;

  for (const c of next.checks) {
    // Only compare graded, fresh checks against a graded, fresh previous reading.
    const before = (prev.checks || []).find(x => x.id === c.id);
    if (!before || c.stale || before.stale) continue;
    if (RANK[c.state] < 0 || RANK[before.state] == null || RANK[before.state] < 0 || before.state === c.state) continue;
    if (RANK[c.state] > RANK[before.state]) {
      const title = `${c.title}: ${GRADE[before.state][1]} → ${GRADE[c.state][1]}`;
      const detail = next.alertDetail && next.alertDetail[c.id] ? `\n\n${next.alertDetail[c.id]}` : '';
      await gh('/issues', 'POST', { title: `[OVER watch] ${title}`, body: `${c.text}${detail}\n\n[Open OVER watch](${PAGE_URL})\n\n${marker('check:' + c.id)}` });
      sent.push(title);
    } else if (c.state === 'good') {
      for (const issue of openIssues.filter(i => (i.body || '').includes(marker('check:' + c.id)))) {
        await gh(`/issues/${issue.number}/comments`, 'POST', { body: `Back to Healthy. ${c.text}` });
        await gh(`/issues/${issue.number}`, 'PATCH', { state: 'closed', state_reason: 'completed' });
        sent.push(`closed #${issue.number}`);
      }
    }
  }

  // New votes, only when both today's and the previous governance reads are fresh.
  // A buyback raise isn't a worse state, so it gets its own one-off alert.
  const rateNow = next.checks.find(c => c.id === 'rate');
  const rateBefore = (prev.checks || []).find(c => c.id === 'rate');
  const raised = THRESHOLDS.buybackRate.raised;
  if (rateNow && rateBefore && !rateNow.stale && !rateBefore.stale && rateNow.value >= raised && !(rateBefore.value >= raised)) {
    await gh('/issues', 'POST', { title: '[OVER watch] Buyback rate up', body: `${rateNow.text}\n\n[Open OVER watch](${PAGE_URL})\n\n${marker('rate-up:' + new Date().toISOString().slice(0, 10))}` });
    sent.push('buyback rate up');
  }

  // A change to a betting pool's code, or to who can change it, against the last good reading (so a
  // change during an outage still shows), and only from a fresh read today. All of a day's changes
  // go in one issue, since an upgrade usually touches every pool at once.
  if (prev.contracts && next.contracts && next.sources.contracts && next.sources.contracts.ok) {
    const changes = [];
    for (const c of next.contracts) {
      const p = prev.contracts.find(x => x.chain === c.chain && x.proxy === c.proxy);
      if (!p) continue;
      const where = `${CHAIN_NAMES[c.chain] || c.chain} ${c.kind}`;
      const link = a => `${EXPLORER_ADDR[c.chain] || ''}${a}`;
      if (p.implementation && c.implementation && p.implementation !== c.implementation) {
        changes.push({ short: `code changed on the ${where}`, line: `- **${where}** (${link(c.proxy)}) runs new code. Before: ${link(p.implementation)}. Now: ${link(c.implementation)}.` });
      }
      if (p.adminOwner && c.adminOwner && p.adminOwner !== c.adminOwner) {
        changes.push({ short: `upgrade key moved on the ${where}`, line: `- **${where}** (${link(c.proxy)}): control of upgrades moved. Before: ${link(p.adminOwner)}. Now: ${link(c.adminOwner)}.` });
      }
    }
    if (changes.length) {
      const title = changes.length === 1 ? `Betting pool ${changes[0].short}` : `Betting pool contracts changed (${changes.length} changes)`;
      await gh('/issues', 'POST', { title: `[OVER watch] ${title}`, body: `${changes.map(c => c.line).join('\n')}\n\nWorth checking the governance forum for what changed.\n\n[Open OVER watch](${PAGE_URL})\n\n${marker('contracts:' + new Date(next.generatedAt * 1000).toISOString().slice(0, 10))}` });
      sent.push(title);
    }
  }

  // New votes: only proposals created after the last good governance read, so a gap or an odd
  // reply can never make old proposals look new.
  const since = prev.sources && prev.sources.governance && prev.sources.governance.asOf;
  if (prev.governance && next.governance && next.sources.governance.ok && since) {
    const known = new Set(prev.governance.proposals.map(p => p.id));
    const fresh = next.governance.proposals.filter(p => !known.has(p.id) && p.created > since - DAY);
    for (const p of fresh.reverse()) {
      const when = p.end ? ` Voting closes ${new Date(p.end * 1000).toUTCString().replace(/:\d\d GMT/, ' UTC')}.` : '';
      const who = ` Voters: ${voterGroup(p).label}.`;
      const tag = p.holderValue ? ' Touches buybacks, fees or the treasury.' : '';
      await gh('/issues', 'POST', { title: `[OVER watch] New vote: ${p.title}`, body: `${p.link}${when}${who}${tag}\n\n${marker('proposal:' + p.id)}` });
      sent.push(`vote: ${p.title}`);
    }
  }
  return sent;
}

// Which tokens DefiLlama files under the treasury's "own tokens" (OVER, or the old THALES).
function ownSymbols(treJ) {
  const own = treJ.chainTvls && treJ.chainTvls.OwnTokens;
  const rows = own && Array.isArray(own.tokensInUsd) ? own.tokensInUsd : [];
  const last = rows.length ? rows[rows.length - 1].tokens || {} : {};
  return Object.keys(last).filter(k => Number(last[k]) > 0);
}

// ---------- Main ----------
async function readJSON(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}

async function main(now, OUT) {
  await mkdir(OUT, { recursive: true });
  const prev = await readJSON(path.join(OUT, 'latest.json'));
  const history = (await readJSON(path.join(OUT, 'history.json'))) || [];

  const series = (name, url, prevRows) => step(name, async () =>
    checkSeries(name, dailySeries(await getJSON(url)).map(p => [p.t, Math.round(p.v)]), prevRows, now));
  const [revFresh, buyFresh, treJ, price, liquidity, governance, poolsFresh] = await Promise.all([
    series('house result', 'https://api.llama.fi/summary/fees/overtime?dataType=dailyRevenue&excludeTotalDataChartBreakdown=true', prev && prev.revenue),
    series('buybacks', 'https://api.llama.fi/summary/fees/overtime?dataType=dailyHoldersRevenue&excludeTotalDataChartBreakdown=true', prev && prev.buybacks),
    step('treasury', async () => {
      const j = await getJSON('https://api.llama.fi/treasury/overtime');
      checkSeries('treasury', treasuryToRows(parseTreasury(j)), prev && prev.treasury, now);
      return j;
    }),
    step('price', priceSnapshot),
    step('liquidity', liquiditySnapshot),
    step('governance', governanceSnapshot),
    step('betting pools', poolSnapshot)
  ]);

  // Each source is either fresh today or carried over from the last good snapshot with its own
  // "as of" time, so the page can say how old it is and alerts can ignore it.
  const sources = {};
  const prevSrc = name => (prev && prev.sources && prev.sources[name]) || null;
  function settle(name, fresh, prevValue) {
    if (fresh != null) { sources[name] = { ok: true, asOf: now }; return fresh; }
    const p = prevSrc(name);
    sources[name] = { ok: false, asOf: p ? p.asOf : (prev && prevValue != null ? prev.generatedAt : null) };
    return prevValue != null ? prevValue : null;
  }

  const revRows = settle('revenue', revFresh, prev && prev.revenue);
  const buyRows = settle('buybacks', buyFresh, prev && prev.buybacks);
  const treasury = treJ ? parseTreasury(treJ) : null;
  const treasuryRows = settle('treasury', treasury ? treasuryToRows(treasury) : null, prev && prev.treasury);
  // Pools from the old DefiLlama-based format included open bets; never carry those over.
  const pools = settle('pools', poolsFresh, prev && prev.pools && prev.pools.chains ? prev.pools : null);

  let priceData = price;
  if (priceData && !(priceData.mcap > 0) && treJ && Number(treJ.mcap) > 0) priceData.mcap = Number(treJ.mcap);
  priceData = settle('price', priceData, prev && prev.price);
  const supplyFresh = await step('supply', () => supplySnapshot(priceData && priceData.usd));
  const overPools = settle('overPools', await step('OVER pools', overPoolSnapshot), prev && prev.overPools);
  const capital = await step('betting money', capitalSnapshot);
  const bettingFresh = summarizeCapital(capital);
  if (capital && !bettingFresh) ctx.errors.push('betting money: not every pool was read in full');
  const betting = settle('betting', bettingFresh, prev && prev.betting);
  const contractsFresh = await step('pool contracts', contractWatch);
  const contracts = settle('contracts', contractsFresh ? carryContracts(prev && prev.contracts, contractsFresh, now) : null, prev && prev.contracts);
  const admin = settle('admin', contracts ? await step('admin multisigs', () => adminSnapshot(contracts)) : null, prev && prev.admin);
  // The house's own OVER isn't free float: the treasury wallets, Overtime's admin multisigs, and its
  // OVER in the betting pools (every round, plus its share of open OVER bets).
  if (supplyFresh && betting && admin) {
    supplyFresh.adminOver = admin.total;
    supplyFresh.overPools = betting.over.total;
    supplyFresh.house = supplyFresh.treasury + admin.total + betting.over.total;
    supplyFresh.float = supplyFresh.circulating - supplyFresh.house;
    supplyFresh.floatUsd = priceData && priceData.usd ? supplyFresh.float * priceData.usd : null;
  }
  if (supplyFresh) {
    const lower = a => a.toLowerCase();
    const exclude = new Set([
      ...DEAD, ...OVER.treasury, ...Object.values(OVER.locked).flat(), ...Object.values(OVER.overPools),
      ...Object.values(supplyFresh.chains).flatMap(c => (c.lockedBy || []).map(l => l.address)),
      ...Object.values((admin && admin.chains) || {}).flatMap(o => Object.keys(o)),
      ...[...Object.values((capital && capital.usdc) || {}), ...Object.values((capital && capital.over) || {})].flatMap(v => (v && v.pools ? v.pools.map(p => p.address) : []))
    ].map(lower));
    supplyFresh.wallets = await step('wallet totals', () => walletTotals(supplyFresh.chains, exclude));
  }
  const supply = settle('supply', supplyFresh, prev && prev.supply);
  const liq = settle('liquidity', liquidity, prev && prev.liquidity);
  const gov = settle('governance', governance, prev && prev.governance);

  // Today's reading of the house's stablecoins goes into history first, so the checks and the
  // money reconciliation see it. History keeps only fresh readings.
  const date = new Date(now * 1000).toISOString().slice(0, 10);
  const fresh = name => sources[name] && sources[name].ok;
  const treasuryNow = treasury && treasury.length ? treasury[treasury.length - 1] : null;
  const ownUsd = treasuryNow ? treasuryNow.own : (prev ? prev.treasuryOwnUsd : null);
  const row = {
    date,
    price: fresh('price') ? priceData.usd : null,
    mcap: fresh('price') ? priceData.mcap : null,
    treasuryStable: fresh('treasury') && treasuryNow ? Math.round(treasuryNow.stable) : null,
    def: 3,  // 2: betting money counts every pool and open bets; 3: house OVER counts the admin multisigs
    poolUsdc: fresh('pools') ? pools.total : null,
    bettingUsdc: fresh('betting') ? betting.usdc.total : null,
    bettingOver: fresh('betting') ? betting.over.total : null,
    circulating: fresh('supply') ? Math.round(supply.circulating) : null,
    burned: fresh('supply') ? Math.round(supply.burned) : null,
    treasuryOver: fresh('supply') ? Math.round(supply.treasury) : null,
    poolOver: fresh('overPools') ? overPools.total : null,
    adminOver: fresh('admin') ? Math.round(admin.total) : null,
    houseOver: fresh('supply') && fresh('betting') && fresh('admin') ? Math.round(supply.treasury + admin.total + betting.over.total) : null,
    liquidityUsd: fresh('liquidity') ? liq.totalUsd : null,
    volume24h: fresh('liquidity') ? liq.volume24h : null,
    checks: {}
  };
  const i = history.findIndex(h => h.date === date);
  if (i >= 0) history[i] = row; else history.push(row);
  history.sort((a, b) => a.date.localeCompare(b.date));

  // Checks run on exactly what gets published (fresh or carried over), on completed days only.
  const fromRows = rows => (rows || []).map(([t, v]) => ({ t, v }));
  const rev = revRows ? completeDays(fromRows(revRows), now) : null;
  const buy = buyRows ? completeDays(fromRows(buyRows), now) : null;
  const readings = readingsFromHistory(history);
  const stats = computeStats({ rev, buy, treasury: treasuryRows ? treasuryRows.map(([t, stable]) => ({ t, stable })) : null, readings, overReadings: overReadingsFromHistory(history) });
  const checks = computeChecks(stats).map(c => ({ ...c, stale: c.sources.some(n => !sources[n] || !sources[n].ok) }));
  row.checks = Object.fromEntries(checks.map(c => [c.id, c.stale ? `${c.state} (stale)` : c.state]));
  const flows = computeFlows(readings, rev, buy);

  const next = {
    generatedAt: now,
    sources,
    price: priceData,
    revenue: revRows,
    buybacks: buyRows,
    treasury: treasuryRows,
    pools,
    overPools,
    treasuryOwnUsd: ownUsd,
    treasuryOwnSymbols: treJ ? ownSymbols(treJ) : (prev ? prev.treasuryOwnSymbols : null),
    supply,
    liquidity: liq,
    governance: gov,
    contracts,
    admin,
    betting,
    capital,
    checks,
    errors: ctx.errors,
    alertDetail: { houseOver: fresh('supply') ? (moves => moves.length ? `House wallets that moved since the last reading:\n- ${moves.join('\n- ')}` : null)(walletMoves(prev && prev.supply, supply, prev && prev.admin, fresh('admin') ? admin : null)) : null }
  };

  await writeFile(path.join(OUT, 'latest.json'), JSON.stringify(next));
  await writeFile(path.join(OUT, 'history.json'), JSON.stringify(history, null, 1));
  if (treJ) {
    const last = Object.fromEntries(Object.entries(treJ.chainTvls || {}).map(([k, v]) => [k, {
      tvl: Array.isArray(v.tvl) && v.tvl.length ? v.tvl[v.tvl.length - 1] : null,
      tokens: Array.isArray(v.tokensInUsd) && v.tokensInUsd.length ? v.tokensInUsd[v.tokensInUsd.length - 1] : null,
      days: Array.isArray(v.tokensInUsd) ? v.tokensInUsd.length : 0
    }]));
    await writeFile(path.join(OUT, 'treasury-debug.json'), JSON.stringify({ current: treJ.currentChainTvls || null, last }, null, 1));
  }

  const sent = await step('alerts', () => sendAlerts(prev, next));
  ctx.log(`Snapshot ${date}: ${checks.map(c => `${c.id}=${c.state}${c.stale ? ' (stale)' : ''}`).join(', ')}`);
  if (stats.lastT) ctx.log(`Completed days through ${fmtDate(stats.lastT)}: 30d result ${money(stats.rev30)}, buybacks ${money(stats.buy30)}`);
  if (supply) ctx.log(`Supply${fresh('supply') ? '' : ' (carried over)'}: circulating ${Math.round(supply.circulating)}, treasury ${Math.round(supply.treasury)}`);
  if (overPools) ctx.log(`OVER pools${fresh('overPools') ? '' : ' (carried over)'}: ${tokens(overPools.total)} OVER (${Object.entries(overPools.chains).map(([c, v]) => `${c} ${tokens(v.over)} in round ${v.round}`).join(', ')})`);
  if (betting) ctx.log(`Betting money${fresh('betting') ? '' : ' (carried over)'}: ${money(betting.usdc.idle)} USDC in pools (${money(betting.usdc.defaultPools)} default) + ${money(betting.usdc.onBets)} house share of ${betting.usdc.openBets} open bets; ${tokens(betting.over.idle)} OVER in pools + ${tokens(betting.over.onBets)} on bets`);
  if (pools) ctx.log(`Betting pools${fresh('pools') ? '' : ' (carried over)'}: ${money(pools.total)} idle USDC (${Object.entries(pools.chains).map(([c, v]) => `${c} ${money(v.usdc)} in round ${v.round}`).join(', ')})`);
  if (flows.ready) ctx.log(`Money in/out over ${flows.days} days: result ${money(flows.result)}, buybacks ${money(flows.buys)}, stablecoins ${money(flows.change)}, other ${money(flows.other)}`);
  if (liq) ctx.log(`Liquidity: ${money(liq.totalUsd)} in ${liq.pools.length} pools`);
  if (capital) for (const [kind, chains] of Object.entries(capital)) for (const [c, v] of Object.entries(chains)) {
    ctx.log(`Betting money (${kind}, ${c}): ${v.error ? 'failed: ' + v.error : `round ${v.round}; ${v.pools.map(p => `r${p.round}${p.round === 1 ? ' (default)' : ''} ${Math.round(p.amount)} [${p.bets} bets]`).join(', ')}; open bets ${v.open.skipped || `${v.open.open}/${v.open.bets} holding ${Math.round(v.open.held || 0)} (stakes ${v.open.stakes == null ? '?' : Math.round(v.open.stakes)})`}`}`);
  }
  if (sent && sent.length) ctx.log('Alerts:', sent.join(' | '));
  if (ctx.errors.length) ctx.log('Errors:', ctx.errors.join(' | '));
  return { next, history, sent: sent || [], stats, flows, ok: fresh('revenue') || fresh('treasury') };
}

// Run one snapshot. Everything has a default for the real job; tests override what they need.
export async function run({ now = Math.floor(Date.now() / 1000), fetchImpl, env = process.env, outDir, retryDelay = 1500, log = console.log, logError = console.error } = {}) {
  ctx = { fetch: fetchImpl || ((...a) => globalThis.fetch(...a)), env, errors: [], retryDelay, log, logError };
  const out = path.resolve(outDir || env.OUT_DIR || path.join(ROOT, 'data'));
  return main(now, out);
}

// Run when executed directly (node scripts/snapshot.mjs), not when imported by the tests.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await run();
  if (!result.ok) process.exitCode = 1; // nothing useful fetched
}
