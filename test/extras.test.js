// MCP servers, hooks, TOML-format items and hand-added projects. Uses a fresh fake home.
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
const H = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-home-'));
process.env.USERPROFILE = H; process.env.HOME = H; process.env.APPDATA = path.join(H, 'AppData', 'Roaming');
for (const d of ['.claude', 'proj', 'other', '.codex', '.gemini', '.config/opencode', '.local/share/opencode/storage/project']) fs.mkdirSync(path.join(H, d), { recursive: true });
const P = path.join(H, 'proj');
const read = rel => fs.readFileSync(path.join(H, rel), 'utf8');
fs.writeFileSync(path.join(H, '.claude.json'), JSON.stringify({ userID: 'u', projects: { [P]: {} }, mcpServers: { old: { command: 'x', custom: 1 } } }, null, 2));
fs.writeFileSync(path.join(H, '.claude/settings.json'), JSON.stringify({ model: 'opus' }, null, 2));
fs.writeFileSync(path.join(H, '.codex/config.toml'), '# mine\nmodel = "gpt-5"\n\n[mcp_servers.keep]\ncommand = "k"\n\n[projects.\'' + P + '\']\ntrust_level = "trusted"\n');
fs.writeFileSync(path.join(H, '.local/share/opencode/storage/project/abc.json'), JSON.stringify({ id: 'abc', worktree: P, time: { updated: 5 } }));
const c = require('../lib/core');
const toml = require('../lib/toml');

let s = c.scan();
const hx = id => s.harnesses.find(h => h.id === id);
assert.strictEqual(hx('opencode').projects[0].path, P);
assert(hx('claude').mcp && hx('claude').hooks.events.includes('Stop') && !hx('aider').mcp);

// --- MCP: one server into four differently-shaped configs
const server = { transport: 'stdio', command: 'npx', args: ['-y', 'pkg'], env: { KEY: 'v' }, url: '', headers: {} };
let plan = c.planMcp({ harnesses: ['claude', 'codex', 'gemini', 'opencode', 'aider'], scope: 'global', name: 'fs', server });
assert.strictEqual(plan.changes.length, 4);
assert(plan.warnings.some(w => w.includes('Aider')) && plan.warnings.some(w => w.includes('.claude.json')));
c.applyMcp({ harnesses: ['claude', 'codex', 'gemini', 'opencode'], scope: 'global', name: 'fs', server });
const cj = JSON.parse(read('.claude.json'));
assert.deepStrictEqual(cj.mcpServers.fs, { command: 'npx', args: ['-y', 'pkg'], env: { KEY: 'v' } });
assert(cj.userID === 'u' && cj.mcpServers.old.custom === 1);
const ct = read('.codex/config.toml');
assert(ct.startsWith('# mine\nmodel = "gpt-5"'));
assert.deepStrictEqual(toml.parse(ct).mcp_servers, { keep: { command: 'k' }, fs: { command: 'npx', args: ['-y', 'pkg'], env: { KEY: 'v' } } });
assert.deepStrictEqual(JSON.parse(read('.config/opencode/opencode.json')).mcp.fs, { type: 'local', command: ['npx', '-y', 'pkg'], environment: { KEY: 'v' } });
assert.deepStrictEqual(JSON.parse(read('.gemini/settings.json')).mcpServers.fs.args, ['-y', 'pkg']);

// remote server: per-harness URL key and type
const remote = { transport: 'http', url: 'https://x/mcp', headers: { Authorization: 'Bearer t' }, command: '', args: [], env: {} };
c.applyMcp({ harnesses: ['claude', 'gemini', 'codex', 'opencode'], scope: 'global', name: 'rem', server: remote });
assert.deepStrictEqual(JSON.parse(read('.claude.json')).mcpServers.rem, { url: 'https://x/mcp', type: 'http', headers: { Authorization: 'Bearer t' } });
assert.strictEqual(JSON.parse(read('.gemini/settings.json')).mcpServers.rem.httpUrl, 'https://x/mcp');
assert.deepStrictEqual(toml.parse(read('.codex/config.toml')).mcp_servers.rem, { url: 'https://x/mcp', http_headers: { Authorization: 'Bearer t' } });
assert.strictEqual(JSON.parse(read('.config/opencode/opencode.json')).mcp.rem.type, 'remote');

// list normalises every shape; edit keeps unknown keys; remove
for (const id of ['claude', 'codex', 'gemini', 'opencode']) {
  const l = c.listMcp({ harness: id, project: '' }).scopes[0].servers;
  const f = l.find(x => x.name === 'fs'), r = l.find(x => x.name === 'rem');
  assert(f.transport === 'stdio' && f.command === 'npx' && f.args.join() === '-y,pkg' && f.env.KEY === 'v', id);
  assert(r.transport === 'http' && r.url === 'https://x/mcp' && r.headers.Authorization === 'Bearer t', id);
}
c.applyMcp({ harness: 'claude', scope: 'global', name: 'old', server: { ...server, command: 'y', args: [], env: {} } });
assert.deepStrictEqual(JSON.parse(read('.claude.json')).mcpServers.old, { custom: 1, command: 'y' });
c.applyMcp({ harnesses: ['claude', 'codex'], scope: 'global', name: 'fs', remove: true });
assert(!JSON.parse(read('.claude.json')).mcpServers.fs);
assert.deepStrictEqual(Object.keys(toml.parse(read('.codex/config.toml')).mcp_servers).sort(), ['keep', 'rem']);
assert(toml.parse(read('.codex/config.toml')).projects[P]);
// project scope + validation
c.applyMcp({ harness: 'claude', scope: 'project', project: P, name: 'fs', server });
assert(JSON.parse(fs.readFileSync(path.join(P, '.mcp.json'), 'utf8')).mcpServers.fs);
assert.strictEqual(c.listMcp({ harness: 'claude', project: P }).scopes.length, 2);
assert.throws(() => c.planMcp({ harness: 'claude', scope: 'global', name: 'bad name', server }), /Server name/);
assert.throws(() => c.planMcp({ harness: 'claude', scope: 'global', name: 'x', server: { transport: 'stdio', command: '' } }), /needs a command/);

// --- hooks
const hook = { event: 'Stop', matcher: '', command: 'npm test 1>&2 || exit 2', timeout: 300 };
c.applyHook({ harness: 'claude', scope: 'global', hook });
c.applyHook({ harness: 'claude', scope: 'global', hook: { event: 'PostToolUse', matcher: 'Edit|Write', command: 'fmt', timeout: '' } });
let st = JSON.parse(read('.claude/settings.json'));
assert.strictEqual(st.model, 'opus');
assert.deepStrictEqual(st.hooks, { Stop: [{ hooks: [{ type: 'command', command: 'npm test 1>&2 || exit 2', timeout: 300 }] }], PostToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'fmt' }] }] });
let hooks = c.listHooks({ harness: 'claude', project: '' }).scopes[0].hooks;
assert.strictEqual(hooks.length, 2);
c.applyHook({ harness: 'claude', scope: 'global', id: hooks.find(x => x.event === 'PostToolUse').id, hook: { event: 'PostToolUse', matcher: 'Write', command: 'fmt2', timeout: 10 } });
hooks = c.listHooks({ harness: 'claude', project: '' }).scopes[0].hooks;
assert(hooks.length === 2 && hooks.some(x => x.command === 'fmt2' && x.matcher === 'Write' && x.timeout === 10));
for (const hk of c.listHooks({ harness: 'claude', project: '' }).scopes[0].hooks.slice().reverse()) c.applyHook({ harness: 'claude', scope: 'global', id: hk.id, remove: true });
assert.deepStrictEqual(JSON.parse(read('.claude/settings.json')), { model: 'opus' });
assert.throws(() => c.planHook({ harness: 'claude', scope: 'global', hook: { event: 'Nope', command: 'x' } }), /Pick an event/);
assert.throws(() => c.planHook({ harness: 'aider', scope: 'global', hook }), /not supported/);
c.applyHook({ harness: 'codex', scope: 'global', hook });
assert(JSON.parse(read('.codex/hooks.json')).hooks.Stop);

// --- TOML-format items: Codex agent, Gemini command
const agent = { type: 'agents', harnesses: ['codex', 'claude'], scope: 'global', name: 'Reviewer', description: 'Reviews "code"', body: 'You review.\nUse C:\\paths and """quotes""".', fields: { model: 'gpt-5', model_reasoning_effort: 'high', tools: 'Read, Grep' } };
c.saveItem(agent);
const ta = toml.parse(read('.codex/agents/reviewer.toml'));
assert.deepStrictEqual(ta, { name: 'reviewer', description: 'Reviews "code"', model: 'gpt-5', model_reasoning_effort: 'high', developer_instructions: 'You review.\nUse C:\\paths and """quotes""".\n' });
assert(read('.claude/agents/reviewer.md').includes('tools: [Read, Grep]'));
let ca = c.listItems({ harness: 'codex', project: '' }).agents[0];
assert(ca.name === 'reviewer' && ca.fields.model === 'gpt-5' && ca.body.startsWith('You review.'));
fs.appendFileSync(ca.path, '\n[mcp_servers.docs]\nurl = "https://d"\n');
c.saveItem({ type: 'agents', path: ca.path, name: 'reviewer', description: 'Updated', body: 'New prompt', fields: { model: 'gpt-5.5' } });
const tb = toml.parse(read('.codex/agents/reviewer.toml'));
assert(tb.description === 'Updated' && tb.model === 'gpt-5.5' && !('model_reasoning_effort' in tb) && tb.mcp_servers.docs.url === 'https://d');
c.saveItem({ type: 'commands', harnesses: ['gemini'], scope: 'global', name: 'explain', description: 'Explain it', body: 'Explain {{args}}', fields: {} });
assert.deepStrictEqual(toml.parse(read('.gemini/commands/explain.toml')), { description: 'Explain it', prompt: 'Explain {{args}}\n' });
assert.strictEqual(c.listItems({ harness: 'gemini', project: '' }).commands[0].name, 'explain');
c.deleteItem({ path: ca.path }); assert(!fs.existsSync(ca.path));
// markdown edit keeps unknown frontmatter
const mdPath = path.join(H, '.claude/agents/reviewer.md');
fs.writeFileSync(mdPath, '---\nname: reviewer\ndescription: d\ncolor: blue\n---\n\nbody\n');
c.saveItem({ type: 'agents', path: mdPath, name: 'reviewer', description: 'd2', body: 'body', fields: {} });
assert(read('.claude/agents/reviewer.md').includes('color: blue') && read('.claude/agents/reviewer.md').includes('description: d2'));

// --- projects added by hand
assert.throws(() => c.getProfile({ harness: 'aider', project: path.join(H, 'other') }), /not a project/);
assert.throws(() => c.addProject({ harness: 'aider', path: path.join(H, 'nope') }), /not an existing folder/);
c.addProject({ harness: 'aider', path: path.join(H, 'other') });
s = c.scan();
assert(s.harnesses.find(h => h.id === 'aider').projects[0].manual);
c.applyProfile({ harness: 'aider', project: path.join(H, 'other'), values: { verbosity: 'terse' } });
assert(fs.readFileSync(path.join(H, 'other', 'CONVENTIONS.md'), 'utf8').includes('Lead with the answer'));
c.removeProject({ harness: 'aider', path: path.join(H, 'other') });
assert.strictEqual(c.scan().harnesses.find(h => h.id === 'aider').projects.length, 0);

console.log('EXTRAS OK');
