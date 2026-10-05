// Behavior tab: levers that compile to instructions in the harness's instruction file.
import { h, api, toast, fail, modal, confirmChanges, debounce, copyText, num, plural, field } from '../ui.js';
import { state, go, draftKey, same } from '../state.js';
import { loadDraft } from './harness.js';
import { PRESET_BLURBS, statusTag } from './overview.js';

function control(lever, value, onChange) {
  if (lever.kind === 'choice') {
    return h('div', { class: 'seg', role: 'radiogroup', 'aria-label': lever.label }, lever.options.map(o =>
      h('button', { role: 'radio', 'aria-checked': String(o.value === value), 'data-v': o.value, onclick: () => onChange(o.value) }, o.label)));
  }
  if (lever.kind === 'toggle') return h('button', { class: 'switch', role: 'switch', 'aria-checked': String(!!value), 'aria-label': lever.label, onclick: () => onChange(!value) });
  if (lever.kind === 'number') return h('input', { type: 'number', min: lever.min, max: lever.max, value: value ?? '', placeholder: lever.placeholder || 'none', 'aria-label': lever.label, style: 'max-width:140px', oninput: e => onChange(e.target.value, true) });
  if (lever.kind === 'textarea') return h('textarea', { class: 'prose', rows: 4, placeholder: lever.placeholder || '', 'aria-label': lever.label, oninput: e => onChange(e.target.value, true) }, value || '');
  return h('input', { type: 'text', value: value ?? '', placeholder: lever.placeholder || '', 'aria-label': lever.label, style: 'max-width:420px', oninput: e => onChange(e.target.value, true) });
}

function presetDialogs(d, ctx) {
  const save = () => {
    const input = h('input', { type: 'text', placeholder: 'e.g. My review mode', maxlength: 60 });
    modal('Save these levers as a preset', field('Name', input), [
      { label: 'Cancel' },
      { label: 'Save', class: 'primary', action: async () => {
        if (!input.value.trim()) throw new Error('Give the preset a name.');
        state.presets = (await api('POST', '/api/presets', { name: input.value.trim(), values: d.values })).presets;
        toast('Preset saved.'); ctx.rerender();
      } },
    ], { narrow: true });
  };
  const share = () => {
    const values = Object.fromEntries(Object.entries(d.values).filter(([k, v]) => !same(v, state.catalog.defaults[k])));
    copyText(JSON.stringify({ agentdeck: 1, name: 'Shared preset', values }, null, 2), 'Preset copied');
  };
  const importIt = () => {
    const area = h('textarea', { rows: 10, placeholder: 'Paste a preset someone shared, or the contents of an AgentDeck export file.' });
    modal('Import presets', h('div', {}, area, h('div', { class: 'muted', style: 'font-size:12.5px;margin-top:8px' }, 'Importing only adds presets to the list above. Nothing is written to a harness until you apply.')), [
      { label: 'Cancel' },
      { label: 'Import', class: 'primary', action: async () => {
        const r = await api('POST', '/api/import', { bundle: area.value });
        state.presets = r.presets; toast(`Imported ${plural(r.imported, 'preset')}.`); ctx.rerender();
      } },
    ], { guard: () => !!area.value.trim() });
  };
  const exportAll = async () => {
    try {
      const data = JSON.stringify(await api('GET', '/api/export'), null, 2);
      const a = h('a', { href: URL.createObjectURL(new Blob([data], { type: 'application/json' })), download: 'agentdeck-presets.json' });
      a.click(); URL.revokeObjectURL(a.href);
    } catch (e) { fail(e); }
  };
  return { save, share, importIt, exportAll };
}

function copyToDialog(x, values) {
  const others = state.scan.harnesses.filter(o => o.id !== x.id && (state.scope ? o.projectInstruction && o.projects.some(p => p.path === state.scope) : o.globalInstruction));
  if (!others.length) { toast(state.scope ? 'No other harness knows this project. Add it from that harness\'s Projects tab.' : 'No other harness has a global instruction file.'); return; }
  const picked = new Set(others.filter(o => o.installed).map(o => o.id));
  modal('Apply this profile to other harnesses', h('div', {},
    h('div', { class: 'muted', style: 'margin-bottom:10px' }, `Writes the same levers into each harness's own instruction file${state.scope ? ` in ${state.scope}` : ''}.`),
    h('div', { class: 'checks' }, others.map(o => h('label', {},
      h('input', { type: 'checkbox', checked: picked.has(o.id), onchange: e => (e.target.checked ? picked.add(o.id) : picked.delete(o.id)) }),
      o.name, o.installed ? null : h('span', { class: 'muted' }, '(not installed)'))))), [
    { label: 'Cancel' },
    { label: 'Review changes', class: 'primary', action: async () => {
      if (!picked.size) throw new Error('Pick at least one harness.');
      return (await confirmChanges('Apply to other harnesses', '/api/profile/preview', '/api/profile/apply', { harnesses: [x.id, ...picked], project: state.scope, values })) != null;
    } },
  ], { narrow: true });
}

async function contextCard(x) {
  const body = h('div', { class: 'muted' }, 'Loading…');
  const card = h('details', { class: 'card', ontoggle: async e => {
    if (!e.target.open || body.dataset.done) return;
    try {
      const c = await api('GET', `/api/context?harness=${x.id}&project=${encodeURIComponent(state.scope)}`);
      body.dataset.done = '1';
      body.className = '';
      body.replaceChildren(
        ...c.notes.map(n => h('div', { class: 'banner' }, n)),
        h('div', { class: 'tablewrap' }, h('table', { class: 'data' },
          h('thead', {}, h('tr', {}, ['File', 'Lines', 'Tokens'].map(t => h('th', {}, t)))),
          h('tbody', {}, c.files.map(f => h('tr', {},
            h('td', {}, h('b', {}, f.role), f.managed ? h('span', { class: 'tag accent' }, 'has AgentDeck block') : null, f.exists ? null : h('span', { class: 'tag' }, 'not created yet'), h('span', { class: 'path' }, f.path)),
            h('td', {}, f.exists ? f.lines : '–'), h('td', {}, f.exists ? '~' + num(f.tokens) : '–'))),
          h('tr', {}, h('td', {}, h('b', {}, 'Sent with every request')), h('td', {}, ''), h('td', {}, h('b', {}, '~' + num(c.tokens))))))));
    } catch (err) { body.textContent = err.message; }
  } }, h('summary', { style: 'cursor:pointer;font-weight:600' }, `What ${x.name} loads ${state.scope ? 'in this project' : 'for every project'}`), h('div', { style: 'margin-top:12px' }, body));
  return card;
}

export async function behaviorTab(x, ctx) {
  const { profile: p, draft: d } = await loadDraft(x);
  const wrap = h('div', {});
  if (!p.target) {
    wrap.append(h('div', { class: 'banner warn' }, state.scope ? `${x.name} has no per-project instruction file AgentDeck can write.` : `${x.name} has no global instruction file. Pick a project under Scope to tune it there.`),
      x.projects.some(q => q.exists) ? null : h('button', { onclick: () => go({ tab: 'projects' }) }, 'Add a project'));
    return wrap;
  }
  const payload = () => ({ harness: x.id, project: state.scope, values: d.values });
  const changedCount = () => Object.keys(d.values).filter(k => !same(d.values[k], d.baseValues[k])).length;
  const dialogs = presetDialogs(d, ctx);

  // ---- live preview with token cost
  const preview = h('pre', { class: 'preview', tabindex: '0', 'aria-label': 'Instructions that will be written' });
  const cost = h('span', {});
  let seq = 0;
  const refresh = debounce(async () => {
    const my = ++seq;
    try {
      const r = await api('POST', '/api/profile/preview', payload());
      if (my !== seq) return;
      preview.textContent = r.block || '(nothing: every lever is at its default, so no block is written)';
      cost.textContent = r.block ? `~${num(r.blockTokens)} tokens, sent with every request` : 'no tokens';
    } catch (e) { if (my === seq) preview.textContent = e.message; }
  }, 160);

  // ---- action bar
  const applyBtn = h('button', { class: 'primary', onclick: async () => {
    try { if (await confirmChanges('Apply behavior profile', '/api/profile/preview', '/api/profile/apply', payload())) delete state.drafts[draftKey()].values; } catch (e) { fail(e); }
  } });
  const discardBtn = h('button', { class: 'ghost', onclick: () => { d.values = { ...d.baseValues }; ctx.rerender(); } }, 'Discard changes');
  const paintBar = () => {
    const n = changedCount();
    const stale = ['edited', 'missing'].includes(p.status);
    applyBtn.textContent = n ? `Review and apply (${plural(n, 'change')})` : stale ? 'Re-apply the saved profile' : 'Review and apply';
    applyBtn.disabled = !n && !stale;
    discardBtn.hidden = !n;
  };

  // ---- presets
  const all = { ...state.catalog.presets, ...state.presets };
  wrap.append(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Presets'),
      h('button', { class: 'small ghost', onclick: dialogs.share, title: 'Copy the current levers as text you can send to someone' }, 'Share'),
      h('button', { class: 'small ghost', onclick: dialogs.importIt }, 'Import'),
      h('button', { class: 'small ghost', onclick: dialogs.exportAll }, 'Export all')),
    h('div', { class: 'note' }, 'A preset sets every lever at once. Adjust anything afterwards; nothing is written until you apply.'),
    h('div', { class: 'chips' },
      Object.entries(all).map(([name, vals]) => {
        const active = same(d.values, { ...state.catalog.defaults, ...vals });
        const mine = Object.prototype.hasOwnProperty.call(state.presets, name);
        return h('span', { style: 'display:inline-flex' }, h('button', { class: 'chip', title: PRESET_BLURBS[name] || 'Your preset', 'aria-pressed': String(active), style: active ? 'border-color:var(--accent);color:var(--accent);font-weight:600' : '', onclick: () => { d.values = { ...state.catalog.defaults, ...vals }; ctx.rerender(); } }, name),
          mine ? h('button', { class: 'link', style: 'margin-left:4px;text-decoration:none;color:var(--muted)', 'aria-label': `Delete preset ${name}`, onclick: async () => { if (!window.confirm(`Delete the preset "${name}"?`)) return; try { state.presets = (await api('POST', '/api/presets/delete', { name })).presets; ctx.rerender(); } catch (e) { fail(e); } } }, '✕') : null);
      }),
      h('button', { class: 'chip ghost', onclick: () => { d.values = { ...state.catalog.defaults }; ctx.rerender(); } }, 'Reset all'),
      h('button', { class: 'chip ghost', onclick: dialogs.save }, '+ Save current'))));

  // ---- status line
  const search = h('input', { type: 'search', placeholder: 'Filter levers…', 'aria-label': 'Filter levers', style: 'max-width:240px' });
  wrap.append(h('div', { class: 'actions', style: 'margin-bottom:12px' }, search, h('span', { class: 'spacer' }),
    h('span', { class: 'muted', style: 'font-size:12.5px' }, state.scope ? 'This project:' : 'Global:'), statusTag(p.status)));
  for (const msg of p.lint) wrap.append(h('div', { class: 'banner warn' }, msg));
  if (p.status === 'edited') wrap.append(h('div', { class: 'banner warn' }, 'The block in the file was changed by hand since AgentDeck applied it. Applying again replaces those manual edits (the current file is backed up first).'));
  if (p.status === 'untracked') wrap.append(h('div', { class: 'banner' }, 'This file already has an AgentDeck block, but not one applied from this machine, so the levers below start at their defaults. Applying replaces that block.'));

  // ---- levers, updated in place so keyboard focus is never lost
  const cards = [];
  for (const g of state.catalog.groups) {
    const rows = state.catalog.levers.filter(l => l.group === g.id).map(l => {
      const lbl = h('div', { class: 'lbl' });
      const cell = h('div', {});
      const row = h('div', { class: 'row', 'data-text': `${l.label} ${l.help || ''} ${(l.options || []).map(o => o.label).join(' ')}`.toLowerCase() }, lbl, cell);
      const paint = focusValue => {
        const v = d.values[l.id];
        const modified = !same(v, state.catalog.defaults[l.id]);
        lbl.replaceChildren(...[modified ? h('span', { class: 'mod', title: 'Changed from the default' }) : null, l.label, l.help ? h('div', { class: 'help' }, l.help) : null].filter(Boolean));
        const opt = (l.options || []).find(o => o.value === v);
        const canEnforce = l.enforce && x.hooks && x.hooks.recipes && modified;
        cell.replaceChildren(...[
          control(l, v, (nv, typing) => { d.values[l.id] = nv; if (typing) { paintLabelOnly(); } else paint(nv); refresh(); paintBar(); }),
          opt && opt.example ? h('div', { class: 'example' }, h('b', {}, 'Sounds like: '), opt.example) : null,
          canEnforce ? h('div', { class: 'help', style: 'margin-top:6px' }, 'This is a request, not a guarantee. ', h('button', { class: 'link', onclick: () => { state.recipeHint = l.enforce; go({ tab: 'hooks' }); } }, 'Enforce it with a hook')) : null,
        ].filter(Boolean));
        if (focusValue !== undefined) { const el = cell.querySelector(l.kind === 'choice' ? `[data-v="${CSS.escape(String(focusValue))}"]` : '.switch'); if (el) el.focus(); }
      };
      const paintLabelOnly = () => { const has = !!lbl.querySelector('.mod'); const want = !same(d.values[l.id], state.catalog.defaults[l.id]); if (has !== want) { if (want) lbl.prepend(h('span', { class: 'mod' })); else lbl.querySelector('.mod').remove(); } };
      paint();
      return row;
    });
    const card = h('div', { class: 'card' }, h('h2', {}, g.label), h('div', { class: 'note' }, g.note), rows);
    cards.push({ card, rows });
    wrap.append(card);
  }
  const noMatch = h('div', { class: 'empty', hidden: true }, 'No lever matches that filter.');
  wrap.append(noMatch);
  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    let any = false;
    for (const { card, rows } of cards) {
      let shown = 0;
      for (const r of rows) { const ok = !q || r.dataset.text.includes(q); r.classList.toggle('hide', !ok); if (ok) shown++; }
      card.hidden = !shown; any = any || shown > 0;
    }
    noMatch.hidden = any;
  });

  // ---- what gets written
  wrap.append(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, 'What will be written'), h('span', { class: 'tag accent' }, cost)),
    h('div', { class: 'note' }, 'The agent reads these instructions at the start of each session. It usually follows them; nothing forces it to (Settings and Hooks do that). Target: ', h('span', { class: 'path' }, p.target),
      p.hasOtherContent ? ` · your own ${num(p.fileTokens)}-token file is left as it is, this block is added at the end.` : ''),
    preview));
  wrap.append(await contextCard(x));
  wrap.append(h('div', { class: 'actionbar actions' }, applyBtn, h('button', { onclick: () => copyToDialog(x, d.values) }, 'Apply to other harnesses…'), discardBtn));
  paintBar();
  refresh();
  return wrap;
}
