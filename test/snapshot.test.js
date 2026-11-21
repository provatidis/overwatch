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
  assert.equal(Math.round(r.next.supply.house), 15_654_317 + 745_000);
  assert.equal(Math.round(r.next.supply.float), 53_933_062 - 16_399_317);
  assert.equal(r.next.pools.total, 503_000);
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
