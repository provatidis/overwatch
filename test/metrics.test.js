import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DAY, completeDays, aggregate, parseTreasury, computeStats, computeChecks, computeFlows,
  readingsFromHistory, overReadingsFromHistory, voterGroup, FIRST_COMPARABLE
} from '../lib/metrics.js';
import { houseEvidenceMarkdown } from '../lib/house-evidence.js';
import { METHOD_CHANGE, OVER } from '../lib/config.js';
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

const raw = n => String(BigInt(n) * 10n ** 18n);
const eventHash = n => '0x' + n.toString(16).padStart(64, '0');
const address = n => '0x' + n.toString(16).padStart(40, '0');
function houseRow(date, change = {}) {
  const block = Number(date.slice(-2)) * 100;
  const row = { date, def: 4, treasuryOver: 15_000_000, adminOver: 2_000_000, bettingOver: 700_000, gamesOver: 400_000,
    buybackInventory: 500_000, float: 30_000_000,
    houseTransfers: { startDate: '2026-11-20', asOf: Date.parse(date) / 1000 + 3600,
      blocks: Object.fromEntries(['ethereum', 'optimism', 'arbitrum', 'base'].map(chain => [chain, {number: block, hash: eventHash(block)}])),
      boughtRaw: '0', burnedRaw: '0', events: [] }, ...change };
  row.houseOver = row.treasuryOver + row.adminOver + row.bettingOver + row.gamesOver;
  return row;
}
function transfer(kind, amount, chain = 'optimism', logIndex = 0, block = 2085) {
  return { kind, amount: raw(amount), chain, logIndex, block, txHash: eventHash(block + logIndex), from: address(1), to: address(2) };
}
const houseStats = (...rows) => computeStats({ overReadings: overReadingsFromHistory(rows) });
const houseGrade = (...rows) => check(computeChecks(houseStats(...rows)), 'houseOver');

test('house outflow uses executed purchases and house-funded burns independently of prices and dollar series', () => {
  const base = houseRow('2026-11-20');
  const pending = houseGrade(base);
  assert.equal(pending.state, 'pending');
  assert.equal(pending.short, pending.title + ' · pending');
  const next = houseRow('2026-11-21', { treasuryOver: 14_700_000, buybackInventory: 10_000, burned: 99_000_000 });
  const buy = transfer('purchase', 10_000), burn = transfer('burn', 800_000, 'ethereum');
  const handover = { ...transfer('internal', 500_000, 'optimism', 1), from: OVER.buybackContracts.optimism, to: OVER.treasury[0] };
  Object.assign(next.houseTransfers, { boughtRaw: raw(10_000), burnedRaw: raw(800_000), events: [buy, handover, burn, handover] });
  const flat = houseGrade(base, next);
  assert.equal(flat.state, 'good');
  assert.equal(flat.value, 0);
  assert.equal(flat.short, flat.title + ' · 0 OVER');
  assert.match(flat.text, /Estimated net house outflow was 0 OVER/);
  const evidence = houseStats(base, next).overEvidence;
  assert.equal(evidence.movements.length, 2);
  assert.equal(evidence.purchases.length, 1);
  assert.match(evidence.movements[0].text, /buyback contract to treasury/);
  assert.match(houseEvidenceMarkdown(evidence), /optimistic\.etherscan\.io\/tx\//);
  assert.match(houseEvidenceMarkdown(evidence), /1 verified purchase totaling 10,000 OVER/);
  // Global supply changes, including an unrelated burn, cannot offset a treasury distribution.
  const sold = houseRow('2026-11-21', { treasuryOver: 13_500_000, burned: 99_000_000 });
  const grade = houseGrade(base, sold);
  assert.equal(grade.state, 'alert');
  assert.match(grade.short, /outflow 8\.29%/);
  const inflow = houseGrade(base, houseRow('2026-11-21', { treasuryOver: 16_000_000 }));
  assert.equal(inflow.state, 'good');
  assert.match(inflow.short, /inflow 5\.52%/);
  assert.doesNotMatch(inflow.text, /to the market/);
});

test('house transfer coverage must match the balances and receipts at both ends', () => {
  const base = houseRow('2026-11-20'), next = houseRow('2026-11-21');
  for (const patch of [{ boughtRaw: null }, { boughtRaw: raw(20_000) }, { blocks: {} }, { startDate: '2026-11-19' }]) {
    const changed = structuredClone(next);
    Object.assign(changed.houseTransfers, patch);
    const missing = houseGrade(base, changed);
    assert.equal(missing.state, 'unknown');
    assert.equal(missing.short, missing.title + ' · no data');
  }
  for (const missing of [{houseTransfers: null}, {buybackInventory: null}]) {
    assert.equal(houseGrade({...base, ...missing}, next).state, 'unknown');
    assert.equal(houseGrade(base, {...next, ...missing}).state, 'unknown');
  }
  assert.equal(houseGrade({...base, houseTransfers: null}).state, 'unknown');
  const later = houseRow('2026-11-22', { buybackInventory: 510_000 });
  Object.assign(later.houseTransfers, {boughtRaw: raw(10_000), events: [transfer('purchase', 10_000)]});
  assert.equal(houseGrade(base, {...next, houseTransfers: null}, later).value, 0);
  later.houseTransfers.boughtRaw = '0';
  assert.equal(houseGrade(base, {...next, houseTransfers: null}, later).state, 'unknown');
});

test('dated float evidence distinguishes daily and check windows and keeps unclassified receipts out of buys', () => {
  const base = houseRow('2026-11-20', {float: 33_440_133}), prev = houseRow('2026-11-21', {float: 33_458_228});
  const last = houseRow('2026-11-22', {float: 33_451_569});
  last.houseTransfers.events = [transfer('external', 350, 'base', 1, 2140), transfer('receipt', 7, 'base', 2, 2140)];
  const e = houseStats(base, prev, last).overEvidence;
  assert.equal(e.float.length, 2);
  assert.match(e.float[0], /^Estimated free float since the previous reading, 21 Nov 2026 to 22 Nov 2026.*−6,659 OVER/);
  assert.match(e.float[1], /^Estimated free float over this check, 20 Nov 2026 to 22 Nov 2026.*\+11,436 OVER/);
  assert.match(e.summary, /0 verified purchases/);
  assert.match(e.movements[0].text, /untracked address/);
  assert.match(e.movements[1].text, /Other SafeBox receipt/);
  assert.equal(houseStats(base, {...last, float: null}).overEvidence.float.length, 0);
  assert.doesNotMatch(houseEvidenceMarkdown(e), /sale/);
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
