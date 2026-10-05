// Usage and cost, health check, drift, context stack, overview, lever compiler, registry.
const assert = require('assert');
const path = require('path');
const { fakeHome, test, done } = require('./helpers');
const home = fakeHome(['.claude/projects/p1/sub/subagents', 'proj', 'proj/.claude/rules', '.codex', '.gemini']);
const { write, read } = home;
const P = home.p('proj');

const now = new Date();
const iso = daysAgo => new Date(now.getTime() - daysAgo * 86400000).toISOString();
const assistant = (id, daysAgo, model, usage) => JSON.stringify({ type: 'assistant', cwd: P, timestamp: iso(daysAgo), requestId: 'r' + id, message: { id: 'm' + id, model, role: 'assistant', usage } });
write('.claude/projects/p1/s1.jsonl', [
  JSON.stringify({ type: 'user', cwd: P, timestamp: iso(1), message: { role: 'user', content: 'private prompt text' } }),
  assistant(1, 1, 'claude-opus-5-5', { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 900, cache_creation_input_tokens: 10 }),
  assistant(1, 1, 'claude-opus-5-5', { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 900, cache_creation_input_tokens: 10 }), // streamed duplicate
  assistant(2, 0, 'claude-haiku-4-5', { input_tokens: 20, output_tokens: 30 }),
  assistant(3, 400, 'claude-opus-5-5', { input_tokens: 5000, output_tokens: 5000 }), // outside the window
  JSON.stringify({ type: 'cost-state', sessionId: 's1', totalCostUSD: 1.5 }),
  JSON.stringify({ type: 'cost-state', sessionId: 's1', totalCostUSD: 2 }),
  'not json at all',
].join('\n'));
write('.claude/projects/p1/sub/subagents/a.jsonl', assistant(9, 0, 'claude-haiku-4-5', { input_tokens: 1, output_tokens: 2 }) + '\n');
write('.claude/CLAUDE.md', '# Mine\n');
write('.codex/config.toml', `[projects.'${P}']\ntrust_level = "trusted"\n`);

const core = require('../lib/core');
const x = require('../lib/integrations');
const ins = require('../lib/insights');
const levers = require('../lib/levers');
const { ADAPTERS } = require('../lib/adapters');
core.scan();

test('usage: tokens by day/model/project, exact session cost, duplicates counted once', () => {
  const u = ins.usage({ days: 30 });
  assert(u.available);
  assert.deepStrictEqual([u.totals.input, u.totals.output, u.totals.cacheRead, u.totals.cacheWrite], [121, 82, 900, 10]);
  assert.strictEqual(u.sessions, 1);
  assert.strictEqual(u.days.length, 30);
  assert.deepStrictEqual(u.models.map(m => m.name).sort(), ['claude-haiku-4-5', 'claude-opus-5-5']);
  assert.strictEqual(u.projects[0].name, P);
  // the session cost ($2) is shared across its days by tokens; the part outside the window is left out
  assert(u.totals.cost > 0 && u.totals.cost < 2);
  assert(!JSON.stringify(u).includes('private prompt'));
  // second run comes from the cache and agrees
  assert.deepStrictEqual(ins.usage({ days: 30 }).totals, u.totals);
});

test('context stack: lists what the harness loads, with sizes', () => {
  write('proj/CLAUDE.md', 'project rules\n');
  write('proj/.claude/rules/style.md', 'style\n');
  write('proj/CLAUDE.local.md', 'local\n');
  const cs = ins.contextStack({ harness: 'claude', project: P });
  assert.deepStrictEqual(cs.files.map(f => f.role), ['Global instructions', 'Project instructions', 'Project (extra)', 'Project rule']);
  assert(cs.tokens > 0 && cs.files.every(f => f.exists));
  assert.strictEqual(ins.contextStack({ harness: 'claude', project: '' }).files.length, 1);
  write('.codex/AGENTS.md', 'x'.repeat(40000));
  assert(ins.contextStack({ harness: 'codex', project: '' }).notes[0].includes('32 KB'));
});

test('drift: same, differs, edited by hand', () => {
  const vals = { verbosity: 'terse' };
  core.applyProfile({ harnesses: ['claude', 'gemini'], project: '', values: vals });
  let row = ins.drift().rows.find(r => r.key === 'global');
  assert.strictEqual(row.cells.claude.status, 'synced');
  assert.strictEqual(row.cells.claude.hash, row.cells.gemini.hash);
  assert.strictEqual(row.state, 'partial'); // codex has none yet
  core.applyProfile({ harness: 'codex', project: '', values: { verbosity: 'caveman' } });
  assert.strictEqual(ins.drift().rows.find(r => r.key === 'global').state, 'differs');
  write('.gemini/GEMINI.md', read('.gemini/GEMINI.md').replace('Lead with', 'Start with'));
  row = ins.drift().rows.find(r => r.key === 'global');
  assert.strictEqual(row.cells.gemini.status, 'edited');
  assert(row.conflicts);
  assert(ins.drift().rows.some(r => r.path === P));
});

test('health: finds real problems, scores them, and findings can be dismissed', () => {
  write('.claude/settings.json', JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } }));
  write('.gemini/settings.json', '{ "broken": ');
  x.applyMcp({ harness: 'claude', scope: 'project', project: P, name: 'db', server: { transport: 'stdio', command: 'npx', args: [], env: { DB_PASSWORD: 'hunter2hunter2' } } });
  x.applyHook({ harness: 'claude', scope: 'global', hook: { event: 'Stop', matcher: '', command: `node "${home.p('.agentdeck/hooks/gone.js').replace(/\\/g, '/')}"`, timeout: '' } });
  const h = ins.health();
  const titles = h.findings.map(f => f.title);
  for (const want of ['Safety checks are off (global)', 'Settings file does not parse (global)', 'Plain-text secrets in MCP config (proj)', 'Hook script is missing (global)', 'Managed block was edited by hand (global)', 'Harnesses disagree (Global)', 'Instruction file needs attention (global)']) {
    assert(titles.includes(want), `missing finding: ${want}\n  got: ${titles.join(' | ')}`);
  }
  assert(h.score < 60 && h.counts.high >= 4);
  assert.strictEqual(h.findings[0].level, 'high');
  ins.dismissFinding({ id: h.findings[0].id });
  const after = ins.health();
  assert.strictEqual(after.findings.length, h.findings.length - 1);
  assert.strictEqual(after.dismissed, 1);
  ins.dismissFinding({ restore: true });
  assert.strictEqual(ins.health().findings.length, h.findings.length);
});

test('overview: one card per detected harness', () => {
  const o = ins.overview();
  assert.deepStrictEqual(o.cards.map(c => c.id).sort(), ['claude', 'codex', 'gemini']);
  const claude = o.cards.find(c => c.id === 'claude');
  assert(claude.hooks === 1 && claude.blockTokens > 0 && claude.fileTokens >= claude.blockTokens);
  assert.strictEqual(o.counts.projects, 1);
  assert.strictEqual(o.firstRun, false);
});

test('levers: defaults compile to nothing, every option and toggle reaches the output', () => {
  assert.strictEqual(levers.compile({}), '');
  assert.strictEqual(levers.compile(levers.defaults()), '');
  for (const l of levers.LEVERS) {
    if (l.kind === 'choice') for (const o of l.options) assert(o.text === '' ? levers.compile({ [l.id]: o.value }) === '' : levers.compile({ [l.id]: o.value }).includes(o.text), `${l.id}=${o.value}`);
    if (l.kind === 'toggle') assert(levers.compile({ [l.id]: true }).includes(l.text), l.id);
    assert(levers.GROUPS.some(g => g.id === l.group), `${l.id} has an unknown group`);
    if (l.enforce) assert(x.RECIPES.some(r => r.id === l.enforce), `${l.id} enforces an unknown recipe`);
  }
  assert(levers.compile({ lengthCap: 99999 }).includes('under 500 lines'));
  assert.strictEqual(levers.compile({ lengthCap: -3 }), '');
  assert(!levers.compile({ custom: 'x <!-- agentdeck:end --> y' }).includes('agentdeck:'));
  for (const [name, vals] of Object.entries(levers.PRESETS)) {
    assert(levers.compile(vals).length > 40, name);
    for (const [id, v] of Object.entries(vals)) {
      const l = levers.LEVERS.find(q => q.id === id);
      assert(l && (l.kind !== 'choice' || l.options.some(o => o.value === v)), `${name}: bad ${id}=${v}`);
    }
  }
});

test('registry: every adapter is internally consistent', () => {
  const ids = new Set();
  for (const a of ADAPTERS) {
    assert(a.id && a.name && !ids.has(a.id), a.id);
    ids.add(a.id);
    assert(a.detect && (a.detect.bins || a.detect.dirs || a.detect.extensions), `${a.id}: no way to detect it`);
    assert(a.instructions && 'global' in a.instructions && 'project' in a.instructions, `${a.id}: instructions`);
    if (a.instructions.project) assert(!path.isAbsolute(a.instructions.project) && !a.instructions.project.startsWith('~'), `${a.id}: project file must be relative`);
    for (const def of a.native || []) {
      const s = a.settings && a.settings[def.file || 'main'];
      assert(s && ['json', 'toml'].includes(s.format) && (s.global || s.project), `${a.id}.${def.key}: no settings file`);
      assert(['text', 'number', 'toggle', 'select', 'list'].includes(def.kind), `${a.id}.${def.key}: kind`);
      if (def.kind === 'select') assert(def.options.length && def.options.every(o => 'value' in o && o.label), `${a.id}.${def.key}: options`);
      if (def.kind === 'list') assert(s.format === 'json' || !def.key.includes('.'), `${a.id}.${def.key}: nested TOML lists are not supported`);
      if (s.format === 'toml') assert(!def.key.includes('.'), `${a.id}.${def.key}: TOML settings must be top-level keys`);
    }
    for (const [type, k] of Object.entries(a.items || {})) {
      assert(['agents', 'skills', 'commands'].includes(type) && ['file', 'dir'].includes(k.layout) && (k.global || k.project), `${a.id}.${type}`);
      if (k.format === 'toml') assert(k.bodyKey && k.ext === '.toml', `${a.id}.${type}: TOML items need bodyKey and ext`);
      for (const p of core.list(k.project)) assert(!path.isAbsolute(p), `${a.id}.${type}: project dir must be relative`);
    }
    for (const f of a.files || []) assert(f.label && (f.scope === 'global' ? f.path : f.scope === 'project' && f.rel), `${a.id}: file entry`);
    if (a.mcp) assert((a.mcp.style === 'codex' || Array.isArray(a.mcp.key)) && (a.mcp.global || a.mcp.project), `${a.id}: mcp`);
    if (a.hooks) assert(Array.isArray(a.hooks.key) && a.hooks.events.length, `${a.id}: hooks`);
    for (const p of a.permissionPresets || []) assert(p.name && Array.isArray(p.allow) && Array.isArray(p.deny) && Array.isArray(p.ask), `${a.id}: preset`);
    if (a.projects) assert.doesNotThrow(() => a.projects(), `${a.id}: project discovery must not throw on a machine without it`);
  }
  assert(ADAPTERS.length >= 21);
});

test('scan on an empty machine: nothing detected, nothing throws', () => {
  const empty = fakeHome();
  const { execFileSync } = require('child_process');
  const out = execFileSync(process.execPath, ['-e', "const c=require('./lib/core');const s=c.scan();const i=require('./lib/insights');console.log(JSON.stringify([s.harnesses.filter(h=>h.installed).length,s.harnesses.length,i.health().score,i.usage().available,i.overview().firstRun]))"],
    { cwd: path.join(__dirname, '..'), env: { ...process.env, USERPROFILE: empty.H, HOME: empty.H, APPDATA: empty.p('AppData', 'Roaming') }, encoding: 'utf8' });
  assert.deepStrictEqual(JSON.parse(out), [0, ADAPTERS.length, 100, false, true]);
});

done('insights');
