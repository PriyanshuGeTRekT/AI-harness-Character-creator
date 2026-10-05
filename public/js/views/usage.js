// Usage and cost, read from Claude Code's own transcripts.
import { h, api, num, money, plural, ago } from '../ui.js';

let days = 30;
let metric = 'cost';

const METRICS = {
  cost: { label: 'Cost', get: d => d.cost, fmt: money },
  output: { label: 'Output tokens', get: d => d.output, fmt: num },
  input: { label: 'Input tokens (incl. cache)', get: d => d.input + d.cacheRead + d.cacheWrite, fmt: num },
};

const SVG = 'http://www.w3.org/2000/svg';
const s = (tag, attrs) => { const el = document.createElementNS(SVG, tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); return el; };

// One series, so one hue and no legend: the card title names it. Thin bars with rounded
// tops on a flat baseline, a recessive grid, and a tooltip on a hit area wider than the bar.
function barChart(series, m) {
  const tip = h('div', { class: 'tip', hidden: true });
  const wrap = h('div', { class: 'chart' });
  // Drawn at the container's real width (and redrawn on resize) so text is never stretched.
  const draw = W => wrap.replaceChildren(drawBars(series, m, Math.max(320, Math.round(W)), tip), tip);
  new ResizeObserver(entries => draw(entries[0].contentRect.width)).observe(wrap);
  draw(900);
  setTimeout(() => { if (wrap.clientWidth) draw(wrap.clientWidth); }, 0); // observers do not fire in a hidden tab
  return wrap;
}

function drawBars(series, m, W, tip) {
  const H = 220, pad = { l: 46, r: 8, t: 12, b: 24 };
  const max = Math.max(...series.map(m.get), 0) || 1;
  const step = (W - pad.l - pad.r) / series.length;
  const bw = Math.max(2, Math.min(28, step - 2));
  const y = v => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `${m.label} per day for the last ${series.length} days. The table below has the same data.` });
  for (const f of [0, 0.5, 1]) {
    svg.append(s('line', { class: 'grid', x1: pad.l, x2: W - pad.r, y1: y(max * f), y2: y(max * f) }));
    const t = s('text', { x: pad.l - 6, y: y(max * f) + 4, 'text-anchor': 'end' }); t.textContent = m.fmt(max * f); svg.append(t);
  }
  const bars = [];
  series.forEach((d, i) => {
    const x = pad.l + i * step + (step - bw) / 2;
    const v = m.get(d);
    const top = y(v), base = y(0), r = Math.min(4, bw / 2, (base - top) / 2);
    const bar = s('path', { class: 'bar', d: v > 0 ? `M${x},${base} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${base} Z` : '' });
    bars.push(bar); svg.append(bar);
    const hit = s('rect', { class: 'hit', x: pad.l + i * step, y: pad.t, width: step, height: H - pad.t - pad.b });
    const show = () => {
      bars.forEach((b, n) => b.classList.toggle('dim', n !== i));
      tip.hidden = false;
      tip.textContent = `${new Date(d.day + 'T12:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} · ${m.fmt(v)}`;
      tip.style.left = `${Math.min(Math.max(x + bw / 2, 70), W - 70)}px`;
      tip.style.top = `${Math.max(top - 6, 22)}px`;
    };
    hit.addEventListener('mouseenter', show); hit.addEventListener('mousemove', show);
    svg.append(hit);
    if (i === 0 || i === series.length - 1 || (series.length > 14 && i === Math.floor(series.length / 2))) {
      const t = s('text', { x: x + bw / 2, y: H - 6, 'text-anchor': i === 0 ? 'start' : i === series.length - 1 ? 'end' : 'middle' });
      t.textContent = new Date(d.day + 'T12:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); svg.append(t);
    }
  });
  svg.addEventListener('mouseleave', () => { tip.hidden = true; bars.forEach(b => b.classList.remove('dim')); });
  return svg;
}

function rankTable(title, rows, nameCell, extra = []) {
  const max = Math.max(...rows.map(r => r.cost || r.output), 0) || 1;
  return h('div', { class: 'card' }, h('h2', {}, title),
    h('div', { class: 'tablewrap' }, h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, h('th', {}, ''), extra.map(e => h('th', {}, e.label)), h('th', {}, 'Input'), h('th', {}, 'Cache read'), h('th', {}, 'Output'), h('th', {}, 'Cost'))),
      h('tbody', {}, rows.map(r => h('tr', {},
        h('td', {}, nameCell(r), h('div', { class: 'share', style: `width:${Math.max(1, ((r.cost || r.output) / max) * 100)}%` })),
        extra.map(e => h('td', {}, e.get(r))),
        h('td', {}, num(r.input + r.cacheWrite)), h('td', {}, num(r.cacheRead)), h('td', {}, num(r.output)), h('td', {}, r.cost ? money(r.cost) : '–')))))));
}

export async function usageView({ rerender }) {
  const u = await api('GET', `/api/usage?days=${days}`);
  const head = h('div', { class: 'head' }, h('div', { class: 'grow' }, h('h1', {}, 'Usage and cost'),
    h('div', { class: 'sub' }, 'Read from the session transcripts Claude Code keeps on this machine. Nothing is sent anywhere.')),
  u.available ? h('label', { class: 'scope' }, 'Period', h('select', { onchange: e => { days = Number(e.target.value); rerender(); } },
    [7, 30, 90, 365].map(d => h('option', { value: d, selected: d === days }, d === 365 ? 'Last year' : `Last ${d} days`)))) : null);
  if (!u.available) return h('div', { class: 'wrap' }, head, h('div', { class: 'card' }, h('h2', {}, 'No usage data yet'), h('div', { class: 'note', style: 'margin:6px 0 0' }, u.reason + ' Other harnesses do not record cost in a form AgentDeck can read yet.')));

  const t = u.totals;
  if (!t.cost && metric === 'cost') metric = 'output';
  const m = METRICS[metric];
  const active = u.days.filter(d => d.messages).length;
  const tiles = h('div', { class: 'tiles' },
    h('div', { class: 'tile' }, h('div', { class: 't-num' }, t.cost ? money(t.cost) : '–'), h('div', { class: 't-lbl' }, 'cost'), h('div', { class: 't-sub' }, active ? `${money(t.cost / active)} per active day` : '')),
    h('div', { class: 'tile' }, h('div', { class: 't-num' }, num(t.output)), h('div', { class: 't-lbl' }, 'output tokens'), h('div', { class: 't-sub' }, `${num(t.messages)} replies`)),
    h('div', { class: 'tile' }, h('div', { class: 't-num' }, num(t.input + t.cacheRead + t.cacheWrite)), h('div', { class: 't-lbl' }, 'input tokens'), h('div', { class: 't-sub' }, `${Math.round(t.cacheHitRate * 100)}% served from cache`)),
    h('div', { class: 'tile' }, h('div', { class: 't-num' }, u.sessions), h('div', { class: 't-lbl' }, plural(u.sessions, 'session').replace(/^\d+ /, '')), h('div', { class: 't-sub' }, `${active} active ${active === 1 ? 'day' : 'days'}`)));

  const chartCard = h('div', { class: 'card' },
    h('div', { class: 'card-head', style: 'margin-bottom:10px' }, h('h2', {}, `${m.label} per day`),
      h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Measure' }, Object.entries(METRICS).filter(([k]) => k !== 'cost' || t.cost).map(([k, v]) =>
        h('button', { class: 'small', role: 'radio', 'aria-checked': String(k === metric), onclick: () => { metric = k; rerender(); } }, v.label)))),
    barChart(u.days, m),
    h('details', { style: 'margin-top:10px' }, h('summary', { class: 'muted', style: 'cursor:pointer;font-size:12.5px' }, 'Show as a table'),
      h('div', { class: 'tablewrap' }, h('table', { class: 'data' },
        h('thead', {}, h('tr', {}, ['Day', 'Input', 'Cache read', 'Output', 'Cost'].map(x => h('th', {}, x)))),
        h('tbody', {}, u.days.filter(d => d.messages).reverse().map(d => h('tr', {}, h('td', {}, d.day), h('td', {}, num(d.input + d.cacheWrite)), h('td', {}, num(d.cacheRead)), h('td', {}, num(d.output)), h('td', {}, d.cost ? money(d.cost) : '–'))))))));

  return h('div', { class: 'wrap' }, head, tiles, chartCard,
    u.models.length ? rankTable('By model', u.models, r => h('span', { class: 'mono' }, r.name)) : null,
    u.projects.length ? rankTable('By project', u.projects, r => h('span', {}, h('b', {}, r.label), h('span', { class: 'path' }, r.name)),
      [{ label: 'Sessions', get: r => r.sessions }, { label: 'Last used', get: r => ago(r.last) }]) : null,
    h('div', { class: 'muted', style: 'font-size:12.5px' }, u.costNote + ' A long conversation re-sends its history on every turn, which is why input dwarfs output; cached input is billed at a fraction of the normal rate.'));
}
