// Daily snapshot for OVER watch. Runs in GitHub Actions on Node 20+ with no dependencies.
// Writes data/latest.json and data/history.json, then opens or closes GitHub issues
// when a thesis check changes state or a new governance vote appears.
//
// Env: GITHUB_TOKEN + GITHUB_REPOSITORY to send alerts, OUT_DIR to write somewhere else,
// NO_ALERTS=1 to skip alerts.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { OVER, DEAD, LOCKED_NAME, HOLDER_VALUE } from '../lib/config.js';
import { dailySeries, parseTreasury, treasuryToRows, computeStats, computeChecks, GRADE, RANK, DAY } from '../lib/metrics.js';
import { money } from '../lib/format.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(process.env.OUT_DIR || path.join(ROOT, 'data'));
const PAGE_URL = 'https://provatidis.com/overwatch/';
const UA = 'overwatch-snapshot (+https://github.com/provatidis/overwatch)';
const errors = [];

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

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJSON(url, opts = {}, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        ...opts,
        headers: { 'user-agent': UA, accept: 'application/json', ...(opts.headers || {}) },
        signal: AbortSignal.timeout(60_000)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
      return await res.json();
    } catch (e) {
      last = e;
      if (i < tries - 1) await sleep(1500 * (i + 1));
    }
  }
  throw last;
}

async function step(name, fn) {
  try { return await fn(); }
  catch (e) { errors.push(`${name}: ${e.message}`); console.error(`[${name}]`, e); return null; }
}

// ---------- Onchain reads ----------
async function ethCall(chain, to, data) {
  let last;
  for (const url of RPCS[chain]) {
    try {
      const j = await getJSON(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] })
      }, 2);
      if (j.error) throw new Error(j.error.message || 'RPC error');
      if (!j.result || j.result === '0x') throw new Error('empty RPC result');
      return BigInt(j.result);
    } catch (e) { last = e; }
  }
  throw last;
}
const UNIT = 10n ** BigInt(OVER.decimals - 6);
const toTokens = big => Number(big / UNIT) / 1e6;
const totalSupply = (chain, token) => ethCall(chain, token, '0x18160ddd').then(toTokens);
const balanceOf = (chain, token, who) =>
  ethCall(chain, token, '0x70a08231' + who.toLowerCase().replace(/^0x/, '').padStart(64, '0')).then(toTokens);

async function topHolders(chain, token) {
  const j = await getJSON(`${BLOCKSCOUT[chain]}/api/v2/tokens/${token}/holders`, {}, 2);
  return (j.items || []).slice(0, 15).map(h => {
    const a = h.address || {};
    const impl = Array.isArray(a.implementations) && a.implementations[0] ? a.implementations[0].name : null;
    return { address: (a.hash || '').toLowerCase(), name: a.name || impl || null, contract: !!a.is_contract, tokens: toTokens(BigInt(h.value || '0')) };
  });
}

async function supplySnapshot(price) {
  const chains = {};
  const lower = s => s.toLowerCase();
  const treasurySet = new Set(OVER.treasury.map(lower));
  for (const [chain, token] of Object.entries(OVER.tokens)) {
    const c = { total: null, dead: 0, locked: 0, treasury: 0, lockedBy: [], holders: null };
    c.total = await totalSupply(chain, token);
    for (const d of DEAD) c.dead += await balanceOf(chain, token, d).catch(() => 0);
    for (const t of treasurySet) c.treasury += await balanceOf(chain, token, t).catch(() => 0);
    c.holders = await step(`holders ${chain}`, () => topHolders(chain, token));
    const lockedAddrs = new Set((OVER.locked[chain] || []).map(lower));
    for (const h of c.holders || []) if (h.contract && h.name && LOCKED_NAME.test(h.name)) lockedAddrs.add(h.address);
    for (const a of lockedAddrs) {
      const bal = await balanceOf(chain, token, a).catch(() => null);
      if (bal != null) { c.locked += bal; c.lockedBy.push({ address: a, tokens: bal }); }
    }
    chains[chain] = c;
  }
  const circulating = Object.values(chains).reduce((s, c) => s + c.total - c.dead - c.locked, 0);
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
  return {
    totalUsd: pools.reduce((s, p) => s + p.liquidityUsd, 0),
    volume24h: pools.reduce((s, p) => s + p.volume24h, 0),
    pools: pools.slice(0, 20)
  };
}

async function governanceSnapshot() {
  const query = `query { proposals(first: 10, skip: 0, where: { space_in: ["${OVER.snapshotSpace}"] }, orderBy: "created", orderDirection: desc) { id title start end state choices scores scores_total link } }`;
  const j = await getJSON('https://hub.snapshot.org/graphql', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query })
  });
  if (j.errors) throw new Error(j.errors.map(e => e.message).join('; '));
  return {
    space: OVER.snapshotSpace,
    proposals: ((j.data && j.data.proposals) || []).map(p => ({
      id: p.id, title: p.title, state: p.state, start: p.start, end: p.end,
      link: p.link || `https://snapshot.box/#/s:${OVER.snapshotSpace}/proposal/${p.id}`,
      choices: p.choices, scores: p.scores, total: p.scores_total,
      holderValue: HOLDER_VALUE.test(p.title || '')
    }))
  };
}

async function priceSnapshot() {
  const j = await getJSON('https://api.coingecko.com/api/v3/simple/price?ids=overtime&vs_currencies=usd&include_market_cap=true&include_24hr_change=true');
  const o = j && j.overtime;
  if (!o || typeof o.usd !== 'number') throw new Error('no CoinGecko price');
  return { usd: o.usd, mcap: o.usd_market_cap || null, change24h: typeof o.usd_24h_change === 'number' ? o.usd_24h_change / 100 : null };
}

// ---------- Alerts ----------
async function gh(p, method = 'GET', body) {
  const res = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}${p}`, {
    method,
    headers: {
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
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
  if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_REPOSITORY || process.env.NO_ALERTS === '1' || !prev) return [];
  const sent = [];
  const openIssues = await gh('/issues?state=open&per_page=100');
  const marker = id => `<!-- overwatch:${id} -->`;

  for (const c of next.checks) {
    const before = (prev.checks || []).find(x => x.id === c.id);
    if (!before || before.state === c.state || c.state === 'unknown' || before.state === 'unknown') continue;
    if (RANK[c.state] > RANK[before.state]) {
      const title = `${c.title}: ${GRADE[before.state][1]} → ${GRADE[c.state][1]}`;
      await gh('/issues', 'POST', { title: `[OVER watch] ${title}`, body: `${c.text}\n\n[Open OVER watch](${PAGE_URL})\n\n${marker('check:' + c.id)}` });
      sent.push(title);
    } else if (c.state === 'good') {
      for (const issue of openIssues.filter(i => (i.body || '').includes(marker('check:' + c.id)))) {
        await gh(`/issues/${issue.number}/comments`, 'POST', { body: `Back to Healthy. ${c.text}` });
        await gh(`/issues/${issue.number}`, 'PATCH', { state: 'closed', state_reason: 'completed' });
        sent.push(`closed #${issue.number}`);
      }
    }
  }

  if (prev.governance && next.governance) {
    const known = new Set(prev.governance.proposals.map(p => p.id));
    for (const p of next.governance.proposals.filter(p => !known.has(p.id)).reverse()) {
      const when = p.end ? ` Voting closes ${new Date(p.end * 1000).toUTCString().replace(/:\d\d GMT/, ' UTC')}.` : '';
      const tag = p.holderValue ? ' Touches buybacks, fees or the treasury.' : '';
      await gh('/issues', 'POST', { title: `[OVER watch] New vote: ${p.title}`, body: `${p.link}${when}${tag}\n\n${marker('proposal:' + p.id)}` });
      sent.push(`vote: ${p.title}`);
    }
  }
  return sent;
}

// ---------- Main ----------
async function readJSON(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const prev = await readJSON(path.join(OUT, 'latest.json'));
  const history = (await readJSON(path.join(OUT, 'history.json'))) || [];

  const [revJ, buyJ, treJ, price, liquidity, governance] = await Promise.all([
    step('house result', () => getJSON('https://api.llama.fi/summary/fees/overtime?dataType=dailyRevenue&excludeTotalDataChartBreakdown=true')),
    step('buybacks', () => getJSON('https://api.llama.fi/summary/fees/overtime?dataType=dailyHoldersRevenue&excludeTotalDataChartBreakdown=true')),
    step('treasury', () => getJSON('https://api.llama.fi/treasury/overtime')),
    step('price', priceSnapshot),
    step('liquidity', liquiditySnapshot),
    step('governance', governanceSnapshot)
  ]);

  const rev = revJ ? dailySeries(revJ) : null;
  const buy = buyJ ? dailySeries(buyJ) : null;
  const treasury = treJ ? parseTreasury(treJ) : null;
  const priceData = price || (prev && prev.price ? { ...prev.price, stale: true } : null);
  if (priceData && !(priceData.mcap > 0) && treJ && Number(treJ.mcap) > 0) priceData.mcap = Number(treJ.mcap);
  const supply = await step('supply', () => supplySnapshot(priceData && priceData.usd));

  // Keep the last good copy of any part that failed today.
  const keep = (fresh, key) => fresh != null ? fresh : (prev ? prev[key] : null);
  const stats = computeStats(rev || [], buy || [], treasury || []);
  const checks = computeChecks(stats);
  const ownUsd = treasury && treasury.length ? treasury[treasury.length - 1].own : null;

  const next = {
    generatedAt: Math.floor(Date.now() / 1000),
    price: priceData,
    revenue: rev ? rev.map(p => [p.t, Math.round(p.v)]) : keep(null, 'revenue'),
    buybacks: buy ? buy.map(p => [p.t, Math.round(p.v)]) : keep(null, 'buybacks'),
    treasury: treasury ? treasuryToRows(treasury) : keep(null, 'treasury'),
    treasuryOwnUsd: ownUsd != null ? ownUsd : keep(null, 'treasuryOwnUsd'),
    supply: keep(supply, 'supply'),
    liquidity: keep(liquidity, 'liquidity'),
    governance: keep(governance, 'governance'),
    checks,
    errors
  };

  const date = new Date().toISOString().slice(0, 10);
  const row = {
    date,
    price: priceData ? priceData.usd : null,
    mcap: priceData ? priceData.mcap : null,
    stables: stats.stablesNow != null ? Math.round(stats.stablesNow) : null,
    circulating: supply ? Math.round(supply.circulating) : null,
    burned: supply ? Math.round(supply.burned) : null,
    treasuryOver: supply ? Math.round(supply.treasury) : null,
    liquidityUsd: liquidity ? liquidity.totalUsd : null,
    volume24h: liquidity ? liquidity.volume24h : null,
    checks: Object.fromEntries(checks.map(c => [c.id, c.state]))
  };
  const i = history.findIndex(h => h.date === date);
  if (i >= 0) history[i] = row; else history.push(row);
  history.sort((a, b) => a.date.localeCompare(b.date));

  await writeFile(path.join(OUT, 'latest.json'), JSON.stringify(next));
  await writeFile(path.join(OUT, 'history.json'), JSON.stringify(history, null, 1));

  const sent = await step('alerts', () => sendAlerts(prev, next));
  console.log(`Snapshot ${date}: ${checks.map(c => `${c.id}=${c.state}`).join(', ')}`);
  if (supply) console.log(`Supply: circulating ${Math.round(supply.circulating)}, treasury ${Math.round(supply.treasury)}`);
  if (liquidity) console.log(`Liquidity: ${money(liquidity.totalUsd)} in ${liquidity.pools.length} pools`);
  if (sent && sent.length) console.log('Alerts:', sent.join(' | '));
  if (errors.length) console.log('Errors:', errors.join(' | '));
  if (!rev && !treasury) process.exitCode = 1; // nothing useful fetched
}

await main();
