// Hooks tab: ready-made recipes plus custom hooks.
import { h, api, modal, reviewFrom, confirmChanges, fail, baseName, field } from '../ui.js';
import { state } from '../state.js';

export async function hooksTab(x) {
  const data = await api('GET', `/api/hooks?harness=${encodeURIComponent(x.id)}&project=${encodeURIComponent(state.scope)}`);
  const hint = state.recipeHint; state.recipeHint = null;
  const installed = new Set(data.scopes.flatMap(sc => sc.hooks.map(hk => hk.recipe)).filter(Boolean));
  const wrap = h('div', {},
    h('div', { class: 'banner' }, 'Hooks are commands the harness itself runs at fixed points. Unlike Behavior levers they are enforced: use them for anything that must happen every time.'),
    data.note ? h('div', { class: 'banner warn' }, data.note) : null);

  if (data.recipes.length) {
    wrap.append(h('div', { class: 'card' }, h('h2', {}, 'Recipes'),
      h('div', { class: 'note' }, 'One click each. They are small Node scripts, so they behave the same on Windows, macOS and Linux, and need nothing else installed.'),
      h('div', { class: 'grid3' }, data.recipes.map(r => h('div', { class: 'item', style: `flex-direction:column;${hint === r.id ? 'border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)' : ''}` },
        h('div', { class: 'i-main' }, h('div', { class: 'i-name' }, r.title, installed.has(r.id) ? h('span', { class: 'tag ok' }, 'installed') : null),
          h('div', { class: 'i-desc' }, r.description),
          h('div', { class: 'path', style: 'margin-top:4px' }, `${r.event}${r.matcher ? ` · ${r.matcher}` : ''}`)),
        h('button', { class: installed.has(r.id) ? 'small' : 'small primary', disabled: installed.has(r.id), onclick: () => recipeDialog(x, r) }, installed.has(r.id) ? 'Installed' : 'Install…'))))));
  }

  wrap.append(h('div', { class: 'actions', style: 'margin:4px 0 14px' }, h('button', { onclick: () => hookDialog(x, data, null, null) }, '+ Custom hook')));
  for (const sc of data.scopes) {
    wrap.append(h('div', { class: 'card' },
      h('h2', {}, sc.scope === 'global' ? 'Global' : `Project: ${baseName(state.scope)}`), h('div', { class: 'note path' }, sc.file),
      sc.error ? h('div', { class: 'banner warn' }, sc.error) : null,
      sc.hooks.length ? h('div', { class: 'list' }, sc.hooks.map(hk => h('div', { class: 'item' },
        h('div', { class: 'i-main' },
          h('div', { class: 'i-name' }, hk.recipeTitle || hk.event, hk.recipeTitle ? h('span', { class: 'tag' }, hk.event) : null, hk.matcher ? h('span', { class: 'tag' }, `on ${hk.matcher}`) : null, hk.editable ? null : h('span', { class: 'tag' }, hk.type)),
          h('div', { class: 'path' }, hk.command)),
        h('div', { class: 'actions' },
          hk.editable && !hk.recipe ? h('button', { class: 'small', onclick: () => hookDialog(x, data, hk, sc.scope) }, 'Edit') : null,
          h('button', { class: 'small danger', onclick: () => confirmChanges('Remove hook', '/api/hooks/preview', '/api/hooks',
            { harness: x.id, project: state.scope, scope: sc.scope, id: hk.id, remove: true }, { applyLabel: 'Remove' }).catch(fail) }, 'Remove')))))
        : (sc.error ? null : h('div', { class: 'muted' }, 'No hooks here.'))));
  }
  return wrap;
}

function scopeField(x, get, set) {
  return field('Scope', h('select', { onchange: e => set(e.target.value) },
    h('option', { value: 'global', selected: get() === 'global' }, 'Global (all projects)'),
    state.scope && x.hooks.project ? h('option', { value: 'project', selected: get() === 'project' }, `Project: ${baseName(state.scope)}`) : null));
}

function recipeDialog(x, r) {
  let scope = state.scope && x.hooks.project ? 'project' : 'global';
  const params = {};
  const input = r.param ? h('input', { type: 'text', value: r.param.default, oninput: e => { params[r.param.key] = e.target.value; } }) : null;
  modal(r.title, h('div', {},
    h('p', { style: 'margin-top:0' }, r.description),
    input ? field(r.param.label, input) : null,
    scopeField(x, () => scope, v => { scope = v; })), [
    { label: 'Cancel' },
    { label: 'Review changes', class: 'primary', action: () => reviewFrom(`Install: ${r.title}`, '/api/hooks/preview', '/api/hooks', { harness: x.id, project: state.scope, scope, recipe: r.id, params }) },
  ], { narrow: true });
}

function hookDialog(x, data, existing, existingScope) {
  const d = existing ? { event: existing.event, matcher: existing.matcher, command: existing.command, timeout: existing.timeout } : { event: data.events[0], matcher: '', command: '', timeout: '' };
  const initial = JSON.stringify(d);
  let scope = existingScope || (state.scope && x.hooks.project ? 'project' : 'global');
  const body = h('div', {},
    h('div', { class: 'grid2' },
      field('When (event)', h('select', { onchange: e => { d.event = e.target.value; } }, data.events.map(ev => h('option', { value: ev, selected: ev === d.event }, ev)))),
      field('Only for tools matching', h('input', { type: 'text', value: d.matcher, placeholder: 'e.g. Bash or Edit|Write (empty = all)', oninput: e => { d.matcher = e.target.value; } }))),
    field('Command', h('textarea', { rows: 4, oninput: e => { d.command = e.target.value; } }, d.command), 'Receives the event as JSON on standard input. In Claude Code, exit code 2 blocks the action and shows the agent what you printed to stderr.'),
    h('div', { class: 'grid2' },
      field('Timeout (seconds)', h('input', { type: 'number', min: 1, value: d.timeout, placeholder: '(default)', oninput: e => { d.timeout = e.target.value; } })),
      existing ? h('div', {}) : scopeField(x, () => scope, v => { scope = v; })));
  modal(existing ? 'Edit hook' : 'Custom hook', body, [
    { label: 'Cancel' },
    { label: 'Review changes', class: 'primary', action: () => reviewFrom(existing ? 'Update hook' : 'Add hook', '/api/hooks/preview', '/api/hooks', { harness: x.id, project: state.scope, scope, id: existing ? existing.id : '', hook: d }) },
  ], { guard: () => JSON.stringify(d) !== initial });
}
