// Entry point: boot, sidebar, routing, theme, command palette.
import { h, mount, api, toast, fail, modal, modalOpen, setHome } from './ui.js';
import { state, harness, tabsFor, readHash, go, anyDirty, isDirty } from './state.js';
import { overviewView } from './views/overview.js';
import { usageView } from './views/usage.js';
import { syncView } from './views/sync.js';
import { harnessView } from './views/harness.js';
import { historyDialog } from './views/history.js';

const main = document.getElementById('main');
const VIEWS = { overview: overviewView, usage: usageView, sync: syncView, harness: harnessView };
const NAV = [
  { id: 'overview', label: 'Overview', ico: '◎' },
  { id: 'usage', label: 'Usage and cost', ico: '▤' },
  { id: 'sync', label: 'Sync', ico: '⇄' },
];

// ---- sidebar ----------------------------------------------------------------

function renderSidebar() {
  mount(document.getElementById('nav'), NAV.map(n => h('button', { class: 'navitem' + (state.view === n.id ? ' active' : ''), 'aria-current': state.view === n.id ? 'page' : null, onclick: () => go({ view: n.id }) },
    h('span', { class: 'ico', 'aria-hidden': 'true' }, n.ico), h('span', { class: 'grow' }, n.label),
    n.id === 'overview' && state.healthCount ? h('span', { class: 'badge' + (state.healthCount.high ? '' : ' warn'), title: 'Open findings in the health check' }, state.healthCount.high || state.healthCount.warn) : null)));

  const on = state.scan.harnesses.filter(x => x.installed), off = state.scan.harnesses.filter(x => !x.installed);
  const btn = x => {
    const active = state.view === 'harness' && x.id === state.harnessId;
    return h('button', { class: `navitem${active ? ' active' : ''}${x.installed ? '' : ' off'}`, 'aria-current': active ? 'page' : null, onclick: () => go({ view: 'harness', harnessId: x.id }) },
      h('span', { class: 'dot' + (x.installed ? ' on' : ''), 'aria-hidden': 'true' }),
      h('span', { class: 'grow' }, x.name),
      isDirty(`${x.id}|`) ? h('span', { class: 'count', title: 'Unsaved changes' }, '●') : x.projects.length ? h('span', { class: 'count' }, x.projects.length) : null);
  };
  mount(document.getElementById('harness-list'),
    h('div', { class: 'side-label' }, `On this machine (${on.length})`), on.map(btn),
    on.length ? null : h('div', { class: 'muted', style: 'padding:4px 8px' }, 'No harness found yet.'),
    h('details', { class: 'more', open: !on.length || (state.view === 'harness' && !harness().installed) },
      h('summary', {}, `${off.length} more supported, not installed`), off.map(btn)));
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('btn-menu').setAttribute('aria-expanded', 'false');
}

// ---- rendering --------------------------------------------------------------

let seq = 0;
async function render() {
  readHash();
  renderSidebar();
  document.title = state.view === 'harness' ? `${harness().name} · AgentDeck` : 'AgentDeck';
  const my = ++seq;
  main.classList.add('loading');
  let node;
  try { node = await VIEWS[state.view]({ rerender: render }); }
  catch (e) { node = h('div', { class: 'wrap' }, h('div', { class: 'banner danger' }, e.message), h('button', { onclick: render }, 'Try again')); }
  if (my !== seq) return; // a newer navigation won
  main.classList.remove('loading');
  mount(main, node);
}

async function rescan({ quiet = false } = {}) {
  try {
    state.scan = await api('GET', '/api/scan');
    api('GET', '/api/health').then(hc => { state.healthCount = hc.counts; renderSidebar(); }).catch(() => {});
  } catch (e) { fail(e); return; }
  await render();
  if (!quiet) toast('Rescanned.');
}

// ---- theme ------------------------------------------------------------------

const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };
function applyTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
}
function cycleTheme() {
  const order = ['auto', 'light', 'dark'];
  const next = order[(order.indexOf(store.get('agentdeck-theme') || 'auto') + 1) % 3];
  store.set('agentdeck-theme', next); applyTheme(next);
  toast(`Theme: ${next === 'auto' ? 'follow system' : next}`);
}

// ---- command palette ----------------------------------------------------------

function commands() {
  const out = NAV.map(n => ({ label: n.label, hint: 'View', run: () => go({ view: n.id }) }));
  for (const x of state.scan.harnesses) {
    out.push({ label: x.name, hint: x.installed ? 'Harness' : 'Harness, not installed', run: () => go({ view: 'harness', harnessId: x.id }) });
    if (!x.installed) continue;
    for (const t of tabsFor(x)) out.push({ label: `${x.name}: ${t.label.replace(/ \(\d+\)$/, '')}`, hint: 'Tab', run: () => go({ view: 'harness', harnessId: x.id, tab: t.id }) });
    for (const p of x.projects.filter(q => q.exists)) out.push({ label: `Tune ${p.name} in ${x.name}`, hint: p.path, run: () => go({ view: 'harness', harnessId: x.id, tab: 'behavior', scope: p.path }) });
  }
  out.push({ label: 'History and undo', hint: 'Action', run: () => historyDialog() }, { label: 'Rescan this machine', hint: 'Action', run: () => rescan() }, { label: 'Switch colour theme', hint: 'Action', run: cycleTheme },
    { label: 'Quit AgentDeck', hint: 'Action', run: async () => { if (anyDirty() && !window.confirm('You have unsaved changes. Quit anyway?')) return; await api('POST', '/api/quit'); mount(main, h('div', { class: 'empty' }, 'AgentDeck has stopped. You can close this window.')); } });
  return out;
}

function palette() {
  if (modalOpen()) return;
  const all = commands();
  let sel = 0, shown = [];
  const results = h('div', { class: 'results', role: 'listbox' });
  const input = h('input', { type: 'text', placeholder: 'Jump to a harness, project, tab or action…', 'aria-label': 'Search' });
  let dlg;
  const pick = i => { const c = shown[i]; if (!c) return; dlg.close(); c.run(); };
  const draw = () => {
    const q = input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    shown = all.filter(c => q.every(w => (c.label + ' ' + c.hint).toLowerCase().includes(w))).slice(0, 40);
    sel = Math.min(sel, Math.max(0, shown.length - 1));
    mount(results, shown.length ? shown.map((c, i) => h('div', { class: 'res' + (i === sel ? ' sel' : ''), role: 'option', 'aria-selected': String(i === sel), onclick: () => pick(i), onmousemove: () => { if (sel !== i) { sel = i; draw(); } } }, h('span', {}, c.label), h('small', {}, c.hint.length > 46 ? '…' + c.hint.slice(-45) : c.hint))) : h('div', { class: 'res muted' }, 'Nothing matches.'));
    const el = results.querySelector('.sel'); if (el) el.scrollIntoView({ block: 'nearest' });
  };
  input.addEventListener('input', () => { sel = 0; draw(); });
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, shown.length - 1); draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); draw(); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(sel); }
  });
  dlg = modal('', h('div', {}, input, results), null, { className: 'palette' });
  draw();
  input.focus();
}

// ---- boot -------------------------------------------------------------------

async function boot() {
  applyTheme(store.get('agentdeck-theme'));
  try {
    [state.scan, state.catalog, state.presets] = await Promise.all([api('GET', '/api/scan'), api('GET', '/api/levers'), api('GET', '/api/presets').then(r => r.presets)]);
  } catch (e) { mount(main, h('div', { class: 'empty' }, e.message)); return; }
  setHome(state.scan.home);
  window.addEventListener('hashchange', render);
  window.addEventListener('agentdeck:changed', () => rescan({ quiet: true }));
  window.addEventListener('beforeunload', e => { if (anyDirty()) { e.preventDefault(); e.returnValue = ''; } });
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); palette(); }
    else if (e.key === '/' && !modalOpen() && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) { e.preventDefault(); palette(); }
  });
  document.getElementById('btn-palette').addEventListener('click', palette);
  document.getElementById('btn-rescan').addEventListener('click', () => rescan());
  document.getElementById('btn-backups').addEventListener('click', () => historyDialog());
  document.getElementById('btn-theme').addEventListener('click', cycleTheme);
  document.getElementById('btn-menu').addEventListener('click', e => { const open = document.getElementById('sidebar').classList.toggle('open'); e.currentTarget.setAttribute('aria-expanded', String(open)); });
  if (/Mac/i.test(navigator.platform)) document.querySelector('#btn-palette kbd').textContent = '⌘ K';
  // Tells a console-less server that the page is still open.
  setInterval(() => api('POST', '/api/alive').catch(() => {}), 30000);
  api('GET', '/api/health').then(hc => { state.healthCount = hc.counts; renderSidebar(); }).catch(() => {});
  await render();
}

boot();
