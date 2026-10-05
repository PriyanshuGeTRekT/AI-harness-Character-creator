// Shared UI pieces: element builder, API client, toasts, modals, diff view, formatters.

// The session key arrives once in the URL from the launcher. It is kept for this tab only
// and removed from the address bar, so it does not end up in history or screenshots.
const TOKEN = (() => {
  const fromUrl = new URLSearchParams(location.search).get('k');
  const keep = { get: () => { try { return sessionStorage.getItem('agentdeck-key'); } catch { return null; } }, set: v => { try { sessionStorage.setItem('agentdeck-key', v); } catch { /* private mode */ } } };
  if (fromUrl) { keep.set(fromUrl); history.replaceState(null, '', location.pathname + location.hash); }
  return fromUrl || keep.get() || '';
})();

export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'open') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  const shorten = home && /\b(path|f-detail|banner|diff-path)\b/.test(el.className);
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false && kid !== '') el.append(kid.nodeType ? kid : document.createTextNode(shorten ? tilde(String(kid)) : String(kid)));
  return el;
}

// Paths under the home folder are shown as ~/..., which is shorter and keeps the user
// name out of screenshots. Display only: the real path is what gets sent to the server.
let home = '';
export const setHome = dir => { home = dir || ''; };
export const tilde = text => (home ? text.split(home).join('~') : text);

export function mount(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter(k => k != null && k !== false && k !== ''));
  return el;
}

export async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-AgentDeck-Token': TOKEN },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('AgentDeck is not running any more. Start it again, then reload this page.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---- formatters -------------------------------------------------------------

export const baseName = p => String(p || '').split(/[\\/]/).filter(Boolean).pop() || String(p || '');
export const num = n => (n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'k' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n || 0)));
export const money = n => '$' + (n >= 100 ? Math.round(n).toLocaleString() : (n || 0).toFixed(2));
export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
export function ago(ts) {
  if (!ts) return '';
  const s = (Date.now() - ts) / 1000;
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 45) return `${Math.round(s / 86400)} days ago`;
  return new Date(ts).toLocaleDateString();
}
export const field = (label, el, small) => h('label', { class: 'field' }, h('span', {}, label), el, small ? h('small', {}, small) : null);

// ---- toasts -----------------------------------------------------------------

export function toast(msg, { error = false, action = null, sticky = false } = {}) {
  const el = h('div', { class: 'toast' + (error ? ' err' : ''), role: error ? 'alert' : null });
  const close = () => el.remove();
  el.append(h('span', {}, msg));
  if (action) el.append(h('button', { onclick: async () => { close(); await action.run(); } }, action.label));
  el.append(h('button', { class: 'close', 'aria-label': 'Dismiss', onclick: close }, '✕'));
  document.getElementById('toast-root').append(el);
  if (!sticky) setTimeout(close, error ? 9000 : action ? 12000 : 3500);
  return close;
}
export const fail = err => toast(err.message, { error: true });

// ---- modals (stackable, keyboard-friendly) -----------------------------------

const stack = [];

function trapKeys(e) {
  const top = stack[stack.length - 1];
  if (!top) return;
  if (e.key === 'Escape') { e.preventDefault(); top.dismiss(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { const p = top.el.querySelector('.modal-foot .primary:not(:disabled)'); if (p) { e.preventDefault(); p.click(); } return; }
  if (e.key !== 'Tab') return;
  const items = [...top.el.querySelectorAll('button, input, select, textarea, [tabindex]')].filter(x => !x.disabled && x.offsetParent !== null);
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  else if (!top.el.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
}
document.addEventListener('keydown', trapKeys);
export const modalOpen = () => stack.length > 0;

// buttons: [{ label, class, action }]. An action returning false (or throwing) keeps the
// dialog open; the error is shown in the footer so nothing the user typed is lost.
export function modal(title, body, buttons, { narrow = false, guard = null, className = '' } = {}) {
  const root = document.getElementById('modal-root');
  const opener = document.activeElement;
  const errBox = h('div', { class: 'err', role: 'alert' });
  let busy = false;
  const entry = {};
  const close = () => {
    const i = stack.indexOf(entry);
    if (i === -1) return;
    stack.splice(i, 1);
    entry.el.remove();
    if (opener && opener.isConnected) opener.focus();
  };
  // Closing by Escape or the backdrop asks first when there is typed work to lose.
  const dismiss = () => { if (busy) return; if (guard && guard() && !window.confirm('Discard what you typed?')) return; close(); };
  const foot = h('div', { class: 'modal-foot' }, errBox, (buttons || []).map(b => {
    const btn = h('button', { class: b.class || '', onclick: async () => {
      if (busy) return;
      if (!b.action) return close();
      busy = true; btn.disabled = true; errBox.textContent = '';
      try { if ((await b.action()) !== false) close(); }
      catch (e) { errBox.textContent = e.message; }
      finally { busy = false; btn.disabled = false; }
    } }, b.label);
    return btn;
  }));
  const id = `m${Date.now()}${stack.length}`;
  const box = h('div', { class: `modal ${narrow ? 'narrow' : ''} ${className}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': id },
    title ? h('div', { class: 'modal-head' }, h('span', { id }, title), h('button', { class: 'ghost icon small', 'aria-label': 'Close', onclick: dismiss }, '✕')) : null,
    h('div', { class: 'modal-body' }, body), buttons ? foot : null);
  let downOnBack = false;
  entry.el = h('div', { class: 'modal-back', onmousedown: e => { downOnBack = e.target === entry.el; }, onmouseup: e => { if (downOnBack && e.target === entry.el) dismiss(); } }, box);
  entry.dismiss = dismiss;
  stack.push(entry);
  root.append(entry.el);
  const focusable = box.querySelector('.modal-body input:not([disabled]), .modal-body select, .modal-body textarea') || box.querySelector('.modal-foot .primary') || box.querySelector('button');
  if (focusable) focusable.focus();
  return { close, setError: msg => { errBox.textContent = msg; } };
}

// ---- diff -------------------------------------------------------------------

function lineDiff(before, after) {
  let a = before ? before.split(/\r?\n/) : [], b = after ? after.split(/\r?\n/) : [];
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const same = a.slice(0, head).map(l => [' ', l]), end = tail ? a.slice(a.length - tail).map(l => [' ', l]) : [];
  a = a.slice(head, a.length - tail); b = b.slice(head, b.length - tail);
  if (a.length * b.length > 4e6) return [...same, ...a.map(l => ['-', l]), ...b.map(l => ['+', l]), ...end];
  const m = a.length, n = b.length;
  const lcs = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out = same;
  let i = 0, j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && a[i] === b[j]) { out.push([' ', a[i]]); i++; j++; }
    else if (j < n && (i === m || lcs[i][j + 1] > lcs[i + 1][j])) { out.push(['+', b[j]]); j++; } // on a tie, show the removal first
    else { out.push(['-', a[i]]); i++; }
  }
  return out.concat(end);
}

export function diffView(before, after) {
  const rows = lineDiff(before || '', after || '');
  const keep = new Set();
  rows.forEach((r, idx) => { if (r[0] !== ' ') for (let k = idx - 2; k <= idx + 2; k++) keep.add(k); });
  const box = h('div', { class: 'diff', tabindex: '0', 'aria-label': 'Changes' });
  let skipped = false;
  rows.forEach((r, idx) => {
    if (!keep.has(idx)) { if (!skipped) box.append(h('div', { class: 'gap' }, '…')); skipped = true; return; }
    skipped = false;
    box.append(h('div', { class: r[0] === '+' ? 'add' : r[0] === '-' ? 'del' : '' }, `${r[0]} ${r[1]}`));
  });
  return box;
}

// ---- preview, confirm, apply, undo --------------------------------------------

export const changed = () => window.dispatchEvent(new Event('agentdeck:changed'));

export async function undo(batch) {
  try {
    const r = await api('POST', '/api/undo', { batch });
    const kept = (r.results || []).filter(x => x.skipped);
    toast(kept.length ? `Undone, except ${kept.map(x => baseName(x.path)).join(', ')}: changed since, so left alone.` : 'Undone.');
    changed();
  } catch (e) { fail(e); }
}

// Shows what would be written, and writes it only on confirmation. Resolves to the apply
// result, or null if the user cancelled or there was nothing to change. Throws when the
// preview itself is rejected, so the calling dialog can show the reason and stay open.
export async function confirmChanges(title, previewUrl, applyUrl, payload, { applyLabel } = {}) {
  const plan = await api('POST', previewUrl, payload);
  const lf = t => (t == null ? t : t.replace(/\r\n/g, '\n'));
  const changes = (plan.changes || []).filter(c => c.removed || lf(c.before) !== lf(c.after));
  if (!changes.length) { toast((plan.warnings || [])[0] || 'Nothing to change: the files already match.'); return null; }
  return new Promise(resolve => {
    let result = null;
    const body = h('div', {},
      (plan.warnings || []).map(w => h('div', { class: 'banner warn' }, w)),
      changes.map(c => h('div', {},
        h('div', {}, h('b', {}, c.removed ? 'Delete ' : c.before == null ? 'Create ' : 'Update '), h('span', { class: 'path' }, c.path)),
        c.removed ? h('div', { class: 'muted', style: 'margin:6px 0 16px' }, 'A copy is kept in History, so this can be undone.') : diffView(c.before, c.after))));
    const m = modal(title, body, [
      { label: 'Cancel', action: () => { resolve(null); } },
      { label: applyLabel || `Apply ${plural(changes.length, 'change')}`, class: 'primary', action: async () => {
        result = await api('POST', applyUrl, payload);
        resolve(result);
        toast(`Done. ${plural(changes.length, 'file')} changed.`, result.batch ? { action: { label: 'Undo', run: () => undo(result.batch) } } : {});
        changed();
      } },
    ]);
    // Escape / backdrop also counts as cancel.
    const watch = new MutationObserver(() => { if (!document.getElementById('modal-root').contains(body)) { watch.disconnect(); resolve(result); } });
    watch.observe(document.getElementById('modal-root'), { childList: true });
    void m;
  });
}

// For editor dialogs: run the preview; keep the editor open unless the change was applied.
export async function reviewFrom(title, previewUrl, applyUrl, payload) {
  return (await confirmChanges(title, previewUrl, applyUrl, payload)) != null;
}

export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export async function copyText(text, what = 'Copied') {
  try { await navigator.clipboard.writeText(text); toast(`${what} to the clipboard.`); }
  catch { modal('Copy this', h('textarea', { rows: 12, readonly: true }, text), [{ label: 'Close' }], { narrow: true }); }
}
