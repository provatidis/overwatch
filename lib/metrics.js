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

// The house's stablecoins: treasury wallets, plus the betting pools from the day the treasury became
// their only liquidity provider (before that, pool money mostly belonged to outside LPs).
// rows: [t, treasuryStable, poolStable|null]
export function bankrollRows(treasury, pools) {
  const poolByDay = new Map((pools || []).map(p => [p.t, p.stable]));
  let lastPool = null;
  const days = [...new Set([...(treasury || []).map(r => r.t), ...poolByDay.keys()])].sort((a, b) => a - b);
  const tre = new Map((treasury || []).map(r => [r.t, r.stable]));
  let lastTre = null;
  const out = [];
  for (const t of days) {
    if (tre.has(t)) lastTre = tre.get(t);
    if (poolByDay.has(t)) lastPool = poolByDay.get(t);
    if (lastTre == null) continue;
    out.push([t, round(lastTre), t >= METHOD_CHANGE && lastPool != null ? round(lastPool) : null]);
  }
  return out;
}
export const bankrollFromRows = rows => (rows || []).map(([t, treasury, pools]) => ({ t, treasury, pools, v: treasury + (pools || 0) }));

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

// rev/buy: complete daily series [{t, v}] or null; bankroll: [{t, v, treasury, pools}] or null.
export function computeStats({ rev, buy, bankroll }) {
  const s = {};
  if (bankroll && bankroll.length) {
    const last = bankroll[bankroll.length - 1];
    s.bankrollNow = last.v;
    s.bankrollLast = last;
    s.bankroll30 = valueAt(bankroll, last.t - 30 * DAY, 'v');
    s.change30 = s.bankroll30 > 0 ? s.bankrollNow / s.bankroll30 - 1 : null;
  }
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

// Each check names the sources it depends on, so a failed source can mark it stale.
export function computeChecks(s) {
  const checks = [];
  const tb = THRESHOLDS.bankroll30d;
  checks.push({
    id: 'bankroll', title: 'House bankroll', sources: ['bankroll'],
    state: grade(s.change30, tb),
    text: ok(s.change30)
      ? `The house’s stablecoins, in the treasury and the betting pools, are ${pct(s.change30, true)} over 30 days, at ${money(s.bankrollNow)}. Watch below ${signedWhole(tb.good)}, alert below ${signedWhole(tb.watch)}.`
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
