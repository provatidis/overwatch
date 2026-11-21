// Scenario tests: the real snapshot job, run day by day against the fake world.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { makeWorld, runDay, tempDir, DAY, T0, ADDR } from './fake-world.js';

const latest = async dir => JSON.parse(await readFile(path.join(dir, 'latest.json'), 'utf8'));
const check = (r, id) => r.next.checks.find(c => c.id === id);
const titles = w => w.issues.map(i => i.title);

test('a normal first run publishes everything and alerts nothing', async () => {
  const w = makeWorld(), dir = await tempDir();
  const r = await runDay(w, dir);
  assert.equal(r.ok, true);
  assert.deepEqual(r.next.errors, []);
  assert.ok(Object.values(r.next.sources).every(s => s.ok));
  assert.equal(Math.round(r.next.supply.circulating), 53_933_062);
  // The house's OVER: treasury wallets, plus every round's OVER pool (current 745K, default 3 × 10K)
  // and its share of open OVER bets (3 × (1,500 − 400)).
  assert.equal(Math.round(r.next.supply.house), 15_654_317 + 778_300);
  assert.equal(Math.round(r.next.supply.float), 53_933_062 - 16_432_617);
  assert.equal(r.next.pools.total, 503_000);
  assert.deepEqual(r.next.betting.usdc, {
    idle: 653_000, defaultPools: 150_000, onBets: 3_300, held: 4_500, stakes: 1_200, openBets: 6, total: 656_300,
    chains: {
      optimism: { idle: 223_000, defaultPool: 50_000, onBets: 1_100, openBets: 2 },
      arbitrum: { idle: 236_000, defaultPool: 50_000, onBets: 1_100, openBets: 2 },
      base: { idle: 194_000, defaultPool: 50_000, onBets: 1_100, openBets: 2 }
    }
  });
  assert.equal(r.history.at(-1).bettingUsdc, 656_300);
  assert.equal(r.history.at(-1).def, 2);
  assert.equal(r.stats.lastT, Math.floor(T0 / DAY) * DAY - DAY); // today is left out
  assert.equal(w.issues.length, 0);
});

test('an empty but successful revenue reply keeps the last good series', async () => {
  const w = makeWorld(), dir = await tempDir();
  await runDay(w, dir, 0);
  const before = (await latest(dir)).revenue.length;
  w.fail.add('revenue-empty');
  const r = await runDay(w, dir, 1);
  assert.equal(r.next.sources.revenue.ok, false);
  assert.equal(r.next.revenue.length, before);
  assert.ok(r.next.errors.some(e => e.startsWith('house result')));
});

test('an empty revenue reply on the very first run is still a failed read', async () => {
  const w = makeWorld(), dir = await tempDir();
  w.fail.add('revenue-empty');
  const r = await runDay(w, dir, 0);
  assert.equal(r.next.sources.revenue.ok, false);
  assert.equal(r.next.revenue, null);
  assert.equal(check(r, 'trend').state, 'unknown');
});

test('a revenue series stuck days in the past is rejected', async () => {
  const w = makeWorld(), dir = await tempDir();
  await runDay(w, dir, 0);
  w.fail.add('revenue-stale');
  const r = await runDay(w, dir, 1);
  assert.equal(r.next.sources.revenue.ok, false);
  assert.ok(r.next.errors.some(e => /newest day/.test(e)));
});

test('an empty proposal list never turns old proposals into a flood of vote alerts', async () => {
  const w = makeWorld(), dir = await tempDir();
  await runDay(w, dir, 0);
  w.fail.add('gov-empty');
  await runDay(w, dir, 1);
  w.fail.delete('gov-empty');
  await runDay(w, dir, 2);
  assert.equal(w.issues.length, 0);
});

test('a new vote opens exactly one issue that says who votes', async () => {
  const w = makeWorld(), dir = await tempDir();
  await runDay(w, dir, 0);
  w.proposals = [{ id: '0xnew', title: 'OIP-266: Raise the buyback rate', created: T0 + DAY / 2, start: T0 + DAY / 2, end: T0 + 6 * DAY, state: 'active', choices: ['For', 'Against'], scores: [0, 0], scores_total: 0, votes: 0, symbol: 'OVER', strategies: [{ name: 'erc20-balance-of' }] }, ...w.proposals];
  await runDay(w, dir, 1);
  await runDay(w, dir, 2);
  assert.deepEqual(titles(w), ['[OVER watch] New vote: OIP-266: Raise the buyback rate']);
  assert.match(w.issues[0].body, /Voters: OVER/);
});

test('when the buybacks feed is down, its check is stale and never alerts', async () => {
  const w = makeWorld(), dir = await tempDir();
  await runDay(w, dir, 0);
  w.fail.add('buybacks');
  const r = await runDay(w, dir, 1);
  assert.equal(check(r, 'cover').stale, true);
  assert.equal(check(r, 'rate').stale, true);
  assert.equal(w.issues.length, 0);
});

test('a bridge balance that does not match the other chains fails the supply read', async () => {
  const w = makeWorld(), dir = await tempDir();
  await runDay(w, dir, 0);
  w.fail.add('bridge');
  const r = await runDay(w, dir, 1);
  assert.equal(r.next.sources.supply.ok, false);
  assert.ok(r.next.errors.some(e => /bridge check failed/.test(e)));
  assert.equal(Math.round(r.next.supply.circulating), 53_933_062); // last good reading kept
});

test('a failed betting-pool read is carried over, not counted as zero', async () => {
  const w = makeWorld(), dir = await tempDir();
  await runDay(w, dir, 0);
  w.fail.add('pool-usdc');
  const r = await runDay(w, dir, 1);
  assert.equal(r.next.sources.pools.ok, false);
  assert.equal(r.next.pools.total, 503_000);
  assert.equal(r.history.at(-1).poolUsdc, null); // history keeps only fresh readings
  assert.equal(r.next.sources.betting.ok, false);
  assert.equal(r.next.betting.usdc.total, 656_300);  // carried over
  assert.equal(r.history.at(-1).bettingUsdc, null);
});

test('a buyback cut opens one issue; a raise opens one "rate up" issue', async () => {
  const cutW = makeWorld(), cutDir = await tempDir();
  await runDay(cutW, cutDir, 0);
  const cutFrom = Math.floor((T0 + DAY) / DAY) * DAY - 7 * DAY;
  cutW.buyback = t => (t >= cutFrom ? 1500 : 2300);
  await runDay(cutW, cutDir, 1);
  await runDay(cutW, cutDir, 2);
  assert.deepEqual(titles(cutW), ['[OVER watch] Buyback rate: Healthy → Watch']);

  const upW = makeWorld(), upDir = await tempDir();
  await runDay(upW, upDir, 0);
  upW.buyback = t => (t >= cutFrom ? 3500 : 2300);
  await runDay(upW, upDir, 1);
  await runDay(upW, upDir, 2);
  assert.deepEqual(titles(upW), ['[OVER watch] Buyback rate up']);
});

test('OVER leaving the house alerts with the wallet; a move into the OVER pools does not', async () => {
  const w = makeWorld(), dir = await tempDir();
  await runDay(w, dir, 0);   // first reading: pending
  await runDay(w, dir, 1);   // no change: healthy
  w.wallets.ethereum[ADDR.SAFE] -= 1_000_000;
  w.overPool.optimism += 1_000_000;
  await runDay(w, dir, 2);   // internal move
  assert.equal(w.issues.length, 0);
  w.wallets.ethereum[ADDR.SAFE] -= 1_500_000;
  const r = await runDay(w, dir, 3);
  assert.equal(check(r, 'houseOver').state, 'alert');
  assert.deepEqual(titles(w), ['[OVER watch] Treasury OVER: Healthy → Alert']);
  assert.match(w.issues[0].body, /0xdac0…b0fa on Ethereum: −1\.50M OVER/);
});

test('an alert closes itself when the check is healthy again', async () => {
  const w = makeWorld(), dir = await tempDir();
  await runDay(w, dir, 0);
  await runDay(w, dir, 1);
  w.wallets.ethereum[ADDR.SAFE] -= 1_500_000;
  await runDay(w, dir, 2);
  assert.equal(w.issues.filter(i => i.state === 'open').length, 1);
  w.wallets.ethereum[ADDR.SAFE] += 1_500_000;
  await runDay(w, dir, 3);
  assert.equal(w.issues.filter(i => i.state === 'open').length, 0);
});

test('the job reads who controls the betting pools and where their money sits', async () => {
  const w = makeWorld(), dir = await tempDir();
  const r = await runDay(w, dir);
  assert.deepEqual(r.next.errors, []);
  assert.equal(r.next.contracts.length, 6);
  assert.ok(r.next.contracts.every(c => c.adminOwner === w.adminOwner && c.implementation && c.since === T0 && c.firstSeen === T0));
  const op = r.next.capital.usdc.optimism;
  assert.equal(op.round, 57);
  assert.deepEqual(op.pools.map(p => [p.round, p.amount]), [[1, 50_000], [57, 173_000]]);
  assert.equal(op.pools[0].bets, 1234);                   // default round: all settled
  assert.deepEqual(op.open, { bets: 1237, open: 2, held: 1_500, stakes: 400 });
  assert.deepEqual(op.pools.map(p => p.open), [{ bets: 0, held: 0, stakes: 0 }, { bets: 2, held: 1_500, stakes: 400 }]);
  assert.equal(r.next.capital.over.base.pools.find(p => p.round === 1).amount, 10_000);
});

test('a change to a pool’s code opens one issue and is remembered', async () => {
  const w = makeWorld(), dir = await tempDir();
  await runDay(w, dir, 0);
  const old = w.impl('usdc', 'optimism');
  const before = w.impl;
  w.impl = (kind, chain) => (kind === 'usdc' && chain === 'optimism' ? '0x' + '9'.repeat(40) : before(kind, chain));
  const r = await runDay(w, dir, 1);
  assert.deepEqual(r.sent, ['Betting pool code changed on the Optimism USDC pool']);
  const c = r.next.contracts.find(x => x.chain === 'optimism' && x.kind === 'USDC pool');
  assert.equal(c.previous, old);
  assert.equal(c.since, T0 + DAY);
  assert.equal(c.firstSeen, T0);
  assert.ok(r.next.contracts.filter(x => x !== c).every(x => x.since === T0));
  const again = await runDay(w, dir, 2);
  assert.deepEqual(again.sent, []);
});

test('an upgrade key moving on every pool is one issue; a failed read alerts nothing', async () => {
  const w = makeWorld(), dir = await tempDir();
  await runDay(w, dir, 0);
  w.fail.add('contracts');
  w.adminOwner = '0x' + '7'.repeat(40);
  const failed = await runDay(w, dir, 1);
  assert.equal(failed.next.sources.contracts.ok, false);
  assert.deepEqual(failed.sent, []);
  w.fail.delete('contracts');
  const moved = await runDay(w, dir, 2);
  assert.deepEqual(moved.sent, ['Betting pool contracts changed (6 changes)']);
  assert.equal(w.issues.length, 1);
});

test('too many listed bets are counted, not read, and the rest still loads', async () => {
  const w = makeWorld({ defaultBets: 70_000 }), dir = await tempDir();
  const r = await runDay(w, dir);
  const op = r.next.capital.usdc.optimism;
  assert.match(op.open.skipped, /more than/);
  assert.equal(op.pools.find(p => p.round === 1).amount, 50_000);
  // Without every open bet read, there's no betting-money figure, and the job says so.
  assert.deepEqual(r.next.errors, ['betting money: not every pool was read in full']);
  assert.equal(r.next.sources.betting.ok, false);
  assert.equal(r.next.betting, null);
});
