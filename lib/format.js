// Number and date formatting shared by the page and the snapshot job.

export const MINUS = '−';
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const ok = v => v != null && Number.isFinite(v);

function compact(a) {
  if (a >= 1e9) return (a / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (a / 1e6).toFixed(a >= 1e8 ? 0 : a >= 1e7 ? 1 : 2) + 'M';
  if (a >= 1e3) return (a / 1e3).toFixed(a >= 1e5 ? 0 : 1) + 'K';
  return a.toFixed(0);
}

export function money(v) {
  if (!ok(v)) return '—';
  return `${v < 0 ? MINUS : ''}$${compact(Math.abs(v))}`;
}

export function tokens(v) {
  if (!ok(v)) return '—';
  return `${v < 0 ? MINUS : ''}${compact(Math.abs(v))}`;
}

export function axisMoney(v) {
  if (v === 0) return '$0';
  const a = Math.abs(v), s = v < 0 ? MINUS : '';
  const trim = x => String(+x.toFixed(2));
  if (a >= 1e6) return `${s}$${trim(a / 1e6)}M`;
  if (a >= 1e3) return `${s}$${trim(a / 1e3)}K`;
  return `${s}$${trim(a)}`;
}

export function axisTokens(v) {
  if (v === 0) return '0';
  const a = Math.abs(v), s = v < 0 ? MINUS : '';
  const trim = x => String(+x.toFixed(2));
  if (a >= 1e6) return `${s}${trim(a / 1e6)}M`;
  if (a >= 1e3) return `${s}${trim(a / 1e3)}K`;
  return `${s}${trim(a)}`;
}

export function pct(v, signed) {
  if (!ok(v)) return '—';
  const a = Math.abs(v) * 100;
  const body = a.toFixed(a < 10 ? 1 : 0) + '%';
  if (!signed) return (v < 0 ? MINUS : '') + body;
  return (v > 0 ? '+' : v < 0 ? MINUS : '±') + body;
}

// Whole-number signed percentages for thresholds.
export const signedWhole = v => `${v > 0 ? '+' : v < 0 ? MINUS : ''}${Math.round(Math.abs(v) * 100)}%`;

// Multiples such as buyback cover. Rounded down, so a figure never shows at a threshold it hasn't reached.
export function times(v) {
  if (!ok(v)) return '—';
  const a = Math.abs(v);
  const body = a >= 10 ? String(Math.floor(a + 1e-9)) : (Math.floor(a * 10 + 1e-9) / 10).toFixed(1);
  return `${v < 0 ? MINUS : ''}${body}×`;
}

export const fmtDate = t => new Date(t * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
export const shortMonth = t => { const d = new Date(t * 1000); return `${MONTHS[d.getUTCMonth()]} ’${String(d.getUTCFullYear()).slice(2)}`; };
