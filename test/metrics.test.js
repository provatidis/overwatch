import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DAY, completeDays, aggregate, parseTreasury, computeStats, computeChecks, computeFlows,
  readingsFromHistory, overReadingsFromHistory, voterGroup, FIRST_COMPARABLE
} from '../lib/metrics.js';
import { METHOD_CHANGE } from '../lib/config.js';
import { times } from '../lib/format.js';

const day = (y, m, d) => Date.UTC(y, m - 1, d) / 1000;
const series = (from, to, v) => { const out = []; for (let t = from; t <= to; t += DAY) out.push({ t, v: typeof v === 'function' ? v(t) : v }); return out; };
const check = (checks, id) => checks.find(c => c.id === id);

test('completeDays drops the day still in progress', () => {
  const s = series(day(2026, 11, 18), day(2026, 11, 20), 1);
  const now = day(2026, 11, 20) + 4 * 3600;
  assert.deepEqual(completeDays(s, now).map(p => p.t), [day(2026, 11, 18), day(2026, 11, 19)]);
});

test('aggregate marks periods that are still running or start mid-way', () => {
  const rev = series(day(2026, 9, 15), day(2026, 11, 19), 100);
  const months = aggregate(rev, [], 'month');
  assert.equal(months[0].partial, true);   // September starts on the 15th
  assert.equal(months[1].partial, false);  // October is complete
  assert.equal(months[2].partial, true);   // November is running
  assert.equal(months[1].rev, 3100);
});

test('parseTreasury splits stablecoins, majors and own tokens, and skips -OwnTokens keys', () => {
  const rows = parseTreasury({ chainTvls: {
    Ethereum: { tokensInUsd: [{ date: day(2026, 11, 1), tokens: { USDC: 100, USDT: 50, WETH: 30, OVER: 999, ARB: 5 } }] },
    'Ethereum-OwnTokens': { tokensInUsd: [{ date: day(2026, 11, 1), tokens: { THALES: 777 } }] },
    OwnTokens: { tvl: [{ date: day(2026, 11, 1), totalLiquidityUSD: 777 }] }
  } });
  assert.deepEqual(rows, [{ t: day(2026, 11, 1), stable: 150, major: 30, other: 5, own: 777 }]);
});

test('house result trend waits until both 90-day windows are after the method change', () => {
  const rev = series(day(2026, 7, 1), day(2026, 11, 19), 6000);
  const pending = check(computeChecks(computeStats({ rev })), 'trend');
  assert.equal(pending.state, 'pending');
  assert.match(pending.text, /17 Jan 2027/);

  const lastT = FIRST_COMPARABLE - DAY;
  const steady = check(computeChecks(computeStats({ rev: series(METHOD_CHANGE, lastT, 6000) })), 'trend');
  assert.equal(steady.state, 'good');
  const dropped = check(computeChecks(computeStats({ rev: series(METHOD_CHANGE, lastT, t => (t > lastT - 90 * DAY ? 4000 : 6000)) })), 'trend');
  assert.equal(dropped.state, 'alert'); // −33%
});

test('a losing 90 days is an alert whatever the comparison', () => {
  const rev = series(day(2026, 8, 1), day(2026, 11, 19), -100);
  assert.equal(check(computeChecks(computeStats({ rev })), 'trend').state, 'alert');
});

test('buyback cover is graded on 90 days, and fixes both ends of the old share check', () => {
  const cover = (r, b) => check(computeChecks(computeStats({ rev: series(day(2026, 8, 1), day(2026, 11, 19), r), buy: series(day(2026, 8, 1), day(2026, 11, 19), b) })), 'cover');
  assert.equal(cover(6000, 2000).state, 'good');       // 3.0×
  assert.equal(cover(9000, 2300).state, 'good');       // 3.9×: a strong quarter, which the old share check called Watch
  assert.equal(cover(2600, 2300).state, 'watch');      // 1.1×: buybacks take 88%, which the old share check called Healthy
  const short = cover(2000, 2300);                     // 0.87×: the treasury tops buybacks up
  assert.equal(short.state, 'alert');
  assert.match(short.text, /topped them up/);
  assert.match(short.short, /not covered/);
  const loss = cover(-100, 2300);
  assert.equal(loss.state, 'alert');
  assert.match(loss.short, /House lost/);
});

test('buyback cover: a losing week is context, not the grade', () => {
  const lastT = day(2026, 11, 19);
  const rev = series(day(2026, 8, 1), lastT, t => (t > lastT - 7 * DAY ? -1000 : 6000));
  const buy = series(day(2026, 8, 1), lastT, 2000);
  const s = computeStats({ rev, buy });
  const c = check(computeChecks(s), 'cover');
  assert.equal(c.state, 'good');
  assert.match(c.text, /over 7 days the house lost \$7\.0K/);
  assert.equal(s.coverWeeksShort, 1);
  assert.ok(s.coverWeeks >= 15);
  assert.match(c.text, /1 of \d+ weeks didn’t cover/);
});

test('multiples round down, so a figure never shows at a threshold it hasn’t reached', () => {
  assert.equal(times(1.49), '1.4×');
  assert.equal(times(1.5), '1.5×');
  assert.equal(times(3.08), '3.0×');
  assert.equal(times(12.7), '12×');
  assert.equal(times(-0.5), '−0.5×');
  assert.equal(times(null), '—');
});

test('buybacks that stop before the last revenue day are not counted as zero', () => {
  const rev = series(day(2026, 8, 1), day(2026, 11, 19), 6000);
  const buy = series(day(2026, 8, 1), day(2026, 11, 15), 2300);
  assert.equal(check(computeChecks(computeStats({ rev, buy })), 'cover').state, 'unknown');
});

test('every check has a short line for the summary under the headline', () => {
  const rev = series(day(2026, 8, 1), day(2026, 11, 19), 6000);
  const buy = series(day(2026, 8, 1), day(2026, 11, 19), 2000);
  const treasury = series(day(2026, 9, 1), day(2026, 11, 19), 2_000_000).map(p => ({ t: p.t, stable: p.v }));
  const filled = computeChecks(computeStats({ rev, buy, treasury }));
  const empty = computeChecks(computeStats({}));
  for (const c of [...filled, ...empty]) assert.ok(c.short && c.short.length <= 40, `${c.id}: ${c.short}`);
  assert.equal(check(filled, 'cover').short, 'Buybacks covered 3.0× in 90 days');
});

test('buyback rate: cut, pause and raise', () => {
  const rev = series(day(2026, 8, 1), day(2026, 11, 19), 6000);
  const last7 = day(2026, 11, 13);
  const rate = v => check(computeChecks(computeStats({ rev, buy: series(day(2026, 8, 1), day(2026, 11, 19), t => (t >= last7 ? v : 2300)) })), 'rate');
  assert.equal(rate(2300).state, 'good');
  assert.equal(rate(1500).state, 'watch');
  assert.equal(rate(800).state, 'alert');
  assert.equal(rate(0).state, 'alert');
  assert.match(rate(0).text, /No buybacks/);
  const raised = rate(3500);
  assert.equal(raised.state, 'good');
  assert.ok(raised.value >= 1.2);
  assert.match(raised.text, /step up/);
});

test('treasury OVER: pending on day one, alert on an outflow, quiet on a move into the pools', () => {
  const h = (date, wallets, pools) => ({ date, treasuryOver: wallets, poolOver: pools, houseOver: wallets + pools });
  const one = computeChecks(computeStats({ overReadings: overReadingsFromHistory([h('2026-11-20', 15_000_000, 700_000)]) }));
  assert.equal(check(one, 'houseOver').state, 'pending');

  const out = computeChecks(computeStats({ overReadings: overReadingsFromHistory([h('2026-11-20', 15_000_000, 700_000), h('2026-11-21', 13_500_000, 700_000)]) }));
  assert.equal(check(out, 'houseOver').state, 'alert');

  const moved = computeChecks(computeStats({ overReadings: overReadingsFromHistory([h('2026-11-20', 15_000_000, 700_000), h('2026-11-21', 14_000_000, 1_700_000)]) }));
  assert.equal(check(moved, 'houseOver').state, 'good');
});

test('bankroll stays like for like: treasury only until 30 days of pool readings exist', () => {
  const treasury = series(day(2026, 9, 1), day(2026, 11, 20), 2_000_000).map(p => ({ t: p.t, stable: p.v }));
  const readings = readingsFromHistory([{ date: '2026-11-20', treasuryStable: 2_000_000, poolUsdc: 500_000 }]);
  const s = computeStats({ treasury, readings });
  assert.equal(s.bankrollMode, 'treasury');
  assert.equal(s.bankrollNow, 2_000_000);

  const hist = [{ date: '2026-10-20', treasuryStable: 2_000_000, poolUsdc: 600_000 }, { date: '2026-11-20', treasuryStable: 2_000_000, poolUsdc: 470_000 }];
  const full = computeStats({ treasury, readings: readingsFromHistory(hist) });
  assert.equal(full.bankrollMode, 'full');
  assert.equal(Math.round(full.change30 * 1000), -50); // 2.47M vs 2.6M
});

test('money reconciliation: other flows are what the result minus buybacks does not explain', () => {
  const readings = readingsFromHistory([
    { date: '2026-11-10', treasuryStable: 2_000_000, poolUsdc: 500_000 },
    { date: '2026-11-20', treasuryStable: 2_020_000, poolUsdc: 490_000 }
  ]);
  const rev = series(day(2026, 11, 1), day(2026, 11, 19), 6000);
  const buy = series(day(2026, 11, 1), day(2026, 11, 19), 2000);
  const f = computeFlows(readings, rev, buy);
  assert.equal(f.ready, true);
  assert.equal(f.days, 10);
  assert.equal(f.result, 60_000);
  assert.equal(f.buys, 20_000);
  assert.equal(f.change, 10_000);
  assert.equal(f.other, -30_000);
});

test('voter groups: TC-NFT is the council, OVER is holders', () => {
  assert.equal(voterGroup({ symbol: 'TC-NFT', strategies: ['erc20-balance-of'] }).council, true);
  assert.equal(voterGroup({ symbol: 'OVER', strategies: ['erc20-balance-of'] }).council, false);
});
