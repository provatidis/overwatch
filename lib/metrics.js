// Pure data shaping and the thesis checks, shared by the page and the snapshot job.
import { THRESHOLDS } from './config.js';
import { money, pct, signedWhole, plainWhole, ok, MONTHS, MONTHS_LONG } from './format.js';

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
export const GRADE = { good: ['✓', 'Healthy'], watch: ['!', 'Watch'], alert: ['✕', 'Alert'], unknown: ['?', 'No data'] };
export const RANK = { good: 0, watch: 1, alert: 2, unknown: -1 };

// rev/buy: [{t, v}] daily; treasury: [{t, stable, ...}] daily.
export function computeStats(rev, buy, treasury) {
  const s = {};
  if (treasury && treasury.length) {
    const last = treasury[treasury.length - 1];
    s.stablesNow = last.stable;
    s.stables30 = valueAt(treasury, last.t - 30 * DAY, 'stable');
    s.change30 = s.stables30 > 0 ? s.stablesNow / s.stables30 - 1 : null;
    s.treasuryLast = last;
  }
  if (rev && rev.length) {
    const lastT = rev[rev.length - 1].t;
    s.lastT = lastT;
    s.rev30 = sumWindow(rev, lastT, 30);
    s.rev90 = sumWindow(rev, lastT, 90);
    s.rev365 = sumWindow(rev, lastT, 365);
    if (buy) { s.buy30 = sumWindow(buy, lastT, 30); s.buy90 = sumWindow(buy, lastT, 90); }
    const quarters = aggregate(rev, buy || [], 'quarter').filter(q => !q.partial);
    if (quarters.length >= 2) { s.qLast = quarters[quarters.length - 1]; s.qPrev = quarters[quarters.length - 2]; }
  }
  return s;
}

export function computeChecks(s) {
  const checks = [];
  const tb = THRESHOLDS.bankroll30d;
  checks.push({
    id: 'bankroll', title: 'House bankroll',
    state: grade(s.change30, tb),
    text: ok(s.change30)
      ? `Treasury stablecoins are ${pct(s.change30, true)} over 30 days, at ${money(s.stablesNow)}. Watch below ${signedWhole(tb.good)}, alert below ${signedWhole(tb.watch)}.`
      : 'Treasury data didn’t load.'
  });

  const tq = THRESHOLDS.quarter;
  if (s.qLast && s.qPrev) {
    const a = s.qLast, b = s.qPrev;
    const change = b.rev > 0 ? a.rev / b.rev - 1 : null;
    checks.push({
      id: 'quarter', title: 'Quarterly house result',
      state: a.rev <= 0 ? 'alert' : grade(change, tq),
      text: `${periodLabel(a.start, 'quarter', true)} brought in ${money(a.rev)}, ${ok(change) ? pct(change, true) : 'n/a'} against ${money(b.rev)} in ${periodLabel(b.start, 'quarter', true)}. Watch on any drop, alert below ${signedWhole(tq.watch)}.`
    });
  } else {
    checks.push({ id: 'quarter', title: 'Quarterly house result', state: 'unknown', text: 'Not enough revenue history loaded.' });
  }

  const ts = THRESHOLDS.buybackShare;
  if (ok(s.rev90) && ok(s.buy90)) {
    const share = s.rev90 > 0 ? s.buy90 / s.rev90 : null;
    let state = s.rev90 <= 0 ? 'alert' : grade(share, ts), text;
    if (s.rev90 <= 0) text = `The house lost ${money(-s.rev90)} over the last 90 days, while ${money(s.buy90)} went to buybacks.`;
    else if (share > 1) { state = 'watch'; text = `Buybacks (${money(s.buy90)}) were larger than the ${money(s.rev90)} house result over the last 90 days, so the treasury is topping them up. That can’t last.`; }
    else text = `Buybacks took ${pct(share)} of the ${money(s.rev90)} house result over the last 90 days. Healthy from ${plainWhole(ts.good)}, alert below ${plainWhole(ts.watch)}.`;
    checks.push({ id: 'share', title: 'Share bought back', state, text });
  } else {
    checks.push({ id: 'share', title: 'Share bought back', state: 'unknown', text: 'Revenue or buyback data didn’t load.' });
  }
  return checks;
}
