// OVER watch page. Reads the daily snapshot (data/latest.json) and a live price.
import { ANNOTATIONS, CHAIN_NAMES, EXPLORERS, OVER, DEAD } from './lib/config.js';
import { money, tokens, axisMoney, axisTokens, pct, fmtDate, shortMonth, ok } from './lib/format.js';
import {
  DAY, dailySeries, fromPairs, parseTreasury, treasuryFromRows, aggregate, periodStart, periodNext,
  periodLabel, computeStats, computeChecks, GRADE
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
  document.querySelector('meta[name="theme-color"]').content = theme === 'dark' ? '#17221c' : '#f7f7f2';
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
function lineChart(container, pts, { aria, name, fmt = money, axisFmt = axisMoney, zero = true }) {
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
    const n = Math.max(2, Math.min(6, Math.floor((x1 - x0) / 90)));
    for (let i = 0; i < n; i++) {
      const t = tMin + span * i / (n - 1);
      const d = new Date(t * 1000);
      svg('text', { class: 'tick', x: X(t), y: y0 + 19, 'text-anchor': i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle' }, s)
        .textContent = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
    }
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
    tip.show(fmtDate(p.t), [{ key: 's1', value: fmt(p.v), name }], cx, cy);
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
    if ((n - 1 - i) % every === 0) svg('text', { class: 'tick', x: cx, y: y0 + 19, 'text-anchor': 'middle' }, s).textContent = periodLabel(p.start, mode, false);
    const rows = [
      { key: 's1', value: money(p.rev), name: 'House result' },
      { key: 's2', value: money(p.buy), name: 'Buybacks' }
    ];
    if (p.share != null) rows.push({ value: pct(p.share), name: 'of the result bought back' });
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

function table(container, head, rows) {
  container.replaceChildren();
  const t = el('table', null, null, container);
  const tr = el('tr', null, null, el('thead', null, null, t));
  head.forEach(h => el('th', null, h, tr));
  const body = el('tbody', null, null, t);
  rows.forEach(r => {
    const row = el('tr', null, null, body);
    r.forEach(c => {
      const td = el('td', null, null, row);
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
  el('span', 'badge', GRADE[c.state][0], li).setAttribute('aria-hidden', 'true');
  const body = el('div', null, null, li);
  const h = el('p', 'check-title', null, body);
  el('strong', null, GRADE[c.state][1], h);
  h.appendChild(document.createTextNode(` · ${c.title}`));
  el('p', 'check-text', c.text, body);
}

// ---------- State ----------
const state = { range: 365, mode: 'month', data: null, rev: null, buy: null, treasury: null, price: null, history: [], loaded: false };

function renderSummary() {
  const { rev, buy, treasury, price } = state;
  const stats = computeStats(rev || [], buy || [], treasury || []);
  const tiles = $('tiles');
  tiles.replaceChildren();
  const mcap = price ? price.mcap : null;
  tile(tiles, 'OVER price', price && ok(price.usd) ? `$${price.usd.toFixed(4)}` : '—', { delta: price ? price.change24h : null, deltaLabel: '24h', note: price && price.stale ? 'From the last snapshot.' : null });
  tile(tiles, 'Market cap', money(mcap), { note: 'Same as fully diluted value: no tokens left to unlock.' });
  tile(tiles, 'Treasury stablecoins', money(stats.stablesNow), { delta: stats.change30, deltaLabel: '30 days' });
  tile(tiles, 'House result, 30 days', money(stats.rev30), { note: ok(stats.rev365) ? `${money(stats.rev365)} over the last year` : null });
  tile(tiles, 'Buybacks, 30 days', money(stats.buy30), { note: ok(stats.buy30) && ok(stats.rev30) ? (stats.rev30 > 0 ? `${pct(stats.buy30 / stats.rev30)} of the house result` : 'The house result was negative') : null });
  const yld = ok(stats.buy90) && mcap > 0 ? (stats.buy90 * 365 / 90) / mcap : null;
  tile(tiles, 'Buyback yield', pct(yld), { note: 'Last 90 days of buybacks, annualized, divided by market cap.' });

  const checks = $('checks');
  checks.replaceChildren();
  computeChecks(stats).forEach(c => check(checks, c));

  const last = stats.treasuryLast;
  if (last) {
    const extras = [];
    if (last.major > 0) extras.push(`${money(last.major)} in ETH and BTC`);
    if (ok(last.own) && last.own > 0) {
      const syms = (state.data && state.data.treasuryOwnSymbols) || [];
      extras.push(syms.length && !syms.includes('OVER') ? `${money(last.own)} that DefiLlama lists as old ${syms.join(', ')} tokens` : `${money(last.own)} in its own tokens`);
    }
    if (last.other > 1000) extras.push(`${money(last.other)} in other tokens`);
    const pools = state.data && state.data.poolsTvl > 0 ? ` The betting pools it funds hold another ${money(state.data.poolsTvl)}.` : '';
    $('treasury-sub').textContent = `Stablecoins in the treasury wallets across chains. Since the treasury became the only liquidity provider, this is the house’s reserve, so losses show up here first.${extras.length ? ` It also holds ${extras.join(', ')}.` : ''}${pools}`;
  }
}

const cutoff = () => state.range === 'all' ? -Infinity : Date.now() / 1000 - state.range * DAY;

function renderTrends() {
  tip.hide();
  const from = cutoff();
  if (state.treasury) {
    const pts = state.treasury.filter(p => p.t >= from).map(p => ({ t: p.t, v: p.stable }));
    lineChart($('treasury-chart'), pts, { aria: `Treasury stablecoins over time, now ${money(pts.length ? pts[pts.length - 1].v : null)}`, name: 'Stablecoins' });
    const monthly = new Map();
    pts.forEach(p => monthly.set(periodStart(p.t, 'month'), p));
    table($('treasury-table'), ['Month (last reading)', 'Stablecoins'], [...monthly.values()].reverse().map(p => [fmtDate(p.t), money(p.v)]));
  } else {
    empty($('treasury-chart'), 'Treasury data didn’t load.');
  }
  if (state.rev) {
    const periods = aggregate(state.rev, state.buy || [], state.mode).filter(p => p.end > from);
    barChart($('rev-chart'), periods, state.mode);
    table($('rev-table'), [state.mode === 'quarter' ? 'Quarter' : 'Month', 'House result', 'Buybacks', 'Share bought back'],
      [...periods].reverse().map(p => [periodLabel(p.start, state.mode, true) + (p.partial ? ' (so far)' : ''), money(p.rev), money(p.buy), p.share != null ? pct(p.share) : '—']));
    const done = periods.filter(p => !p.partial);
    const lastDone = done[done.length - 1];
    $('legend-rev').textContent = lastDone ? `${money(lastDone.rev)} in ${periodLabel(lastDone.start, state.mode, false)}` : '';
    $('legend-buy').textContent = lastDone ? `${money(lastDone.buy)}${lastDone.share != null ? ` (${pct(lastDone.share)})` : ''}` : '';
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
  tile(tiles, 'Circulating supply', tokens(sup.circulating), { unit: 'OVER', note: `${pct(sup.circulating / sup.max)} of the ${tokens(sup.max)} maximum` });
  tile(tiles, 'Burned so far', tokens(sup.burned), { unit: 'OVER', note: `${pct(sup.burned / sup.max)} of the maximum supply` });
  tile(tiles, 'Held by the treasury', tokens(sup.treasury), { unit: 'OVER', note: `${pct(sup.treasury / sup.circulating)} of circulating supply` });
  tile(tiles, 'Free float', tokens(sup.float), { unit: 'OVER', note: ok(price) ? `Worth ${money(sup.float * price)} at today’s price` : null });

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
  $('supply-note').textContent = notes.join(' ');

  const rows = Object.entries(sup.chains || {}).map(([chain, c]) => [chainName(chain), tokens(c.total), tokens(c.locked), tokens(c.dead), tokens(c.treasury), tokens(c.total - c.locked - c.dead)]);
  table($('supply-table'), ['Chain', 'Contract supply', 'Locked in bridge', 'Burn addresses', 'Treasury', 'Circulating'], rows);

  // Largest holders that aren't the bridge, a burn address or a listed treasury wallet.
  const skip = new Set([...DEAD, ...OVER.treasury, ...Object.values(OVER.locked).flat()].map(a => a.toLowerCase()));
  const holders = [];
  for (const [chain, c] of Object.entries(sup.chains || {})) {
    for (const h of c.holders || []) {
      if (!h.address || skip.has(h.address) || (c.lockedBy || []).some(l => l.address === h.address)) continue;
      holders.push({ ...h, chain });
    }
  }
  holders.sort((a, b) => b.tokens - a.tokens);
  const top = holders.slice(0, 8);
  const wrap = $('holders-table');
  if (top.length) {
    table(wrap, ['Holder', 'Chain', 'OVER', 'Share of circulating'], top.map(h => [
      { href: (EXPLORERS[h.chain] || '') + h.address, text: `${h.address.slice(0, 6)}…${h.address.slice(-4)}${h.name ? ` (${h.name.replace(/Proxy$/, '')})` : ''}` },
      chainName(h.chain), tokens(h.tokens), pct(h.tokens / sup.circulating)
    ]));
  } else {
    empty(wrap, 'Holder lists weren’t available in this snapshot.');
  }
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

function renderGovernance() {
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
  for (const p of gov.proposals) {
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
      const i = p.scores.indexOf(Math.max(...p.scores));
      bits.push(`${p.choices[i]} ${p.state === 'closed' ? 'won with' : 'leads with'} ${pct(p.scores[i] / p.total)}`);
    }
    meta.textContent = bits.join(' · ');
    if (p.holderValue) el('span', 'tag', 'Holder value', meta);
  }
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
  if (rev.status === 'fulfilled') state.rev = dailySeries(rev.value);
  if (buy.status === 'fulfilled') state.buy = dailySeries(buy.value);
  if (tre.status === 'fulfilled') { const t = parseTreasury(tre.value); state.treasury = t.length ? t : null; }
}

async function livePrice() {
  const j = await getJSON('https://api.coingecko.com/api/v3/simple/price?ids=overtime&vs_currencies=usd&include_market_cap=true&include_24hr_change=true', 12000);
  const o = j && j.overtime;
  if (!o || !ok(o.usd)) throw new Error('no price');
  return { usd: o.usd, mcap: o.usd_market_cap || null, change24h: ok(o.usd_24h_change) ? o.usd_24h_change / 100 : null };
}

async function load() {
  const [snap, hist, price] = await Promise.allSettled([
    getJSON('./data/latest.json', 20000, { cache: 'no-cache' }),
    getJSON('./data/history.json', 20000, { cache: 'no-cache' }),
    livePrice()
  ]);
  const notes = [];
  if (snap.status === 'fulfilled') {
    const d = state.data = snap.value;
    state.rev = d.revenue ? fromPairs(d.revenue) : null;
    state.buy = d.buybacks ? fromPairs(d.buybacks) : null;
    state.treasury = d.treasury ? treasuryFromRows(d.treasury) : null;
    notes.push(`Snapshot taken ${new Date(d.generatedAt * 1000).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC.`);
    if (d.errors && d.errors.length) notes.push(`Some parts are from an earlier snapshot: ${d.errors.map(e => e.split(':')[0]).join(', ')}.`);
  } else {
    await loadLive();
    notes.push('The daily snapshot didn’t load, so only the core charts are shown, straight from DefiLlama.');
  }
  if (hist.status === 'fulfilled' && Array.isArray(hist.value)) state.history = hist.value;
  if (price.status === 'fulfilled') {
    state.price = price.value;
    const snapMcap = state.data && state.data.price && state.data.price.mcap;
    if (!(state.price.mcap > 0) && snapMcap > 0) state.price.mcap = state.price.usd * (snapMcap / state.data.price.usd);
  } else if (state.data && state.data.price) {
    state.price = { ...state.data.price, stale: true };
  }
  if (state.rev && state.rev.length) notes.push(`Daily figures run to ${fmtDate(state.rev[state.rev.length - 1].t)}.`);
  state.loaded = true;
  renderAll();
  const status = $('status');
  status.textContent = notes.join(' ');
  if (!state.data || (state.data.errors && state.data.errors.length)) status.classList.add('error');
}
load();
