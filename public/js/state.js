// App state and hash routing. The URL holds the view, harness, tab and project scope, so
// reload, back/forward and bookmarks all land where the user was.

export const state = {
  scan: null, catalog: null, presets: {},
  view: 'overview', harnessId: null, tab: 'behavior', scope: '',
  drafts: {}, // unsaved lever / native edits, keyed by harness and scope
  healthCount: null,
};

export const harness = (id = state.harnessId) => state.scan.harnesses.find(x => x.id === id);

export function tabsFor(x) {
  const tabs = [{ id: 'behavior', label: 'Behavior' }];
  if (x.hasNative) tabs.push({ id: 'native', label: 'Settings' });
  for (const k of x.itemKinds) tabs.push({ id: k.type, label: k.label });
  if (x.mcp) tabs.push({ id: 'mcp', label: 'MCP servers' });
  if (x.hooks) tabs.push({ id: 'hooks', label: 'Hooks' });
  tabs.push({ id: 'projects', label: `Projects (${x.projects.length})` }, { id: 'files', label: 'Files' });
  return tabs;
}

export function routeToHash(r = state) {
  if (r.view !== 'harness') return `#/${r.view}`;
  return `#/h/${r.harnessId}/${r.tab}${r.scope ? `?p=${encodeURIComponent(r.scope)}` : ''}`;
}

// Reads location.hash into state. Unknown or stale parts fall back to something valid.
export function readHash() {
  const [pathPart, query] = location.hash.replace(/^#\/?/, '').split('?');
  const parts = pathPart.split('/').filter(Boolean);
  if (parts[0] === 'h' && state.scan.harnesses.some(x => x.id === parts[1])) {
    const x = harness(parts[1]);
    const scope = new URLSearchParams(query || '').get('p') || '';
    Object.assign(state, {
      view: 'harness', harnessId: x.id,
      tab: tabsFor(x).some(t => t.id === parts[2]) ? parts[2] : 'behavior',
      scope: x.projects.some(p => p.exists && p.path === scope) ? scope : '',
    });
  } else {
    state.view = ['overview', 'usage', 'sync'].includes(parts[0]) ? parts[0] : 'overview';
  }
}

export function go(patch) {
  const next = { view: state.view, harnessId: state.harnessId, tab: state.tab, scope: state.scope, ...patch };
  if (patch.harnessId && patch.harnessId !== state.harnessId && !('scope' in patch)) {
    // Keep the project scope when the other harness knows the same folder.
    const x = harness(patch.harnessId);
    next.scope = x && x.projects.some(p => p.exists && p.path === state.scope) ? state.scope : '';
  }
  const hash = routeToHash(next);
  if (hash === location.hash) window.dispatchEvent(new Event('hashchange'));
  else location.hash = hash;
}

export const draftKey = (id = state.harnessId, scope = state.scope) => `${id}|${scope}`;
export const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function isDirty(key = draftKey()) {
  const d = state.drafts[key];
  return !!d && ((d.values && !same(d.values, d.baseValues)) || (d.native && !same(d.native, d.baseNative)));
}
export const anyDirty = () => Object.keys(state.drafts).some(isDirty);
