// History: every change AgentDeck made, grouped by action, with undo and per-file restore.
import { h, api, fail, modal, confirmChanges, undo, ago, plural, baseName } from '../ui.js';

export async function historyDialog() {
  let data;
  try { data = await api('GET', '/api/backups'); } catch (e) { return fail(e); }
  // Entries from one action share a batch id and are shown together.
  const groups = [];
  for (const b of data.backups) {
    const g = b.batch && groups.find(x => x.batch === b.batch);
    if (g) g.entries.push(b); else groups.push({ batch: b.batch, label: b.label || 'Change', time: b.time, entries: [b] });
  }
  let dlg;
  const body = h('div', {},
    h('div', { class: 'muted', style: 'font-size:12.5px;margin-bottom:12px' }, 'A copy is saved before every write. Copies live in ', h('span', { class: 'path' }, data.dir), ' and the oldest are pruned automatically.'),
    groups.length ? h('div', { class: 'list' }, groups.slice(0, 80).map(g => h('div', { class: 'item' },
      h('div', { class: 'i-main' },
        h('div', { class: 'i-name' }, g.label, h('span', { class: 'tag' }, ago(g.time)), h('span', { class: 'tag' }, plural(g.entries.length, 'file'))),
        g.entries.map(e => h('div', { class: 'path', style: 'display:flex;gap:8px;align-items:baseline' },
          h('span', { style: 'flex:1' }, `${e.created ? 'created ' : e.isDir ? 'folder ' : ''}${e.original}`),
          e.created ? null : h('button', { class: 'link', style: 'font-family:inherit', onclick: () => confirmChanges(`Restore ${baseName(e.original)}`, '/api/backups/preview', '/api/backups/restore', { id: e.id }, { applyLabel: 'Restore this version' }).then(r => { if (r) dlg.close(); }).catch(fail) }, 'restore')))),
      g.batch ? h('button', { class: 'small', title: 'Put every file in this change back the way it was', onclick: async () => { dlg.close(); await undo(g.batch); } }, 'Undo all') : null)))
      : h('div', { class: 'muted' }, 'Nothing yet. Every change you apply will be listed here.'));
  dlg = modal('History', body, [{ label: 'Close' }]);
}
