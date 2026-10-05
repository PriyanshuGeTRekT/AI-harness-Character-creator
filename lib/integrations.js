// MCP servers, hooks, and ready-made hook recipes.
const path = require('path');
const fsx = require('./fsx');
const toml = require('./toml');
const core = require('./core');

const { bad, adapter, list, checkProject } = core;
const RESERVED = /^(__proto__|constructor|prototype)$/;

const getKey = (obj, keyPath) => keyPath.reduce((o, k) => (o == null || typeof o !== 'object' ? undefined : o[k]), obj);

function setKey(obj, keyPath, value) {
  let o = obj;
  for (const k of keyPath.slice(0, -1)) {
    if (typeof o[k] !== 'object' || o[k] == null || Array.isArray(o[k])) o[k] = {};
    o = o[k];
  }
  const last = keyPath[keyPath.length - 1];
  if (value === undefined) delete o[last];
  else o[last] = value;
}

function scopedFile(def, proj, scope) {
  if (scope === 'project') return def.project && proj ? path.join(proj, def.project) : null;
  return def.global ? fsx.expand(def.global) : null;
}

const loadJsonDoc = file => core.parseJsonSettings(file, fsx.readText(file));
const dumpJson = doc => JSON.stringify(doc, null, 2) + '\n';

// ---- MCP servers ----------------------------------------------------------------
// Each harness stores servers in its own shape; the UI works with one neutral shape:
// { transport: 'stdio'|'http'|'sse', command, args[], env{}, url, headers{}, disabled }

const SECRET_NAME = /(key|token|secret|password|passwd|credential|auth)/i;
const SECRET_VALUE = /^(sk-|ghp_|gho_|github_pat_|xox[abp]-|AKIA|AIza|eyJ)|^[A-Za-z0-9+/_=-]{32,}$/;
const looksSecret = (name, value) => {
  const v = String(value == null ? '' : value).replace(/^Bearer\s+/i, '');
  if (!v || /^\$\{?[A-Za-z_]/.test(v) || /^\{env:/.test(v)) return false; // a reference, not a value
  return SECRET_VALUE.test(v) || (SECRET_NAME.test(name) && v.length >= 12);
};

function rawServers(a, file) {
  let servers;
  if (a.mcp.style === 'codex') {
    const text = fsx.readText(file);
    if (text == null) return {};
    try { servers = toml.parse(text).mcp_servers; } catch (e) { throw bad(`${file} could not be parsed (${e.message}). Edit it from the Files tab.`, 409); }
  } else servers = getKey(loadJsonDoc(file), a.mcp.key);
  return servers && typeof servers === 'object' && !Array.isArray(servers) ? servers : {};
}

const strMap = o => (o && typeof o === 'object' && !Array.isArray(o) ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, String(v)])) : {});

function fromRaw(a, name, raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  let s;
  if (a.mcp.style === 'opencode') {
    const cmd = Array.isArray(r.command) ? r.command.map(String) : [];
    s = { transport: r.type === 'remote' ? 'http' : 'stdio', command: cmd[0] || '', args: cmd.slice(1), env: strMap(r.environment), url: r.url || '', headers: strMap(r.headers), disabled: r.enabled === false };
  } else {
    const url = r.httpUrl || r.url || r.serverUrl || '';
    // Gemini-style configs use "url" for SSE and "httpUrl" for streamable HTTP.
    const sse = r.type === 'sse' || (a.mcp.urlKey === 'httpUrl' && !r.httpUrl && !!r.url);
    s = {
      transport: url ? (sse ? 'sse' : 'http') : 'stdio', command: String(r.command || ''), args: Array.isArray(r.args) ? r.args.map(String) : [],
      env: strMap(r.env), url: String(url), headers: strMap(r.headers || r.http_headers), disabled: r.disabled === true || r.enabled === false,
    };
  }
  const secrets = [...Object.entries(s.env), ...Object.entries(s.headers)].filter(([k, v]) => looksSecret(k, v)).map(([k]) => k);
  return { name, ...s, secrets };
}

function toRaw(a, server, prev) {
  const s = server && typeof server === 'object' ? server : {};
  const raw = { ...(prev && typeof prev === 'object' ? prev : {}) };
  for (const k of ['command', 'args', 'env', 'environment', 'url', 'httpUrl', 'serverUrl', 'headers', 'http_headers']) delete raw[k];
  const has = o => o && typeof o === 'object' && Object.keys(o).length > 0;
  const remote = s.transport === 'http' || s.transport === 'sse';
  const sse = s.transport === 'sse';
  if (remote && !s.url) throw bad('A remote server needs a URL.');
  if (!remote && !s.command) throw bad('A local server needs a command.');
  const flag = a.mcp.disable; // 'disabled' or 'enabled', when the harness has such a switch
  if (flag === 'disabled') { if (s.disabled) raw.disabled = true; else delete raw.disabled; }
  if (flag === 'enabled') { if (s.disabled) raw.enabled = false; else delete raw.enabled; }

  if (a.mcp.style === 'opencode') {
    if (remote) Object.assign(raw, { type: 'remote', url: s.url }, has(s.headers) ? { headers: s.headers } : {});
    else Object.assign(raw, { type: 'local', command: [s.command, ...list(s.args)] }, has(s.env) ? { environment: s.env } : {});
    return raw;
  }
  if (remote) {
    if (a.mcp.urlKey === 'httpUrl') raw[sse ? 'url' : 'httpUrl'] = s.url;
    else raw[a.mcp.urlKey || 'url'] = s.url;
    if (a.mcp.httpType) raw.type = sse ? 'sse' : a.mcp.httpType;
    else if (sse && a.mcp.urlKey !== 'httpUrl') raw.type = 'sse';
    else if (raw.type === 'sse' || raw.type === 'stdio') delete raw.type;
    if (has(s.headers)) raw[a.mcp.style === 'codex' ? 'http_headers' : 'headers'] = s.headers;
  } else {
    if (raw.type && raw.type !== 'stdio') delete raw.type;
    raw.command = s.command;
    if (list(s.args).length) raw.args = list(s.args);
    if (has(s.env)) raw.env = s.env;
  }
  return raw;
}

function listMcp({ harness, project }) {
  const a = adapter(harness);
  if (!a.mcp) return { supported: false, scopes: [] };
  const proj = checkProject(project);
  const scopes = [];
  for (const scope of ['global', 'project']) {
    const file = scopedFile(a.mcp, proj, scope);
    if (!file) continue;
    const entry = { scope, file, exists: fsx.exists(file), servers: [] };
    try { entry.servers = Object.entries(rawServers(a, file)).map(([name, raw]) => fromRaw(a, name, raw)); } catch (e) { entry.error = e.message; }
    scopes.push(entry);
  }
  return { supported: true, canDisable: !!a.mcp.disable, scopes };
}

function planMcp(body) {
  const name = String(body.name || '').trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(name) || RESERVED.test(name)) throw bad('Server name may only contain letters, digits, dot, dash and underscore.');
  const scope = body.scope === 'project' ? 'project' : 'global';
  const proj = scope === 'project' ? checkProject(body.project) : '';
  if (scope === 'project' && !proj) throw bad('Pick a project in Scope first.');
  const changes = [];
  const warnings = [];
  for (const id of list(body.harnesses || body.harness)) {
    const a = adapter(id);
    const file = a.mcp && scopedFile(a.mcp, proj, scope);
    if (!file) { warnings.push(`${a.name} has no ${scope} MCP config AgentDeck can write; skipped.`); continue; }
    const before = fsx.readText(file);
    const servers = rawServers(a, file);
    const prev = Object.prototype.hasOwnProperty.call(servers, name) ? servers[name] : undefined;
    let after;
    if (a.mcp.style === 'codex') {
      if (body.remove && toml.definedInline(before || '', ['mcp_servers', name])) throw bad(`${name} is written inline in ${file}. Remove it from the Files tab.`, 409);
      after = body.remove ? toml.removeTable(before || '', ['mcp_servers', name]) : toml.setTable(before || '', ['mcp_servers', name], toRaw(a, body.server, prev));
    } else {
      const doc = loadJsonDoc(file);
      const next = { ...servers };
      if (body.remove) delete next[name];
      else next[name] = toRaw(a, body.server, prev);
      setKey(doc, a.mcp.key, next);
      after = dumpJson(doc);
    }
    if (path.basename(file) === '.claude.json') warnings.push('Claude Code rewrites .claude.json while it is running. Close Claude Code before applying, or the change may be overwritten.');
    changes.push({ path: file, before, after });
  }
  if (!body.remove) {
    const s = fromRaw({ mcp: {} }, name, { ...body.server, env: body.server.env, headers: body.server.headers });
    if (s.transport === 'stdio') warnings.push(`This makes the harness run "${body.server.command}" on your machine each session. Only add servers you trust.`);
    if (s.secrets.length) warnings.push(`${s.secrets.join(', ')} will be stored in plain text in the config file${scope === 'project' ? ', inside the project folder: make sure that file is not committed' : ''}.`);
  }
  return { changes, warnings };
}

function applyMcp(body) {
  const plan = planMcp(body);
  return fsx.withBatch(body.remove ? 'Remove MCP server' : 'MCP server', () => ({ results: core.applyChanges(plan.changes), warnings: plan.warnings }));
}

// ---- hooks ----------------------------------------------------------------------
// Claude-style layout: { Event: [ { matcher, hooks: [ { type: 'command', command, timeout } ] } ] }
// hooks.key is where that tree sits in the file; [] means the file itself is the tree.

const HOOK_DIR = path.join(fsx.APP_DIR, 'hooks');
const fwd = p => p.replace(/\\/g, '/');

function hookTree(a, file) {
  const doc = loadJsonDoc(file);
  const tree = getKey(doc, a.hooks.key);
  return { doc, tree: tree && typeof tree === 'object' && !Array.isArray(tree) ? tree : {} };
}

function listHooks({ harness, project }) {
  const a = adapter(harness);
  if (!a.hooks) return { supported: false, scopes: [] };
  const proj = checkProject(project);
  const scopes = [];
  for (const scope of ['global', 'project']) {
    const file = scopedFile(a.hooks, proj, scope);
    if (!file) continue;
    const entry = { scope, file, hooks: [] };
    try {
      for (const [event, groups] of Object.entries(hookTree(a, file).tree)) {
        list(Array.isArray(groups) ? groups : []).forEach((g, gi) => list(g && Array.isArray(g.hooks) ? g.hooks : []).forEach((hk, hi) => {
          const command = String((hk && (hk.command || hk.prompt || hk.url)) || '');
          const recipe = RECIPES.find(r => command.includes(`/hooks/${r.script}`));
          entry.hooks.push({
            id: `${event}/${gi}/${hi}`, event, matcher: (g && g.matcher) || '', type: (hk && hk.type) || 'command', command,
            timeout: hk && hk.timeout != null ? hk.timeout : '', editable: !hk || (hk.type || 'command') === 'command', recipe: recipe ? recipe.id : null, recipeTitle: recipe ? recipe.title : null,
          });
        }));
      }
    } catch (e) { entry.error = e.message; }
    scopes.push(entry);
  }
  return { supported: true, events: a.hooks.events, recipes: a.hooks.events.includes('PreToolUse') ? RECIPES.map(({ source, ...r }) => r) : [], note: a.hooks.note || '', scopes };
}

function planHook(body) {
  const a = adapter(body.harness);
  if (!a.hooks) throw bad(`${a.name} hooks are not supported.`);
  const scope = body.scope === 'project' ? 'project' : 'global';
  const proj = scope === 'project' ? checkProject(body.project) : '';
  const file = scopedFile(a.hooks, proj, scope);
  if (!file) throw bad(`${a.name} has no ${scope} hooks file. Pick a project in Scope first.`);
  const before = fsx.readText(file);
  const { doc, tree: current } = hookTree(a, file);
  const tree = { ...current };
  const changes = [];
  const warnings = [];
  let hook = body.hook && typeof body.hook === 'object' ? body.hook : {};

  if (body.id) {
    const [event, gi, hi] = String(body.id).split('/');
    const groups = Object.prototype.hasOwnProperty.call(tree, event) && Array.isArray(tree[event]) ? tree[event].map(g => ({ ...g, hooks: [...list(g && g.hooks)] })) : null;
    if (!groups || !groups[gi] || !groups[gi].hooks[hi]) throw bad('That hook no longer exists. Reload and try again.', 409);
    groups[gi].hooks.splice(Number(hi), 1);
    const kept = groups.filter(g => g.hooks.length);
    if (kept.length) tree[event] = kept; else delete tree[event];
  }
  if (body.recipe) {
    const r = RECIPES.find(x => x.id === body.recipe);
    if (!r) throw bad('Unknown recipe.');
    if (!a.hooks.events.includes(r.event)) throw bad(`${a.name} has no ${r.event} event, so this recipe does not apply.`);
    const script = path.join(HOOK_DIR, r.script);
    if (fsx.readText(script) !== r.source) changes.push({ path: script, before: fsx.readText(script), after: r.source });
    const arg = r.param ? ` ${JSON.stringify(String((body.params && body.params[r.param.key]) || r.param.default))}` : '';
    hook = { event: r.event, matcher: r.matcher, command: `node "${fwd(script)}"${arg}`, timeout: r.timeout };
    const dup = list(tree[r.event]).some(g => list(g && g.hooks).some(hk => hk && String(hk.command || '').includes(`/hooks/${r.script}`)));
    if (dup) throw bad('That recipe is already installed here. Remove it first to change its settings.', 409);
    warnings.push(`The hook runs a small script AgentDeck saves at ${script}. It needs Node on the PATH the harness uses.`);
  }
  if (!body.remove) {
    if (!a.hooks.events.includes(hook.event) || RESERVED.test(hook.event)) throw bad('Pick an event.');
    if (!String(hook.command || '').trim()) throw bad('A hook needs a command.');
    const entry = { type: 'command', command: String(hook.command).trim() };
    const timeout = Number(hook.timeout);
    if (hook.timeout !== '' && hook.timeout != null && Number.isFinite(timeout) && timeout > 0) entry.timeout = timeout;
    const matcher = String(hook.matcher || '').trim();
    tree[hook.event] = [...list(tree[hook.event]), { ...(matcher ? { matcher } : {}), hooks: [entry] }];
    warnings.push('A hook runs its shell command automatically, with your permissions, every time the event fires.');
  }
  let next = doc;
  if (a.hooks.key.length) setKey(doc, a.hooks.key, Object.keys(tree).length ? tree : undefined);
  else next = tree;
  changes.push({ path: file, before, after: dumpJson(next) });
  if (a.hooks.note) warnings.push(a.hooks.note);
  return { changes, warnings };
}

function applyHook(body) {
  const plan = planHook(body);
  return fsx.withBatch(body.remove ? 'Remove hook' : 'Hook', () => ({ results: core.applyChanges(plan.changes), warnings: plan.warnings }));
}

// ---- hook recipes ---------------------------------------------------------------
// Each recipe is a small Node script (no jq, no bash), so it behaves the same on Windows,
// macOS and Linux. Protocol: the event arrives as JSON on stdin; exit code 2 blocks the
// action and sends stderr to the agent.

const READ_EVENT = "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{let j={};try{j=JSON.parse(s)}catch{}\n";

const RECIPES = [
  {
    id: 'guard-destructive', title: 'Block destructive shell commands', event: 'PreToolUse', matcher: 'Bash', timeout: 10, script: 'guard-destructive.js',
    description: 'Stops rm -rf on root/home/wildcards, force pushes, hard resets, git clean, dropping tables, disk overwrites and piping downloads into a shell. The agent is told why and asked to hand the command to you.',
    enforces: ['autonomy'],
    source: `// AgentDeck hook recipe: block destructive shell commands.
${READ_EVENT}const cmd=String((j.tool_input&&(j.tool_input.command||j.tool_input.cmd))||'');
const rules=[
[/\\brm\\s+(-[a-zA-Z]*\\s+)*-[a-zA-Z]*[rR][a-zA-Z]*\\s+(-[a-zA-Z]*\\s+)*(["']?)(\\/|~|\\$HOME|\\*|\\.\\.?)\\3(\\s|$|\\/\\*)/,'recursive delete of a root, home, parent or wildcard path'],
[/\\bgit\\s+push\\b[^|;&]*\\s(--force|-f)(\\s|$)/,'force push (use --force-with-lease yourself if it is really needed)'],
[/\\bgit\\s+reset\\s+--hard\\b/,'git reset --hard discards uncommitted work'],
[/\\bgit\\s+clean\\s+-[a-zA-Z]*f/,'git clean deletes untracked files'],
[/\\bgit\\s+checkout\\s+(--\\s+)?\\.(\\s|$)/,'git checkout . discards uncommitted work'],
[/\\b(drop|truncate)\\s+(table|database|schema)\\b/i,'dropping or truncating a table or database'],
[/\\bmkfs(\\.|\\s)|\\bdd\\s+[^|;&]*of=\\/dev\\//,'overwriting a disk'],
[/(curl|wget)\\b[^|;&]*\\|\\s*(sudo\\s+)?(ba|z|fi)?sh\\b/,'piping a download straight into a shell'],
[/\\bRemove-Item\\b[^|;]*-Recurse\\b[^|;]*(\\s|["'])([A-Za-z]:\\\\?|~|\\$HOME|\\$env:USERPROFILE)(["']|\\s|$)/i,'recursive delete of a drive or home folder'],
[/\\bformat\\s+[A-Za-z]:/i,'formatting a drive'],
[/\\bchmod\\s+-R\\s+777\\b/,'making a whole tree world-writable'],
];
for(const [re,why] of rules) if(re.test(cmd)){process.stderr.write('Blocked by the AgentDeck guard: '+why+'. Do not retry or work around it. Tell the user the exact command so they can run it themselves.\\n');process.exit(2)}
process.exit(0)});
`,
  },
  {
    id: 'protect-secrets', title: 'Keep the agent out of secret files', event: 'PreToolUse', matcher: 'Read|Edit|Write|MultiEdit', timeout: 10, script: 'protect-secrets.js',
    description: 'Blocks reading or editing .env files, private keys, credential files and anything under a secrets folder.',
    enforces: [],
    source: `// AgentDeck hook recipe: keep the agent out of secret files.
${READ_EVENT}const t=j.tool_input||{};const file=String(t.file_path||t.path||t.notebook_path||'').replace(/\\\\/g,'/');
const base=file.split('/').pop()||'';
const hit=/^\\.env(\\..*)?$/.test(base)&&!/\\.(example|sample|template)$/.test(base)
 ||/\\.(pem|key|p12|pfx|keystore)$/i.test(base)||/^id_(rsa|dsa|ecdsa|ed25519)$/.test(base)
 ||/^(credentials|\\.npmrc|\\.pypirc|\\.netrc)$/i.test(base)||/(^|\\/)(secrets?|\\.aws|\\.ssh|\\.gnupg)\\//i.test(file);
if(hit){process.stderr.write('Blocked by the AgentDeck guard: '+base+' looks like a secrets file. Do not read or change it. Ask the user for the specific value you need.\\n');process.exit(2)}
process.exit(0)});
`,
  },
  {
    id: 'tests-before-done', title: 'Tests must pass before the agent finishes', event: 'Stop', matcher: '', timeout: 600, script: 'tests-before-done.js',
    description: 'Runs your test command when the agent tries to stop. If it fails, the agent is shown the output and has to keep working. It will not loop: a second failure in a row lets the agent stop and report.',
    param: { key: 'command', label: 'Test command', default: 'npm test' },
    enforces: ['testing', 'verifyDone'],
    source: `// AgentDeck hook recipe: tests must pass before the agent finishes.
${READ_EVENT}if(j.stop_hook_active)process.exit(0); // already retried once: let it stop and report
const cmd=process.argv[2]||'npm test';
try{require('child_process').execSync(cmd,{cwd:j.cwd||process.cwd(),stdio:'pipe',timeout:570000});process.exit(0)}
catch(e){const out=String((e.stdout||'')+(e.stderr||'')||e.message).slice(-4000);
process.stderr.write('The checks failed ('+cmd+'). Fix the cause, do not edit the tests to pass, then finish.\\n'+out+'\\n');process.exit(2)}});
`,
  },
  {
    id: 'format-on-edit', title: 'Format files after every edit', event: 'PostToolUse', matcher: 'Edit|Write|MultiEdit', timeout: 60, script: 'format-on-edit.js',
    description: 'Runs your formatter on each file the agent changes, so style never costs a review round. {file} is replaced by the file path.',
    param: { key: 'command', label: 'Formatter command', default: 'npx prettier --write {file}' },
    enforces: [],
    source: `// AgentDeck hook recipe: format files after every edit.
${READ_EVENT}const t=j.tool_input||{};const file=t.file_path||t.path;if(!file)process.exit(0);
const cmd=(process.argv[2]||'npx prettier --write {file}').replace('{file}','"'+String(file).replace(/"/g,'')+'"'); // plain quotes: cmd.exe does not unescape backslashes
try{require('child_process').execSync(cmd,{cwd:j.cwd||process.cwd(),stdio:'ignore',timeout:55000})}catch{}
process.exit(0)});
`,
  },
  {
    id: 'log-commands', title: 'Keep a log of every shell command', event: 'PreToolUse', matcher: 'Bash', timeout: 5, script: 'log-commands.js',
    description: 'Appends each command the agent runs, with the time and folder, to ~/.agentdeck/command-log.txt. Useful for audits and for seeing what happened while you were away.',
    enforces: [],
    source: `// AgentDeck hook recipe: keep a log of every shell command.
${READ_EVENT}const cmd=String((j.tool_input&&(j.tool_input.command||j.tool_input.cmd))||'');
if(cmd){const fs=require('fs'),p=require('path'),dir=p.join(require('os').homedir(),'.agentdeck');
try{fs.mkdirSync(dir,{recursive:true});fs.appendFileSync(p.join(dir,'command-log.txt'),new Date().toISOString()+'\\t'+(j.cwd||'')+'\\t'+cmd.replace(/\\r?\\n/g,' \\u23ce ')+'\\n')}catch{}}
process.exit(0)});
`,
  },
];

module.exports = { listMcp, planMcp, applyMcp, listHooks, planHook, applyHook, RECIPES, rawServers, fromRaw, looksSecret, scopedFile, HOOK_DIR };
