import { CHAIN_NAMES, EXPLORERS, OVER } from './config.js';
import { fmtDate, ok } from './format.js';

const chains = Object.keys(OVER.tokens);
const uint = value => typeof value === 'string' && /^\d+$/.test(value);
const hash = value => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value);
// Insert the decimal before converting to Number so exact whole-token amounts stay exact.
function tokenAmount(raw) {
  const units = String(raw).padStart(OVER.decimals + 1, '0');
  return Number(units.slice(0, -OVER.decimals) + '.' + units.slice(-OVER.decimals));
}
function number(raw) {
  const amount = tokenAmount(raw);
  return amount.toLocaleString('en-GB', {minimumFractionDigits: Number.isInteger(amount) ? 0 : 2, maximumFractionDigits: 2});
}
const shortAddress = addr => typeof addr === 'string' && /^0x[0-9a-f]{40}$/i.test(addr) ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : 'unknown address';
const descriptions = {
  purchase: 'Buyback purchase', burn: 'House-funded burn', internal: 'Internal transfer',
  external: 'Transfer to an untracked address', bridge: 'Bridge transfer', receipt: 'Other SafeBox receipt'
};
const fullAmount = n => Math.abs(n).toLocaleString('en-GB', {maximumFractionDigits: 0});

export function validTransferReading(reading) {
  return !!reading && typeof reading.startDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(reading.startDate) &&
    Number.isSafeInteger(reading.asOf) && uint(reading.boughtRaw) && uint(reading.burnedRaw) && Array.isArray(reading.events) &&
    chains.every(chain => {
      const block = reading.blocks?.[chain];
      return Number.isSafeInteger(block?.number) && block.number >= 0 && hash(block.hash);
    });
}

export function verifiedWindow(rows, base, last) {
  const start = base.transfers, end = last.transfers;
  if (!validTransferReading(start) || !validTransferReading(end) || start.startDate !== end.startDate ||
      end.asOf <= start.asOf || !chains.every(chain => {
        const a = start.blocks[chain], b = end.blocks[chain];
        return b.number > a.number || (a.number === b.number && a.hash === b.hash);
      })) return null;
  const bought = BigInt(end.boughtRaw) - BigInt(start.boughtRaw);
  const burned = BigInt(end.burnedRaw) - BigInt(start.burnedRaw);
  if (bought < 0n || burned < 0n) return null;
  const events = new Map();
  for (const row of rows) {
    const cp = row.transfers;
    if (row.t <= base.t || row.t > last.t || !validTransferReading(cp) || cp.startDate !== end.startDate) continue;
    for (const event of cp.events || []) {
      if (!chains.includes(event.chain) || !Number.isSafeInteger(event.block) || !hash(event.txHash) ||
          !Number.isSafeInteger(event.logIndex) || event.logIndex < 0 || !uint(event.amount)) return null;
      if (event.block <= start.blocks[event.chain].number || event.block > end.blocks[event.chain].number) continue;
      events.set([event.chain, event.txHash.toLowerCase(), event.logIndex].join('/'), event);
    }
  }
  let purchases = 0n, burns = 0n;
  for (const event of events.values()) {
    if (event.kind === 'purchase') purchases += BigInt(event.amount);
    if (event.kind === 'burn') burns += BigInt(event.amount);
  }
  if (purchases !== bought || burns !== burned) return null;
  return { bought: tokenAmount(bought), burned: tokenAmount(burned), boughtRaw: String(bought), events: [...events.values()] };
}

function floatChange(from, to, label) {
  if (!from || !ok(from.float) || !ok(to.float)) return null;
  const change = to.float - from.float;
  const sign = change < 0 ? '−' : change > 0 ? '+' : '';
  const percent = from.float > 0 ? ` (${sign}${(100 * Math.abs(change) / from.float).toFixed(2)}%)` : '';
  return `${label}, ${fmtDate(from.t)} to ${fmtDate(to.t)} · ${sign}${fullAmount(change)} OVER${percent}.`;
}

export function houseEvidence(window, base, last, previous) {
  const float = [];
  if (base && previous && base.t === previous.t) {
    float.push(floatChange(base, last, 'Adjusted free float since the previous reading and over this check'));
  } else {
    float.push(floatChange(previous, last, 'Adjusted free float since the previous reading'));
    float.push(floatChange(base, last, 'Adjusted free float over this check'));
  }
  const movements = [], purchases = [];
  if (window) {
    for (const event of window.events) {
      const { chain, txHash, amount, kind } = event;
      const label = descriptions[kind] || 'Token transfer';
      const isHandover = kind === 'internal' && event.from?.toLowerCase() === OVER.buybackContracts[chain] && OVER.treasury.some(a => a.toLowerCase() === event.to?.toLowerCase());
      const route = isHandover ? 'buyback contract to treasury' : `${shortAddress(event.from)} → ${shortAddress(event.to)}`;
      const item = { text: `${label} · ${number(amount)} OVER · ${CHAIN_NAMES[chain]} · ${route}`, href: new URL(`/tx/${txHash}`, EXPLORERS[chain]).href };
      (kind === 'purchase' ? purchases : movements).push(item);
    }
  }
  return {
    float: float.filter(Boolean), movements, purchases,
    summary: window ? `${purchases.length} verified ${purchases.length === 1 ? 'purchase' : 'purchases'} totaling ${number(window.boughtRaw)} OVER, ${fmtDate(base.t)} to ${fmtDate(last.t)}.` : null
  };
}

export function houseEvidenceMarkdown(evidence) {
  if (!evidence) return null;
  const sections = [...evidence.float];
  const receiptList = items => items.map(item => `- [${item.text}](${item.href})`).join('\n');
  if (evidence.movements.length) sections.push('Verified transfers\n' + receiptList(evidence.movements));
  if (evidence.summary) sections.push(evidence.summary);
  if (evidence.purchases.length) sections.push('<details><summary>Purchase receipts</summary>\n\n' + receiptList(evidence.purchases) + '\n\n</details>');
  const markdown = sections.join('\n\n');
  if (markdown.length <= 52000) return markdown || null;
  // GitHub issue bodies have a size limit. Keep complete receipts available on the dashboard.
  return [...evidence.float, evidence.summary, receiptList(evidence.movements.slice(0, 24)), '[View all transfer and purchase receipts](https://overwatch.day/#check-houseOver)'].filter(Boolean).join('\n\n');
}
