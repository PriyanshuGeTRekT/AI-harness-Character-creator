// Agents, skills and commands.
import { h, api, modal, reviewFrom, confirmChanges, fail, baseName, field } from '../ui.js';
import { state } from '../state.js';

const TEMPLATES = {
  skills: [
    { name: 'Blank', slug: '', description: '', body: '# Instructions\n\n' },
    { name: 'Code review checklist', slug: 'review-checklist', description: 'Review a diff against the team checklist. Use when asked to review code, a PR, or staged changes.', body: '# Code review\n\n1. Read the full diff before commenting.\n2. Check, in order: correctness, error handling, security at trust boundaries, tests, naming.\n3. Report findings most severe first, each with file:line and a concrete failure scenario.\n4. Do not comment on style the formatter already enforces.\n5. If nothing is wrong, say so in one line.\n' },
    { name: 'Commit message writer', slug: 'commit-message', description: 'Write a commit message for the staged changes. Use when asked to commit or to draft a commit message.', body: '# Commit message\n\n1. Run `git diff --staged` and read it.\n2. Subject: imperative mood, under 60 characters, no trailing period.\n3. Body: why the change was made, not a list of files. Wrap at 72 columns.\n4. Never mention things that are not in the diff.\n' },
    { name: 'Test writer', slug: 'write-tests', description: 'Write tests for a function or module. Use when asked to add tests or improve coverage.', body: '# Writing tests\n\n1. Find the existing test framework and copy its conventions; do not add a new one.\n2. Cover the main path, each branch, and the edge cases (empty, null, boundary, error).\n3. One behavior per test, named for the behavior.\n4. Run the tests and report the command and result.\n' },
    { name: 'Terse mode', slug: 'terse-mode', description: 'Switch to terse replies to save output tokens. Use when the user says "be brief", "terse mode" or "save tokens".', body: '# Terse mode\n\nAnswer first. No greetings, hedges, recaps or closing offers. Fragments are fine.\nKeep code, commands, paths, numbers and error text exact.\nUse full sentences for security warnings, destructive actions and ordered steps.\nStay in this mode until the user says "normal mode".\n' },
    { name: 'Bug investigation', slug: 'debug', description: 'Investigate a bug systematically. Use when something fails, crashes or behaves unexpectedly.', body: '# Debugging\n\n1. Reproduce the failure first and record the exact command and output.\n2. Form one hypothesis at a time and test it with the cheapest check available.\n3. Find the root cause before changing code; do not patch symptoms.\n4. After the fix, rerun the reproduction and the surrounding tests.\n' },
    { name: 'Docs writer', slug: 'write-docs', description: 'Write or update documentation for code. Use when asked for a README, docstrings or usage docs.', body: '# Documentation\n\n1. Read the code being documented; never describe behavior you have not confirmed.\n2. Start with what it does and a runnable example.\n3. Document inputs, outputs, errors and one common pitfall.\n4. Match the tone and structure of the existing docs.\n' },
    { name: 'Pull request description', slug: 'pr-description', description: 'Write a pull request description from the branch diff. Use when asked to open or describe a PR.', body: '# Pull request description\n\n1. Read `git log main..HEAD` and `git diff main...HEAD`.\n2. Title: what changes for the user, under 70 characters.\n3. Body: why, what changed (grouped, not per file), how it was tested, and anything a reviewer should look at first.\n4. State plainly what was not tested.\n' },
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
    { name: 'Review my changes', slug: 'review', description: 'Review uncommitted changes', body: 'Review the uncommitted changes (git diff). Report real bugs first with file:line, then risky patterns. Skip style nits.\n' },
  ],
};

export async function itemsTab(x, kind) {
  const data = await api('GET', `/api/items?harness=${encodeURIComponent(x.id)}&project=${encodeURIComponent(state.scope)}`);
  const items = data[kind.type] || [];
  const canCreate = state.scope ? kind.project || kind.global : kind.global;
  const wrap = h('div', {});
  wrap.append(h('div', { class: 'actions', style: 'margin-bottom:14px' },
    h('button', { class: 'primary', disabled: !canCreate, onclick: () => itemDialog(x, kind, null) }, `+ New ${kind.noun}`),
    h('span', { class: 'muted' }, canCreate ? kind.note : `${x.name} keeps ${kind.label.toLowerCase()} per project: pick one under Scope.`)));
  if (!items.length) wrap.append(h('div', { class: 'card' }, h('h2', {}, `No ${kind.label.toLowerCase()} here yet`),
    h('div', { class: 'note', style: 'margin:6px 0 0' }, kind.type === 'skills' ? 'A skill is a reusable set of instructions the agent loads only when the task calls for it, so it costs no tokens the rest of the time.' : kind.type === 'agents' ? 'A subagent is a specialist with its own prompt and tools that the main agent can hand work to.' : 'A command is a saved prompt you run by name.')));
  wrap.append(h('div', { class: 'list' }, items.map(it => h('div', { class: 'item' },
    h('div', { class: 'i-main' },
      h('div', { class: 'i-name' }, it.name, h('span', { class: 'tag' }, it.scope), it.readOnly ? h('span', { class: 'tag danger' }, it.source || 'read-only') : null),
      h('div', { class: 'i-desc' }, it.description || ''),
      h('div', { class: 'path' }, it.path)),
    it.readOnly ? null : h('div', { class: 'actions' },
      h('button', { class: 'small', onclick: () => itemDialog(x, kind, it) }, 'Edit'),
      h('button', { class: 'small', title: 'Create the same thing for other harnesses', onclick: () => itemDialog(x, kind, null, it) }, 'Copy to…'),
      h('button', { class: 'small danger', onclick: () => confirmChanges(`Delete ${kind.noun}`, '/api/items/preview', '/api/items/delete', { path: it.path, remove: true }, { applyLabel: 'Delete' }).catch(fail) }, 'Delete'))))));
  return wrap;
}

// existing: edit in place. seed: start a new item from an existing one ("Copy to…").
function itemDialog(x, kind, existing, seed) {
  const from = existing || seed;
  const d = from ? { name: from.name, description: from.description || '', body: from.body || '', fields: { ...from.fields } } : { name: '', description: '', body: TEMPLATES[kind.type][0].body, fields: {} };
  const initial = JSON.stringify(d);
  let scope = existing ? existing.scope : (state.scope && kind.project ? 'project' : 'global');
  const attach = new Set(seed ? [] : [x.id]);
  const others = existing ? [] : state.scan.harnesses.filter(o => (seed || o.id !== x.id) && o.itemKinds.some(k => k.type === kind.type));

  const nameIn = h('input', { type: 'text', value: d.name, placeholder: 'lowercase-with-dashes', disabled: !!existing, oninput: e => { d.name = e.target.value; } });
  const descIn = h('textarea', { class: 'prose', rows: 2, placeholder: 'What it does and when the agent should use it', oninput: e => { d.description = e.target.value; } }, d.description);
  const bodyIn = h('textarea', { rows: 13, oninput: e => { d.body = e.target.value; } }, d.body);
  const tplSel = from ? null : h('select', { onchange: e => {
    const t = TEMPLATES[kind.type][Number(e.target.value)];
    if (JSON.stringify(d) !== initial && d.body.trim() && !window.confirm('Replace what you have typed with this template?')) return;
    d.name = nameIn.value = t.slug; d.description = descIn.value = t.description; d.body = bodyIn.value = t.body;
  } }, TEMPLATES[kind.type].map((t, i) => h('option', { value: i }, t.name)));

  const body = h('div', {},
    tplSel ? field('Start from a template', tplSel) : null,
    h('div', { class: 'grid2' },
      field('Name', nameIn, existing ? 'The name is how the harness finds it, so it is fixed.' : null),
      existing ? h('div', {}) : field('Scope', h('select', { onchange: e => { scope = e.target.value; } },
        h('option', { value: 'global', selected: scope === 'global' }, 'Global (all projects)'),
        state.scope ? h('option', { value: 'project', selected: scope === 'project' }, `Project: ${baseName(state.scope)}`) : null))),
    field('Description', descIn, 'The agent decides when to use this from the description, so say when it applies.'),
    kind.fields.length ? h('div', { class: 'grid2' }, kind.fields.map(f => field(f.label,
      f.options
        ? h('select', { onchange: e => { d.fields[f.key] = e.target.value; } }, h('option', { value: '' }, '(default)'), f.options.map(o => h('option', { value: o, selected: String(d.fields[f.key] ?? '') === o }, o)),
          d.fields[f.key] && !f.options.includes(String(d.fields[f.key])) ? h('option', { value: d.fields[f.key], selected: true }, `${d.fields[f.key]} (current)`) : null)
        : h('input', { type: 'text', value: d.fields[f.key] ?? '', placeholder: f.placeholder || '', oninput: e => { d.fields[f.key] = e.target.value; } }),
      f.help))) : null,
    existing && existing.complex.length ? h('div', { class: 'banner' }, `This file also has ${existing.complex.join(', ')} with nested settings. They are kept exactly as they are; edit them from the Files tab.`) : null,
    field(kind.type === 'agents' ? 'System prompt' : 'Instructions', bodyIn),
    others.length ? h('div', { class: 'field' }, h('span', {}, seed ? 'Copy to' : 'Also create for'),
      h('div', { class: 'checks' }, others.map(o => h('label', {},
        h('input', { type: 'checkbox', onchange: e => (e.target.checked ? attach.add(o.id) : attach.delete(o.id)) }), o.name,
        o.installed ? null : h('span', { class: 'muted' }, '(not installed)')))),
      h('small', {}, 'Each harness gets the file in its own location and format. Fields a harness does not have are left out.')) : null);

  modal(existing ? `Edit ${kind.noun}: ${existing.name}` : seed ? `Copy ${kind.noun}: ${seed.name}` : `New ${kind.noun}`, body, [
    { label: 'Cancel' },
    { label: 'Review changes', class: 'primary', action: () => {
      if (!d.name.trim()) throw new Error('Give it a name.');
      if (!existing && !attach.size) throw new Error('Pick at least one harness.');
      const payload = { type: kind.type, harnesses: [...attach], scope, project: scope === 'project' ? state.scope : '', path: existing ? existing.path : '', ...d };
      return reviewFrom(existing ? `Update ${kind.noun}` : `Create ${kind.noun}`, '/api/items/preview', '/api/items', payload);
    } },
  ], { guard: () => JSON.stringify(d) !== initial });
}
