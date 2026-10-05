// Projects tab and Files tab.
import { h, api, toast, fail, modal, reviewFrom, ago, plural } from '../ui.js';
import { state, go } from '../state.js';

export function projectsTab(x, ctx) {
  const input = h('input', { type: 'text', placeholder: state.scan.platform === 'win32' ? 'Full folder path, e.g. C:\\code\\my-app' : 'Full folder path, e.g. /home/me/code/my-app', 'aria-label': 'Project folder path' });
  const everywhere = h('input', { type: 'checkbox' });
  const add = async () => {
    try {
      await api('POST', '/api/projects/add', { harness: everywhere.checked ? '*' : x.id, path: input.value });
      state.scan = await api('GET', '/api/scan'); toast('Project added.'); ctx.rerender();
    } catch (e) { fail(e); }
  };
  input.addEventListener('keydown', e => { if (e.key === 'Enter') add(); });
  const adder = h('div', { class: 'card' },
    h('h2', {}, 'Add a project folder'),
    h('div', { class: 'note' }, x.projects.length ? 'For folders this harness has not recorded yet.' : x.needsSqlite && !state.scan.sqlite ? `${x.name} keeps its history in a database this version of Node cannot read (needs Node 22.13 or later). Add the folders you use it in.` : x.installed ? `AgentDeck could not find any projects in ${x.name}'s history. Add the folders you use it in.` : 'Not installed, but you can still prepare a project for it.'),
    h('div', { class: 'actions' }, h('div', { style: 'flex:1;min-width:260px' }, input), h('button', { class: 'primary', onclick: add }, 'Add')),
    h('label', { class: 'checks', style: 'margin-top:8px;font-size:12.5px' }, everywhere, 'Add it to every detected harness'));
  return h('div', {}, adder, h('div', { class: 'list' }, x.projects.map(p => h('div', { class: 'item' },
    h('div', { class: 'i-main' },
      h('div', { class: 'i-name' }, p.name, p.exists ? null : h('span', { class: 'tag danger' }, 'folder missing'),
        p.manual ? h('span', { class: 'tag' }, 'added by you') : null,
        p.hasInstructions ? h('span', { class: 'tag' }, 'has instruction file') : null, p.tuned ? h('span', { class: 'tag ok' }, 'tuned') : null),
      h('div', { class: 'path' }, p.path),
      h('div', { class: 'i-desc' }, [p.sessions ? plural(p.sessions, 'session') : null, p.lastUsed ? `last used ${ago(p.lastUsed)}` : null].filter(Boolean).join(' · '))),
    h('div', { class: 'actions' },
      p.exists ? h('button', { class: 'small', onclick: () => go({ tab: 'behavior', scope: p.path }) }, 'Tune this project') : null,
      p.manual ? h('button', { class: 'small danger', onclick: async () => {
        try { await api('POST', '/api/projects/remove', { harness: x.id, path: p.path }); state.scan = await api('GET', '/api/scan'); if (state.scope === p.path) go({ scope: '' }); else ctx.rerender(); } catch (e) { fail(e); }
      } }, 'Remove from list') : null)))));
}

export function filesTab(x) {
  const sep = state.scan.sep || '/';
  const files = x.files.filter(f => (state.scope ? f.scope === 'project' : f.scope === 'global'))
    .map(f => ({ ...f, path: f.scope === 'project' ? `${state.scope}${sep}${f.rel.replace(/\//g, sep)}` : f.path }));
  if (!files.length) return h('div', { class: 'empty' }, state.scope ? 'No project files are known for this harness. Switch Scope to Global.' : 'No global files are known for this harness. Pick a project under Scope.');
  return h('div', {},
    h('div', { class: 'banner' }, 'Direct access to this harness\'s own files, for anything the other tabs do not cover. Saving still shows a diff and keeps a backup.'),
    h('div', { class: 'list' }, files.map(f => h('div', { class: 'item' },
      h('div', { class: 'i-main' }, h('div', { class: 'i-name' }, f.label), h('div', { class: 'path' }, f.path)),
      h('button', { class: 'small', onclick: () => fileDialog(f) }, 'Open')))));
}

async function fileDialog(f) {
  let data;
  try { data = await api('GET', `/api/file?path=${encodeURIComponent(f.path)}`); } catch (e) { return fail(e); }
  const area = h('textarea', { rows: 22, spellcheck: 'false' }, data.content || '');
  modal(f.label, h('div', {}, h('div', { class: 'path', style: 'margin-bottom:8px' }, f.path + (data.exists ? '' : '  (does not exist yet)')), area), [
    { label: 'Close' },
    { label: 'Review changes', class: 'primary', action: () => reviewFrom(`Save ${f.label}`, '/api/file/preview', '/api/file', { path: f.path, content: area.value }) },
  ], { guard: () => area.value !== (data.content || '') });
}
