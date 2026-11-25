import test from 'node:test';
import assert from 'node:assert/strict';
import { BUYBACK_TOPIC, TRANSFER_TOPIC, readHouseTransfers } from '../lib/house-transfers.js';
import { DEAD, OVER } from '../lib/config.js';

const chain = 'optimism', token = OVER.tokens[chain], safeBox = OVER.buybackContracts[chain];
const treasury = OVER.treasury[0], pool = OVER.overPools[chain].toLowerCase();
const outside = '0x00000000000000000000000000000000000000ff', exchange = '0x00000000000000000000000000000000000000ef';
const bridge = '0x5c5e86abc6cfe3772dc2aae4faffeefd641fd460';
const unit = 10n ** 18n;
const word = n => BigInt(n).toString(16).padStart(64, '0');
const addressTopic = a => '0x' + a.slice(2).padStart(64, '0');
const hex = n => '0x' + n.toString(16);

function log(block, tx, index, address, topics, data) {
  return { blockNumber: hex(block), transactionHash: '0x' + word(tx), logIndex: hex(index), address, topics, data };
}
function transfer(block, tx, index, from, to, n) {
  return log(block, tx, index, token, [TRANSFER_TOPIC, addressTopic(from), addressTopic(to)], '0x' + word(n));
}
function execution(block, tx, index, n) {
  return log(block, tx, index, safeBox, [BUYBACK_TOPIC], '0x' + word(200000000) + word(n));
}
function fakeRpc(logs, limit = Infinity) {
  return async (chainName, method, [filter]) => {
    assert.equal(chainName, chain);
    assert.equal(method, 'eth_getLogs');
    const from = Number(filter.fromBlock), to = Number(filter.toBlock);
    if (to - from + 1 > limit) throw new Error('block range too large');
    return logs.filter(l => l.address === filter.address && Number(l.blockNumber) >= from && Number(l.blockNumber) <= to &&
      filter.topics.every((t, i) => t === null || (Array.isArray(t) ? t.includes(l.topics[i]) : t === l.topics[i]))).reverse();
  };
}
function read(logs, changes = {}) {
  return readHouseTransfers({
    chain, token, safeBox, owners: [treasury, safeBox], internalAddresses: [pool],
    fromBlock: 100, toBlock: 105, rpc: fakeRpc(logs), ...changes
  });
}

test('purchases require a matching SafeBox execution and exact OVER receipt; treasury top-ups are internal', async () => {
  const amount = 1126593238880880768987n;
  const events = [
    transfer(99, 1, 0, outside, safeBox, unit),
    transfer(100, 2, 1, exchange, safeBox, amount), execution(100, 2, 4, amount),
    transfer(101, 3, 0, outside, safeBox, unit),
    transfer(102, 4, 3, treasury, safeBox, unit), transfer(103, 5, 1, safeBox, treasury, unit),
    transfer(106, 6, 0, outside, safeBox, unit)
  ];
  const result = await read(events);
  assert.deepEqual(result.map(e => e.kind), ['purchase', 'receipt', 'internal', 'internal']);
  assert.deepEqual(result[0], {
    chain, block: 100, txHash: '0x' + word(2), logIndex: 1, from: exchange, to: safeBox, amount: amount.toString(), kind: 'purchase'
  });
});

test('only house burns count, and CCIP movements stay distinct from external transfer receipts', async () => {
  const events = [
    transfer(100, 4, 0, treasury, bridge, 31000n * unit),
    transfer(100, 4, 1, bridge, DEAD[0], 31000n * unit),
    transfer(101, 5, 0, outside, DEAD[1], 1026n * unit),
    transfer(102, 6, 0, treasury, DEAD[1], 800000n * unit),
    transfer(103, 7, 0, pool, DEAD[1], 10n * unit),
    transfer(104, 8, 0, treasury, outside, 30n * unit),
    transfer(105, 9, 0, treasury, pool, 5n * unit)
  ];
  const result = await read(events);
  assert.deepEqual(result.map(e => [e.kind, e.amount]), [
    ['bridge', (31000n * unit).toString()], ['burn', (800000n * unit).toString()], ['burn', (10n * unit).toString()],
    ['external', (30n * unit).toString()], ['internal', (5n * unit).toString()]
  ]);
});

test('every execution must reconcile to one distinct actual receipt', async () => {
  await assert.rejects(read([execution(100, 2, 3, unit)]), /reconcile/);
  await assert.rejects(read([transfer(100, 2, 0, exchange, safeBox, unit), execution(100, 2, 3, 2n * unit)]), /reconcile/);
  await assert.rejects(read([transfer(100, 2, 0, exchange, safeBox, unit), transfer(100, 2, 1, outside, safeBox, unit), execution(100, 2, 3, unit)]), /reconcile/);
  const result = await read([
    transfer(100, 2, 0, exchange, safeBox, unit), execution(100, 2, 1, unit),
    transfer(100, 2, 3, exchange, safeBox, unit), execution(100, 2, 4, unit)
  ]);
  assert.deepEqual(result.map(e => e.kind), ['purchase', 'purchase']);
});

test('reads inclusive blocks in smaller pages on provider limits, deduplicates and fails closed on incomplete data', async () => {
  const first = transfer(100, 2, 0, treasury, safeBox, unit);
  const last = transfer(105, 3, 0, treasury, outside, unit);
  const events = [first, first, last];
  assert.deepEqual((await read(events, { rpc: fakeRpc(events, 2) })).map(e => e.block), [100, 105]);
  await assert.rejects(read([], { rpc: async () => null }), /Invalid eth_getLogs/);
  await assert.rejects(read([{ ...first, removed: true }]), /Inconsistent/);
  await assert.rejects(read([], { rpc: async () => { throw new Error('provider unavailable'); } }), /provider unavailable/);
  await assert.rejects(read([first, { ...first, data: '0x' + word(unit + 1n) }]), /Conflicting/);
  assert.deepEqual(await read([], { fromBlock: 106, rpc: () => assert.fail('empty block range queried') }), []);
});
