// OVER watch page. Reads the daily snapshot (data/latest.json) and a live price.
import { ANNOTATIONS, CHAIN_NAMES, EXPLORERS, OVER, HOUSE, DEAD, METHOD_CHANGE } from './lib/config.js';
import { money, tokens, coins, axisMoney, axisTokens, pct, fmtDate, shortMonth, ok } from './lib/format.js';
import {
  DAY, dailySeries, fromPairs, parseTreasury, treasuryFromRows, readingsFromHistory, overReadingsFromHistory, completeDays, aggregate, periodStart,
  periodNext, periodLabel, computeStats, computeChecks, computeFlows, houseOverContext, FLOWS_MIN_DAYS, voterGroup, GRADE, RANK
} from './lib/metrics.js';

// ---------- Theme (same storage key as provatidis.com) ----------
const root = document.documentElement;
const toggle = document.querySelector('.theme-toggle');
const systemTheme = matchMedia('(prefers-color-scheme: dark)');
let preference = null;
try {
  const saved = localStorage.getItem('ap-theme');
  if (saved === 'dark' || saved === 'light') preference = saved;
} catch { /* Optional. */ }
function applyTheme(theme) {
  root.dataset.theme = theme;
  toggle.setAttribute('aria-label', `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`);
  document.querySelector('meta[name="theme-color"]').content = theme === 'dark' ? '#0e1511' : '#f2f3ec';
}
applyTheme(preference || (systemTheme.matches ? 'dark' : 'light'));
toggle.hidden = false;
toggle.addEventListener('click', () => {
  preference = root.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(preference);
  try { localStorage.setItem('ap-theme', preference); } catch { /* Optional. */ }
});
systemTheme.addEventListener('change', e => { if (!preference) applyTheme(e.matches ? 'dark' : 'light'); });

// ---------- DOM helpers ----------
const $ = id => document.getElementById(id);
const SVGNS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs, parent) {
  const node = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
  if (parent) parent.appendChild(node);
  return node;
}
function el(tag, className, text, parent) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  if (parent) parent.appendChild(node);
  return node;
}
function link(href, text, parent) {
  const a = el('a', null, text, parent);
  a.href = href;
  a.rel = 'noopener';
  return a;
}

function niceScale(min, max, count) {
  if (min === max) max = min + 1;
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.abs(v) < step / 1e6 ? 0 : +v.toPrecision(12));
  return { lo, hi, ticks };
}
function nearest(points, t) {
  let lo = 0, hi = points.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (points[mid].t < t) lo = mid; else hi = mid; }
  return Math.abs(points[lo].t - t) <= Math.abs(points[hi].t - t) ? lo : hi;
}

// ---------- Tooltip ----------
const tipEl = $('tooltip');
const tip = {
  show(head, rows, x, y) {
    tipEl.replaceChildren();
    el('div', 't-head', head, tipEl);
    for (const r of rows) {
      const row = el('div', 'row', null, tipEl);
      if (r.key) el('span', 'k ' + r.key, null, row);
      el('strong', null, r.value, row);
      el('span', 'n', r.name, row);
    }
    tipEl.hidden = false;
    const w = tipEl.offsetWidth, h = tipEl.offsetHeight;
    let left = x + 16, top = y - h - 14;
    if (left + w > innerWidth - 8) left = x - w - 16;
    if (left < 8) left = 8;
    if (top < 8) top = y + 18;
    tipEl.style.left = left + 'px';
    tipEl.style.top = top + 'px';
  },
  hide() { tipEl.hidden = true; }
};
addEventListener('scroll', () => tip.hide(), { passive: true });

function empty(container, text, className = 'empty') {
  container.replaceChildren();
  el('div', className, text, container);
}

// ---------- Charts ----------
function axes(s, sc, Y, x0, x1, fmt) {
  for (const v of sc.ticks) {
    const y = Math.round(Y(v)) + 0.5;
    if (v !== 0) svg('line', { class: 'grid', x1: x0, x2: x1, y1: y, y2: y }, s);
    svg('text', { class: 'tick', x: x0 - 10, y: y + 4, 'text-anchor': 'end' }, s).textContent = fmt(v);
  }
}

// Single-series line with area wash, end label, crosshair and keyboard readout.
function lineChart(container, pts, { aria, name, fmt = money, axisFmt = axisMoney, zero = true, tipRows = null }) {
  container.replaceChildren();
  if (pts.length < 2) return empty(container, 'Not enough data for this range.');
  const W = Math.max(280, container.clientWidth), H = container.clientHeight || 300;
  const m = { top: 26, right: 72, bottom: 28, left: 54 };
  const x0 = m.left, x1 = W - m.right, y0 = H - m.bottom, y1 = m.top;
  const tMin = pts[0].t, tMax = pts[pts.length - 1].t;
  const values = pts.map(p => p.v);
  const vMin = Math.min(...values), vMax = Math.max(...values);
  const sc = zero ? niceScale(Math.min(0, vMin), vMax, 4) : niceScale(vMin - (vMax - vMin || vMax * 0.02) * 0.4, vMax + (vMax - vMin || vMax * 0.02) * 0.4, 4);
  const X = t => x0 + (t - tMin) / (tMax - tMin) * (x1 - x0);
  const Y = v => y0 - (v - sc.lo) / (sc.hi - sc.lo) * (y0 - y1);
  const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': aria, tabindex: 0 });
  axes(s, sc, Y, x0, x1, axisFmt);

  const span = tMax - tMin;
  if (span > 70 * DAY) {
    const months = [];
    for (let t = periodNext(periodStart(tMin, 'month'), 'month'); t <= tMax; t = periodNext(t, 'month')) months.push(t);
    const every = Math.max(1, Math.ceil(months.length / Math.max(2, Math.floor((x1 - x0) / 70))));
    months.forEach((t, i) => {
      if ((months.length - 1 - i) % every) return;
      svg('text', { class: 'tick', x: X(t), y: y0 + 19, 'text-anchor': 'middle' }, s).textContent = shortMonth(t);
    });
  } else {
    // Short ranges: the first and last reading's dates, plus whole days in between, each date once
    // and never closer than 80px, so two readings a day apart don't repeat a label.
    const day = t => new Date(t * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
    const tick = (t, anchor) => { svg('text', { class: 'tick', x: X(t), y: y0 + 19, 'text-anchor': anchor }, s).textContent = day(t); };
    const n = Math.max(2, Math.min(6, Math.floor((x1 - x0) / 90)));
    const first = Math.floor(tMin / DAY) * DAY, mids = [];
    for (let t = first + DAY; t < tMax; t += DAY) mids.push(t);
    const every = Math.max(1, Math.ceil((mids.length + 1) / (n - 1)));
    tick(tMin, 'start');
    let lastX = X(tMin);
    mids.forEach(t => {
      if (Math.round((t - first) / DAY) % every || day(t) === day(tMin) || day(t) === day(tMax)) return;
      if (X(t) - lastX < 80 || X(tMax) - X(t) < 80) return;
      tick(t, 'middle');
      lastX = X(t);
    });
    if (day(tMax) !== day(tMin)) tick(tMax, 'end');
  }
  for (const a of ANNOTATIONS) {
    if (a.t <= tMin || a.t >= tMax) continue;
    const g = svg('g', { class: 'annot' }, s);
    const x = Math.round(X(a.t)) + 0.5;
    svg('line', { x1: x, x2: x, y1: 18, y2: y0 }, g);
    svg('text', { x: x + 5, y: 13 }, g).textContent = a.label;
  }
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`).join('');
  const base = Y(zero ? Math.max(0, sc.lo) : sc.lo).toFixed(1);
  if (zero) svg('path', { class: 'area', d: `${path}L${X(tMax).toFixed(1)},${base}L${X(tMin).toFixed(1)},${base}Z` }, s);
  svg('path', { class: 'line', d: path }, s);
  const zy = Math.round(Y(zero ? 0 : sc.lo)) + 0.5;
  svg('line', { class: 'baseline', x1: x0, x2: x1, y1: zy, y2: zy }, s);
  const last = pts[pts.length - 1];
  svg('circle', { class: 'dot', cx: X(last.t), cy: Y(last.v), r: 4 }, s);
  svg('text', { class: 'end-label', x: X(last.t) + 10, y: Y(last.v) + 4 }, s).textContent = fmt(last.v);

  const cross = svg('line', { class: 'cross', y1: y1, y2: y0, visibility: 'hidden' }, s);
  const cdot = svg('circle', { class: 'dot', r: 4, visibility: 'hidden' }, s);
  const hit = svg('rect', { x: x0, y: 0, width: x1 - x0, height: y0, fill: 'transparent' }, s);
  let idx = pts.length - 1;
  const show = (i, cx, cy) => {
    idx = i;
    const p = pts[i], x = X(p.t), y = Y(p.v);
    cross.setAttribute('x1', x); cross.setAttribute('x2', x); cross.setAttribute('visibility', 'visible');
    cdot.setAttribute('cx', x); cdot.setAttribute('cy', y); cdot.setAttribute('visibility', 'visible');
    tip.show(fmtDate(p.t), tipRows ? tipRows(p) : [{ key: 's1', value: fmt(p.v), name }], cx, cy);
  };
  const hide = () => { cross.setAttribute('visibility', 'hidden'); cdot.setAttribute('visibility', 'hidden'); tip.hide(); };
  const toClient = i => { const r = s.getBoundingClientRect(); return [r.left + X(pts[i].t) * r.width / W, r.top + Y(pts[i].v) * r.height / H]; };
  hit.addEventListener('pointermove', e => {
    const r = s.getBoundingClientRect();
    const px = (e.clientX - r.left) * W / r.width;
    show(nearest(pts, tMin + (px - x0) / (x1 - x0) * (tMax - tMin)), e.clientX, e.clientY);
  });
  hit.addEventListener('pointerleave', hide);
  s.addEventListener('focus', () => show(idx, ...toClient(idx)));
  s.addEventListener('blur', hide);
  s.addEventListener('keydown', e => {
    const step = e.shiftKey ? 30 : 1;
    let i = idx;
    if (e.key === 'ArrowLeft') i = Math.max(0, idx - step);
    else if (e.key === 'ArrowRight') i = Math.min(pts.length - 1, idx + step);
    else if (e.key === 'Home') i = 0;
    else if (e.key === 'End') i = pts.length - 1;
    else return;
    e.preventDefault();
    show(i, ...toClient(i));
  });
  container.appendChild(s);
}

// Which DefiLlama measure a period uses: fees before the method change, the full result after.
const measureOf = p => p.end <= METHOD_CHANGE ? 'fees' : p.start >= METHOD_CHANGE ? 'result' : 'both';
const MEASURE_LABEL = { fees: 'Fees', result: 'Full result', both: 'Both (switched 21 Jul)' };

function barPath(x, w, zero, y) {
  const h = Math.abs(y - zero);
  if (h < 0.5) return '';
  const r = Math.min(4, h, w / 2);
  if (y < zero) return `M${x},${zero}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${zero}Z`;
  return `M${x},${zero}V${y - r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y - r}V${zero}Z`;
}

// Grouped columns: house result and buybacks per period.
function barChart(container, periods, mode) {
  container.replaceChildren();
  if (!periods.length) return empty(container, 'No data for this range.');
  const W = Math.max(280, container.clientWidth), H = container.clientHeight || 300;
  const m = { top: 14, right: 8, bottom: 28, left: 54 };
  const x0 = m.left, x1 = W - m.right, y0 = H - m.bottom, y1 = m.top;
  const vals = periods.flatMap(p => [p.rev, p.buy]);
  const sc = niceScale(Math.min(0, ...vals), Math.max(0, ...vals), 4);
  const Y = v => y0 - (v - sc.lo) / (sc.hi - sc.lo) * (y0 - y1);
  const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'group', 'aria-label': `House result and buybacks by ${mode === 'quarter' ? 'quarter' : 'month'}` });
  axes(s, sc, Y, x0, x1, axisMoney);
  const n = periods.length, band = (x1 - x0) / n;
  const barW = Math.max(3, Math.min(24, (band - 12) / 2 - 1));
  const groupW = barW * 2 + 2;
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor((x1 - x0) / 58))));
  const zero = Y(0);
  periods.forEach((p, i) => {
    const cx = x0 + band * (i + 0.5);
    const long = periodLabel(p.start, mode, true) + (p.partial ? ' (so far)' : '');
    const label = `${long}: house result ${money(p.rev)}, buybacks ${money(p.buy)}${p.share != null ? `, ${pct(p.share)} of the result` : ''}`;
    const g = svg('g', { class: 'group' + (p.partial ? ' partial' : ''), tabindex: 0, role: 'img', 'aria-label': label }, s);
    svg('rect', { class: 'hit', x: cx - band / 2 + 1, y: y1 - 6, width: band - 2, height: y0 - y1 + 6, rx: 4 }, g);
    const bx = cx - groupW / 2;
    const pr = barPath(bx, barW, zero, Y(p.rev));
    if (pr) svg('path', { class: 'bar b-rev', d: pr }, g);
    const pb = barPath(bx + barW + 2, barW, zero, Y(p.buy));
    if (pb) svg('path', { class: 'bar b-buy', d: pb }, g);
    if ((n - 1 - i) % every === 0) svg('text', { class: 'tick', x: cx, y: y0 + 19, 'text-anchor': 'middle' }, s).textContent = periodLabel(p.start, mode, false) + (measureOf(p) === 'both' ? '*' : '');
    const rows = [
      { key: 's1', value: money(p.rev), name: 'House result' },
      { key: 's2', value: money(p.buy), name: 'Buybacks' }
    ];
    if (p.share != null) rows.push({ value: pct(p.share), name: 'of the result bought back' });
    if (measureOf(p) === 'both') rows.push({ value: 'Mixed', name: 'fees before 21 Jul, full result after' });
    g.addEventListener('pointermove', e => tip.show(long, rows, e.clientX, e.clientY));
    g.addEventListener('pointerleave', () => tip.hide());
    g.addEventListener('focus', () => { const r = g.getBoundingClientRect(); tip.show(long, rows, r.left + r.width / 2, r.top + 12); });
    g.addEventListener('blur', () => tip.hide());
  });
  const zy = Math.round(zero) + 0.5;
  svg('line', { class: 'baseline', x1: x0, x2: x1, y1: zy, y2: zy }, s);
  container.appendChild(s);
}

// Horizontal bars: one per pool, value at the tip. Names sit beside the bars on wide
// screens and above them on narrow ones.
function hBarChart(container, pools) {
  container.replaceChildren();
  if (!pools.length) return empty(container, 'No pools found.');
  const rows = pools.slice(0, 8);
  const W = Math.max(280, container.clientWidth);
  const stacked = W < 560;
  const nameW = stacked ? 0 : Math.min(260, W * 0.32);
  const barH = 18, rowH = stacked ? 50 : 34, top = 6;
  const H = top + rows.length * rowH + 4;
  container.style.height = H + 'px';
  const x0 = stacked ? 0 : nameW + 12, x1 = W - 64;
  const max = Math.max(...rows.map(p => p.liquidityUsd), 1);
  const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'group', 'aria-label': 'DEX pools holding OVER, by liquidity' });
  if (!stacked) svg('line', { class: 'baseline', x1: x0 + 0.5, x2: x0 + 0.5, y1: top - 2, y2: H - 2 }, s);
  rows.forEach((p, i) => {
    const rowTop = top + i * rowH;
    const y = stacked ? rowTop + 22 : rowTop + (rowH - barH) / 2;
    const w = Math.max(2, (p.liquidityUsd / max) * (x1 - x0));
    const label = `${p.pair} on ${dexName(p)}, ${chainName(p.chain)}: ${money(p.liquidityUsd)} liquidity, ${money(p.volume24h)} traded in 24 hours`;
    const g = svg('g', { class: 'group', tabindex: 0, role: 'img', 'aria-label': label }, s);
    svg('rect', { class: 'hit', x: 0, y: rowTop, width: W, height: rowH, rx: 4 }, g);
    const name = svg('text', { class: 'bar-name', x: 0, y: stacked ? rowTop + 14 : y + barH / 2 + 4 }, g);
    name.textContent = p.pair + ' ';
    svg('tspan', {}, name).textContent = `${dexName(p)} · ${chainName(p.chain)}`;
    // Square at the baseline (left), rounded at the data end (right).
    const r = Math.min(4, w / 2, barH / 2);
    svg('path', { class: 'bar b-pool', d: `M${x0},${y}H${x0 + w - r}Q${x0 + w},${y} ${x0 + w},${y + r}V${y + barH - r}Q${x0 + w},${y + barH} ${x0 + w - r},${y + barH}H${x0}Z` }, g);
    svg('text', { class: 'bar-value', x: x0 + w + 8, y: y + barH / 2 + 4 }, g).textContent = money(p.liquidityUsd);
    const rowsTip = [{ key: 's1', value: money(p.liquidityUsd), name: 'liquidity' }, { value: money(p.volume24h), name: 'traded in 24h' }];
    const head = `${p.pair} · ${dexName(p)} · ${chainName(p.chain)}`;
    g.addEventListener('pointermove', e => tip.show(head, rowsTip, e.clientX, e.clientY));
    g.addEventListener('pointerleave', () => tip.hide());
    g.addEventListener('focus', () => { const b = g.getBoundingClientRect(); tip.show(head, rowsTip, b.left + x0 + w, b.top); });
    g.addEventListener('blur', () => tip.hide());
  });
  container.appendChild(s);
}
const chainName = c => CHAIN_NAMES[c] || (c ? c[0].toUpperCase() + c.slice(1) : '');
const DEX_NAMES = { uniswap: 'Uniswap', velodrome: 'Velodrome', aerodrome: 'Aerodrome', sushiswap: 'SushiSwap', camelot: 'Camelot', balancer: 'Balancer' };
const dexName = p => (DEX_NAMES[p.dex] || p.dex || '') + (p.version ? ` ${p.version}` : '');

// Numbers are right-aligned; columns listed in opts.text hold words and read left-aligned.
function table(container, head, rows, opts = {}) {
  container.replaceChildren();
  const textCol = i => (opts.text || []).includes(i) ? 'text' : null;
  const t = el('table', null, null, container);
  const tr = el('tr', null, null, el('thead', null, null, t));
  head.forEach((h, i) => el('th', textCol(i), h, tr));
  const body = el('tbody', null, null, t);
  rows.forEach(r => {
    const row = el('tr', null, null, body);
    r.forEach((c, i) => {
      const td = el('td', textCol(i), null, row);
      if (c && typeof c === 'object' && c.href) link(c.href, c.text, td); else td.textContent = c;
    });
  });
}

// ---------- Tiles and checks ----------
function tile(parent, label, value, opts = {}) {
  const t = el('div', 'tile', null, parent);
  el('p', 'label', label, t);
  const v = el('p', 'value', value, t);
  if (opts.unit) { v.append(' '); el('small', null, opts.unit, v); }
  if (opts.delta != null && ok(opts.delta)) {
    const up = opts.delta >= 0;
    const d = el('p', 'delta ' + (up ? 'up' : 'down'), `${up ? '▲' : '▼'} ${pct(opts.delta, true)} `, t);
    el('span', null, opts.deltaLabel, d);
  }
  if (opts.note) el('p', 'note', opts.note, t);
}
function check(parent, c) {
  const li = el('li', 'check ' + c.state, null, parent);
  li.id = 'check-' + c.id;
  el('span', 'badge', GRADE[c.state][0], li).setAttribute('aria-hidden', 'true');
  const body = el('div', null, null, li);
  const h = el('p', 'check-title', null, body);
  el('strong', null, GRADE[c.state][1], h);
  h.appendChild(document.createTextNode(` · ${c.title}`));
  if (c.why) el('p', 'check-why', c.why, body);
  el('p', 'check-text', c.text, body);
  if (c.transfers?.length) {
    el('p', 'check-evidence', 'Verified transfers', body);
    const list = el('ul', 'check-receipts', null, body);
    for (const { label, href } of c.transfers) link(href, label, el('li', null, null, list));
  }
  if (c.floatDay) el('p', 'check-evidence', c.floatDay.text, body);
  if (c.staleSince) el('p', 'stale-note', `Today’s update failed, so this uses data from ${c.staleSince}. No alerts until it refreshes.`, body);
}

// Checks in the order a newcomer needs them: are buybacks paid for, is the bankroll holding, is the
// payout steady, is the house keeping its OVER; the trend comparison, still pending, last.
const PRIORITY = ['cover', 'bankroll', 'rate', 'houseOver', 'trend'];
const pos = c => { const i = PRIORITY.indexOf(c.id); return i < 0 ? PRIORITY.length : i; };

// One line per check under the headline, worst first, each linking to the full check.
function verdict(parent, checks) {
  parent.replaceChildren();
  const rank = c => (RANK[c.state] < 0 ? -1 : RANK[c.state]);
  [...checks].sort((a, b) => rank(b) - rank(a) || pos(a) - pos(b)).forEach(c => {
    const li = el('li', 'verdict-item ' + c.state, null, parent);
    const a = el('a', null, null, li);
    a.href = '#check-' + c.id;
    el('span', 'badge', GRADE[c.state][0], a).setAttribute('aria-hidden', 'true');
    const text = el('span', 'verdict-text', null, a);
    el('span', 'sr-only', GRADE[c.state][1] + ': ', text);
    text.append(c.short || c.title);
    if ((c.state === 'watch' || c.state === 'alert') && c.floatDay) {
      const { change, to } = c.floatDay;
      const sign = change < 0 ? '−' : change > 0 ? '+' : '';
      el('small', 'verdict-detail', `Estimated float ${sign}${coins(Math.abs(change))} OVER on ${fmtDate(to)}`, text);
    }
    if (c.staleSince) el('span', 'verdict-stale', ' (earlier data)', text);
  });
}

// ---------- State ----------
const state = { range: 365, mode: 'month', data: null, now: null, rev: null, buy: null, treasury: null, price: null, history: [], loaded: false };

const SOURCE_NAMES = { buybackInventory: 'buyback inventory', admin: 'admin multisigs', revenue: 'house result', buybacks: 'buybacks', treasury: 'treasury', pools: 'betting pools', overPools: 'OVER pools', betting: 'betting money', house: 'casino, Speed Markets, ETH and BTC', majors: 'ETH and BTC prices', contracts: 'pool contracts', price: 'price', supply: 'supply', liquidity: 'liquidity', governance: 'governance' };
const staleSources = () => Object.entries((state.data && state.data.sources) || {}).filter(([, v]) => !v.ok);
const sourceDate = name => { const v = state.data && state.data.sources && state.data.sources[name]; return v && v.asOf ? fmtDate(v.asOf) : 'an earlier day'; };

function renderSummary() {
  const { rev, buy, price } = state;
  const readings = readingsFromHistory(state.history);
  const s = computeStats({ rev, buy, treasury: state.treasury, readings, overReadings: overReadingsFromHistory(state.history) });
  const end = s.lastT != null ? fmtDate(s.lastT) : null;

  // The headline: earnings and buybacks for the same dated period. Built aside and swapped in only
  // when it changes, so screen readers don't hear it again when the live price lands.
  const target = $('headline');
  const head = document.createElement('p');
  if (end && ok(s.rev30)) {
    const strong = t => el('strong', null, t, head);
    const text = t => head.append(t);
    text(`In the 30 days to ${end}, Overtime’s house `);
    if (s.rev30 >= 0) { text('made '); strong(money(s.rev30)); } else { text('lost '); strong(money(-s.rev30)); }
    if (ok(s.buy30)) {
      text(s.rev30 > 0 ? ' and ' : ' while ');
      strong(money(s.buy30));
      if (s.rev30 <= 0) text(' still went to buying back OVER.');
      else if (s.buy30 > s.rev30) text(` (${pct(s.buy30 / s.rev30)} of that) went to buying back OVER.`);
      else text(` of it (${pct(s.buy30 / s.rev30)}) went to buying back OVER.`);
    } else text('. Buyback data isn’t available.');
    if (ok(s.rev90) && ok(s.buy90)) {
      el('span', 'headline-sub', ` Over 90 days: ${money(s.rev90)} and ${money(s.buy90)}${s.rev90 > 0 ? ` (${pct(s.buy90 / s.rev90)})` : ''}.`, head);
    }
  } else {
    head.textContent = 'House result and buyback figures didn’t load.';
  }
  if (head.innerHTML !== target.innerHTML) target.replaceChildren(...head.childNodes);

  const tiles = $('tiles');
  tiles.replaceChildren();
  const mcap = price ? price.mcap : null;
  tile(tiles, 'House result, 30 days', money(s.rev30), { note: end ? `To ${end} · ${money(s.rev365)} over the last year` : null });
  tile(tiles, 'Bought back, 30 days', money(s.buy30), { note: ok(s.buy30) && ok(s.rev30) ? (s.rev30 > 0 ? `${pct(s.buy30 / s.rev30)} of the house result` : 'The house result was negative') : null });
  const yld = ok(s.buy90) && mcap > 0 ? (s.buy90 * 365 / 90) / mcap : null;
  tile(tiles, 'Buyback yield', pct(yld), { note: 'Like a dividend yield: a year of buybacks at the last 90 days’ pace, as a share of market cap.' });
  tile(tiles, 'OVER price', price && ok(price.usd) ? `$${price.usd.toFixed(4)}` : '—', { delta: price ? price.change24h : null, deltaLabel: '24h', note: price && price.stale ? 'From the last snapshot.' : null });
  tile(tiles, 'Market cap', money(mcap), { note: 'Same as fully diluted value: no tokens left to unlock.' });
  tile(tiles, s.bankrollMode === 'full' ? 'House bankroll' : 'Treasury stablecoins', money(s.bankrollNow), {
    delta: s.change30, deltaLabel: '30 days',
    note: s.bankrollMode === 'full'
      ? 'Stablecoins plus ETH and BTC at today’s prices, read onchain: treasury wallets, betting pools and open bets, casino and Speed Markets.'
      : (s.latestReading ? `From DefiLlama. Read onchain, the house holds ${money(s.latestReading.v)} in all, counting its betting pools, casino, Speed Markets, ETH and BTC.` : 'Treasury wallets, from DefiLlama.')
  });

  const list = $('checks');
  list.replaceChildren();
  const failed = new Set(staleSources().map(([k]) => k));
  const checks = computeChecks(s).map(c => {
    const bad = c.sources.filter(n => failed.has(n));
    return { ...c, staleSince: bad.length ? sourceDate(bad[0]) : null };
  });
  const houseCheck = checks.find(c => c.id === 'houseOver');
  if (houseCheck && !houseCheck.staleSince && state.data) {
    const context = houseOverContext(state.history, state.data.generatedAt, s.overBase?.t);
    houseCheck.transfers = context.transfers;
    if (state.data.sources?.buybackInventory?.ok && ok(state.data.supply?.float)) houseCheck.floatDay = context.floatDay;
  }
  [...checks].sort((a, b) => pos(a) - pos(b)).forEach(c => check(list, c));
  verdict($('verdict'), checks);

  // Describe the rest of what the treasury holds next to the stablecoin chart.
  const last = state.treasury && state.treasury.length ? state.treasury[state.treasury.length - 1] : null;
  const extras = [];
  const house = state.data && state.data.house, majors = state.data && state.data.majors;
  if (last) {
    if (last.major > 0 && !house) extras.push(`${money(last.major)} in ETH and BTC`);
    if (ok(last.own) && last.own > 0) {
      const syms = (state.data && state.data.treasuryOwnSymbols) || [];
      extras.push(syms.length && !syms.includes('OVER') ? `${money(last.own)} that DefiLlama lists as old ${syms.join(', ')} tokens` : `${money(last.own)} in its own tokens`);
    }
  }
  const bet = state.data && state.data.betting && state.data.betting.usdc;
  const parts = ['Stablecoins in the treasury wallets, from DefiLlama. Since OIP-265, the governance vote behind the July 2026 switch, the betting pools that bettors play against hold only treasury money.'];
  if (bet) {
    parts.push(`Read onchain, they hold another ${money(bet.idle)} in USDC (${Object.entries(bet.chains).map(([c, v]) => `${chainName(c)} ${money(v.idle)}`).join(', ')}), ${money(bet.defaultPools)} of it in the default pools that take futures and parlays spanning more than one round.`);
    parts.push(`${bet.openBets.toLocaleString('en-GB')} open bets hold ${money(bet.held)}: ${money(bet.stakes)} of bettors’ stakes and ${money(bet.onBets)} of the house’s money, which comes back if the bets lose.`);
  }
  if (house) {
    const p = house.pools, g = house.games;
    parts.push(`Its ETH and BTC pools hold ${coins(p.eth)} ETH and ${coins(p.btc, 2)} BTC, and the casino games and Speed Markets run on treasury money too: ${money(g.stable)} in stablecoins, ${coins(g.eth)} ETH and ${tokens(g.over)} OVER.`);
    const eth = house.wallets.eth + p.eth + g.eth, btc = house.wallets.btc + p.btc + g.btc;
    parts.push(`In all, the house holds ${coins(eth)} ETH and ${coins(btc, 2)} BTC${majors ? `, about ${money(eth * majors.eth + btc * majors.btc)} at today’s prices` : ''}.`);
    const base = house.wallets.chains && house.wallets.chains.base;
    if (base && base.stable >= 1000) parts.push(`DefiLlama doesn’t cover Base, where the treasury wallets hold another ${money(base.stable)} in stablecoins; the onchain readings include it.`);
  }
  if (extras.length) parts.push(`The treasury also holds ${extras.length > 1 ? `${extras.slice(0, -1).join(', ')} and ${extras[extras.length - 1]}` : extras[0]}.`);
  $('treasury-sub').textContent = parts.join(' ');

  renderFlows(readings);
}

// Where the money went: what the house made, minus buybacks, against what happened to its stablecoins.
function renderFlows(readings) {
  const f = computeFlows(readings, state.rev, state.buy);
  const box = $('flows');
  box.replaceChildren();
  if (!f.ready) {
    const start = f.since ? fmtDate(f.since) : 'the first onchain pool reading';
    const ready = f.since ? fmtDate(f.since + FLOWS_MIN_DAYS * DAY) : null;
    el('p', 'flows-wait', `This needs all the house’s money (treasury, betting pools and open bets, casino and Speed Markets) on two dates. Readings started ${start}${ready ? `, and the first ${FLOWS_MIN_DAYS}-day view appears on ${ready}` : ''}. It then covers the latest 30 days.`, box);
    return;
  }
  const s = el('p', 'flows-line', null, box);
  const strong = t => el('strong', null, t, s);
  s.append(`From ${fmtDate(f.from)} to ${fmtDate(f.to)}, the house ${f.result >= 0 ? 'made' : 'lost'} `); strong(money(Math.abs(f.result)));
  s.append(' and spent '); strong(money(f.buys)); s.append(' on buybacks, so its money should have moved by ');
  strong(money(f.expected)); s.append('. It moved by '); strong(money(f.change));
  s.append(`, leaving ${money(f.other)} in other flows.`);
  table(el('div', null, null, box), ['', `${f.days} days`], [
    ['House result', money(f.result)],
    ['Bought back', money(-f.buys)],
    ['Expected change', money(f.expected)],
    ['Actual change in the house’s money', `${money(f.change)} (treasury ${money(f.treasuryChange)}, betting pools ${money(f.poolsChange)}, casino and Speed Markets ${money(f.gamesChange)})`],
    ['Other flows', money(f.other)]
  ]);
}

const cutoff = () => state.range === 'all' ? -Infinity : Date.now() / 1000 - state.range * DAY;

function renderTrends() {
  tip.hide();
  const from = cutoff();
  if (state.treasury) {
    const pts = state.treasury.filter(p => p.t >= from).map(p => ({ t: p.t, v: p.stable }));
    lineChart($('treasury-chart'), pts, { aria: `Treasury stablecoins over time, now ${money(pts.length ? pts[pts.length - 1].v : null)}`, name: 'Treasury stablecoins' });
    const monthly = new Map();
    pts.forEach(p => monthly.set(periodStart(p.t, 'month'), p));
    table($('treasury-table'), ['Month (last reading)', 'Treasury stablecoins'], [...monthly.values()].reverse().map(p => [fmtDate(p.t), money(p.v)]));
  } else {
    empty($('treasury-chart'), 'Treasury data didn’t load.');
  }
  if (state.rev) {
    const periods = aggregate(state.rev, state.buy || [], state.mode).filter(p => p.end > from);
    barChart($('rev-chart'), periods, state.mode);
    table($('rev-table'), [state.mode === 'quarter' ? 'Quarter' : 'Month', 'House result', 'Buybacks', 'Share bought back', 'Measured as'],
      [...periods].reverse().map(p => [periodLabel(p.start, state.mode, true) + (p.partial ? ' (so far)' : ''), money(p.rev), money(p.buy), p.share != null ? pct(p.share) : '—', MEASURE_LABEL[measureOf(p)]]));
    const done = periods.filter(p => !p.partial);
    const lastDone = done[done.length - 1];
    $('legend-rev').textContent = lastDone ? `${money(lastDone.rev)} in ${periodLabel(lastDone.start, state.mode, false)}` : '';
    $('legend-buy').textContent = lastDone ? `${money(lastDone.buy)}${lastDone.share != null ? ` (${pct(lastDone.share)})` : ''}` : '';
    $('rev-mixed').hidden = !periods.some(p => measureOf(p) === 'both');
  } else {
    empty($('rev-chart'), 'Revenue data didn’t load.');
  }
}

function renderSupply() {
  const sup = state.data && state.data.supply;
  const tiles = $('supply-tiles');
  tiles.replaceChildren();
  if (!sup) {
    empty($('supply-chart'), state.data ? 'Supply data isn’t in the snapshot yet.' : 'Supply comes from the daily snapshot, which didn’t load.');
    return;
  }
  const price = state.price && state.price.usd;
  const supplySrc = state.data.sources && state.data.sources.supply;
  $('supply-asof').textContent = supplySrc && !supplySrc.ok ? `Today’s onchain read failed, so these figures are from ${sourceDate('supply')}.` : '';
  tile(tiles, 'Circulating supply', tokens(sup.circulating), { unit: 'OVER', note: `${pct(sup.circulating / sup.max)} of the ${tokens(sup.max)} maximum` });
  // Every burn, from buybacks and from bets placed in OVER, shows up as growth in burned supply.
  const burns = state.history.filter(h => ok(h.burned)).map(h => ({ t: Date.parse(h.date) / 1000, v: h.burned }));
  const recent = burns.filter(b => b.t >= burns[burns.length - 1]?.t - 30 * DAY);
  const burnNote = recent.length >= 2
    ? `${tokens(recent[recent.length - 1].v - recent[0].v)} burned since ${fmtDate(recent[0].t)}${ok(price) ? `, about ${money((recent[recent.length - 1].v - recent[0].v) * price)}` : ''}`
    : `${pct(sup.burned / sup.max)} of the maximum. Daily burn shows from the second snapshot.`;
  tile(tiles, 'Burned so far', tokens(sup.burned), { unit: 'OVER', note: burnNote });
  if (ok(sup.house)) {
    const where = [`${tokens(sup.treasury)} in treasury wallets`, ok(sup.adminOver) ? `${tokens(sup.adminOver)} in Overtime’s admin multisigs` : null, `${tokens(sup.overPools)} in the OVER betting pools and open bets`, ok(sup.gamesOver) ? `${tokens(sup.gamesOver)} in the casino and Speed Markets` : null].filter(Boolean);
    tile(tiles, 'Held by the house', tokens(sup.house), { unit: 'OVER', note: `${pct(sup.house / sup.circulating)} of circulating: ${where.slice(0, -1).join(', ')} and ${where[where.length - 1]}` });
  } else {
    tile(tiles, 'Held by the treasury', tokens(sup.treasury), { unit: 'OVER', note: `${pct(sup.treasury / sup.circulating)} of circulating supply. The OVER betting pools didn’t load.` });
  }
  const sources = state.data.sources || {};
  const inventory = sup.buybackInventory;
  tile(tiles, 'Buyback inventory', ok(inventory) ? coins(inventory) : '—', {
    unit: 'OVER',
    note: ok(inventory)
      ? (sources.buybackInventory?.ok ? 'Held in the Optimism and Base buyback contracts.' : `Last verified ${sourceDate('buybackInventory')}.`)
      : 'Awaiting balances from both buyback contracts.'
  });
  const floatReady = ['supply', 'betting', 'admin', 'house', 'contracts', 'buybackInventory'].every(name => sources[name]?.ok)
    && ok(inventory) && ok(sup.float);
  tile(tiles, 'Estimated free float', floatReady ? tokens(sup.float) : '—', {
    unit: 'OVER',
    note: floatReady ? (ok(price) ? `Worth ${money(sup.float * price)} at the displayed OVER price.` : null)
      : 'Requires fresh readings for supply, house holdings and buyback inventory.'
  });

  const hist = state.history.filter(h => ok(h.circulating)).map(h => ({ t: Date.parse(h.date) / 1000, v: h.circulating }));
  if (hist.length >= 2) {
    $('supply-sub').textContent = `One reading a day since ${fmtDate(hist[0].t)}.`;
    lineChart($('supply-chart'), hist, { aria: `Circulating OVER supply, now ${tokens(sup.circulating)}`, name: 'OVER circulating', fmt: v => tokens(v), axisFmt: axisTokens, zero: false });
  } else {
    empty($('supply-chart'), `History starts ${hist.length ? fmtDate(hist[0].t) : 'with the first snapshot'} and adds a reading every day. The chart appears from the second day.`, 'history-note');
  }

  // DefiLlama's "own tokens" figure: say what it actually is.
  const eth = (sup.chains || {}).ethereum;
  const notes = [];
  const ownUsd = state.data.treasuryOwnUsd, syms = state.data.treasuryOwnSymbols || [];
  if (ok(ownUsd) && ownUsd > 0) {
    if (syms.length && !syms.includes('OVER')) {
      notes.push(`DefiLlama also lists ${money(ownUsd)} of “own tokens” in the treasury, but it files them as ${syms.join(', ')}, the token OVER replaced, valued at OVER’s price. They aren’t OVER, so they’re left out of the treasury figure here.`);
    } else if (ok(price) && price > 0 && eth && ownUsd / price > (eth.total - eth.locked - eth.dead) * 1.05) {
      notes.push(`DefiLlama values the treasury’s own OVER at ${money(ownUsd)}, more than all the OVER on Ethereum outside the bridge pool and burn address, so it must include the ${tokens(eth.locked)} locked in Chainlink’s bridge pool. Those back the tokens on the other chains and don’t belong to the treasury.`);
    }
  }
  if (ok(sup.adminOver) && sup.adminOver > 0) notes.push(`The house’s OVER includes ${tokens(sup.adminOver)} in Overtime’s admin multisigs, the wallets that hold the betting pools’ upgrade key. DefiLlama doesn’t count them as treasury, but Overtime controls them, so they aren’t free float here.`);
  if (ok(sup.gamesOver) && sup.gamesOver > 0) notes.push(`The house’s OVER also includes the ${tokens(sup.gamesOver)} in the casino games’ and Speed Markets’ bankrolls, which run on treasury money.`);
  $('supply-note').textContent = notes.join(' ');

  const op = (state.data.betting && state.data.betting.over && state.data.betting.over.chains) || {};
  const adm = (state.data.admin && state.data.admin.chains) || {};
  const adminOn = chain => (adm[chain] ? Object.values(adm[chain]).reduce((a, b) => a + b, 0) : null);
  const games = (state.data.house && state.data.house.games && state.data.house.games.chains) || {};
  const rows = Object.entries(sup.chains || {}).map(([chain, c]) => [chainName(chain), tokens(c.total), tokens(c.locked), tokens(c.dead), tokens(c.treasury), adminOn(chain) != null ? tokens(adminOn(chain)) : '—', op[chain] ? tokens(op[chain].idle + op[chain].onBets) : '—', games[chain] ? tokens(games[chain].over) : '—', tokens(c.total - c.locked - c.dead)]);
  table($('supply-table'), ['Chain', 'Contract supply', 'Locked in bridge', 'Burn addresses', 'Treasury wallets', 'Admin multisigs', 'OVER betting pools', 'Casino & Speed Markets', 'Circulating'], rows);

  // Largest holders outside the house: not the bridge, a burn address, a treasury wallet, one of
  // Overtime's admin multisigs, one of its betting pools (every round, read onchain), or a casino
  // game or Speed Markets contract.
  const cap = state.data.capital || {};
  const bettingPools = [...Object.values(cap.usdc || {}), ...Object.values(cap.over || {})].flatMap(v => (v && v.pools ? v.pools.map(p => p.address) : []));
  const admins = Object.values((state.data.admin && state.data.admin.chains) || {}).flatMap(o => Object.keys(o));
  const gameAddrs = Object.values(HOUSE.games).flatMap(g => Object.values(g));
  const skip = new Set([...DEAD, ...OVER.treasury, ...Object.values(OVER.locked).flat(), ...Object.values(OVER.overPools), ...bettingPools, ...admins, ...gameAddrs].map(a => a.toLowerCase()));
  const isWallet = h => !h.contract || /7702|DeleGator/i.test(h.name || '');
  const listed = [];
  for (const [chain, c] of Object.entries(sup.chains || {})) {
    for (const h of c.holders || []) {
      if (!h.address || OVER.buybackContracts[chain] === h.address.toLowerCase() || skip.has(h.address) || (c.lockedBy || []).some(l => l.address === h.address)) continue;
      listed.push({ ...h, chain });
    }
  }
  // Ordinary wallets: one row each, with their OVER on every chain added up (read onchain, Base
  // included). Contracts stay one row per chain, since the same address can be someone else's.
  const combined = Array.isArray(sup.wallets);
  const rowsIn = combined
    ? [
      ...sup.wallets.filter(w => !skip.has(w.address)).map(w => ({ address: w.address, chains: Object.keys(w.chains), tokens: w.total, wallet: true, name: (listed.find(h => h.address === w.address) || {}).name, contract: (listed.find(h => h.address === w.address) || {}).contract })),
      ...listed.filter(h => !isWallet(h)).map(h => ({ ...h, chains: [h.chain] }))
    ]
    : listed.map(h => ({ ...h, chains: [h.chain] }));
  rowsIn.sort((a, b) => b.tokens - a.tokens);
  const top = rowsIn.slice(0, 8);
  const wrap = $('holders-table');
  const label = holderLabeler();
  if (top.length) {
    table(wrap, ['Holder', 'What it is', combined ? 'Chains' : 'Chain', 'OVER', 'Share of circulating'], top.map(h => [
      { href: (EXPLORERS[h.chains[0]] || '') + h.address, text: `${h.address.slice(0, 6)}…${h.address.slice(-4)}` },
      label({ ...h, chain: h.chains[0] }), h.chains.map(chainName).join(', '), tokens(h.tokens), pct(h.tokens / sup.circulating)
    ]), { text: [1, 2] });
  } else {
    empty(wrap, 'Holder lists weren’t available in this snapshot.');
  }
  // Say which chains the list covers: the block explorers don't always answer.
  const chains = Object.entries(sup.chains || {});
  const covered = chains.filter(([, c]) => Array.isArray(c.holders)).map(([k]) => chainName(k));
  const missingRaw = chains.filter(([, c]) => !Array.isArray(c.holders));
  const missing = missingRaw.map(([k]) => chainName(k));
  const paywalled = missingRaw.length > 0 && missingRaw.every(([, c]) => /\b402\b/.test(c.holdersError || ''));
  const list = names => names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
  $('holders-note').textContent = `The largest holders outside the house: excluding the bridge pool, burn addresses, buyback contracts, treasury wallets, Overtime admin multisigs, one of the house’s betting pools or a casino or Speed Markets contract. ${covered.length ? `They come from the holder lists on ${list(covered)}.` : ''}`
    + (combined ? ' An ordinary wallet shows its OVER on all four chains added up, Base included, read straight from each chain; contracts are listed per chain.' : '')
    + (missing.length ? ` ${list(missing)}’s own list ${missing.length === 1 ? 'isn’t' : 'aren’t'} included: ${paywalled
      ? `Blockscout only serves ${missing.length === 1 ? 'its' : 'their'} holder list${missing.length === 1 ? '' : 's'} on a paid plan, so a wallet holding OVER only there can be missing.`
      : `the block explorer didn’t return ${missing.length === 1 ? 'its' : 'their'} holder list${missing.length === 1 ? '' : 's'} today.`}` : '')
    + ' “Wallet” means an ordinary account; who controls it isn’t public.';
}

// Plain names for holders: Overtime's admin multisig (read onchain as the owner of the betting
// pools' upgrade key), DEX pools (from the liquidity list), then what the block explorer reports.
function holderLabeler() {
  const key = (chain, a) => `${chain}:${String(a).toLowerCase()}`;
  const admins = new Set(((state.data && state.data.contracts) || []).filter(c => c.adminOwner).map(c => key(c.chain, c.adminOwner)));
  const dex = new Set(((state.data && state.data.liquidity && state.data.liquidity.pools) || [])
    .map(p => { const m = /\/(0x[0-9a-fA-F]{40})$/.exec(p.url || ''); return m ? key(p.chain, m[1]) : null; }).filter(Boolean));
  return h => {
    const n = h.name || '';
    if (admins.has(key(h.chain, h.address))) return 'Overtime admin multisig (holds the betting pools’ upgrade key)';
    if (dex.has(key(h.chain, h.address)) || /UniswapV[23](Pool|Pair)|CLPool|^Pool$|Pair$/.test(n)) return 'DEX pool';
    if (/PoolManager/.test(n)) return 'Uniswap v4 pools';
    if (/GnosisSafe|^Safe/.test(n)) return 'Safe multisig';
    if (/7702|DeleGator/i.test(n)) return 'Wallet (smart account)';  // an ordinary account with EIP-7702 smart-account code
    if (h.contract) return n && !/Proxy$|^ERC1967|^Transparent/.test(n) ? `Contract (${n})` : 'Contract';
    return 'Wallet';
  };
}

function renderLiquidity() {
  const liq = state.data && state.data.liquidity;
  const tiles = $('liq-tiles');
  tiles.replaceChildren();
  if (!liq) {
    empty($('liq-chart'), 'Liquidity comes from the daily snapshot, which didn’t include it.');
    return;
  }
  const deepest = liq.pools[0];
  const mcap = state.price && state.price.mcap;
  tile(tiles, 'DEX liquidity', money(liq.totalUsd), { note: mcap > 0 ? `${pct(liq.totalUsd / mcap)} of market cap, across ${liq.pools.length} pools` : `Across ${liq.pools.length} pools` });
  tile(tiles, 'Traded in 24 hours', money(liq.volume24h), { note: liq.totalUsd > 0 ? `${pct(liq.volume24h / liq.totalUsd)} of pool liquidity` : null });
  tile(tiles, 'Deepest pool', deepest ? money(deepest.liquidityUsd) : '—', { note: deepest ? `${deepest.pair} on ${dexName(deepest)}, ${chainName(deepest.chain)}` : null });
  hBarChart($('liq-chart'), liq.pools.filter(p => p.liquidityUsd > 0));
  table($('liq-table'), ['Pool', 'DEX', 'Chain', 'Liquidity', '24h volume'],
    liq.pools.map(p => [p.url ? { href: p.url, text: p.pair } : p.pair, dexName(p), chainName(p.chain), money(p.liquidityUsd), money(p.volume24h)]));
}

// Who can change the betting pools: they're upgradeable, so whoever holds the upgrade key can swap
// their code. Read daily from the contracts; a change opens an issue.
function renderControl() {
  const note = $('control-note');
  const list = (state.data && state.data.contracts) || null;
  if (!list || !list.length) { note.textContent = 'The pool contracts come from the daily snapshot, which didn’t include them.'; return; }
  note.replaceChildren();
  const short = a => `${a.slice(0, 6)}…${a.slice(-4)}`;
  const owners = new Map();
  for (const c of list) if (c.adminOwner) {
    const k = `${c.chain}:${c.adminOwner}`;
    if (!owners.has(k)) owners.set(k, { chain: c.chain, address: c.adminOwner, pools: 0 });
    owners.get(k).pools++;
  }
  const holderOf = (chain, a) => { const c = state.data.supply && state.data.supply.chains && state.data.supply.chains[chain]; return c && Array.isArray(c.holders) ? c.holders.find(h => h.address === a.toLowerCase()) : null; };
  note.append(`All ${list.length} betting pools are upgradeable contracts: whoever holds the upgrade key can replace their code. `);
  if (owners.size) {
    note.append('The key is held by ');
    [...owners.values()].forEach((o, i, arr) => {
      if (i) note.append(i === arr.length - 1 ? ' and ' : ', ');
      link((EXPLORERS[o.chain] || '') + o.address, short(o.address), note);
      const h = holderOf(o.chain, o.address);
      const what = h && /GnosisSafe|^Safe/.test(h.name || '') ? 'a Safe multisig' : null;
      const bits = [chainName(o.chain), what, h ? `holding ${tokens(h.tokens)} OVER` : null, `${o.pools} pool${o.pools === 1 ? '' : 's'}`].filter(Boolean);
      note.append(` (${bits.join(', ')})`);
    });
    note.append('. ');
  }
  const changed = list.filter(c => c.since > c.firstSeen);
  const first = Math.min(...list.map(c => c.firstSeen));
  note.append(changed.length
    ? `Code changed since tracking began on ${fmtDate(first)}: ${changed.map(c => `${chainName(c.chain)} ${c.kind} on ${fmtDate(c.since)}`).join(', ')}. `
    : `None of their code has changed since tracking began on ${fmtDate(first)}. `);
  note.append('A change, or the key moving, opens a GitHub issue.');
}

function renderGovernance() {
  renderControl();
  const gov = state.data && state.data.governance;
  const list = $('props');
  list.replaceChildren();
  if (!gov || !gov.proposals.length) {
    const li = el('li', 'prop', null, list);
    el('span', null, null, li);
    el('p', 'meta', gov ? 'No proposals found.' : 'Governance comes from the daily snapshot, which didn’t include it.', li);
    return;
  }
  const now = Date.now() / 1000;
  const groups = gov.proposals.map(p => voterGroup(p));
  const known = gov.proposals.some(p => p.symbol);
  const allCouncil = known && groups.every(g => g.council);
  const holderVotes = groups.filter(g => !g.council).length;
  $('gov-sub').textContent = !known
    ? 'Latest Overtime Improvement Proposals on Snapshot. Proposals tagged “Holder value” touch buybacks, fees, incentives or the treasury.'
    : allCouncil
      ? 'OIP-263 (June 2026) moved the final vote from the elected council to OVER holders. Every vote here, including OIP-265 after it, was still cast with the council’s TC-NFTs, and no holder vote has been held in this Snapshot space yet. Proposals tagged “Holder value” touch buybacks, fees, incentives or the treasury.'
      : `Since OIP-263 (June 2026), OVER holders vote directly; ${holderVotes} of the ${gov.proposals.length} proposals here ${holderVotes === 1 ? 'was a holder vote' : 'were holder votes'}. Each row says who voted. Proposals tagged “Holder value” touch buybacks, fees, incentives or the treasury.`;

  gov.proposals.forEach((p, i) => {
    const g = groups[i];
    const li = el('li', 'prop', null, list);
    const label = p.state === 'active' ? 'Active' : p.state === 'pending' ? 'Upcoming' : 'Closed';
    el('span', 'chip ' + p.state, label, li);
    const body = el('div', null, null, li);
    link(p.link, p.title, body);
    const meta = el('p', 'meta', null, body);
    const bits = [];
    if (p.state === 'pending') bits.push(`Opens ${fmtDate(p.start)}`);
    else if (p.state === 'active' || p.end > now) bits.push(`Voting closes ${fmtDate(p.end)}`);
    else bits.push(`Closed ${fmtDate(p.end)}`);
    if (p.total > 0 && Array.isArray(p.scores) && p.scores.length) {
      const k = p.scores.indexOf(Math.max(...p.scores));
      const n = p.votes != null ? p.votes : null;
      if (g.council) {
        bits.push(`${p.choices[k]} ${p.state === 'closed' ? 'won' : 'leads with'} ${tokens(p.scores[k])} of ${tokens(p.total)} council votes${p.symbol ? ` (${p.symbol})` : ''}`);
      } else if (p.symbol) {
        bits.push(`${p.choices[k]} ${p.state === 'closed' ? 'won' : 'leads'} with ${pct(p.scores[k] / p.total)} of ${tokens(p.total)} ${p.symbol}${n != null ? ` from ${n} wallet${n === 1 ? '' : 's'}` : ''}`);
      } else {
        bits.push(`${p.choices[k]} ${p.state === 'closed' ? 'won with' : 'leads with'} ${pct(p.scores[k] / p.total)}`);
      }
    }
    meta.textContent = bits.join(' · ');
    if (g.council) el('span', 'tag council', 'Council vote', meta);
    if (p.holderValue) el('span', 'tag', 'Holder value', meta);
  });
}

function renderAll() {
  renderSummary();
  renderTrends();
  renderSupply();
  renderLiquidity();
  renderGovernance();
}

document.querySelectorAll('.seg').forEach(group => {
  group.addEventListener('click', e => {
    const btn = e.target.closest('button');
    if (!btn) return;
    group.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
    const v = btn.dataset.value;
    if (group.dataset.control === 'range') state.range = v === 'all' ? 'all' : Number(v);
    else state.mode = v;
    renderTrends();
  });
});

let frame = 0, lastWidth = 0;
new ResizeObserver(entries => {
  const w = Math.round(entries[0].contentRect.width);
  if (w === lastWidth || !state.loaded) return;
  lastWidth = w;
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(() => { renderTrends(); renderSupply(); renderLiquidity(); });
}).observe($('rev-chart'));

// ---------- Loading ----------
async function getJSON(url, ms = 45000, init = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(timer); }
}

// If the snapshot is missing, fall back to DefiLlama directly for the core charts.
async function loadLive() {
  const [rev, buy, tre] = await Promise.allSettled([
    getJSON('https://api.llama.fi/summary/fees/overtime?dataType=dailyRevenue&excludeTotalDataChartBreakdown=true'),
    getJSON('https://api.llama.fi/summary/fees/overtime?dataType=dailyHoldersRevenue&excludeTotalDataChartBreakdown=true'),
    getJSON('https://api.llama.fi/treasury/overtime')
  ]);
  state.now = Date.now() / 1000;
  if (rev.status === 'fulfilled') state.rev = completeDays(dailySeries(rev.value), state.now);
  if (buy.status === 'fulfilled') state.buy = completeDays(dailySeries(buy.value), state.now);
  if (tre.status === 'fulfilled') {
    const t = parseTreasury(tre.value);
    state.treasury = t.length ? t : null;
  }
}

async function livePrice() {
  const j = await getJSON('https://api.coingecko.com/api/v3/simple/price?ids=overtime&vs_currencies=usd&include_market_cap=true&include_24hr_change=true', 12000);
  const o = j && j.overtime;
  if (!o || !ok(o.usd)) throw new Error('no price');
  return { usd: o.usd, mcap: o.usd_market_cap || null, change24h: ok(o.usd_24h_change) ? o.usd_24h_change / 100 : null };
}

// The page draws as soon as the daily snapshot is in, using the snapshot's price, and swaps in the
// live price when CoinGecko answers. Waiting for CoinGecko first could hold the page for 12 seconds.
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);

async function load() {
  const live = livePrice();
  live.catch(() => {});
  const early = window.owData || [];
  const [snap, hist] = await Promise.allSettled([
    early[0] ? withTimeout(early[0], 20000) : getJSON('./data/latest.json', 20000, { cache: 'no-cache' }),
    early[1] ? withTimeout(early[1], 20000) : getJSON('./data/history.json', 20000, { cache: 'no-cache' })
  ]);
  const notes = [];
  if (snap.status === 'fulfilled') {
    const d = state.data = snap.value;
    state.now = d.generatedAt;
    state.rev = d.revenue ? completeDays(fromPairs(d.revenue), d.generatedAt) : null;
    state.buy = d.buybacks ? completeDays(fromPairs(d.buybacks), d.generatedAt) : null;
    state.treasury = d.treasury ? treasuryFromRows(d.treasury) : null;
    if (state.rev && state.rev.length) notes.push(`Figures run through ${fmtDate(state.rev[state.rev.length - 1].t)}, the last full day.`);
    notes.push(`Snapshot taken ${new Date(d.generatedAt * 1000).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC.`);
    const stale = staleSources();
    if (stale.length) notes.push(`Couldn’t refresh today, so these are earlier readings: ${stale.map(([k, v]) => `${SOURCE_NAMES[k] || k} (${v.asOf ? fmtDate(v.asOf) : 'unknown date'})`).join(', ')}.`);
  } else {
    await loadLive();
    notes.push('The daily snapshot didn’t load, so only the core charts are shown, straight from DefiLlama.');
    if (state.rev && state.rev.length) notes.push(`Figures run through ${fmtDate(state.rev[state.rev.length - 1].t)}.`);
  }
  if (hist.status === 'fulfilled' && Array.isArray(hist.value)) state.history = hist.value;
  if (state.data && state.data.price) state.price = { ...state.data.price, stale: true };
  state.loaded = true;
  renderAll();
  const status = $('status');
  status.textContent = notes.join(' ');
  if (!state.data || staleSources().length) status.classList.add('error');

  try {
    const p = await live;
    const snapMcap = state.data && state.data.price && state.data.price.mcap;
    if (!(p.mcap > 0) && snapMcap > 0) p.mcap = p.usd * (snapMcap / state.data.price.usd);
    state.price = p;
    renderSummary();
    renderSupply();
    renderLiquidity();
  } catch { /* Keep the snapshot's price. */ }
}
load();
