import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserHistory } from '../lib/browser-history.js';
import { computeChecks, computeStats, overReadingsFromHistory } from '../lib/metrics.js';
import { houseEvidenceMarkdown } from '../lib/house-evidence.js';
import { OVER } from '../lib/config.js';

const date = day => new Date(Date.UTC(2026, 0, day)).toISOString().slice(0, 10);
const hash = n => '0x' + n.toString(16).padStart(64, '0');
const units = n => String(BigInt(n) * 10n ** 18n);
function purchase(day, amount) {
  return { chain: 'optimism', block: day * 100, logIndex: 1, txHash: hash(day), kind: 'purchase',
    from: '0x' + '1'.repeat(40), to: OVER.buybackContracts.optimism, amount: units(amount) };
}
function row(day, bought = 0, events = [], epoch = 1) {
  const asOf = Date.parse(date(day)) / 1000;
  const blocks = Object.fromEntries(Object.keys(OVER.tokens).map(chain => [chain, {number: day * 100, hash: hash(day), timestamp: asOf}]));
  return {
    date: date(day), def: 4, treasuryOver: 300, adminOver: 100, bettingOver: 500, gamesOver: 100 - day,
    houseOver: 1000 - day, buybackInventory: bought, float: 2000 + day - bought,
    houseTransfers: { asOf, startDate: date(epoch), blocks, inventoryRaw: {optimism: units(bought), base: '0'},
      ownersByChain: {base: []}, internalByChain: {base: []}, boughtRaw: units(bought), burnedRaw: '0', events }
  };
}
function visible(history) {
  const stats = computeStats({overReadings: overReadingsFromHistory(history)});
  return { check: computeChecks(stats).find(c => c.id === 'houseOver'), evidence: stats.overEvidence,
    markdown: houseEvidenceMarkdown(stats.overEvidence) };
}
function compare(history) {
  const before = structuredClone(history);
  const projection = browserHistory(history);
  assert.deepEqual(history, before);
  assert.deepEqual(visible(projection), visible(history));
  const chartFields = ({houseTransfers, ...fields}) => fields;
  assert.deepEqual(projection.map(chartFields), history.map(chartFields));
  return projection;
}

test('the browser gets complete charts and only the evidence used by the current check', () => {
  const rows = [row(1), row(8, 2, [purchase(8, 2)]), row(9, 5, [purchase(9, 3)]), row(12, 5), row(15, 6, [purchase(15, 1)])];
  const compact = compare(rows);
  assert.deepEqual(compact.map(r => r.houseTransfers?.events.length), [undefined, 0, 1, undefined, 1]);
  for (const r of compact.filter(r => r.houseTransfers)) {
    assert.deepEqual(Object.keys(r.houseTransfers).sort(), ['asOf', 'blocks', 'boughtRaw', 'burnedRaw', 'events', 'startDate']);
    assert.deepEqual(Object.keys(r.houseTransfers.blocks.optimism).sort(), ['hash', 'number']);
  }
  assert.equal(visible(compact).evidence.purchases.length, 2);
  assert.deepEqual(browserHistory(compact), compact);
});

test('a gap over fourteen days still uses the actual previous comparable block range', () => {
  const compact = compare([row(1), row(3, 2, [purchase(3, 2)]), row(25, 5, [purchase(25, 3)])]);
  assert.deepEqual(compact.map(r => r.houseTransfers?.events.length), [undefined, 0, 1]);
  assert.equal(visible(compact).evidence.purchases.length, 1);
});

test('first readings, custody changes and missing endpoints keep their published status and float dates', () => {
  assert.deepEqual(compare([]), []);
  assert.deepEqual(compare([{date: date(1), def: 2, float: null}]), [{date: date(1), def: 2, float: null}]);
  const newEpoch = compare([row(1), row(9, 2, [purchase(9, 2)]), row(10, 0, [], 10)]);
  assert.deepEqual(newEpoch.map(r => !!r.houseTransfers), [false, false, true]);
  assert.equal(visible(newEpoch).check.state, 'pending');
  const dropped = row(25);
  delete dropped.houseTransfers;
  assert.equal(visible(compare([row(1), row(3), dropped])).check.state, 'unknown');
  const incomplete = row(25);
  incomplete.houseOver = null;
  assert.equal(visible(compare([row(1), row(3), incomplete])).check.state, 'unknown');
  const broken = row(25, 5, [purchase(25, 3)]);
  const missingBase = row(3);
  delete missingBase.houseTransfers;
  assert.equal(visible(compare([row(1), missingBase, broken])).check.state, 'unknown');
  assert.equal(visible(compare([row(1), row(3), broken])).check.state, 'unknown');
});
