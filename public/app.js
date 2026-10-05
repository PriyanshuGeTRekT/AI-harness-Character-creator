'use strict';

const state = {
  scan: null, catalog: null, userPresets: {},
  harnessId: null, scope: '', tab: 'behavior',
  profile: null, values: {}, native: {}, items: null, mcp: null, hooks: null,
};

const TEMPLATES = {
  skills: [
    { name: 'Blank', slug: '', description: '', body: '# Instructions\n\n' },
    { name: 'Code review checklist', slug: 'review-checklist', description: 'Review a diff against the team checklist. Use when asked to review code, a PR, or staged changes.', body: '# Code review\n\n1. Read the full diff before commenting.\n2. Check, in order: correctness, error handling, security at trust boundaries, tests, naming.\n3. Report findings most severe first, each with file:line and a concrete failure scenario.\n4. Do not comment on style the formatter already enforces.\n5. If nothing is wrong, say so in one line.\n' },
    { name: 'Commit message writer', slug: 'commit-message', description: 'Write a commit message for the staged changes. Use when asked to commit or to draft a commit message.', body: '# Commit message\n\n1. Run `git diff --staged` and read it.\n2. Subject: imperative mood, under 60 characters, no trailing period.\n3. Body: why the change was made, not a list of files. Wrap at 72 columns.\n4. Never mention things that are not in the diff.\n' },
    { name: 'Test writer', slug: 'write-tests', description: 'Write tests for a function or module. Use when asked to add tests or improve coverage.', body: '# Writing tests\n\n1. Find the existing test framework and copy its conventions; do not add a new one.\n2. Cover the main path, each branch, and the edge cases (empty, null, boundary, error).\n3. One behavior per test, named for the behavior.\n4. Run the tests and report the command and result.\n' },
    { name: 'Terse mode', slug: 'terse-mode', description: 'Switch to terse replies to save output tokens. Use when the user says "be brief", "terse mode" or "save tokens".', body: '# Terse mode\n\nAnswer first. No greetings, hedges, recaps or closing offers. Fragments are fine.\nKeep code, commands, paths, numbers and error text exact.\nUse full sentences for security warnings, destructive actions and ordered steps.\nStay in this mode until the user says "normal mode".\n' },
    { name: 'Bug investigation', slug: 'debug', description: 'Investigate a bug systematically. Use when something fails, crashes or behaves unexpectedly.', body: '# Debugging\n\n1. Reproduce the failure first and record the exact command and output.\n2. Form one hypothesis at a time and test it with the cheapest check available.\n3. Find the root cause before changing code; do not patch symptoms.\n4. After the fix, rerun the reproduction and the surrounding tests.\n' },
    { name: 'Docs writer', slug: 'write-docs', description: 'Write or update documentation for code. Use when asked for a README, docstrings or usage docs.', body: '# Documentation\n\n1. Read the code being documented; never describe behavior you have not confirmed.\n2. Start with what it does and a runnable example.\n3. Document inputs, outputs, errors and one common pitfall.\n4. Match the tone and structure of the existing docs.\n' },
  ],
  agents: [
    { name: 'Blank', slug: '', description: '', body: 'You are a specialist subagent.\n\n' },
    { name: 'Code reviewer', slug: 'code-reviewer', description: 'Reviews code changes for bugs and risky patterns. Use after writing or modifying code.', body: 'You are a senior code reviewer. Read the changed code and its callers before judging it.\n\nReport only real problems, most severe first, each with file:line and how it fails.\nDo not rewrite the code; describe the fix in one sentence.\nIf the change is fine, say so in one line.\n' },
    { name: 'Test runner', slug: 'test-runner', description: 'Runs the test suite and diagnoses failures. Use after code changes.', body: 'You run tests and diagnose failures.\n\nFind the project test command, run it, and read the full output.\nFor each failure give the test name, the assertion, and the most likely cause with file:line.\nDo not modify tests to make them pass.\n' },
    { name: 'Codebase explorer', slug: 'explorer', description: 'Finds where things live in the codebase. Use for "where is X" and "how does Y work" questions.', body: 'You are a read-only codebase explorer.\n\nSearch widely, read only what you need, and answer with file:line references.\nNever edit files. Report what you could not find as well as what you did.\n' },
    { name: 'Planner', slug: 'planner', description: 'Designs an implementation plan before any code is written. Use for multi-file or ambiguous tasks.', body: 'You are a software architect. You do not write code.\n\nRead the relevant code, then produce a numbered plan: files to change, the change in each, risks, and how to verify.\nName the trade-off behind every non-obvious decision.\n' },
    { name: 'Security auditor', slug: 'security-auditor', description: 'Audits changes for security problems. Use before merging code that handles input, auth, files or network.', body: 'You are a security reviewer.\n\nCheck input validation at trust boundaries, injection, authn/authz, secrets in code, unsafe file and network access, and dependency risk.\nReport each finding with file:line, impact, and a fix. Ignore theoretical issues with no realistic attacker.\n' },
  ],
  commands: [
    { name: 'Blank', slug: '', description: '', body: '' },
    { name: 'Explain this', slug: 'explain', description: 'Explain the selected code or file', body: 'Explain what this code does, why it is written this way, and anything surprising about it. Be brief.\n' },
    { name: 'Fix failing tests', slug: 'fix-tests', description: 'Run the tests and fix failures', body: 'Run the test suite. For each failure, find the root cause and fix the code (not the test) unless the test is wrong. Rerun until green and report the result.\n' },
  ],
};

// ---- helpers ----------------------------------------------------------------

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-AgentDeck-Token': window.AGENTDECK_TOKEN },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(msg, isError) {
  const el = h('div', { class: 'toast' + (isError ? ' err' : '') }, msg);
  document.getElementById('toast-root').append(el);
  setTimeout(() => el.remove(), isError ? 6000 : 3000);
}

const fail = err => toast(err.message, true);

function modal(title, body, buttons) {
  const root = document.getElementById('modal-root');
  const close = () => root.replaceChildren();
  const foot = h('div', { class: 'modal-foot' }, (buttons || []).map(b =>
    h('button', { class: b.class || '', onclick: async () => { if (!b.action || (await b.action()) !== false) close(); } }, b.label)));
  const back = h('div', { class: 'modal-back', onmousedown: e => { if (e.target === back) close(); } },
    h('div', { class: 'modal' }, h('div', { class: 'modal-head' }, title), h('div', { class: 'modal-body' }, body), foot));
  root.replaceChildren(back);
  return close;
}

function lineDiff(before, after) {
  let a = before ? before.split('\n') : [], b = after ? after.split('\n') : [];
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
    else if (j < n && (i === m || lcs[i][j + 1] >= lcs[i + 1][j])) { out.push(['+', b[j]]); j++; }
    else { out.push(['-', a[i]]); i++; }
  }
  return out.concat(end);
}

function diffView(before, after) {
  const rows = lineDiff(before || '', after || '');
  const keep = new Set();
  rows.forEach((r, idx) => { if (r[0] !== ' ') for (let k = idx - 2; k <= idx + 2; k++) keep.add(k); });
  const box = h('div', { class: 'diff' });
  let skipped = false;
  rows.forEach((r, idx) => {
    if (!keep.has(idx)) { if (!skipped) box.append(h('div', { class: 'gap' }, '…')); skipped = true; return; }
    skipped = false;
    box.append(h('div', { class: r[0] === '+' ? 'add' : r[0] === '-' ? 'del' : '' }, `${r[0]} ${r[1]}`));
  });
  return box;
}

// Every write is previewed as a diff first, then applied on confirmation.
async function confirmChanges(title, previewUrl, applyUrl, payload, after) {
  let plan;
  try { plan = await api('POST', previewUrl, payload); } catch (e) { return fail(e); }
  const changes = (plan.changes || []).filter(c => c.before !== c.after);
  if (!changes.length) return toast('Nothing to change.');
  const body = h('div', {},
    (plan.warnings || []).map(w => h('div', { class: 'banner warn' }, w)),
    changes.map(c => h('div', {},
      h('div', {}, h('b', {}, c.removed ? 'Delete ' : c.before == null ? 'Create ' : 'Update '), h('span', { class: 'path' }, c.path)),
      c.removed ? h('div', { class: 'muted', style: 'margin:6px 0 16px' }, 'A copy is kept in Backups.') : diffView(c.before, c.after))));
  modal(title, body, [
    { label: 'Cancel' },
    { label: `Apply ${changes.length} change${changes.length > 1 ? 's' : ''}`, class: 'primary', action: async () => {
      try { await api('POST', applyUrl, payload); toast('Applied. Previous versions are in Backups.'); if (after) await after(); }
      catch (e) { fail(e); return false; }
    } },
  ]);
}

const harness = () => state.scan.harnesses.find(x => x.id === state.harnessId);
const baseName = p => p.split(/[\\/]/).filter(Boolean).pop() || p;

// ---- sidebar ----------------------------------------------------------------

function renderSidebar() {
  const list = document.getElementById('harness-list');
  const on = state.scan.harnesses.filter(x => x.installed), off = state.scan.harnesses.filter(x => !x.installed);
  const btn = x => h('button', { class: `harness${x.id === state.harnessId ? ' active' : ''}${x.installed ? '' : ' off'}`, onclick: () => selectHarness(x.id) },
    h('span', { class: 'dot' + (x.installed ? ' on' : '') }),
    h('span', { class: 'h-name' }, x.name),
    x.projects.length ? h('span', { class: 'h-count' }, `${x.projects.length} proj`) : null);
  list.replaceChildren(...[
    h('div', { class: 'side-label' }, `Detected (${on.length})`), on.map(btn),
    on.length ? null : h('div', { class: 'muted', style: 'padding:4px 8px' }, 'None found.'),
    h('div', { class: 'side-label' }, `Not installed (${off.length})`), off.map(btn)].flat().filter(Boolean));
}

async function selectHarness(id) {
  state.harnessId = id;
  state.scope = '';
  if (!tabsFor(harness()).some(t => t.id === state.tab)) state.tab = 'behavior';
  renderSidebar();
  await loadTab();
}

// ---- main -------------------------------------------------------------------

function tabsFor(x) {
  const tabs = [{ id: 'behavior', label: 'Behavior' }];
  if (x.hasNative) tabs.push({ id: 'native', label: 'Native settings' });
  for (const k of x.itemKinds) tabs.push({ id: k.type, label: k.label });
  if (x.mcp) tabs.push({ id: 'mcp', label: 'MCP servers' });
  if (x.hooks) tabs.push({ id: 'hooks', label: 'Hooks' });
  tabs.push({ id: 'projects', label: `Projects (${x.projects.length})` }, { id: 'files', label: 'Files' });
  return tabs;
}

async function loadTab() {
  const x = harness();
  const q = `harness=${encodeURIComponent(x.id)}&project=${encodeURIComponent(state.scope)}`;
  try {
    if (state.tab === 'behavior' || state.tab === 'native') {
      state.profile = await api('GET', `/api/profile?${q}`);
      state.values = { ...state.catalog.defaults, ...state.profile.values };
      state.native = Object.fromEntries(state.profile.native.map(n => [n.key, n.value ?? '']));
    } else if (state.tab === 'mcp') {
      state.mcp = await api('GET', `/api/mcp?${q}`);
    } else if (state.tab === 'hooks') {
      state.hooks = await api('GET', `/api/hooks?${q}`);
    } else if (x.itemKinds.some(k => k.type === state.tab)) {
      state.items = await api('GET', `/api/items?${q}`);
    }
  } catch (e) { fail(e); }
  renderMain();
}

function renderMain() {
  const x = harness();
  const main = document.getElementById('main');
  const scopeSel = h('select', { onchange: e => { state.scope = e.target.value; loadTab(); } },
    h('option', { value: '' }, 'Global (all projects)'),
    x.projects.filter(p => p.exists).map(p => h('option', { value: p.path, selected: p.path === state.scope }, `${p.name}  ·  ${p.path}`)));
  const head = h('div', { class: 'head' },
    h('div', { class: 'grow' },
      h('h1', {}, x.name),
      h('div', { class: 'sub' }, x.installed ? `Detected: ${x.evidence.join(' · ')}` : 'Not installed on this machine. You can still prepare its files; they take effect once it is installed.')),
    h('label', { class: 'scope' }, 'Scope', scopeSel));
  const note = x.note ? h('div', { class: 'banner' }, x.note) : null;
  const tabs = h('div', { class: 'tabs' }, tabsFor(x).map(t =>
    h('button', { class: 'tab' + (t.id === state.tab ? ' active' : ''), onclick: () => { state.tab = t.id; loadTab(); } }, t.label)));
  const body = state.tab === 'behavior' ? behaviorTab(x)
    : state.tab === 'native' ? nativeTab(x)
    : state.tab === 'projects' ? projectsTab(x)
    : state.tab === 'files' ? filesTab(x)
    : state.tab === 'mcp' ? mcpTab(x)
    : state.tab === 'hooks' ? hooksTab(x)
    : itemsTab(x, x.itemKinds.find(k => k.type === state.tab));
  main.replaceChildren(...[head, note, tabs, body].filter(Boolean));
}

// ---- behavior tab -----------------------------------------------------------

function control(lever, value, onChange) {
  if (lever.kind === 'choice' || lever.kind === 'select') {
    if (lever.options.length > 6) return h('select', { onchange: e => onChange(e.target.value) },
      lever.options.map(o => h('option', { value: o.value, selected: o.value === value }, o.label)));
    return h('div', { class: 'seg' }, lever.options.map(o =>
      h('button', { class: o.value === value ? 'on' : '', title: o.danger ? 'Removes safety checks' : '', onclick: () => onChange(o.value) }, o.label)));
  }
  if (lever.kind === 'toggle') return h('button', { class: 'switch' + (value ? ' on' : ''), role: 'switch', 'aria-checked': String(!!value), 'aria-label': lever.label, onclick: () => onChange(!value) });
  if (lever.kind === 'number') return h('input', { type: 'number', min: lever.min, max: lever.max, value: value ?? '', placeholder: lever.placeholder || '', style: 'max-width:140px', oninput: e => onChange(e.target.value, true) });
  if (lever.kind === 'textarea') return h('textarea', { rows: 5, placeholder: lever.placeholder || '', oninput: e => onChange(e.target.value, true) }, value || '');
  return h('input', { type: 'text', value: value ?? '', placeholder: lever.placeholder || '', oninput: e => onChange(e.target.value, true) });
}

function behaviorTab(x) {
  const p = state.profile;
  if (!p) return h('div', { class: 'empty' }, 'Could not load.');
  const wrap = h('div', {});
  if (!p.target) {
    wrap.append(h('div', { class: 'banner warn' }, state.scope ? 'This harness has no per-project instruction file AgentDeck can write.' : 'This harness has no global instruction file. Pick a project in Scope to tune it per project.'));
    return wrap;
  }
  const preview = h('pre', { class: 'preview' });
  const refresh = async () => {
    try { preview.textContent = (await api('POST', '/api/profile/preview', payload())).block || '(no instructions: every lever is at its default)'; } catch (e) { preview.textContent = e.message; }
  };
  const payload = () => ({ harness: x.id, project: state.scope, values: state.values });
  const set = (id, v, keepFocus) => { state.values[id] = v; if (keepFocus) refresh(); else renderMain(); };

  const allPresets = { ...state.catalog.presets, ...state.userPresets };
  wrap.append(h('div', { class: 'card' },
    h('h2', {}, 'Presets'),
    h('div', { class: 'note' }, 'A preset resets every lever, then sets its own. Adjust anything afterwards.'),
    h('div', { class: 'chips' },
      Object.entries(allPresets).map(([name, vals]) => h('button', { class: 'chip', onclick: () => { state.values = { ...state.catalog.defaults, ...vals }; renderMain(); } }, name)),
      h('button', { class: 'chip ghost', onclick: () => { state.values = { ...state.catalog.defaults }; renderMain(); } }, 'Reset all'),
      h('button', { class: 'chip ghost', onclick: savePresetDialog }, '+ Save current as preset'))));

  for (const g of state.catalog.groups) {
    const levers = state.catalog.levers.filter(l => l.group === g.id);
    wrap.append(h('div', { class: 'card' }, h('h2', {}, g.label), h('div', { class: 'note' }, g.note),
      levers.map(l => h('div', { class: 'row' },
        h('div', { class: 'lbl' }, l.label, l.help ? h('div', { class: 'help' }, l.help) : null),
        h('div', {}, control(l, state.values[l.id], (v, keep) => set(l.id, v, keep)))))));
  }

  wrap.append(h('div', { class: 'card' },
    h('h2', {}, 'What will be written'),
    h('div', { class: 'note' }, 'These are instructions the agent reads at the start of each session. It usually follows them; nothing forces it to. Enforced settings are under Native settings. Target: ', h('span', { class: 'path' }, p.target),
      p.hasOtherContent ? ' (your existing content in this file is left untouched)' : ''),
    preview));
  wrap.append(h('div', { class: 'actionbar actions' },
    h('button', { class: 'primary', onclick: () => confirmChanges('Apply behavior profile', '/api/profile/preview', '/api/profile/apply', payload(), loadTab) }, 'Review and apply'),
    h('button', { onclick: copyToDialog }, 'Copy this profile to other harnesses…')));
  refresh();
  return wrap;
}

function savePresetDialog() {
  const input = h('input', { type: 'text', placeholder: 'Preset name' });
  modal('Save preset', h('label', { class: 'field' }, h('span', {}, 'Name'), input), [
    { label: 'Cancel' },
    { label: 'Save', class: 'primary', action: async () => {
      const name = input.value.trim();
      if (!name) return false;
      try { state.userPresets = (await api('POST', '/api/presets', { name, values: state.values })).presets; renderMain(); } catch (e) { fail(e); return false; }
    } },
  ]);
}

function copyToDialog() {
  const others = state.scan.harnesses.filter(x => x.id !== state.harnessId && (state.scope ? x.projectInstruction : x.globalInstruction));
  const picked = new Set(others.filter(x => x.installed).map(x => x.id));
  const body = h('div', {},
    h('div', { class: 'note muted', style: 'margin-bottom:10px' }, state.scope ? `Writes the same levers into each harness's instruction file in ${state.scope}.` : `Writes the same levers into each harness's global instruction file.`),
    h('div', { class: 'checks' }, others.map(x => h('label', {},
      h('input', { type: 'checkbox', checked: picked.has(x.id), onchange: e => e.target.checked ? picked.add(x.id) : picked.delete(x.id) }),
      x.name, x.installed ? null : h('span', { class: 'muted' }, '(not installed)')))));
  modal('Copy profile to other harnesses', body, [
    { label: 'Cancel' },
    { label: 'Review', class: 'primary', action: () => {
      if (!picked.size) return false;
      setTimeout(() => confirmChanges('Copy behavior profile', '/api/profile/preview', '/api/profile/apply',
        { harnesses: [...picked], project: state.scope, values: state.values }, null), 0);
    } },
  ]);
}

// ---- native settings tab ----------------------------------------------------

function nativeTab(x) {
  const p = state.profile;
  if (!p || !p.native.length) return h('div', { class: 'empty' }, state.scope ? 'No per-project native settings for this harness. Switch Scope to Global.' : 'No native settings available.');
  const payload = () => ({ harness: x.id, project: state.scope, native: state.native });
  const files = [...new Set(p.native.map(n => n.file))];
  return h('div', {},
    h('div', { class: 'banner' }, 'These are real settings the harness enforces, written to its own config file. Empty means "leave the harness default".'),
    files.map(file => h('div', { class: 'card' },
      h('h2', {}, baseName(file)), h('div', { class: 'note path' }, file),
      p.native.filter(n => n.file === file).map(n => h('div', { class: 'row' },
        h('div', { class: 'lbl' }, n.label, h('span', { class: 'tag hard' }, 'enforced'), n.danger ? h('span', { class: 'tag danger' }, 'has unsafe options') : null,
          h('div', { class: 'help mono' }, n.key), n.help ? h('div', { class: 'help' }, n.help) : null),
        h('div', {}, nativeControl(n)))))),
    h('div', { class: 'actionbar actions' },
      h('button', { class: 'primary', onclick: () => confirmChanges('Apply native settings', '/api/profile/preview', '/api/profile/apply', payload(), loadTab) }, 'Review and apply')));
}

function nativeControl(n) {
  const set = v => { state.native[n.key] = v; };
  const value = state.native[n.key];
  if (n.kind === 'select') return h('select', { onchange: e => set(e.target.value) },
    h('option', { value: '' }, '(harness default)'),
    n.options.map(o => h('option', { value: o.value, selected: String(o.value) === String(value) }, o.label + (o.danger ? '  ⚠ unsafe' : ''))),
    value !== '' && !n.options.some(o => String(o.value) === String(value)) ? h('option', { value, selected: true }, `${value} (current)`) : null);
  if (n.kind === 'toggle') return h('select', { onchange: e => set(e.target.value === '' ? '' : e.target.value === 'true') },
    [['', '(harness default)'], ['true', 'On'], ['false', 'Off']].map(([v, l]) => h('option', { value: v, selected: String(value) === v }, l)));
  return h('input', { type: n.kind === 'number' ? 'number' : 'text', value: value ?? '', placeholder: n.placeholder || '(harness default)', style: 'max-width:340px',
    oninput: e => set(n.kind === 'number' && e.target.value !== '' ? Number(e.target.value) : e.target.value) });
}

// ---- agents / skills / commands tabs ----------------------------------------

function itemsTab(x, kind) {
  const items = (state.items && state.items[kind.type]) || [];
  const wrap = h('div', {});
  wrap.append(h('div', { class: 'actions', style: 'margin-bottom:14px' },
    h('button', { class: 'primary', onclick: () => itemDialog(x, kind, null) }, `+ New ${kind.noun}`),
    h('span', { class: 'muted' }, kind.note || '')));
  if (!items.length) wrap.append(h('div', { class: 'empty' }, `No ${kind.label.toLowerCase()} found for this scope.`));
  wrap.append(h('div', { class: 'list' }, items.map(it => h('div', { class: 'item' },
    h('div', { class: 'i-main' },
      h('div', { class: 'i-name' }, it.name, h('span', { class: 'tag' }, it.scope), it.readOnly ? h('span', { class: 'tag' }, it.source || 'read-only') : null),
      h('div', { class: 'i-desc' }, it.description || ''),
      h('div', { class: 'path' }, it.path)),
    it.readOnly ? null : h('div', { class: 'actions' },
      h('button', { class: 'small', onclick: () => itemDialog(x, kind, it) }, 'Edit'),
      h('button', { class: 'small danger', onclick: () => confirmChanges(`Delete ${kind.noun}`, '/api/items/preview', '/api/items/delete', { path: it.path, remove: true }, loadTab) }, 'Delete'))))));
  return wrap;
}

function itemDialog(x, kind, existing) {
  const d = existing ? { name: existing.name, description: existing.description || '', body: existing.body || '', fields: { ...existing.fields } } : { name: '', description: '', body: TEMPLATES[kind.type][0].body, fields: {} };
  let scope = existing ? existing.scope : (state.scope ? 'project' : 'global');
  const attach = new Set([x.id]);
  const others = existing ? [] : state.scan.harnesses.filter(o => o.id !== x.id && o.itemKinds.some(k => k.type === kind.type));

  const nameIn = h('input', { type: 'text', value: d.name, placeholder: 'lowercase-with-dashes', disabled: !!existing, oninput: e => { d.name = e.target.value; } });
  const descIn = h('input', { type: 'text', value: d.description, placeholder: 'What it does and when the agent should use it', oninput: e => { d.description = e.target.value; } });
  const bodyIn = h('textarea', { rows: 12, oninput: e => { d.body = e.target.value; } }, d.body);
  const tplSel = existing ? null : h('select', { onchange: e => {
    const t = TEMPLATES[kind.type][Number(e.target.value)];
    d.name = nameIn.value = t.slug; d.description = descIn.value = t.description; d.body = bodyIn.value = t.body;
  } }, TEMPLATES[kind.type].map((t, i) => h('option', { value: i }, t.name)));

  const body = h('div', {},
    tplSel ? h('label', { class: 'field' }, h('span', {}, 'Start from template'), tplSel) : null,
    h('div', { class: 'grid2' },
      h('label', { class: 'field' }, h('span', {}, 'Name'), nameIn),
      existing ? h('div', {}) : h('label', { class: 'field' }, h('span', {}, 'Scope'),
        h('select', { onchange: e => { scope = e.target.value; } },
          h('option', { value: 'global', selected: scope === 'global' }, 'Global (all projects)'),
          state.scope ? h('option', { value: 'project', selected: scope === 'project' }, `Project: ${baseName(state.scope)}`) : null))),
    h('label', { class: 'field' }, h('span', {}, 'Description'), descIn, h('small', {}, 'The agent decides when to use this from the description, so say when it applies.')),
    kind.fields.length ? h('div', { class: 'grid2' }, kind.fields.map(f => h('label', { class: 'field' }, h('span', {}, f.label),
      f.options
        ? h('select', { onchange: e => { d.fields[f.key] = e.target.value; } }, h('option', { value: '' }, '(default)'), f.options.map(o => h('option', { value: o, selected: d.fields[f.key] === o }, o)))
        : h('input', { type: 'text', value: Array.isArray(d.fields[f.key]) ? d.fields[f.key].join(', ') : (d.fields[f.key] || ''), placeholder: f.placeholder || '', oninput: e => { d.fields[f.key] = e.target.value; } }),
      f.help ? h('small', {}, f.help) : null))) : null,
    h('label', { class: 'field' }, h('span', {}, kind.type === 'agents' ? 'System prompt' : 'Instructions'), bodyIn),
    others.length ? h('div', { class: 'field' }, h('span', {}, 'Also attach to'),
      h('div', { class: 'checks' }, others.map(o => h('label', {},
        h('input', { type: 'checkbox', onchange: e => e.target.checked ? attach.add(o.id) : attach.delete(o.id) }), o.name,
        o.installed ? null : h('span', { class: 'muted' }, '(not installed)')))),
      h('small', {}, 'Each harness gets the file in its own location and format. Harness-specific fields are only written where they apply.')) : null);

  modal(existing ? `Edit ${kind.noun}: ${existing.name}` : `New ${kind.noun}`, body, [
    { label: 'Cancel' },
    { label: 'Review', class: 'primary', action: () => {
      if (!d.name.trim()) { toast('Give it a name.', true); return false; }
      const payload = { type: kind.type, harnesses: [...attach], scope, project: scope === 'project' ? state.scope : '', path: existing ? existing.path : '', ...d };
      setTimeout(() => confirmChanges(existing ? `Update ${kind.noun}` : `Create ${kind.noun}`, '/api/items/preview', '/api/items', payload, loadTab), 0);
    } },
  ]);
}

// ---- projects tab -----------------------------------------------------------

function projectsTab(x) {
  const input = h('input', { type: 'text', placeholder: 'Full folder path, e.g. C:\\code\\my-app' });
  const add = async () => {
    try { await api('POST', '/api/projects/add', { harness: x.id, path: input.value }); await boot(true); toast('Project added.'); } catch (e) { fail(e); }
  };
  const adder = h('div', { class: 'card' },
    h('h2', {}, 'Add a project folder'),
    h('div', { class: 'note' }, x.projects.length ? 'For folders this harness has not recorded yet.' : (x.installed ? 'This harness has not recorded any projects AgentDeck can read. Add the folders you use it in.' : 'Not installed, but you can still prepare a project for it.')),
    h('div', { class: 'actions' }, h('div', { style: 'flex:1;min-width:260px' }, input), h('button', { class: 'primary', onclick: add }, 'Add')));
  return h('div', {}, adder, h('div', { class: 'list' }, x.projects.map(p => h('div', { class: 'item' },
    h('div', { class: 'i-main' },
      h('div', { class: 'i-name' }, p.name, p.exists ? null : h('span', { class: 'tag danger' }, 'folder missing'),
        p.manual ? h('span', { class: 'tag' }, 'added by you') : null,
        p.hasInstructions ? h('span', { class: 'tag' }, 'has instruction file') : null, p.tuned ? h('span', { class: 'tag hard' }, 'tuned') : null),
      h('div', { class: 'path' }, p.path),
      h('div', { class: 'i-desc' }, [p.sessions ? `${p.sessions} session${p.sessions > 1 ? 's' : ''}` : null, p.lastUsed ? `last used ${new Date(p.lastUsed).toLocaleDateString()}` : null].filter(Boolean).join(' · '))),
    h('div', { class: 'actions' },
      p.exists ? h('button', { class: 'small', onclick: () => { state.scope = p.path; state.tab = 'behavior'; loadTab(); } }, 'Tune this project') : null,
      p.manual ? h('button', { class: 'small danger', onclick: async () => {
        try { await api('POST', '/api/projects/remove', { harness: x.id, path: p.path }); if (state.scope === p.path) state.scope = ''; await boot(true); } catch (e) { fail(e); }
      } }, 'Remove from list') : null)))));
}

// ---- MCP servers tab --------------------------------------------------------

const MCP_TEMPLATES = [
  { label: 'Blank', name: '', transport: 'stdio', command: '', args: '' },
  { label: 'Filesystem (folder access)', name: 'filesystem', transport: 'stdio', command: 'npx', args: '-y\n@modelcontextprotocol/server-filesystem\nC:\\path\\to\\folder' },
  { label: 'Memory (knowledge graph)', name: 'memory', transport: 'stdio', command: 'npx', args: '-y\n@modelcontextprotocol/server-memory' },
  { label: 'Playwright (browser control)', name: 'playwright', transport: 'stdio', command: 'npx', args: '-y\n@playwright/mcp@latest' },
  { label: 'Context7 (library docs)', name: 'context7', transport: 'stdio', command: 'npx', args: '-y\n@upstash/context7-mcp' },
  { label: 'Fetch (web pages)', name: 'fetch', transport: 'stdio', command: 'uvx', args: 'mcp-server-fetch' },
  { label: 'Remote server (URL)', name: '', transport: 'http', url: 'https://' },
];

const pairsToText = (obj, sep) => Object.entries(obj || {}).map(([k, v]) => `${k}${sep}${v}`).join('\n');
function textToPairs(text, sep) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const at = line.indexOf(sep);
    if (at > 0) out[line.slice(0, at).trim()] = line.slice(at + sep.length).trim();
  }
  return out;
}

function mcpTab(x) {
  const data = state.mcp;
  if (!data) return h('div', { class: 'empty' }, 'Could not load.');
  const wrap = h('div', {},
    h('div', { class: 'banner' }, 'MCP servers give the agent extra tools (browsers, databases, docs). Every enabled server also adds its tool list to each request, so fewer servers means fewer input tokens.'),
    h('div', { class: 'actions', style: 'margin-bottom:14px' }, h('button', { class: 'primary', onclick: () => mcpDialog(x, null, null) }, '+ Add server')));
  for (const sc of data.scopes) {
    wrap.append(h('div', { class: 'card' },
      h('h2', {}, sc.scope === 'global' ? 'Global' : `Project: ${baseName(state.scope)}`), h('div', { class: 'note path' }, sc.file),
      sc.error ? h('div', { class: 'banner warn' }, sc.error) : null,
      sc.servers.length ? h('div', { class: 'list' }, sc.servers.map(sv => h('div', { class: 'item' },
        h('div', { class: 'i-main' },
          h('div', { class: 'i-name' }, sv.name, h('span', { class: 'tag' }, sv.transport === 'http' ? 'remote' : 'local'), sv.disabled ? h('span', { class: 'tag danger' }, 'disabled') : null),
          h('div', { class: 'path' }, sv.transport === 'http' ? sv.url : [sv.command, ...sv.args].join(' ')),
          Object.keys(sv.env).length ? h('div', { class: 'i-desc' }, `env: ${Object.keys(sv.env).join(', ')}`) : null),
        h('div', { class: 'actions' },
          h('button', { class: 'small', onclick: () => mcpDialog(x, sv, sc.scope) }, 'Edit'),
          h('button', { class: 'small danger', onclick: () => confirmChanges('Remove MCP server', '/api/mcp/preview', '/api/mcp',
            { harness: x.id, project: state.scope, scope: sc.scope, name: sv.name, remove: true }, loadTab) }, 'Remove')))))
        : (sc.error ? null : h('div', { class: 'muted' }, 'No servers here.'))));
  }
  return wrap;
}

function mcpDialog(x, existing, existingScope) {
  const d = existing ? { ...existing, args: existing.args.join('\n'), env: pairsToText(existing.env, '='), headers: pairsToText(existing.headers, ': ') }
    : { name: '', transport: 'stdio', command: '', args: '', env: '', url: '', headers: '' };
  let scope = existingScope || (state.scope && x.mcp.project ? 'project' : 'global');
  const attach = new Set([x.id]);
  const others = existing ? [] : state.scan.harnesses.filter(o => o.id !== x.id && o.mcp);
  const body = h('div', {});
  const field = (label, el, small) => h('label', { class: 'field' }, h('span', {}, label), el, small ? h('small', {}, small) : null);
  const draw = () => {
    const stdio = d.transport !== 'http';
    body.replaceChildren(...[
      existing ? null : field('Start from template', h('select', { onchange: e => {
        const t = MCP_TEMPLATES[Number(e.target.value)];
        Object.assign(d, { command: '', args: '', url: '' }, t); draw();
      } }, MCP_TEMPLATES.map((t, i) => h('option', { value: i }, t.label)))),
      h('div', { class: 'grid2' },
        field('Name', h('input', { type: 'text', value: d.name, disabled: !!existing, placeholder: 'letters, digits, dashes', oninput: e => { d.name = e.target.value; } })),
        field('Type', h('select', { onchange: e => { d.transport = e.target.value; draw(); } },
          h('option', { value: 'stdio', selected: stdio }, 'Local command'), h('option', { value: 'http', selected: !stdio }, 'Remote URL')))),
      stdio ? field('Command', h('input', { type: 'text', value: d.command, placeholder: 'npx', oninput: e => { d.command = e.target.value; } })) : null,
      stdio ? field('Arguments', h('textarea', { rows: 4, oninput: e => { d.args = e.target.value; } }, d.args), 'One per line.') : null,
      stdio ? field('Environment variables', h('textarea', { rows: 3, placeholder: 'API_KEY=...', oninput: e => { d.env = e.target.value; } }, d.env), 'One KEY=value per line. Stored in plain text in the harness config.') : null,
      stdio ? null : field('URL', h('input', { type: 'text', value: d.url, placeholder: 'https://example.com/mcp', oninput: e => { d.url = e.target.value; } })),
      stdio ? null : field('Headers', h('textarea', { rows: 3, placeholder: 'Authorization: Bearer ...', oninput: e => { d.headers = e.target.value; } }, d.headers), 'One "Name: value" per line.'),
      existing ? null : field('Scope', h('select', { onchange: e => { scope = e.target.value; } },
        h('option', { value: 'global', selected: scope === 'global' }, 'Global (all projects)'),
        state.scope && x.mcp.project ? h('option', { value: 'project', selected: scope === 'project' }, `Project: ${baseName(state.scope)}`) : null)),
      others.length ? h('div', { class: 'field' }, h('span', {}, 'Also add to'),
        h('div', { class: 'checks' }, others.map(o => h('label', {},
          h('input', { type: 'checkbox', checked: attach.has(o.id), onchange: e => (e.target.checked ? attach.add(o.id) : attach.delete(o.id)) }), o.name,
          o.installed ? null : h('span', { class: 'muted' }, '(not installed)')))),
        h('small', {}, 'Each harness gets the server in its own config format.')) : null,
    ].filter(Boolean));
  };
  draw();
  modal(existing ? `Edit MCP server: ${existing.name}` : 'Add MCP server', body, [
    { label: 'Cancel' },
    { label: 'Review', class: 'primary', action: () => {
      const server = { transport: d.transport, command: d.command.trim(), args: d.args.split('\n').map(s => s.trim()).filter(Boolean),
        env: textToPairs(d.env, '='), url: (d.url || '').trim(), headers: textToPairs(d.headers, ':') };
      const payload = { harnesses: [...attach], project: scope === 'project' ? state.scope : '', scope, name: d.name.trim(), server };
      setTimeout(() => confirmChanges(existing ? 'Update MCP server' : 'Add MCP server', '/api/mcp/preview', '/api/mcp', payload, loadTab), 0);
    } },
  ]);
}

// ---- hooks tab --------------------------------------------------------------

const HOOK_TEMPLATES = [
  { label: 'Blank', event: '', matcher: '', command: '', timeout: '' },
  { label: 'Run tests before the agent may finish', event: 'Stop', matcher: '', command: 'npm test 1>&2 || exit 2', timeout: 300,
    note: 'Exit code 2 stops the agent from finishing and shows it the test output. Replace "npm test" with your test command.' },
  { label: 'Format files after every edit', event: 'PostToolUse', matcher: 'Edit|Write', command: "jq -r '.tool_input.file_path' | xargs npx prettier --write", timeout: 30,
    note: 'Needs jq and prettier installed.' },
  { label: 'Log every shell command', event: 'PreToolUse', matcher: 'Bash', command: "jq -r '.tool_input.command' >> ~/agent-commands.log", timeout: 5, note: 'Needs jq installed.' },
];

function hooksTab(x) {
  const data = state.hooks;
  if (!data) return h('div', { class: 'empty' }, 'Could not load.');
  const wrap = h('div', {},
    h('div', { class: 'banner' }, 'Hooks are shell commands the harness itself runs at fixed points. Unlike Behavior levers they are enforced: use them for anything that must happen every time, such as running tests before the agent stops.'),
    h('div', { class: 'actions', style: 'margin-bottom:14px' }, h('button', { class: 'primary', onclick: () => hookDialog(x, data, null, null) }, '+ Add hook')));
  for (const sc of data.scopes) {
    wrap.append(h('div', { class: 'card' },
      h('h2', {}, sc.scope === 'global' ? 'Global' : `Project: ${baseName(state.scope)}`), h('div', { class: 'note path' }, sc.file),
      sc.error ? h('div', { class: 'banner warn' }, sc.error) : null,
      sc.hooks.length ? h('div', { class: 'list' }, sc.hooks.map(hk => h('div', { class: 'item' },
        h('div', { class: 'i-main' },
          h('div', { class: 'i-name' }, hk.event, hk.matcher ? h('span', { class: 'tag' }, `matches ${hk.matcher}`) : null, hk.editable ? null : h('span', { class: 'tag' }, hk.type)),
          h('div', { class: 'path' }, hk.command)),
        h('div', { class: 'actions' },
          hk.editable ? h('button', { class: 'small', onclick: () => hookDialog(x, data, hk, sc.scope) }, 'Edit') : null,
          h('button', { class: 'small danger', onclick: () => confirmChanges('Remove hook', '/api/hooks/preview', '/api/hooks',
            { harness: x.id, project: state.scope, scope: sc.scope, id: hk.id, remove: true }, loadTab) }, 'Remove')))))
        : (sc.error ? null : h('div', { class: 'muted' }, 'No hooks here.'))));
  }
  return wrap;
}

function hookDialog(x, data, existing, existingScope) {
  const d = existing ? { event: existing.event, matcher: existing.matcher, command: existing.command, timeout: existing.timeout } : { event: data.events[0], matcher: '', command: '', timeout: '' };
  let scope = existingScope || (state.scope && x.hooks.project ? 'project' : 'global');
  const body = h('div', {});
  const field = (label, el, small) => h('label', { class: 'field' }, h('span', {}, label), el, small ? h('small', {}, small) : null);
  let note = '';
  const draw = () => body.replaceChildren(...[
    existing ? null : field('Start from template', h('select', { onchange: e => {
      const t = HOOK_TEMPLATES[Number(e.target.value)];
      Object.assign(d, { matcher: t.matcher, command: t.command, timeout: t.timeout }, data.events.includes(t.event) ? { event: t.event } : {});
      note = t.note || ''; draw();
    } }, HOOK_TEMPLATES.map((t, i) => h('option', { value: i }, t.label))), 'Templates use Claude Code event names; other harnesses may name the event differently.'),
    note ? h('div', { class: 'banner' }, note) : null,
    h('div', { class: 'grid2' },
      field('When (event)', h('select', { onchange: e => { d.event = e.target.value; } }, data.events.map(ev => h('option', { value: ev, selected: ev === d.event }, ev)))),
      field('Only for tools matching', h('input', { type: 'text', value: d.matcher, placeholder: 'e.g. Bash or Edit|Write (empty = all)', oninput: e => { d.matcher = e.target.value; } }))),
    field('Command', h('textarea', { rows: 4, oninput: e => { d.command = e.target.value; } }, d.command), 'Receives the event as JSON on standard input.'),
    h('div', { class: 'grid2' },
      field('Timeout (seconds)', h('input', { type: 'number', value: d.timeout, placeholder: '(default)', oninput: e => { d.timeout = e.target.value; } })),
      existing ? h('div', {}) : field('Scope', h('select', { onchange: e => { scope = e.target.value; } },
        h('option', { value: 'global', selected: scope === 'global' }, 'Global (all projects)'),
        state.scope && x.hooks.project ? h('option', { value: 'project', selected: scope === 'project' }, `Project: ${baseName(state.scope)}`) : null))),
  ].filter(Boolean));
  draw();
  modal(existing ? 'Edit hook' : 'Add hook', body, [
    { label: 'Cancel' },
    { label: 'Review', class: 'primary', action: () => {
      const payload = { harness: x.id, project: state.scope, scope, id: existing ? existing.id : '', hook: d };
      setTimeout(() => confirmChanges(existing ? 'Update hook' : 'Add hook', '/api/hooks/preview', '/api/hooks', payload, loadTab), 0);
    } },
  ]);
}

// ---- files tab --------------------------------------------------------------

function filesTab(x) {
  const files = x.files.filter(f => (state.scope ? f.scope === 'project' : f.scope === 'global'))
    .map(f => ({ ...f, path: f.scope === 'project' ? `${state.scope}\\${f.rel}` : f.path }));
  if (!files.length) return h('div', { class: 'empty' }, 'No known files for this scope.');
  return h('div', {},
    h('div', { class: 'banner' }, 'Raw access to this harness\'s own files, for anything the other tabs do not cover.'),
    h('div', { class: 'list' }, files.map(f => h('div', { class: 'item' },
      h('div', { class: 'i-main' }, h('div', { class: 'i-name' }, f.label), h('div', { class: 'path' }, f.path)),
      h('button', { class: 'small', onclick: () => fileDialog(f) }, 'Open')))));
}

async function fileDialog(f) {
  let data;
  try { data = await api('GET', `/api/file?path=${encodeURIComponent(f.path)}`); } catch (e) { return fail(e); }
  const area = h('textarea', { rows: 22 }, data.content || '');
  modal(f.label, h('div', {}, h('div', { class: 'path', style: 'margin-bottom:8px' }, f.path + (data.exists ? '' : '  (does not exist yet)')), area), [
    { label: 'Close' },
    { label: 'Save', class: 'primary', action: async () => {
      try { await api('POST', '/api/file', { path: f.path, content: area.value }); toast('Saved. Previous version is in Backups.'); } catch (e) { fail(e); return false; }
    } },
  ]);
}

// ---- backups ----------------------------------------------------------------

async function backupsDialog() {
  let data;
  try { data = await api('GET', '/api/backups'); } catch (e) { return fail(e); }
  const body = h('div', {},
    h('div', { class: 'path', style: 'margin-bottom:10px' }, data.dir),
    data.backups.length ? h('div', { class: 'list' }, data.backups.map(b => h('div', { class: 'item' },
      h('div', { class: 'i-main' }, h('div', { class: 'i-name' }, new Date(b.time).toLocaleString()), h('div', { class: 'path' }, b.original)),
      b.isDir ? h('span', { class: 'muted' }, 'folder') : h('button', { class: 'small', onclick: async () => {
        try { await api('POST', '/api/backups/restore', { file: b.file }); toast('Restored.'); await loadTab(); } catch (e) { fail(e); }
      } }, 'Restore'))))
      : h('div', { class: 'muted' }, 'No backups yet. One is made before every change.'));
  modal('Backups', body, [{ label: 'Close' }]);
}

// ---- boot -------------------------------------------------------------------

async function boot(keep) {
  try {
    [state.scan, state.catalog, state.userPresets] = await Promise.all([
      api('GET', '/api/scan'), api('GET', '/api/levers'), api('GET', '/api/presets').then(r => r.presets)]);
  } catch (e) { document.getElementById('main').replaceChildren(h('div', { class: 'empty' }, e.message)); return; }
  if (!keep || !harness()) state.harnessId = (state.scan.harnesses.find(x => x.installed) || state.scan.harnesses[0]).id;
  renderSidebar();
  await loadTab();
}

document.getElementById('btn-rescan').addEventListener('click', () => boot(true).then(() => toast('Rescanned.')));
document.getElementById('btn-backups').addEventListener('click', backupsDialog);
boot();
