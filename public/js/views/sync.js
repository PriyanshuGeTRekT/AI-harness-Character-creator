// Sync: is every harness being told the same thing, globally and in each project?
import { h, api, modal, confirmChanges, num } from '../ui.js';
import { state, go } from '../state.js';

const LABEL = { synced: 'Applied', edited: 'Edited by hand', missing: 'Removed', untracked: 'Not tracked', none: 'Not tuned' };

function matchDialog(row, harnesses) {
  const sources = harnesses.filter(x => ['synced', 'edited', 'missing'].includes(row.cells[x.id].status));
  if (!sources.length) { modal('Nothing to copy yet', h('p', {}, 'No harness has a profile applied by AgentDeck in this scope. Tune one first, then come back to copy it to the others.'), [{ label: 'Close' }], { narrow: true }); return; }
  let source = sources[0].id;
  const targets = new Set(harnesses.filter(x => row.cells[x.id].status !== 'na').map(x => x.id));
  const boxes = h('div', { class: 'checks' });
  const draw = () => boxes.replaceChildren(...harnesses.filter(x => row.cells[x.id].status !== 'na' && x.id !== source).map(x => h('label', {},
    h('input', { type: 'checkbox', checked: targets.has(x.id), onchange: e => (e.target.checked ? targets.add(x.id) : targets.delete(x.id)) }), x.name)));
  draw();
  modal(`Make harnesses match: ${row.label}`, h('div', {},
    h('label', { class: 'field' }, h('span', {}, 'Copy the profile from'), h('select', { onchange: e => { source = e.target.value; draw(); } }, sources.map(x => h('option', { value: x.id }, x.name)))),
    h('div', { class: 'field' }, h('span', {}, 'To'), boxes),
    h('div', { class: 'muted', style: 'font-size:12.5px' }, 'Each harness gets the same levers in its own instruction file. You will see every change before it is written.')), [
    { label: 'Cancel' },
    { label: 'Review changes', class: 'primary', action: async () => {
      const profile = await api('GET', `/api/profile?harness=${source}&project=${encodeURIComponent(row.path)}`);
      const to = [...targets].filter(id => id !== source);
      return (await confirmChanges('Sync behavior', '/api/profile/preview', '/api/profile/apply', { harnesses: [source, ...to], project: row.path, values: { ...state.catalog.defaults, ...profile.values } })) != null;
    } },
  ], { narrow: true });
}

export async function syncView() {
  const d = await api('GET', '/api/drift');
  const head = h('div', { class: 'head' }, h('div', { class: 'grow' }, h('h1', {}, 'Sync'),
    h('div', { class: 'sub' }, 'Each harness reads its own instruction file. This shows where the behavior AgentDeck applied matches across them, and where it has drifted.')));
  if (d.harnesses.length < 1) return h('div', { class: 'wrap' }, head, h('div', { class: 'empty' }, 'No harness detected yet.'));

  const cell = (row, x) => {
    const c = row.cells[x.id];
    if (c.status === 'na') return h('span', { class: 'muted' }, '–');
    // A second marker ring flags cells whose text differs from the first applied one in the row.
    const first = Object.values(row.cells).find(v => v.hash);
    const odd = c.hash && first && c.hash !== first.hash;
    return h('button', { class: `link cell ${c.status}${odd ? ' group-b' : ''}`, style: 'text-decoration:none;color:inherit', title: odd ? 'Differs from the first harness in this row' : '', onclick: () => go({ view: 'harness', harnessId: x.id, tab: 'behavior', scope: row.path }) },
      h('i', {}), `${LABEL[c.status]}${odd ? ' (differs)' : ''}`, c.tokens ? h('span', { class: 'muted' }, ` ~${num(c.tokens)}`) : null);
  };
  const stateTag = r => h('span', { class: `tag ${r.conflicts || r.state === 'differs' ? 'danger' : r.state === 'same' ? 'ok' : r.state === 'partial' ? 'warn' : ''}` },
    r.conflicts ? 'Needs attention' : { same: 'In sync', differs: 'Harnesses disagree', partial: 'Only some tuned', empty: 'Not tuned' }[r.state]);

  return h('div', { class: 'wrap' }, head,
    h('div', { class: 'card' }, h('div', { class: 'tablewrap' }, h('table', { class: 'matrix' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Scope'), d.harnesses.map(x => h('th', {}, x.name)), h('th', {}, ''), h('th', {}, ''))),
      h('tbody', {}, d.rows.map(r => h('tr', {},
        h('td', { title: r.path || 'Applies to every project' }, h('b', {}, r.label), r.path ? h('div', { class: 'path' }, r.path) : null),
        d.harnesses.map(x => h('td', {}, cell(r, x))),
        h('td', {}, stateTag(r)),
        h('td', {}, Object.values(r.cells).filter(c => c.status !== 'na').length > 1 ? h('button', { class: 'small', onclick: () => matchDialog(r, d.harnesses) }, 'Make them match…') : null))))))),
    h('div', { class: 'muted', style: 'font-size:12.5px' }, 'Numbers are the size of the applied block in tokens. "Edited by hand" means the file no longer matches what AgentDeck wrote; "Not tracked" means a block exists that this copy of AgentDeck did not apply.'));
}
