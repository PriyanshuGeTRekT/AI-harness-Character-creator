// Settings tab: values the harness itself enforces, written to its own config file.
import { h, fail, confirmChanges, baseName, plural, toast } from '../ui.js';
import { state, draftKey, same } from '../state.js';
import { loadDraft } from './harness.js';

function control(n, d, onChange) {
  const value = d.native[n.key];
  const set = v => { d.native[n.key] = v; onChange(); };
  if (n.kind === 'select') return h('select', { 'aria-label': n.label, onchange: e => set(e.target.value) },
    h('option', { value: '' }, '(harness default)'),
    n.options.map(o => h('option', { value: o.value, selected: String(o.value) === String(value) }, o.label + (o.danger ? '  (removes safety checks)' : ''))),
    value !== '' && !n.options.some(o => String(o.value) === String(value)) ? h('option', { value, selected: true }, `${value} (current)`) : null);
  if (n.kind === 'toggle') return h('select', { 'aria-label': n.label, style: 'max-width:220px', onchange: e => set(e.target.value === '' ? '' : e.target.value === 'true') },
    [['', '(harness default)'], ['true', 'On'], ['false', 'Off']].map(([v, l]) => h('option', { value: v, selected: String(value) === v }, l)));
  if (n.kind === 'list') return h('textarea', { rows: Math.min(10, Math.max(3, String(value || '').split('\n').length + 1)), 'aria-label': n.label, placeholder: n.placeholder || 'One per line', 'data-key': n.key, oninput: e => set(e.target.value) }, value || '');
  return h('input', { type: n.kind === 'number' ? 'number' : 'text', value: value ?? '', 'aria-label': n.label, placeholder: n.placeholder || '(harness default)', style: 'max-width:360px',
    oninput: e => set(n.kind === 'number' && e.target.value !== '' ? Number(e.target.value) : e.target.value) });
}

const lines = v => String(v || '').split('\n').map(s => s.trim()).filter(Boolean);

export async function nativeTab(x, ctx) {
  const { profile: p, draft: d } = await loadDraft(x);
  if (!p.native.length) return h('div', { class: 'empty' }, state.scope ? `${x.name} has no per-project settings AgentDeck can edit. Switch Scope to Global.` : 'No settings available for this harness.');
  const changedKeys = () => Object.keys(d.native).filter(k => !same(d.native[k], d.baseNative[k]));
  const applyBtn = h('button', { class: 'primary', onclick: async () => {
    // Send only what changed, so untouched keys in the file are never rewritten.
    const native = Object.fromEntries(changedKeys().map(k => [k, d.native[k]]));
    try { if (await confirmChanges('Apply settings', '/api/profile/preview', '/api/profile/apply', { harness: x.id, project: state.scope, native })) delete state.drafts[draftKey()].native; } catch (e) { fail(e); }
  } });
  const discardBtn = h('button', { class: 'ghost', onclick: () => { d.native = { ...d.baseNative }; ctx.rerender(); } }, 'Discard changes');
  const paintBar = () => {
    const n = changedKeys().length;
    applyBtn.textContent = n ? `Review and apply (${plural(n, 'change')})` : 'Review and apply';
    applyBtn.disabled = !n; discardBtn.hidden = !n;
  };

  const groups = [...new Set(p.native.map(n => n.group || 'Model, output and context'))];
  const wrap = h('div', {}, h('div', { class: 'banner' }, 'These are real settings the harness enforces. Empty means "leave the harness default". ',
    state.scope ? 'Project settings override the global ones for this folder.' : ''));
  for (const g of groups) {
    const defs = p.native.filter(n => (n.group || 'Model, output and context') === g);
    const presets = g === 'Permissions' && defs.some(n => n.kind === 'list') ? x.permissionPresets : [];
    const card = h('div', { class: 'card' },
      h('h2', {}, g), h('div', { class: 'note path' }, [...new Set(defs.map(n => n.file))].join(' · ')),
      presets.length ? h('div', { style: 'margin-bottom:10px' },
        h('div', { class: 'help muted', style: 'margin-bottom:6px;font-size:12.5px' }, 'Tired of approving the same commands? Add a rule set (it is merged into the lists below; review before applying):'),
        h('div', { class: 'chips' }, presets.map(ps => h('button', { class: 'chip', title: ps.description, onclick: () => {
          for (const part of ['allow', 'ask', 'deny']) {
            const key = `permissions.${part}`;
            if (key in d.native) d.native[key] = [...new Set([...lines(d.native[key]), ...ps[part]])].join('\n');
          }
          toast(`Added "${ps.name}" rules. Review them, then apply.`); ctx.rerender();
        } }, '+ ' + ps.name)))) : null,
      defs.map(n => h('div', { class: 'row' },
        h('div', { class: 'lbl' }, n.label, n.danger ? h('span', { class: 'tag danger' }, 'has unsafe options') : null,
          h('div', { class: 'help mono' }, n.key), n.help ? h('div', { class: 'help' }, n.help) : null),
        h('div', {}, control(n, d, paintBar)))));
    wrap.append(card);
  }
  wrap.append(h('div', { class: 'actionbar actions' }, applyBtn, discardBtn, h('span', { class: 'muted', style: 'font-size:12.5px' }, `Written to ${[...new Set(p.native.map(n => baseName(n.file)))].join(', ')}. Most harnesses read settings when a session starts.`)));
  paintBar();
  return wrap;
}
