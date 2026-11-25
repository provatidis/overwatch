import { houseComparison, overReadingsFromHistory } from './metrics.js';
import { validTransferReading } from './house-evidence.js';

// Keep chart history intact. The page verifies receipts only for its current comparison,
// while the collector and historical replay use the complete checkpoints in history.json.
export function browserHistory(history = []) {
  const { base, last } = houseComparison(overReadingsFromHistory(history));
  const current = last?.transfers;
  const comparable = last?.complete && base?.complete && base !== last
    && validTransferReading(current) && validTransferReading(base.transfers)
    && base.transfers.startDate === current.startDate;

  return history.map(({ houseTransfers, ...row }) => {
    if (!(row.def >= 4) || !validTransferReading(houseTransfers)) return row;
    const t = Date.parse(row.date) / 1000;
    const isCurrent = t === last?.t;
    const inWindow = comparable && t >= base.t && t <= last.t && houseTransfers.startDate === current.startDate;
    // The base's interval ended before this comparison. An empty intermediate interval adds no receipts.
    const events = inWindow && t > base.t ? houseTransfers.events : [];
    if (!isCurrent && !(inWindow && (t === base.t || events.length))) return row;
    const { asOf, startDate, boughtRaw, burnedRaw } = houseTransfers;
    const blocks = Object.fromEntries(Object.entries(houseTransfers.blocks).map(([chain, { number, hash }]) => [chain, { number, hash }]));
    return { ...row, houseTransfers: { asOf, startDate, blocks, boughtRaw, burnedRaw, events } };
  });
}
