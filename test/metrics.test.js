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

test('every check has a short line for the summary and a reason line for newcomers', () => {
  const rev = series(day(2026, 8, 1), day(2026, 11, 19), 6000);
  const buy = series(day(2026, 8, 1), day(2026, 11, 19), 2000);
  const treasury = series(day(2026, 9, 1), day(2026, 11, 19), 2_000_000).map(p => ({ t: p.t, stable: p.v }));
  const filled = computeChecks(computeStats({ rev, buy, treasury }));
  const empty = computeChecks(computeStats({}));
  for (const c of [...filled, ...empty]) assert.ok(c.short && c.short.length <= 40, `${c.id}: ${c.short}`);
  assert.equal(check(filled, 'cover').short, 'Buybacks covered 3.0× in 90 days');
  for (const c of [...filled, ...empty]) assert.ok(c.why && c.why.length > 20, `${c.id} has no reason line`);
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

test('house OVER: pending on day one, alert on an outflow, quiet on a move into the pools', () => {
  const h = (date, wallets, pools, admin = 2_000_000, games = 400_000) => ({ date, def: 4, treasuryOver: wallets, adminOver: admin, bettingOver: pools, gamesOver: games, houseOver: wallets + admin + pools + games });
  const one = computeChecks(computeStats({ overReadings: overReadingsFromHistory([h('2026-11-20', 15_000_000, 700_000)]) }));
  assert.equal(check(one, 'houseOver').state, 'pending');
  assert.match(check(one, 'houseOver').text, /2\.00M in Overtime’s admin multisigs/);
  assert.match(check(one, 'houseOver').text, /400K in the casino and Speed Markets/);

  const out = computeChecks(computeStats({ overReadings: overReadingsFromHistory([h('2026-11-20', 15_000_000, 700_000), h('2026-11-21', 13_500_000, 700_000)]) }));
  assert.equal(check(out, 'houseOver').state, 'alert');

  const moved = computeChecks(computeStats({ overReadings: overReadingsFromHistory([h('2026-11-20', 15_000_000, 700_000), h('2026-11-21', 14_000_000, 1_700_000)]) }));
  assert.equal(check(moved, 'houseOver').state, 'good');

  // OVER leaving an admin multisig, or the casino, is OVER leaving the house.
  const adminOut = computeChecks(computeStats({ overReadings: overReadingsFromHistory([h('2026-11-20', 15_000_000, 700_000), h('2026-11-21', 15_000_000, 700_000, 500_000)]) }));
  assert.equal(check(adminOut, 'houseOver').state, 'alert');
  assert.match(check(adminOut, 'houseOver').text, /admin multisigs −1\.50M/);
  const gamesOut = computeChecks(computeStats({ overReadings: overReadingsFromHistory([h('2026-11-20', 15_000_000, 700_000), h('2026-11-21', 15_000_000, 700_000, 2_000_000, 0)]) }));
  assert.equal(check(gamesOut, 'houseOver').state, 'alert');
  assert.match(check(gamesOut, 'houseOver').text, /casino and Speed Markets −400K/);

  // Readings made before the admin multisigs or the casino were counted are left out, not compared.
  const old2 = { date: '2026-11-18', def: 2, treasuryOver: 15_000_000, bettingOver: 700_000, houseOver: 15_700_000 };
  const old3 = { date: '2026-11-19', def: 3, treasuryOver: 15_000_000, adminOver: 2_000_000, bettingOver: 700_000, houseOver: 17_700_000 };
  assert.equal(overReadingsFromHistory([old2, old3, h('2026-11-21', 15_000_000, 700_000)]).length, 1);
});

// A day of the house's money, as the job writes it: coins in [treasury wallets, pools, casino].
const money4 = (date, o = {}) => ({
  date, def: 4, walletStable: 2_000_000, bettingUsdc: 600_000, gamesUsdc: 100_000,
  eth: [250, 200, 30], btc: [0.3, 1.8, 0], ethPrice: 2000, btcPrice: 60_000, ...o
});

test('bankroll stays like for like: treasury only until 30 days of full readings exist', () => {
  const treasury = series(day(2026, 9, 1), day(2026, 11, 23), 2_000_000).map(p => ({ t: p.t, stable: p.v }));
  const s = computeStats({ treasury, readings: readingsFromHistory([money4('2026-11-23')]) });
  assert.equal(s.bankrollMode, 'treasury');
  assert.equal(s.bankrollNow, 2_000_000);
  const c = check(computeChecks(s), 'bankroll');
  assert.match(c.text, /joins this check from 23 Dec 2026/);
  assert.deepEqual(c.sources, ['treasury']);

  // Older definitions never mix in: a def-3 row a month back doesn't make a full comparison.
  const old = { date: '2026-10-23', def: 3, treasuryStable: 2_000_000, bettingUsdc: 600_000 };
  assert.equal(computeStats({ treasury, readings: readingsFromHistory([old, money4('2026-11-23')]) }).bankrollMode, 'treasury');

  const full = computeStats({ treasury, readings: readingsFromHistory([money4('2026-10-23'), money4('2026-11-23', { bettingUsdc: 470_000 })]) });
  assert.equal(full.bankrollMode, 'full');
  // 2.7M stablecoins + 480 ETH × $2,000 + 2.1 BTC × $60K = 3.786M, then 130K less.
  assert.equal(Math.round(full.change30 * 10000), Math.round((-130_000 / 3_786_000) * 10000));
  const fc = check(computeChecks(full), 'bankroll');
  assert.deepEqual(fc.sources, ['betting', 'house']);
  assert.match(fc.text, /480 ETH and 2\.10 BTC/);
  assert.match(fc.short, /^Bankroll/);
});

test('bankroll counts ETH and BTC at one price: a price move is not a loss, losing coins is', () => {
  const treasury = series(day(2026, 9, 1), day(2026, 11, 23), 2_000_000).map(p => ({ t: p.t, stable: p.v }));
  const crash = readingsFromHistory([money4('2026-10-23', { ethPrice: 4000, btcPrice: 100_000 }), money4('2026-11-23', { ethPrice: 1500, btcPrice: 50_000 })]);
  assert.equal(computeStats({ treasury, readings: crash }).change30, 0);
  // 100 ETH lost from the pools at today's $2,000: −200K on 3.786M.
  const lost = readingsFromHistory([money4('2026-10-23'), money4('2026-11-23', { eth: [250, 100, 30] })]);
  const s = computeStats({ treasury, readings: lost });
  assert.equal(Math.round(s.change30 * 1000), Math.round(-200_000 / 3_786_000 * 1000));
  assert.equal(check(computeChecks(s), 'bankroll').state, 'watch');
  // A day without prices uses the last known ones.
  assert.equal(readingsFromHistory([money4('2026-11-22'), money4('2026-11-23', { ethPrice: null, btcPrice: null })]).at(-1).ethPrice, 2000);
});

test('money reconciliation: other flows are what the result minus buybacks does not explain', () => {
  const readings = readingsFromHistory([
    money4('2026-11-10'),
    money4('2026-11-20', { walletStable: 2_020_000, bettingUsdc: 590_000, eth: [250, 195, 30] })
  ]);
  const rev = series(day(2026, 11, 1), day(2026, 11, 19), 6000);
  const buy = series(day(2026, 11, 1), day(2026, 11, 19), 2000);
  const f = computeFlows(readings, rev, buy);
  assert.equal(f.ready, true);
  assert.equal(f.days, 10);
  assert.equal(f.result, 60_000);
  assert.equal(f.buys, 20_000);
  assert.equal(f.change, 0);                // +20K treasury, −10K USDC pools, −5 ETH × $2,000 in the pools
  assert.equal(f.treasuryChange, 20_000);
  assert.equal(f.poolsChange, -20_000);
  assert.equal(f.gamesChange, 0);
  assert.equal(f.other, -40_000);
});

test('voter groups: TC-NFT is the council, OVER is holders', () => {
  assert.equal(voterGroup({ symbol: 'TC-NFT', strategies: ['erc20-balance-of'] }).council, true);
  assert.equal(voterGroup({ symbol: 'OVER', strategies: ['erc20-balance-of'] }).council, false);
});
