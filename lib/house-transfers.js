import { DEAD, OVER } from './config.js';

export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export const BUYBACK_TOPIC = '0x8e8412cac6b961b95ef832e2bac486977bbd29eb9725f9eddd97f3380c31f649';

// Registered OVER CCIP pools: https://docs.chain.link/ccip/directory/mainnet/token/OVER
// The Ethereum pool locks collateral; the L2 pools burn and mint on behalf of bridge users.
const BRIDGE_POOL = {
  ethereum: OVER.locked.ethereum[0],
  optimism: '0x5c5e86abc6cfe3772dc2aae4faffeefd641fd460',
  arbitrum: '0xccedd35627336f20b86a96d81eb88a75908d67e9',
  base: '0xad897dd53328d86282a3a822c15201d669201aa8'
};
const dead = new Set(DEAD);
const lowerAddress = address => {
  if (!/^0x[\da-f]{40}$/i.test(address)) throw new Error(`Invalid OVER transfer address: ${address}`);
  return address.toLowerCase();
};
const topicAddress = address => '0x' + address.slice(2).padStart(64, '0');
const hex = number => '0x' + number.toString(16);
function quantity(value) {
  if (!/^0x[\da-f]+$/i.test(value)) throw new Error('Invalid block or log index in OVER transfer data');
  const number = Number(BigInt(value));
  if (!Number.isSafeInteger(number)) throw new Error('OVER transfer index exceeds safe integer range');
  return number;
}

// Providers have different block-range and result-count limits. Retain a working page size
// across the range; a failed page or a missing single-block response invalidates this reading.
async function readLogs(chain, rpc, filter, from, to) {
  // PublicNode on Base accepts at most 50k blocks. Other providers can serve
  // up to 100k and the fallback below discovers a smaller limit when needed.
  let pageSize = Math.min(to - from + 1, chain === 'base' ? 50_000 : 100_000);
  const logs = [];
  for (let start = from; start <= to;) {
    const end = Math.min(to, start + pageSize - 1);
    let result;
    try {
      result = await rpc(chain, 'eth_getLogs', [{ ...filter, fromBlock: hex(start), toBlock: hex(end) }]);
    } catch (error) {
      const limited = /block.{0,24}(range|limit)|range|too (large|many)|more than|limit exceeded|timed? ?out|timeout|response size|-32005|413/i.test(error.message);
      if (end === start || !limited) throw error;
      pageSize = Math.max(1, Math.floor((end - start + 1) / 2));
      continue;
    }
    if (!Array.isArray(result)) throw new Error('Invalid eth_getLogs response for OVER transfer reading');
    // Some providers cap a successful page at a round number of logs.
    if (result.length >= 1000) {
      if (start === end) throw new Error('OVER transfer logs may be truncated within a single block');
      pageSize = Math.max(1, Math.floor((end - start + 1) / 2));
      continue;
    }
    for (const log of result) {
      const block = quantity(log.blockNumber);
      if (log.removed || block < start || block > end || !/^0x[\da-f]{64}$/i.test(log.transactionHash)) {
        throw new Error('Inconsistent OVER transfer log in requested block range');
      }
      logs.push(log);
    }
    start = end + 1;
  }
  return logs;
}

function parseLog(log, chain) {
  const position = {
    chain, block: quantity(log.blockNumber), txHash: log.transactionHash.toLowerCase(), logIndex: quantity(log.logIndex)
  };
  const [signature, from, to] = log.topics;
  if (signature.toLowerCase() === TRANSFER_TOPIC && log.topics.length === 3 &&
      /^0x0{24}[\da-f]{40}$/i.test(from) && /^0x0{24}[\da-f]{40}$/i.test(to) && /^0x[\da-f]{64}$/i.test(log.data)) {
    return { ...position, from: '0x' + from.slice(-40).toLowerCase(), to: '0x' + to.slice(-40).toLowerCase(), amount: BigInt(log.data).toString() };
  }
  if (signature.toLowerCase() === BUYBACK_TOPIC && log.topics.length === 1 && /^0x[\da-f]{128}$/i.test(log.data)) {
    const spend = BigInt(log.data.slice(0, 66));
    const received = BigInt('0x' + log.data.slice(66));
    if (spend > 0n && received > 0n) return { ...position, execution: true, amount: received.toString() };
  }
  throw new Error(`Invalid OVER transfer or buyback execution log in ${position.txHash}`);
}

// A purchase has two matching logs in the same successful transaction: an OVER receipt and a
// subsequent BuybackExecuted on the registered SafeBox. A donation or top-up is only a receipt.
function classifyTransaction(logs, owners, internal, safeBox, bridge) {
  const transfers = [], receipts = [];
  for (const log of logs.sort((a, b) => a.logIndex - b.logIndex)) {
    if (log.execution) {
      const matches = receipts.filter(t => t.kind === 'receipt' && t.amount === log.amount);
      if (matches.length !== 1) throw new Error(`Could not reconcile SafeBox execution with received OVER in ${log.txHash}`);
      matches[0].kind = 'purchase';
      receipts.length = 0;
      continue;
    }
    const { from, to } = log;
    let kind;
    if (internal.has(from) && dead.has(to) && from !== bridge) kind = 'burn';
    else if (owners.has(from)) kind = to === bridge ? 'bridge' : internal.has(to) ? 'internal' : 'external';
    else if (to === safeBox) kind = internal.has(from) ? 'internal' : from === bridge ? 'bridge' : 'receipt';
    if (!kind || log.amount === '0') continue;
    const transfer = { ...log, kind };
    transfers.push(transfer);
    if (kind === 'receipt' && !dead.has(from)) receipts.push(transfer);
  }
  return transfers;
}

// Both block endpoints are inclusive. Use previous checkpoint + 1 as fromBlock.
// rpc handles provider failover. No partial results can escape when one filter fails.
export async function readHouseTransfers({ chain, fromBlock, toBlock, rpc, owners, internalAddresses = [], safeBox, token }) {
  if (![fromBlock, toBlock].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('Invalid OVER transfer block range');
  if (fromBlock > toBlock) return [];
  const ownerSet = new Set(owners.map(lowerAddress));
  safeBox = safeBox ? lowerAddress(safeBox) : null;
  if (safeBox) ownerSet.add(safeBox);
  const internal = new Set([...ownerSet, ...internalAddresses.map(lowerAddress)]);
  const tokenAddress = lowerAddress(token);
  const filters = [];
  if (ownerSet.size) filters.push({ address: tokenAddress, topics: [TRANSFER_TOPIC, [...ownerSet].map(topicAddress)] });
  if (internal.size > ownerSet.size) filters.push({ address: tokenAddress, topics: [TRANSFER_TOPIC, null, DEAD.map(topicAddress)] });
  if (safeBox) {
    filters.push({ address: tokenAddress, topics: [TRANSFER_TOPIC, null, topicAddress(safeBox)] });
    filters.push({ address: safeBox, topics: [BUYBACK_TOPIC] });
  }
  const byTx = new Map();
  for (const filter of filters) {
    const logs = await readLogs(chain, rpc, filter, fromBlock, toBlock);
    for (const raw of logs) {
      if (lowerAddress(raw.address) !== filter.address || raw.topics?.[0]?.toLowerCase() !== filter.topics[0]) {
        throw new Error('Unexpected contract or signature in OVER transfer query');
      }
      const log = parseLog(raw, chain);
      if (!byTx.has(log.txHash)) byTx.set(log.txHash, new Map());
      const txLogs = byTx.get(log.txHash);
      const duplicate = txLogs.get(log.logIndex);
      if (duplicate && (duplicate.amount !== log.amount || duplicate.from !== log.from || duplicate.to !== log.to || duplicate.block !== log.block)) {
        throw new Error(`Conflicting OVER transfer logs for ${log.txHash} index ${log.logIndex}`);
      }
      txLogs.set(log.logIndex, log);
    }
  }
  const transfers = [];
  for (const txLogs of byTx.values()) transfers.push(...classifyTransaction([...txLogs.values()], ownerSet, internal, safeBox, BRIDGE_POOL[chain]));
  return transfers.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
}
