// One harness: header, scope picker, tabs.
import { h, api, tilde } from '../ui.js';
import { state, harness, tabsFor, go, draftKey, same } from '../state.js';
import { behaviorTab } from './behavior.js';
import { nativeTab } from './native.js';
import { itemsTab } from './items.js';
import { mcpTab } from './mcp.js';
import { hooksTab } from './hooks.js';
import { projectsTab, filesTab } from './projects.js';

// Behavior and Settings share one draft per harness and scope, so switching between the
// two tabs (or away and back) never loses unsaved edits.
export async function loadDraft(x) {
  const key = draftKey(x.id, state.scope);
  const profile = await api('GET', `/api/profile?harness=${encodeURIComponent(x.id)}&project=${encodeURIComponent(state.scope)}`);
  const d = state.drafts[key] || (state.drafts[key] = {});
  const baseValues = { ...state.catalog.defaults, ...profile.values };
  const baseNative = Object.fromEntries(profile.native.map(n => [n.key, n.kind === 'list' ? n.value.join('\n') : (n.value ?? '')]));
  if (!d.values || same(d.values, d.baseValues)) d.values = { ...baseValues };
  if (!d.native || same(d.native, d.baseNative)) d.native = { ...baseNative };
  Object.assign(d, { baseValues, baseNative });
  return { profile, draft: d };
}

export async function harnessView(ctx) {
  const x = harness();
  const projects = x.projects.filter(p => p.exists);
  const scopeSel = h('select', { 'aria-label': 'Scope', onchange: e => go({ scope: e.target.value }) },
    h('option', { value: '' }, 'Global (all projects)'),
    projects.map(p => h('option', { value: p.path, selected: p.path === state.scope }, `${p.name}  ·  ${tilde(p.path)}`)));
  const head = h('div', { class: 'head' },
    h('div', { class: 'grow' },
      h('h1', {}, x.name),
      h('div', { class: 'sub' }, x.installed ? `Detected by ${x.evidence.join(' · ')}` : 'Not installed on this machine. You can still prepare its files; they take effect once it is installed.')),
    h('label', { class: 'scope' + (state.scope ? ' project' : '') }, state.scope ? 'Scope: this project only' : 'Scope', scopeSel));
  const tabs = h('div', { class: 'tabs', role: 'tablist' }, tabsFor(x).map(t =>
    h('button', { class: 'tab' + (t.id === state.tab ? ' active' : ''), role: 'tab', 'aria-selected': String(t.id === state.tab), onclick: () => go({ tab: t.id }) }, t.label)));
  const kind = x.itemKinds.find(k => k.type === state.tab);
  const body = state.tab === 'behavior' ? await behaviorTab(x, ctx)
    : state.tab === 'native' ? await nativeTab(x, ctx)
    : state.tab === 'mcp' ? await mcpTab(x, ctx)
    : state.tab === 'hooks' ? await hooksTab(x, ctx)
    : state.tab === 'projects' ? projectsTab(x, ctx)
    : state.tab === 'files' ? filesTab(x, ctx)
    : await itemsTab(x, kind, ctx);
  return h('div', { class: 'wrap' }, head, x.note ? h('div', { class: 'banner' }, x.note) : null, tabs, h('div', { role: 'tabpanel' }, body));
}
