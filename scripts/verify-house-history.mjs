// Read-only replay of published House OVER checkpoints. Optional ARCHIVE_RPC_<CHAIN> overrides
// go first for historical eth_call, storage and logs. This script never runs the daily job.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { historicalHouseReading, houseTransferCheckpoint } from './snapshot.mjs';

const [from, through] = process.argv.slice(2);
if (![from, through].every(d => /^\d{4}-\d{2}-\d{2}$/.test(d)) || through < from) {
  throw new Error('Usage: node scripts/verify-house-history.mjs YYYY-MM-DD YYYY-MM-DD');
}
const archives = {
  ethereum: ['https://gateway.tenderly.co/public/mainnet', 'https://eth.api.pocket.network', 'https://eth-mainnet.public.blastapi.io'],
  optimism: ['https://optimism.gateway.tenderly.co', 'https://mainnet.optimism.io', 'https://optimism-rpc.publicnode.com'],
  arbitrum: ['https://arbitrum-one.public.blastapi.io', 'https://arbitrum.gateway.tenderly.co', 'https://arb-pokt.nodies.app', 'https://arb1.arbitrum.io/rpc'],
  base: ['https://base-rpc.publicnode.com', 'https://mainnet.base.org', 'https://base.gateway.tenderly.co']
};
const preferred = new Map();

async function rpc(chain, method, params) {
  const key = chain + '/' + method;
  const urls = new Set([process.env['ARCHIVE_RPC_' + chain.toUpperCase()], preferred.get(key), ...archives[chain]].filter(Boolean));
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    let retry = false;
    for (const url of urls) {
      try {
        const response = await fetch(url, {
          method: 'POST', headers: {'content-type': 'application/json'},
          body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params}), signal: AbortSignal.timeout(30000)
        });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const reply = await response.json();
        if (reply.error || reply.result == null || reply.result === '0x') throw new Error(reply.error?.message || 'empty reply');
        preferred.set(key, url);
        return reply.result;
      } catch (err) {
        retry ||= /429|timed? ?out|timeout/i.test(err.message);
        lastError = err;
      }
    }
    if (!retry || attempt) break;
    await sleep(2500);
  }
  throw new Error(`${chain} ${method}: ${lastError?.message || 'archive unavailable'}`);
}

const history = JSON.parse(await readFile(new URL('../data/history.json', import.meta.url)));
const checkpoints = history.filter(row => row.houseTransfers);
const selected = checkpoints.filter(row => from <= row.date && row.date <= through);
assert.ok(selected.length, 'No published checkpoints in that date range');
let previous = checkpoints[checkpoints.indexOf(selected[0]) - 1]?.houseTransfers || null;
for (const row of selected) {
  const saved = row.houseTransfers;
  for (const [chain, block] of Object.entries(saved.blocks)) {
    const header = await rpc(chain, 'eth_getBlockByNumber', ['0x' + block.number.toString(16), false]);
    assert.equal(Number(header.number), block.number, chain + ' height');
    assert.equal(header.hash.toLowerCase(), block.hash, chain + ' block hash');
    assert.ok(Number(header.timestamp) <= saved.asOf, chain + ' block timestamp exceeds snapshot time');
  }
  const {ownersByChain, internalByChain, inventoryRaw, ...balances} = await historicalHouseReading({blocks: saved.blocks, rpc});
  for (const [key, amount] of Object.entries(balances)) assert.equal(amount, row[key], `${row.date} ${key}`);
  const observed = await houseTransferCheckpoint({
    blocks: saved.blocks, date: row.date, asOf: saved.asOf, previous,
    ownersByChain, internalByChain, inventoryRaw, rpc
  });
  assert.deepEqual(observed, saved, row.date + ' transfer checkpoint differs');
  console.log(`${row.date}: verified four block hashes, house balances and ${observed.events.length} transfer receipts.`);
  previous = observed;
}
