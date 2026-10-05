// Detection, behavior profiles, native settings, items, raw files, backups, presets.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { fakeHome, test, done } = require('./helpers');
const home = fakeHome(['.claude/projects/p1', 'proj', 'other', '.codex', '.gemini', '.cursor']);
const { H, read, write, has } = home;
const P = home.p('proj');

write('.claude/projects/p1/a.jsonl', JSON.stringify({ type: 'user', cwd: P }) + '\n');
write('.claude/projects/p1/rel.jsonl', JSON.stringify({ type: 'user', cwd: 'relative/dir' }) + '\n');
write('.claude/settings.json', JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, env: { FOO: '1' } }, null, 2));
write('.claude/CLAUDE.md', '# My rules\n\n- keep this\n');
write('.codex/config.toml', `model = "gpt-5"\n\n[projects.'${P}']\ntrust_level = "trusted"\n`);
const c = require('../lib/core');
const toml = require('../lib/toml');
const vals = { verbosity: 'terse', readFirst: true, lengthCap: '40', custom: 'Use pnpm\n- Never push' };

test('scan: detection is by config folders only, projects are absolute and deduped', () => {
  const s = c.scan();
  assert.deepStrictEqual(s.harnesses.filter(h => h.installed).map(h => h.id).sort(), ['claude', 'codex', 'cursor', 'gemini']);
  const claude = s.harnesses.find(h => h.id === 'claude');
  assert.deepStrictEqual(claude.projects.map(p => p.path), [P]);
  assert.strictEqual(s.harnesses.find(h => h.id === 'codex').projects[0].path, P);
  assert(s.version && s.node);
});

test('behavior profile: apply to two harnesses, keeps user content, undo', () => {
  const plan = c.planProfile({ harnesses: ['claude', 'codex'], project: '', values: vals });
  assert.strictEqual(plan.changes.length, 2);
  assert(plan.blockTokens > 10);
  const r = c.applyProfile({ harnesses: ['claude', 'codex'], project: '', values: vals });
  const md = read('.claude/CLAUDE.md');
  assert(md.startsWith('# My rules\n\n- keep this\n') && md.includes('under 40 lines') && md.includes('- Never push'));
  assert.strictEqual(c.getProfile({ harness: 'claude', project: '' }).status, 'synced');
  assert.deepStrictEqual(c.getProfile({ harness: 'codex', project: '' }).values, vals);
  c.undo({ batch: r.batch });
  assert.strictEqual(read('.claude/CLAUDE.md'), '# My rules\n\n- keep this\n');
  assert(!has('.codex/AGENTS.md'));
  c.applyProfile({ harnesses: ['claude', 'codex'], project: '', values: vals });
});

test('behavior profile: status tracks hand edits; reset removes the block and empty files', () => {
  write('.claude/CLAUDE.md', read('.claude/CLAUDE.md').replace('under 40 lines', 'under 9 lines'));
  assert.strictEqual(c.getProfile({ harness: 'claude', project: '' }).status, 'edited');
  c.applyProfile({ harness: 'claude', project: '', values: { verbosity: 'caveman' } });
  const md = read('.claude/CLAUDE.md');
  assert.strictEqual(md.match(/agentdeck:start/g).length, 1);
  assert(!md.includes('9 lines') && md.includes('keep this'));
  c.applyProfile({ harness: 'claude', project: '', values: {} });
  assert.strictEqual(read('.claude/CLAUDE.md'), '# My rules\n\n- keep this\n');
  // codex AGENTS.md held only our block: resetting removes the file rather than leaving it empty
  c.applyProfile({ harness: 'codex', project: '', values: {} });
  assert(!has('.codex/AGENTS.md'));
  // and all-default levers never create a file
  assert.strictEqual(c.planProfile({ harness: 'gemini', project: '', values: {} }).changes.length, 0);
});

test('native settings: JSON edits, lists, unset, danger warning', () => {
  const r = c.planProfile({ harness: 'claude', project: '', native: { 'permissions.defaultMode': 'bypassPermissions' } });
  assert.strictEqual(r.warnings.length, 1);
  c.applyProfile({ harness: 'claude', project: '', native: { effortLevel: 'high', 'permissions.defaultMode': 'plan', 'env.BASH_MAX_OUTPUT_LENGTH': '10000', cleanupPeriodDays: '30', alwaysThinkingEnabled: true, 'permissions.deny': 'Read(./.env)\n\nRead(./.env)\nBash(rm -rf:*)', model: '' } });
  assert.deepStrictEqual(JSON.parse(read('.claude/settings.json')), { permissions: { allow: ['Bash(ls)'], defaultMode: 'plan', deny: ['Read(./.env)', 'Bash(rm -rf:*)'] }, env: { FOO: '1', BASH_MAX_OUTPUT_LENGTH: '10000' }, effortLevel: 'high', alwaysThinkingEnabled: true, cleanupPeriodDays: 30 });
  const native = c.getProfile({ harness: 'claude', project: '' }).native;
  assert.deepStrictEqual(native.find(n => n.key === 'permissions.deny').value, ['Read(./.env)', 'Bash(rm -rf:*)']);
  c.applyProfile({ harness: 'claude', project: '', native: { effortLevel: '', 'permissions.deny': [], 'env.BASH_MAX_OUTPUT_LENGTH': '' } });
  const st = JSON.parse(read('.claude/settings.json'));
  assert(!('effortLevel' in st) && !('deny' in st.permissions) && !('BASH_MAX_OUTPUT_LENGTH' in st.env));
  // an untouched form (every value as currently stored) is not a change
  const same = Object.fromEntries(c.getProfile({ harness: 'claude', project: '' }).native.map(n => [n.key, n.value ?? '']));
  assert.strictEqual(c.planProfile({ harness: 'claude', project: '', native: same }).changes.length, 0);
});

test('native settings: refuses JSONC and non-objects instead of clobbering', () => {
  write('.gemini/settings.json', '{\n  // comment\n  "model": {}\n}\n');
  assert.throws(() => c.planProfile({ harness: 'gemini', project: '', native: { 'model.name': 'x' } }), /not plain JSON/);
  write('.gemini/settings.json', '[]');
  assert.throws(() => c.planProfile({ harness: 'gemini', project: '', native: { 'model.name': 'x' } }), /JSON object/);
  fs.unlinkSync(home.p('.gemini/settings.json'));
});

test('native settings: TOML edits keep the rest of the file', () => {
  c.applyProfile({ harness: 'codex', project: '', native: { model_verbosity: 'low', model_auto_compact_token_limit: '120000', model: 'gpt-5.5' } });
  assert(/^model = "gpt-5.5"\nmodel_verbosity = "low"\nmodel_auto_compact_token_limit = 120000\n\n\[projects/.test(read('.codex/config.toml')));
  assert.strictEqual(c.getProfile({ harness: 'codex', project: '' }).native.find(n => n.key === 'model_verbosity').value, 'low');
});

test('project scope: only known folders, and a project can be added by hand', () => {
  c.applyProfile({ harness: 'claude', project: P, values: { scope: 'surgical' } });
  assert(fs.readFileSync(path.join(P, 'CLAUDE.md'), 'utf8').includes('Touch only'));
  const outside = process.platform === 'win32' ? 'C:\\Windows' : '/usr';
  assert.throws(() => c.getProfile({ harness: 'claude', project: outside }), /not a project/);
  assert.throws(() => c.getProfile({ harness: 'aider', project: home.p('other') }), /not a project/);
  assert.throws(() => c.addProject({ harness: 'aider', path: home.p('nope') }), /not an existing folder/);
  assert.throws(() => c.addProject({ harness: 'aider', path: H }), /not a drive or your home/);
  c.addProject({ harness: 'aider', path: home.p('other') });
  assert(c.scan().harnesses.find(h => h.id === 'aider').projects[0].manual);
  c.applyProfile({ harness: 'aider', project: home.p('other'), values: { verbosity: 'terse' } });
  assert(read('other/CONVENTIONS.md').includes('Lead with the answer'));
  c.removeProject({ harness: 'aider', path: home.p('other') });
  assert.strictEqual(c.scan().harnesses.find(h => h.id === 'aider').projects.length, 0);
});

test('items: one skill to several harnesses, each in its own place', () => {
  const skill = { type: 'skills', scope: 'global', name: 'Review Checklist', description: 'Review: a diff', body: '# Hi', fields: { 'allowed-tools': 'Read, Grep' } };
  const plan = c.planItem({ ...skill, harnesses: ['claude', 'codex', 'gemini', 'aider'] });
  assert.strictEqual(plan.changes.length, 3);
  assert.strictEqual(plan.warnings.length, 1);
  c.saveItem({ ...skill, harnesses: ['claude', 'codex', 'gemini'] });
  const sk = c.listItems({ harness: 'claude', project: '' }).skills[0];
  assert.deepStrictEqual([sk.name, sk.description, sk.fields['allowed-tools']], ['review-checklist', 'Review: a diff', 'Read, Grep']);
  assert(read('.claude/skills/review-checklist/SKILL.md').includes('allowed-tools: [Read, Grep]'));
  assert(!read('.agents/skills/review-checklist/SKILL.md').includes('allowed-tools'));
  // Gemini reads both of its skill folders, without listing a file twice
  assert.strictEqual(c.listItems({ harness: 'gemini', project: '' }).skills.length, 2);
  c.deleteItem({ path: sk.path });
  assert(!fs.existsSync(path.dirname(sk.path)));
  const dir = c.listBackups().backups.find(b => b.isDir);
  c.restoreBackup({ id: dir.id });
  assert(has('.claude/skills/review-checklist/SKILL.md'));
});

test('items: editing changes only what was edited', () => {
  const file = home.p('.claude/agents/Reviewer.md');
  const original = '---\nname: Code Reviewer\ndescription: |\n  Reviews code.\n  Carefully.\ntools:\n- Read\n- Grep\nhooks:\n  PreToolUse:\n    - matcher: Bash\ncolor: blue\nmodel: sonnet\n---\n\nYou review.\n';
  write('.claude/agents/Reviewer.md', original);
  write('.claude/agents/README.md', 'not an agent');
  const items = c.listItems({ harness: 'claude', project: '' }).agents;
  assert.strictEqual(items.length, 1);
  const it = items[0];
  assert.deepStrictEqual([it.name, it.description, it.fields.tools, it.fields.model, it.complex], ['Code Reviewer', 'Reviews code.\nCarefully.', 'Read, Grep', 'sonnet', ['hooks']]);
  // the form round-trips its own values: only the model differs
  c.saveItem({ type: 'agents', path: file, name: it.name, description: it.description, body: it.body, fields: { ...it.fields, model: 'opus' } });
  assert.strictEqual(read('.claude/agents/Reviewer.md'), original.replace('model: sonnet', 'model: opus'));
  // clearing a field removes it; complex keys the form cannot show stay
  c.saveItem({ type: 'agents', path: file, name: it.name, description: 'Short', body: 'New body', fields: { model: 'opus' } });
  const after = read('.claude/agents/Reviewer.md');
  assert(after.includes('name: Code Reviewer') && after.includes('description: Short') && after.includes('    - matcher: Bash') && after.includes('color: blue'));
  assert(!after.includes('- Read') && after.endsWith('New body\n'));
});

test('items: typed fields, TOML formats, unparseable files are left alone', () => {
  c.saveItem({ type: 'agents', harnesses: ['cursor', 'codex'], scope: 'global', name: 'Helper', description: 'Helps "a lot"', body: 'You help.\nUse C:\\paths and """quotes""".', fields: { readonly: 'true', model: 'gpt-5', model_reasoning_effort: 'high' } });
  assert(read('.cursor/agents/helper.md').includes('readonly: true\n'));
  assert.deepStrictEqual(toml.parse(read('.codex/agents/helper.toml')), { name: 'helper', description: 'Helps "a lot"', model: 'gpt-5', model_reasoning_effort: 'high', developer_instructions: 'You help.\nUse C:\\paths and """quotes""".\n' });
  const ca = c.listItems({ harness: 'codex', project: '' }).agents[0];
  fs.appendFileSync(ca.path, '\n[mcp_servers.docs]\nurl = "https://d"\n');
  c.saveItem({ type: 'agents', path: ca.path, name: 'helper', description: 'Updated', body: 'New prompt', fields: { model: 'gpt-5.5' } });
  const tb = toml.parse(read('.codex/agents/helper.toml'));
  assert(tb.description === 'Updated' && tb.model === 'gpt-5.5' && !('model_reasoning_effort' in tb) && tb.mcp_servers.docs.url === 'https://d');
  c.saveItem({ type: 'commands', harnesses: ['gemini'], scope: 'global', name: 'explain', description: 'Explain it', body: 'Explain {{args}}', fields: {} });
  assert.deepStrictEqual(toml.parse(read('.gemini/commands/explain.toml')), { description: 'Explain it', prompt: 'Explain {{args}}\n' });
  write('.codex/agents/broken.toml', 'name = "broken\nmodel = \n');
  const broken = c.listItems({ harness: 'codex', project: '' }).agents.find(a => a.name === 'broken');
  assert.strictEqual(broken.readOnly, true);
  assert.throws(() => c.saveItem({ type: 'agents', path: broken.path, name: 'broken', description: 'd', body: 'b', fields: {} }), /could not be parsed/);
  assert.strictEqual(read('.codex/agents/broken.toml'), 'name = "broken\nmodel = \n');
});

test('items and files: only paths a harness owns', () => {
  assert.throws(() => c.planItem({ path: home.p('.claude/settings.json'), remove: true }), /not an agent/);
  assert.throws(() => c.planItem({ path: home.p('.claude/agents/../../.ssh/id.md'), remove: true }), /not an agent/);
  assert.throws(() => c.readFile({ path: home.p('.ssh/id_rsa') }), /not one of/);
  assert.throws(() => c.planItem({ type: 'skills', harnesses: ['claude'], scope: 'global', name: '!!!', body: '' }), /letters or digits/);
});

test('files: preview warns on bad syntax; restore brings a version back', () => {
  assert.strictEqual(c.planFile({ path: home.p('.claude/settings.json'), content: '{ bad' }).warnings.length, 1);
  c.writeFile({ path: home.p('.claude/CLAUDE.md'), content: 'changed\n' });
  const b = c.listBackups().backups.find(x => !x.created && !x.isDir && x.original.endsWith(path.join('.claude', 'CLAUDE.md')));
  assert.strictEqual(c.planRestore({ id: b.id }).changes[0].after, '# My rules\n\n- keep this\n');
  c.restoreBackup({ id: b.id });
  assert.strictEqual(read('.claude/CLAUDE.md'), '# My rules\n\n- keep this\n');
});

test('presets: save, export, import (only known levers survive)', () => {
  c.savePreset({ name: 'mine', values: { ...vals, bogus: 'x', verbosity: 'not-an-option' } });
  assert.deepStrictEqual(c.listPresets().presets.mine, { readFirst: true, lengthCap: '40', custom: 'Use pnpm\n- Never push' });
  assert.throws(() => c.savePreset({ name: '__proto__', values: {} }), /needs a name/);
  const bundle = c.exportBundle();
  assert(bundle.agentdeck === 1 && bundle.presets.mine);
  c.deletePreset({ name: 'mine' });
  assert.strictEqual(c.importBundle({ bundle: JSON.stringify(bundle) }).presets.mine.lengthCap, '40');
  assert.strictEqual(c.importBundle({ bundle: { name: 'Shared', values: { verbosity: 'terse' } } }).presets.Shared.verbosity, 'terse');
  assert.throws(() => c.importBundle({ bundle: '{nope' }), /not valid JSON/);
  assert.throws(() => c.importBundle({ bundle: { presets: { x: { bogus: 1 } } } }), /No presets/);
});

done('engine');
