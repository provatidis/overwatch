// Pure data shaping and the thesis checks, shared by the page and the snapshot job.
import { THRESHOLDS, METHOD_CHANGE } from './config.js';
import { money, pct, signedWhole, plainWhole, ok, fmtDate, MONTHS, MONTHS_LONG } from './format.js';

export const DAY = 86400;

// ---------- Daily series ----------
// DefiLlama summary JSON → [{ t, v }] sorted by day (t = UTC midnight, seconds).
export function dailySeries(json) {
  const rows = Array.isArray(json && json.totalDataChart) ? json.totalDataChart : [];
  return fromPairs(rows);
}
export function fromPairs(rows) {
  return rows
    .filter(r => Array.isArray(r) && ok(Number(r[0])))
    .map(([t, v]) => ({ t: Math.floor(t / DAY) * DAY, v: Number(v) || 0 }))
    .sort((a, b) => a.t - b.t);
}
// DefiLlama pulls Overtime's adapter hourly and files each day under its UTC start, so the newest
// entry is usually today so far. Headline figures use only days that have ended by `now`.
export function completeDays(series, now) {
  return (series || []).filter(p => p.t + DAY <= now);
}
export function sumWindow(series, endT, days) {
  const from = endT - (days - 1) * DAY;
  let s = 0;
  for (const p of series) if (p.t >= from && p.t <= endT) s += p.v;
  return s;
}

// ---------- Periods ----------
export function periodStart(t, mode) {
  const d = new Date(t * 1000);
  let m = d.getUTCMonth();
  if (mode === 'quarter') m -= m % 3;
  return Date.UTC(d.getUTCFullYear(), m, 1) / 1000;
}
export function periodNext(start, mode) {
  const d = new Date(start * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + (mode === 'quarter' ? 3 : 1), 1) / 1000;
}
export function periodLabel(start, mode, long) {
  const d = new Date(start * 1000), y = d.getUTCFullYear(), m = d.getUTCMonth();
  if (mode === 'quarter') { const q = Math.floor(m / 3) + 1; return long ? `Q${q} ${y}` : `Q${q} ’${String(y).slice(2)}`; }
  return long ? `${MONTHS_LONG[m]} ${y}` : `${MONTHS[m]} ’${String(y).slice(2)}`;
}
export function aggregate(rev, buy, mode) {
  const map = new Map();
  const add = (series, field) => {
    for (const p of series) {
      const s = periodStart(p.t, mode);
      let r = map.get(s);
      if (!r) { r = { start: s, end: periodNext(s, mode), rev: 0, buy: 0 }; map.set(s, r); }
      r[field] += p.v;
    }
  };
  add(rev, 'rev');
  add(buy, 'buy');
  const first = rev.length ? rev[0].t : 0, last = rev.length ? rev[rev.length - 1].t : 0;
  return [...map.values()]
    .filter(r => r.end > first)
    .sort((a, b) => a.start - b.start)
    .map(r => ({ ...r, partial: first > r.start || last < r.end - DAY, share: r.rev > 0 ? r.buy / r.rev : null }));
}

// ---------- Treasury ----------
const SKIP_KEY = /^(staking|pool2|borrowed|vesting|offers|doublecounted|liquidstaking|ownTokens)$/i;
const STABLE = /USD|DAI|FRAX|GHO|EURC/i;
const MAJOR = /^(W?ETH|ETHEREUM|W?BTC|BITCOIN|WRAPPED-BITCOIN|CBBTC|TBTC|WSTETH|STETH|RETH|CBETH|WEETH)$/i;
const OWN = /^(OVER|THALES)$/i;

// DefiLlama treasury JSON → [{ t, stable, major, other, own }] per day, forward-filled per chain.
export function parseTreasury(json) {
  const chains = (json && json.chainTvls) || {};
  const perChain = [];
  for (const [key, v] of Object.entries(chains)) {
    if (key.includes('-') || SKIP_KEY.test(key) || !v) continue;
    const m = new Map();
    if (Array.isArray(v.tokensInUsd) && v.tokensInUsd.length) {
      for (const e of v.tokensInUsd) {
        const b = { stable: 0, major: 0, other: 0 };
        for (const [sym, raw] of Object.entries(e.tokens || {})) {
          const val = Number(raw);
          if (!ok(val) || OWN.test(sym)) continue;
          if (STABLE.test(sym)) b.stable += val; else if (MAJOR.test(sym)) b.major += val; else b.other += val;
        }
        m.set(Math.floor(e.date / DAY), b);
      }
    } else if (Array.isArray(v.tvl)) {
      for (const e of v.tvl) m.set(Math.floor(e.date / DAY), { stable: 0, major: 0, other: Number(e.totalLiquidityUSD) || 0 });
    }
    if (m.size) perChain.push(m);
  }
  const own = new Map();
  for (const e of (chains.OwnTokens && chains.OwnTokens.tvl) || []) own.set(Math.floor(e.date / DAY), Number(e.totalLiquidityUSD) || 0);

  const days = new Set();
  perChain.forEach(m => m.forEach((_, d) => days.add(d)));
  const lastSeen = perChain.map(() => null);
  let lastOwn = null;
  const out = [];
  for (const d of [...days].sort((a, b) => a - b)) {
    const row = { t: d * DAY, stable: 0, major: 0, other: 0, own: null };
    perChain.forEach((m, i) => {
      if (m.has(d)) lastSeen[i] = m.get(d);
      const b = lastSeen[i];
      if (b) { row.stable += b.stable; row.major += b.major; row.other += b.other; }
    });
    if (own.has(d)) lastOwn = own.get(d);
    row.own = lastOwn;
    out.push(row);
  }
  return out;
}
export const treasuryToRows = rows => rows.map(r => [r.t, round(r.stable), round(r.major), round(r.other), r.own == null ? null : round(r.own)]);
export const treasuryFromRows = rows => (rows || []).map(([t, stable, major, other, own]) => ({ t, stable, major, other, own }));
const round = v => Math.round(v);

// Daily readings of the house's stablecoins from history.json: the treasury wallets (DefiLlama) and
// the idle USDC in the betting pools (read onchain). Only days where both were read fresh count.
export function readingsFromHistory(history) {
  return (history || [])
    .filter(h => ok(h.treasuryStable) && ok(h.poolUsdc))
    .map(h => ({ t: Date.parse(h.date) / 1000, treasury: h.treasuryStable, pools: h.poolUsdc, v: h.treasuryStable + h.poolUsdc }));
}

export function valueAt(series, t, field) {
  let found = null;
  for (const p of series) { if (p.t <= t) found = p; else break; }
  return found ? found[field] : null;
}

// ---------- Thesis checks ----------
function grade(value, t) {
  if (!ok(value)) return 'unknown';
  return value >= t.good ? 'good' : value >= t.watch ? 'watch' : 'alert';
}
export const GRADE = { good: ['✓', 'Healthy'], watch: ['!', 'Watch'], alert: ['✕', 'Alert'], pending: ['–', 'Not comparable yet'], unknown: ['?', 'No data'] };
export const RANK = { good: 0, watch: 1, alert: 2, pending: -1, unknown: -1 };
// The first day a 90-day window and the 90 days before it both fall after the method change.
export const FIRST_COMPARABLE = METHOD_CHANGE + 180 * DAY;

// rev/buy: complete daily series [{t, v}] or null; treasury: [{t, stable, ...}] (DefiLlama, daily);
// readings: [{t, treasury, pools, v}] from readingsFromHistory.
export function computeStats({ rev, buy, treasury, readings }) {
  const s = {};
  // Bankroll change: treasury + pools when there are onchain readings ~30 days apart, otherwise the
  // treasury alone from DefiLlama's history. Always like for like.
  const r = readings || [];
  const lastR = r.length ? r[r.length - 1] : null;
  const baseR = lastR ? valueAtRow(r, lastR.t - 30 * DAY) : null;
  if (lastR && baseR && lastR.t - baseR.t >= 28 * DAY) {
    s.bankrollMode = 'full';
    s.bankrollNow = lastR.v;
    s.change30 = baseR.v > 0 ? lastR.v / baseR.v - 1 : null;
  } else if (treasury && treasury.length) {
    const last = treasury[treasury.length - 1];
    s.bankrollMode = 'treasury';
    s.bankrollNow = last.stable;
    const base = valueAt(treasury, last.t - 30 * DAY, 'stable');
    s.change30 = base > 0 ? last.stable / base - 1 : null;
    s.poolsFullFrom = r.length ? r[0].t + 30 * DAY : null;
  }
  s.latestReading = lastR;
  if (rev && rev.length) {
    const lastT = rev[rev.length - 1].t;
    s.lastT = lastT;
    s.rev30 = sumWindow(rev, lastT, 30);
    s.rev90 = sumWindow(rev, lastT, 90);
    s.revPrev90 = sumWindow(rev, lastT - 90 * DAY, 90);
    s.rev365 = sumWindow(rev, lastT, 365);
    s.comparable = lastT + DAY >= FIRST_COMPARABLE;
    // Buybacks only count if their series reaches the same last day.
    if (buy && buy.length && buy[buy.length - 1].t >= lastT) {
      s.buy30 = sumWindow(buy, lastT, 30);
      s.buy90 = sumWindow(buy, lastT, 90);
      const recent = buy.filter(p => p.t > lastT - 30 * DAY && p.t <= lastT).map(p => p.v);
      if (recent.length >= 20) {
        const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
        const sd = Math.sqrt(recent.reduce((a, b) => a + (b - mean) ** 2, 0) / recent.length);
        s.buyDaily = mean;
        s.buySteady = mean > 0 && sd / mean < 0.25;
      }
    }
  }
  return s;
}
function valueAtRow(rows, t) {
  let found = null;
  for (const p of rows) { if (p.t <= t) found = p; else break; }
  return found;
}

// Where the money went between two readings, up to 30 days apart: what the house made, minus
// buybacks, against what actually happened to its stablecoins. The rest is everything else:
// running costs, incentives, swaps into other tokens, and money tied up in open bets.
export const FLOWS_MIN_DAYS = 7;
export function computeFlows(readings, rev, buy) {
  const r = readings || [];
  if (r.length < 2) return { ready: false, days: 0, since: r.length ? r[0].t : null };
  const last = r[r.length - 1];
  const first = r.find(x => x.t >= last.t - 30 * DAY);
  const days = Math.round((last.t - first.t) / DAY);
  const inWindow = series => (series || []).filter(p => p.t >= first.t && p.t < last.t);
  const revDays = inWindow(rev), buyDays = inWindow(buy);
  if (revDays.length < days || buyDays.length < days) return { ready: false, days, since: first.t, missing: true };
  const result = revDays.reduce((a, p) => a + p.v, 0);
  const buys = buyDays.reduce((a, p) => a + p.v, 0);
  const change = last.v - first.v;
  return {
    ready: days >= FLOWS_MIN_DAYS, days, since: first.t, from: first.t, to: last.t,
    result, buys, expected: result - buys, change, other: change - (result - buys),
    treasuryChange: last.treasury - first.treasury, poolsChange: last.pools - first.pools
  };
}

// Each check names the sources it depends on, so a failed source can mark it stale.
export function computeChecks(s) {
  const checks = [];
  const tb = THRESHOLDS.bankroll30d;
  const what = s.bankrollMode === 'full' ? 'The house’s stablecoins, in the treasury and the betting pools,' : 'Treasury stablecoins';
  const later = s.bankrollMode === 'treasury' && s.poolsFullFrom ? ` Betting-pool capital joins this check from ${fmtDate(s.poolsFullFrom)}, after 30 days of onchain readings.` : '';
  checks.push({
    id: 'bankroll', title: 'House bankroll', sources: s.bankrollMode === 'full' ? ['treasury', 'pools'] : ['treasury'],
    state: grade(s.change30, tb),
    text: ok(s.change30)
      ? `${what} are ${pct(s.change30, true)} over 30 days, at ${money(s.bankrollNow)}. Watch below ${signedWhole(tb.good)}, alert below ${signedWhole(tb.watch)}.${later}`
      : 'Treasury data didn’t load.'
  });

  const th = THRESHOLDS.houseTrend;
  if (!ok(s.rev90)) {
    checks.push({ id: 'trend', title: 'House result trend', sources: ['revenue'], state: 'unknown', text: 'Revenue data didn’t load.' });
  } else if (s.rev90 <= 0) {
    checks.push({ id: 'trend', title: 'House result trend', sources: ['revenue'], state: 'alert', text: `The house lost ${money(-s.rev90)} over the 90 days to ${fmtDate(s.lastT)}.` });
  } else if (!s.comparable) {
    checks.push({
      id: 'trend', title: 'House result trend', sources: ['revenue'], state: 'pending',
      text: `DefiLlama switched from counting fees to the full betting result on ${fmtDate(METHOD_CHANGE)}, so earlier periods aren’t comparable. Like-for-like 90-day comparisons start ${fmtDate(FIRST_COMPARABLE)}. The 90 days to ${fmtDate(s.lastT)} brought in ${money(s.rev90)}.`
    });
  } else {
    const change = s.revPrev90 > 0 ? s.rev90 / s.revPrev90 - 1 : null;
    checks.push({
      id: 'trend', title: 'House result trend', sources: ['revenue'], state: grade(change, th),
      text: `The 90 days to ${fmtDate(s.lastT)} brought in ${money(s.rev90)}, ${ok(change) ? pct(change, true) : 'n/a'} against ${money(s.revPrev90)} in the 90 days before. Watch below ${signedWhole(th.good)}, alert below ${signedWhole(th.watch)}.`
    });
  }

  const ts = THRESHOLDS.buybackShare;
  const steady = s.buySteady ? ` Buybacks run at a steady ~${money(s.buyDaily)} a day, so this share mostly moves with the house result.` : '';
  if (ok(s.rev90) && ok(s.buy90)) {
    const share = s.rev90 > 0 ? s.buy90 / s.rev90 : null;
    let state = s.rev90 <= 0 ? 'alert' : grade(share, ts), text;
    if (s.rev90 <= 0) text = `The house lost ${money(-s.rev90)} over the last 90 days, while ${money(s.buy90)} went to buybacks.`;
    else if (share > 1) { state = 'watch'; text = `Buybacks (${money(s.buy90)}) were larger than the ${money(s.rev90)} house result over the last 90 days, so the treasury is topping them up. That can’t last.`; }
    else text = `Buybacks took ${pct(share)} of the ${money(s.rev90)} house result over the 90 days to ${fmtDate(s.lastT)}. Healthy from ${plainWhole(ts.good)}, alert below ${plainWhole(ts.watch)}.${steady}`;
    checks.push({ id: 'share', title: 'Share bought back', sources: ['revenue', 'buybacks'], state, text });
  } else {
    checks.push({ id: 'share', title: 'Share bought back', sources: ['revenue', 'buybacks'], state: 'unknown', text: 'Revenue or buyback data didn’t load.' });
  }
  return checks;
}

// ---------- Governance ----------
// Who cast the votes: the council's TC-NFTs, or OVER itself.
export function voterGroup(p) {
  const sym = String(p.symbol || '');
  if (/TC-?NFT/i.test(sym) || (p.strategies || []).some(n => /erc721|nft/i.test(n))) return { council: true, label: `council (${sym || 'NFT'})` };
  return { council: false, label: sym || 'votes' };
}
