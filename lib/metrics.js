// Pure data shaping and the thesis checks, shared by the page and the snapshot job.
import { houseEvidence, validTransferReading, verifiedWindow } from './house-evidence.js';
import { THRESHOLDS, METHOD_CHANGE } from './config.js';
import { money, tokens, coins, pct, times, signedWhole, ok, fmtDate, MONTHS, MONTHS_LONG } from './format.js';

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

// The house's money on each reading, all read onchain: stablecoins, plus ETH and BTC counted in
// coins and valued at one price, the latest reading's, so only coins won, lost or spent move the
// total, never their market price. Three places: the treasury wallets; the betting pools (every
// round's pool in USDC, ETH and BTC, and the house's share of open bets); and the casino games'
// and Speed Markets' bankrolls. Rows from before 23 Nov 2026 (definition 4) counted less, so they're
// left out rather than compared with the full figure.
const sum3 = a => a[0] + a[1] + a[2];
export function readingsFromHistory(history) {
  const rows = (history || []).filter(h => h.def >= 4 && ok(h.walletStable) && ok(h.bettingUsdc) && ok(h.gamesUsdc) && Array.isArray(h.eth) && Array.isArray(h.btc));
  const priced = [...(history || [])].reverse().find(h => ok(h.ethPrice) && ok(h.btcPrice));
  if (!priced) return [];
  const pe = priced.ethPrice, pb = priced.btcPrice;
  const usd = (h, i) => h.eth[i] * pe + h.btc[i] * pb;
  return rows.map(h => {
    const treasury = h.walletStable + usd(h, 0), pools = h.bettingUsdc + usd(h, 1), games = h.gamesUsdc + usd(h, 2);
    return {
      t: Date.parse(h.date) / 1000, treasury, pools, games, v: treasury + pools + games,
      stable: h.walletStable + h.bettingUsdc + h.gamesUsdc, eth: sum3(h.eth), btc: sum3(h.btc), ethPrice: pe, btcPrice: pb
    };
  });
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
export function computeStats({ rev, buy, treasury, readings, overReadings }) {
  const s = {};
  // Bankroll change: all the house's money when there are onchain readings ~30 days apart, otherwise
  // the treasury's stablecoins alone from DefiLlama's history. Always like for like.
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
    s.rev7 = sumWindow(rev, lastT, 7);
    if (buy && buy.length && buy[buy.length - 1].t >= lastT) {
      s.buy7 = sumWindow(buy, lastT, 7);
      s.buy30 = sumWindow(buy, lastT, 30);
      s.buy90 = sumWindow(buy, lastT, 90);
      Object.assign(s, coverHistory(rev, buy, lastT));
      const recent = buy.filter(p => p.t > lastT - 30 * DAY && p.t <= lastT).map(p => p.v);
      if (recent.length >= 20) {
        const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
        const sd = Math.sqrt(recent.reduce((a, b) => a + (b - mean) ** 2, 0) / recent.length);
        s.buyDaily = mean;
        s.buySteady = mean > 0 && sd / mean < 0.25;
      }
      // Buyback rate: the last 7 days against the 30 before them.
      const daily = (from, to) => { const xs = buy.filter(p => p.t >= from && p.t <= to).map(p => p.v); return xs.length ? { mean: xs.reduce((a, b) => a + b, 0) / xs.length, n: xs.length } : null; };
      const recent7 = daily(lastT - 6 * DAY, lastT), base30 = daily(lastT - 36 * DAY, lastT - 7 * DAY);
      if (recent7 && base30 && recent7.n >= 6 && base30.n >= 25) {
        s.rate7 = recent7.mean;
        s.rate30 = base30.mean;
        s.rateRatio = base30.mean > 0 ? recent7.mean / base30.mean : null;
        s.ratePaused = buy.filter(p => p.t > lastT - 3 * DAY && p.t <= lastT).every(p => p.v <= 0);
      }
    }
  }
  const over = overReadings || [];
  const last = over.at(-1);
  if (last) {
    s.overLast = last;
    const checkpoint = last.transfers;
    const epoch = validTransferReading(checkpoint) ? Date.parse(checkpoint.startDate) / 1000 : null;
    const eligible = ok(epoch) ? over.filter(row => row.t >= epoch) : over;
    const base = valueAtRow(eligible, last.t - 7 * DAY) || eligible[0];
    const previous = over.at(-2);
    let window = null;
    if (base && base !== last) {
      s.overBase = base;
      if (base.complete && last.complete) window = verifiedWindow(over, base, last);
      if (window && base.v > 0) {
        s.overDays = Math.round((last.t - base.t) / DAY);
        s.overBought = window.bought;
        s.overBurned = window.burned;
        // Negative is a net decrease in house custody after purchases and house burns.
        s.overNet = last.v - base.v + last.inventory - base.inventory + window.burned - window.bought;
        s.overChange = s.overNet / base.v;
      }
    } else if (last.complete && validTransferReading(checkpoint) && last.t === epoch) {
      s.overFirst = true;
    }
    s.overEvidence = houseEvidence(window, base !== last ? base : null, last, previous);
  }
  return s;
}
// How buyback cover has behaved since the method change, so one bad week isn't misread: the
// 7-day blocks (counting back from the last day) where the house result fell short of buybacks,
// and the lowest cover over any 90 days. Only windows that fall wholly after the change count.
function coverHistory(rev, buy, lastT) {
  const out = { coverWeeks: 0, coverWeeksShort: 0, coverMin90: null };
  for (let end = lastT; end - 6 * DAY >= METHOD_CHANGE; end -= 7 * DAY) {
    const b = sumWindow(buy, end, 7);
    if (b <= 0) continue;
    out.coverWeeks++;
    if (sumWindow(rev, end, 7) < b) out.coverWeeksShort++;
  }
  for (let end = METHOD_CHANGE + 89 * DAY; end <= lastT; end += DAY) {
    const b = sumWindow(buy, end, 90);
    if (b <= 0) continue;
    const c = sumWindow(rev, end, 90) / b;
    if (out.coverMin90 == null || c < out.coverMin90) out.coverMin90 = c;
  }
  return out;
}

function valueAtRow(rows, t) {
  let found = null;
  for (const p of rows) { if (p.t <= t) found = p; else break; }
  return found;
}

// The house's OVER on each reading: treasury wallets, Overtime's admin multisigs, the OVER betting
// pools, and the casino's and Speed Markets' bankrolls. Rows before 23 Nov 2026 counted less
// (version 3 added the admin multisigs, version 4 the casino and Speed Markets), so they're left
// out rather than compared with the full figure.
// Keep incomplete rows so a failed endpoint cannot silently fall back to a different date.
export function overReadingsFromHistory(history) {
  return (history || []).filter(h => h.def >= 4).map(h => ({
    t: Date.parse(h.date) / 1000, wallets: h.treasuryOver, admin: h.adminOver, pools: h.bettingOver, games: h.gamesOver,
    v: h.houseOver, inventory: h.buybackInventory, float: h.float, transfers: h.houseTransfers,
    complete: [h.houseOver, h.treasuryOver, h.adminOver, h.bettingOver, h.gamesOver, h.buybackInventory].every(ok)
  }));
}

// Where the money went between two readings, up to 30 days apart: what the house made, minus
// buybacks, against what actually happened to its money (treasury, betting pools and open bets,
// casino and Speed Markets; ETH and BTC at one price). The rest is everything else: running costs,
// incentives, swaps into other tokens.
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
    treasuryChange: last.treasury - first.treasury, poolsChange: last.pools - first.pools, gamesChange: last.games - first.games
  };
}

// Each check names the sources it depends on, so a failed source can mark it stale.
// Why each check matters, for someone seeing the page for the first time.
export const WHY = {
  bankroll: 'The treasury backs every bet. If its money shrinks, losses or spending are outrunning what the house wins.',
  trend: 'Buybacks only last if the house keeps winning, so this compares its latest 90 days with the 90 before.',
  cover: 'Buybacks should be paid for by what the house wins, not by drawing down the treasury.',
  rate: 'Buybacks are how holders get paid. A cut is the clearest sign that payout is shrinking.',
  houseOver: 'This compares the OVER held by the treasury, admin multisigs, betting pools, casino, Speed Markets and buyback contracts. Purchases and house-funded burns are measured from transfer receipts.'
};

export function computeChecks(s) {
  const checks = [];
  const tb = THRESHOLDS.bankroll30d;
  const full = s.bankrollMode === 'full', L = s.latestReading;
  const limits = ` Watch below ${signedWhole(tb.good)}, alert below ${signedWhole(tb.watch)}.`;
  const later = !full && s.poolsFullFrom ? ` The rest of the house’s money (the betting pools, the casino and Speed Markets, and its ETH and BTC) joins this check from ${fmtDate(s.poolsFullFrom)}, after 30 days of onchain readings.` : '';
  checks.push({
    id: 'bankroll', title: 'House bankroll', sources: full ? ['betting', 'house'] : ['treasury'],
    state: grade(s.change30, tb),
    text: !ok(s.change30)
      ? 'Treasury data didn’t load.'
      : full
        ? `The house’s money is ${pct(s.change30, true)} over 30 days, at ${money(s.bankrollNow)}: ${money(L.stable)} in stablecoins plus ${coins(L.eth)} ETH and ${coins(L.btc, 2)} BTC, across the treasury, the betting pools, the casino and Speed Markets. ETH and BTC count at today’s prices on both dates, so only coins won, lost or spent move this, not their market price.${limits}`
        : `Treasury stablecoins are ${pct(s.change30, true)} over 30 days, at ${money(s.bankrollNow)}.${limits}${later}`,
    short: !ok(s.change30) ? 'Bankroll: no data' : full ? `Bankroll ${pct(s.change30, true)} in 30 days` : `Stablecoins ${pct(s.change30, true)} in 30 days`
  });

  const th = THRESHOLDS.houseTrend;
  if (!ok(s.rev90)) {
    checks.push({ id: 'trend', title: 'House result trend', sources: ['revenue'], state: 'unknown', text: 'Revenue data didn’t load.', short: 'House result: no data' });
  } else if (s.rev90 <= 0) {
    checks.push({ id: 'trend', title: 'House result trend', sources: ['revenue'], state: 'alert', text: `The house lost ${money(-s.rev90)} over the 90 days to ${fmtDate(s.lastT)}.`, short: `House lost ${money(-s.rev90)} in 90 days` });
  } else if (!s.comparable) {
    checks.push({
      id: 'trend', title: 'House result trend', sources: ['revenue'], state: 'pending',
      text: `DefiLlama switched from counting fees to the full betting result on ${fmtDate(METHOD_CHANGE)}, so earlier periods aren’t comparable. Like-for-like 90-day comparisons start ${fmtDate(FIRST_COMPARABLE)}. The 90 days to ${fmtDate(s.lastT)} brought in ${money(s.rev90)}.`,
      short: `Trend comparable from ${fmtDate(FIRST_COMPARABLE)}`
    });
  } else {
    const change = s.revPrev90 > 0 ? s.rev90 / s.revPrev90 - 1 : null;
    checks.push({
      id: 'trend', title: 'House result trend', sources: ['revenue'], state: grade(change, th),
      text: `The 90 days to ${fmtDate(s.lastT)} brought in ${money(s.rev90)}, ${ok(change) ? pct(change, true) : 'n/a'} against ${money(s.revPrev90)} in the 90 days before. Watch below ${signedWhole(th.good)}, alert below ${signedWhole(th.watch)}.`,
      short: ok(change) ? `House result ${pct(change, true)} on prior 90 days` : 'Trend: no data'
    });
  }

  // Buyback cover: how many times the house result paid for buybacks. Judged on 90 days, because
  // a sportsbook's week is noisy; 30 and 7 days are shown for context.
  const tc = THRESHOLDS.buybackCover;
  if (ok(s.rev90) && ok(s.buy90)) {
    const cover = s.buy90 > 0 ? s.rev90 / s.buy90 : null;
    const ctx = (r, b, days) => !ok(r) || !ok(b) || b <= 0 ? null : r < 0 ? `over ${days} days the house lost ${money(-r)}` : `${times(r / b)} over ${days} days`;
    const shorter = [ctx(s.rev30, s.buy30, 30), ctx(s.rev7, s.buy7, 7)].filter(Boolean);
    const context = shorter.length ? ` It was ${shorter.join(' and ')}.` : '';
    const past = s.coverWeeks >= 4
      ? ` Since ${fmtDate(METHOD_CHANGE)}, ${s.coverWeeksShort} of ${s.coverWeeks} weeks didn’t cover their buybacks${ok(s.coverMin90) ? `, but no 90-day stretch dropped below ${times(s.coverMin90)}` : ''}.`
      : '';
    const limits = ` Healthy from ${tc.good}×, alert below ${tc.watch}×.`;
    let state, text, short;
    if (s.rev90 <= 0) {
      state = 'alert';
      text = `The house lost ${money(-s.rev90)} over the 90 days to ${fmtDate(s.lastT)}, while ${money(s.buy90)} went to buybacks. The treasury is paying for them.`;
      short = `House lost ${money(-s.rev90)} in 90 days`;
    } else if (!ok(cover)) {
      state = 'alert';
      text = `No buybacks over the 90 days to ${fmtDate(s.lastT)}.`;
      short = 'No buybacks in 90 days';
    } else {
      state = grade(cover, tc);
      const lead = cover < 1
        ? `The house result covered only ${times(cover)} of buybacks over the 90 days to ${fmtDate(s.lastT)}: ${money(s.rev90)} against ${money(s.buy90)}, so the treasury topped them up.`
        : `The house result covered buybacks ${times(cover)} over the 90 days to ${fmtDate(s.lastT)}: ${money(s.rev90)} against ${money(s.buy90)}.`;
      text = lead + context + past + limits;
      short = cover < 1 ? `Buybacks not covered: ${times(cover)} in 90 days` : `Buybacks covered ${times(cover)} in 90 days`;
    }
    checks.push({ id: 'cover', title: 'Buyback cover', sources: ['revenue', 'buybacks'], state, value: cover, text, short });
  } else {
    checks.push({ id: 'cover', title: 'Buyback cover', sources: ['revenue', 'buybacks'], state: 'unknown', text: 'Revenue or buyback data didn’t load.', short: 'Buyback cover: no data' });
  }

  // Buyback rate: a cut or a pause matters to holders; so does a raise, which gets its own alert.
  const tr = THRESHOLDS.buybackRate;
  if (s.ratePaused) {
    checks.push({ id: 'rate', title: 'Buyback rate', sources: ['buybacks'], state: 'alert', value: 0, text: `No buybacks for the last 3 days to ${fmtDate(s.lastT)}, after ${money(s.rate30)} a day before that.`, short: 'Buybacks paused' });
  } else if (ok(s.rateRatio)) {
    const change = s.rateRatio - 1;
    const note = s.rateRatio >= tr.raised ? ' That’s a step up.' : s.rateRatio < tr.good ? ' That’s a cut.' : '';
    checks.push({
      id: 'rate', title: 'Buyback rate', sources: ['buybacks'], state: grade(s.rateRatio, tr), value: s.rateRatio,
      text: `Buybacks averaged ${money(s.rate7)} a day in the 7 days to ${fmtDate(s.lastT)}, against ${money(s.rate30)} in the 30 days before (${pct(change, true)}).${note} Watch below ${signedWhole(tr.good - 1)}, alert below ${signedWhole(tr.watch - 1)}.`,
      short: Math.abs(change) < 0.05 ? 'Buyback rate steady' : `Buyback rate ${pct(change, true)}`
    });
  } else {
    checks.push({ id: 'rate', title: 'Buyback rate', sources: ['buybacks'], state: 'unknown', text: 'Not enough buyback history loaded.', short: 'Buyback rate: no data' });
  }

  const house = { id: 'houseOver', title: 'Estimated net house outflow', sources: ['supply', 'contracts', 'betting', 'admin', 'house', 'buybackInventory', 'houseTransfers'] };
  const to = THRESHOLDS.houseOver7d;
  if (s.overFirst) {
    checks.push({ ...house, state: 'pending', text: `The first complete transfer reading is dated ${fmtDate(s.overLast.t)}. A second reading will establish the net change.`, short: 'House OVER: first transfer reading' });
  } else if (!ok(s.overChange)) {
    checks.push({ ...house, state: 'unknown', text: 'A net outflow estimate needs complete house balances and transfer records on all four chains at both ends of the comparison.', short: 'House OVER: incomplete readings' });
  } else {
    const delta = (field) => {
      const change = s.overLast[field] - s.overBase[field];
      return change === 0 ? 'unchanged' : (change > 0 ? '+' : '') + tokens(change);
    };
    const kind = s.overNet === 0 ? 'flat' : s.overNet < 0 ? 'outflow' : 'inflow';
    const percent = (100 * Math.abs(s.overChange)).toFixed(2) + '%';
    const lead = kind === 'flat' ? 'Estimated net house movement was flat'
      : `Estimated net house ${kind} was ${tokens(Math.abs(s.overNet))} OVER (${percent} of starting house holdings)`;
    const short = kind === 'flat' ? 'House OVER flat' : `Estimated net house ${kind} ${percent}`;
    checks.push({
      ...house, state: grade(s.overChange, to), value: s.overChange, short,
      text: `${lead} from ${fmtDate(s.overBase.t)} to ${fmtDate(s.overLast.t)}. House balances changed across treasury wallets (${delta('wallets')}), admin multisigs (${delta('admin')}), OVER betting pools and open bets (${delta('pools')}), and casino and Speed Markets (${delta('games')}). Watch above ${pct(-to.good)} net outflow, alert above ${pct(-to.watch)}.`
    });
  }
  for (const c of checks) c.why = WHY[c.id];
  return checks;
}

// ---------- Governance ----------
// Who cast the votes: the council's TC-NFTs, or OVER itself.
export function voterGroup(p) {
  const sym = String(p.symbol || '');
  if (/TC-?NFT/i.test(sym) || (p.strategies || []).some(n => /erc721|nft/i.test(n))) return { council: true, label: `council (${sym || 'NFT'})` };
  return { council: false, label: sym || 'votes' };
}
