// Engine: detection, behavior profiles, agents/skills/commands, raw files, backups.
const fs = require('fs');
const path = require('path');
const fsx = require('./fsx');
const levers = require('./levers');
const toml = require('./toml');
const { ADAPTERS } = require('./adapters');

const KIND_META = {
  agents: { label: 'Agents', noun: 'agent' },
  skills: { label: 'Skills', noun: 'skill' },
  commands: { label: 'Commands', noun: 'command' },
};

function bad(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

const norm = p => path.resolve(p).toLowerCase();
const adapter = id => ADAPTERS.find(a => a.id === id) || (() => { throw bad(`Unknown harness: ${id}`); })();

// ---- detection ----------------------------------------------------------------

function findOnPath(bin) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', '.ps1', ''] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const full = path.join(dir, bin + ext);
      try { if (fs.statSync(full).isFile()) return full; } catch { /* not here */ }
    }
  }
  return null;
}

let extensionDirs = null;
function editorExtensions() {
  if (extensionDirs) return extensionDirs;
  extensionDirs = [];
  for (const root of ['~/.vscode/extensions', '~/.cursor/extensions', '~/.windsurf/extensions', '~/.vscode-insiders/extensions']) {
    for (const e of fsx.listDir(fsx.expand(root))) if (e.isDirectory()) extensionDirs.push(e.name.toLowerCase());
  }
  return extensionDirs;
}

function detect(a) {
  const evidence = [];
  const d = a.detect || {};
  for (const bin of d.bins || []) {
    const hit = findOnPath(bin);
    if (hit) evidence.push(`${bin} on PATH`);
  }
  for (const dir of d.dirs || []) if (fsx.exists(fsx.expand(dir))) evidence.push(dir);
  for (const ext of d.extensions || []) if (editorExtensions().some(n => n.startsWith(ext.toLowerCase()))) evidence.push(`editor extension ${ext}`);
  return evidence;
}

let known = null; // normalized project paths seen in the last scan; the only folders we write into

function scan() {
  extensionDirs = null;
  const state = fsx.loadState();
  const seen = new Set();
  const harnesses = ADAPTERS.map(a => {
    const evidence = detect(a);
    let projects = [];
    try { projects = a.projects ? a.projects() : []; } catch { projects = []; }
    for (const p of (state.manualProjects || {})[a.id] || []) projects.push({ path: p, manual: true });
    const byPath = new Map();
    for (const p of projects) {
      if (!p.path) continue;
      const key = norm(p.path);
      const prev = byPath.get(key);
      if (!prev) byPath.set(key, { ...p, path: path.resolve(p.path) });
      else { prev.lastUsed = Math.max(prev.lastUsed || 0, p.lastUsed || 0); prev.sessions = (prev.sessions || 0) + (p.sessions || 0); prev.manual = prev.manual || p.manual; }
    }
    projects = [...byPath.values()].map(p => {
      const exists = fsx.isDir(p.path);
      if (exists) seen.add(norm(p.path));
      const instr = a.instructions.project && exists ? path.join(p.path, a.instructions.project) : null;
      return {
        path: p.path, name: path.basename(p.path) || p.path, exists,
        lastUsed: p.lastUsed || 0, sessions: p.sessions || 0, manual: !!p.manual,
        hasInstructions: !!instr && fsx.exists(instr),
        tuned: !!state.profiles[`${a.id}|${norm(p.path)}`],
      };
    }).sort((x, y) => y.lastUsed - x.lastUsed);
    return {
      id: a.id, name: a.name, vendor: a.vendor, note: a.note || '', installed: evidence.length > 0, evidence, projects,
      globalInstruction: !!a.instructions.global, projectInstruction: !!a.instructions.project,
      hasNative: (a.native || []).length > 0,
      mcp: a.mcp ? { project: !!a.mcp.project } : null,
      hooks: a.hooks ? { project: !!a.hooks.project, events: a.hooks.events } : null,
      itemKinds: Object.entries(a.items || {}).map(([type, k]) => ({ type, ...KIND_META[type], fields: k.fields || [], note: k.note || '' })),
      files: (a.files || []).map(f => ({ label: f.label, scope: f.scope, path: f.path ? fsx.expand(f.path) : null, rel: f.rel || null })),
    };
  });
  known = seen;
  harnesses.sort((x, y) => Number(y.installed) - Number(x.installed));
  return { home: fsx.HOME, harnesses };
}

function checkProject(project) {
  if (!project) return '';
  if (!known) scan();
  if (!known.has(norm(project))) throw bad('That folder is not a project any detected harness has worked in.', 403);
  return path.resolve(project);
}

// ---- behavior profiles and native settings --------------------------------------

function instructionTarget(a, project) {
  if (project) return a.instructions.project ? path.join(project, a.instructions.project) : null;
  return a.instructions.global ? fsx.expand(a.instructions.global) : null;
}

function settingsTarget(a, def, project) {
  const s = a.settings && a.settings[def.file || 'main'];
  if (!s) return null;
  if (project) return s.project ? { path: path.join(project, s.project), format: s.format } : null;
  return s.global ? { path: fsx.expand(s.global), format: s.format } : null;
}

function readSetting(target, key) {
  const text = fsx.readText(target.path);
  if (text == null) return undefined;
  if (target.format === 'toml') return fsx.tomlGet(text, key);
  try { return fsx.getPath(JSON.parse(text), key); } catch { return undefined; }
}

function getProfile({ harness, project }) {
  const a = adapter(harness);
  const proj = checkProject(project);
  const target = instructionTarget(a, proj);
  const text = target ? fsx.readText(target) : null;
  const state = fsx.loadState();
  const native = [];
  for (const def of a.native || []) {
    const t = settingsTarget(a, def, proj);
    if (!t) continue;
    const { file, ...rest } = def;
    let value = readSetting(t, def.key);
    let help = rest.help;
    if (value && typeof value === 'object') { value = undefined; help = `${help ? help + ' ' : ''}Currently a custom rule set in the file; choosing a value here replaces it.`; }
    native.push({ ...rest, help, file: t.path, value });
  }
  return {
    target, exists: text != null,
    block: fsx.getBlock(text) || '',
    hasOtherContent: !!text && fsx.setBlock(text, '').trim().length > 0,
    values: state.profiles[`${a.id}|${proj ? norm(proj) : 'global'}`] || {},
    native,
  };
}

function coerce(def, value) {
  if (value === '' || value == null) return undefined;
  if (def.kind === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n)) throw bad(`${def.label} must be a number.`);
    return n;
  }
  if (def.kind === 'toggle') return value === true || value === 'true';
  if (def.kind === 'select' && def.options.every(o => typeof o.value === 'number')) return Number(value);
  return String(value);
}

function planProfile(body) {
  const ids = body.harnesses || [body.harness];
  const proj = checkProject(body.project);
  const changes = [];
  const warnings = [];
  const block = body.values ? levers.compile(body.values) : '';

  for (const id of ids) {
    const a = adapter(id);
    if (body.values) {
      const target = instructionTarget(a, proj);
      if (!target) warnings.push(`${a.name} has no ${proj ? 'project' : 'global'} instruction file; skipped.`);
      else {
        const before = fsx.readText(target);
        changes.push({ path: target, before, after: fsx.setBlock(before, block) });
      }
    }
    if (body.native) {
      const byFile = new Map();
      for (const def of a.native || []) {
        if (!(def.key in body.native)) continue;
        const t = settingsTarget(a, def, proj);
        if (!t) continue;
        if (!byFile.has(t.path)) byFile.set(t.path, { target: t, edits: [] });
        const value = coerce(def, body.native[def.key]);
        const opt = (def.options || []).find(o => String(o.value) === String(value));
        if (opt && opt.danger) warnings.push(`${a.name}: "${opt.label}" for ${def.label} removes safety checks. The agent will be able to act without asking.`);
        byFile.get(t.path).edits.push([def.key, value]);
      }
      for (const { target, edits } of byFile.values()) {
        const before = fsx.readText(target.path);
        let after;
        if (target.format === 'toml') after = edits.reduce((text, [k, v]) => fsx.tomlSet(text, k, v), before || '');
        else {
          let obj = {};
          if (before != null && before.trim()) {
            try { obj = JSON.parse(before); } catch { throw bad(`${target.path} is not plain JSON (comments or a syntax error), so AgentDeck will not rewrite it. Edit it from the Files tab.`); }
          }
          for (const [k, v] of edits) fsx.setPath(obj, k, v);
          after = JSON.stringify(obj, null, 2) + '\n';
          if (before == null && Object.keys(obj).length === 0) after = null;
        }
        if (after != null && (before || '') !== after) changes.push({ path: target.path, before, after });
      }
    }
  }
  return { changes, warnings, block };
}

function applyProfile(body) {
  const plan = planProfile(body);
  const results = plan.changes.map(c => fsx.writeSafe(c.path, c.after));
  if (body.values) {
    const state = fsx.loadState();
    const proj = body.project ? norm(body.project) : 'global';
    for (const id of body.harnesses || [body.harness]) state.profiles[`${id}|${proj}`] = body.values;
    fsx.saveState(state);
  }
  return { results, warnings: plan.warnings };
}

// ---- agents, skills, commands ---------------------------------------------------

function itemDirs(a, type, proj) {
  const k = a.items && a.items[type];
  if (!k) return [];
  const dirs = [];
  if (k.global) dirs.push({ dir: fsx.expand(k.global), scope: 'global' });
  if (proj && k.project) dirs.push({ dir: path.join(proj, k.project), scope: 'project' });
  return dirs;
}

function readItem(file, k, scope) {
  const text = fsx.readText(file);
  if (text == null) return null;
  const fallback = k.layout === 'dir' ? path.basename(path.dirname(file)) : path.basename(file).slice(0, -(k.ext || '.md').length);
  if (k.format === 'toml') {
    let data;
    try { data = toml.parse(text); } catch { return { name: fallback, description: 'Could not parse this file; open it from Files.', fields: {}, body: '', path: file, scope, readOnly: true, source: 'unreadable' }; }
    const { name, description, [k.bodyKey]: body, ...fields } = data;
    return { name: name || fallback, description: description || '', fields, body: body || '', path: file, scope };
  }
  const { data, body } = fsx.parseFrontmatter(text);
  const { name, description, ...fields } = data;
  return { name: name || fallback, description: description || '', fields, body, path: file, scope };
}

function listItems({ harness, project }) {
  const a = adapter(harness);
  const proj = checkProject(project);
  const out = {};
  for (const [type, k] of Object.entries(a.items || {})) {
    out[type] = [];
    for (const { dir, scope } of itemDirs(a, type, proj)) {
      for (const e of fsx.listDir(dir)) {
        let file = null;
        if (k.layout === 'dir' && e.isDirectory()) file = path.join(dir, e.name, k.file || 'SKILL.md');
        else if (k.layout !== 'dir' && e.isFile() && e.name.toLowerCase().endsWith(k.ext || '.md')) file = path.join(dir, e.name);
        const item = file && readItem(file, k, scope);
        if (item) out[type].push(item);
      }
    }
    out[type].sort((x, y) => x.name.localeCompare(y.name));
  }
  return out;
}

// Resolve a path the client sent back to an item file we actually own.
function ownedItem(p) {
  if (!known) scan();
  const target = norm(p);
  for (const a of ADAPTERS) {
    for (const [type, k] of Object.entries(a.items || {})) {
      const dirs = [];
      if (k.global) dirs.push(fsx.expand(k.global));
      if (k.project) for (const proj of known) dirs.push(path.join(proj, k.project));
      for (const dir of dirs) {
        const rel = path.relative(norm(dir), target);
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
        const parts = rel.split(path.sep);
        const ok = k.layout === 'dir' ? parts.length === 2 && parts[1] === (k.file || 'SKILL.md').toLowerCase() : parts.length === 1 && parts[0].endsWith(k.ext || '.md');
        if (ok) return { a, type, k };
      }
    }
  }
  throw bad('That path is not an agent, skill or command file managed by a known harness.', 403);
}

// prevText is the file being edited, so keys the form does not know about survive the edit.
function itemContent(k, body, prevText) {
  const isToml = k.format === 'toml';
  let prev = {};
  if (prevText) {
    try { prev = isToml ? toml.parse(prevText) : fsx.parseFrontmatter(prevText).data; } catch { prev = {}; }
  }
  const data = {};
  if (k.nameInFrontmatter !== false) data.name = fsx.slug(body.name);
  data.description = String(body.description || '').trim();
  for (const f of k.fields || []) {
    let v = (body.fields || {})[f.key];
    if (v == null || v === '') continue;
    if (f.list && !Array.isArray(v)) v = String(v).split(',').map(s => s.trim()).filter(Boolean);
    data[f.key] = v;
  }
  const known = new Set(['name', 'description', k.bodyKey, ...(k.fields || []).map(f => f.key)]);
  const extra = Object.fromEntries(Object.entries(prev).filter(([key]) => !known.has(key)));
  if (isToml) return toml.stringify({ ...data, [k.bodyKey]: String(body.body || '').trim() + '\n', ...extra });
  return fsx.buildFrontmatter({ ...data, ...extra }, body.body);
}

function planItem(body) {
  if (body.remove) {
    const { k } = ownedItem(body.path);
    const target = k.layout === 'dir' ? path.dirname(path.resolve(body.path)) : path.resolve(body.path);
    return { changes: [{ path: target, before: fsx.readText(path.resolve(body.path)), after: null, removed: true }], warnings: [] };
  }
  const changes = [];
  const warnings = [];
  if (body.path) {
    const { k } = ownedItem(body.path);
    const file = path.resolve(body.path);
    const existing = readItem(file, k, '') || {};
    const before = fsx.readText(file);
    changes.push({ path: file, before, after: itemContent(k, { ...body, name: existing.name || body.name }, before) });
    return { changes, warnings };
  }
  const name = fsx.slug(body.name);
  if (!name) throw bad('Name must contain letters or digits.');
  const proj = body.scope === 'project' ? checkProject(body.project) : '';
  if (body.scope === 'project' && !proj) throw bad('Pick a project in Scope first.');
  for (const id of body.harnesses || []) {
    const a = adapter(id);
    const k = a.items && a.items[body.type];
    if (!k) { warnings.push(`${a.name} does not support ${body.type}; skipped.`); continue; }
    const base = proj ? (k.project && path.join(proj, k.project)) : (k.global && fsx.expand(k.global));
    if (!base) { warnings.push(`${a.name} has no ${proj ? 'project' : 'global'} location for ${body.type}; skipped.`); continue; }
    const file = k.layout === 'dir' ? path.join(base, name, k.file || 'SKILL.md') : path.join(base, name + (k.ext || '.md'));
    if (changes.some(c => norm(c.path) === norm(file))) continue; // several harnesses share this location
    const before = fsx.readText(file);
    if (before != null) warnings.push(`${file} already exists and will be overwritten.`);
    changes.push({ path: file, before, after: itemContent(k, body) });
  }
  return { changes, warnings };
}

function saveItem(body) {
  const plan = planItem({ ...body, remove: false });
  return { results: plan.changes.map(c => fsx.writeSafe(c.path, c.after)), warnings: plan.warnings };
}

function deleteItem(body) {
  const plan = planItem({ path: body.path, remove: true });
  return { results: plan.changes.map(c => fsx.removeSafe(c.path)) };
}

// ---- raw files ------------------------------------------------------------------

function ownedFile(p) {
  if (!p) throw bad('Missing path.');
  if (!known) scan();
  const target = norm(p);
  for (const a of ADAPTERS) {
    for (const f of a.files || []) {
      if (f.scope === 'global' && f.path && norm(fsx.expand(f.path)) === target) return path.resolve(p);
      if (f.scope === 'project' && f.rel) for (const proj of known) if (norm(path.join(proj, f.rel)) === target) return path.resolve(p);
    }
  }
  throw bad('That file is not one of a known harness\'s config files.', 403);
}

function readFile({ path: p }) {
  const file = ownedFile(p);
  const content = fsx.readText(file);
  return { path: file, exists: content != null, content: content || '' };
}

function writeFile({ path: p, content }) {
  const file = ownedFile(p);
  if (typeof content !== 'string') throw bad('Missing content.');
  return fsx.writeSafe(file, content);
}

// ---- backups and presets --------------------------------------------------------

function listBackups() {
  const index = fsx.readJson(fsx.BACKUP_INDEX) || [];
  return { dir: fsx.BACKUP_DIR, backups: index.slice().reverse().slice(0, 200) };
}

function restoreBackup({ file }) {
  const entry = (fsx.readJson(fsx.BACKUP_INDEX) || []).find(b => b.file === file);
  if (!entry || entry.isDir) throw bad('Unknown backup.', 404);
  const content = fsx.readText(path.join(fsx.BACKUP_DIR, entry.file));
  if (content == null) throw bad('Backup file is missing.', 404);
  return fsx.writeSafe(entry.original, content);
}

function listPresets() {
  return { presets: fsx.loadState().presets || {} };
}

function savePreset({ name, values }) {
  if (!name || typeof values !== 'object') throw bad('Preset needs a name and values.');
  const state = fsx.loadState();
  state.presets = { ...(state.presets || {}), [String(name).slice(0, 60)]: values };
  fsx.saveState(state);
  return { presets: state.presets };
}

function deletePreset({ name }) {
  const state = fsx.loadState();
  if (state.presets) delete state.presets[name];
  fsx.saveState(state);
  return { presets: state.presets || {} };
}

// ---- shared JSON-document helpers (MCP servers, hooks) ---------------------------

function loadJsonDoc(file) {
  const text = fsx.readText(file);
  if (text == null || !text.trim()) return {};
  try { return JSON.parse(text); } catch { throw bad(`${file} is not plain JSON (comments or a syntax error), so AgentDeck will not rewrite it. Edit it from the Files tab.`); }
}

const getKey = (obj, keyPath) => keyPath.reduce((o, k) => (o == null ? undefined : o[k]), obj);

function setKey(obj, keyPath, value) {
  let o = obj;
  for (const k of keyPath.slice(0, -1)) {
    if (typeof o[k] !== 'object' || o[k] == null) o[k] = {};
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

const dumpJson = doc => JSON.stringify(doc, null, 2) + '\n';

// ---- MCP servers ----------------------------------------------------------------
// Each harness stores servers in its own shape; the UI works with one neutral shape:
// { transport: 'stdio'|'http', command, args[], env{}, url, headers{}, disabled }

function rawServers(a, file) {
  if (a.mcp.style === 'codex') {
    const text = fsx.readText(file);
    if (text == null) return {};
    try { return toml.parse(text).mcp_servers || {}; } catch (e) { throw bad(`${file} could not be parsed (${e.message}). Edit it from the Files tab.`); }
  }
  return getKey(loadJsonDoc(file), a.mcp.key) || {};
}

function fromRaw(a, name, raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  if (a.mcp.style === 'opencode') {
    const cmd = Array.isArray(r.command) ? r.command : [];
    return { name, transport: r.type === 'remote' ? 'http' : 'stdio', command: cmd[0] || '', args: cmd.slice(1), env: r.environment || {}, url: r.url || '', headers: r.headers || {}, disabled: r.enabled === false };
  }
  const url = r.url || r.httpUrl || r.serverUrl || '';
  return {
    name, transport: url ? 'http' : 'stdio', command: r.command || '', args: Array.isArray(r.args) ? r.args : [],
    env: r.env || {}, url, headers: r.headers || r.http_headers || {}, disabled: r.disabled === true || r.enabled === false,
  };
}

function toRaw(a, server, prev) {
  const raw = { ...(prev || {}) };
  for (const k of ['command', 'args', 'env', 'environment', 'url', 'httpUrl', 'serverUrl', 'headers', 'http_headers']) delete raw[k];
  const has = o => o && Object.keys(o).length > 0;
  const http = server.transport === 'http';
  if (http && !server.url) throw bad('A remote server needs a URL.');
  if (!http && !server.command) throw bad('A local server needs a command.');
  if (a.mcp.style === 'opencode') {
    if (http) Object.assign(raw, { type: 'remote', url: server.url }, has(server.headers) ? { headers: server.headers } : {});
    else Object.assign(raw, { type: 'local', command: [server.command, ...(server.args || [])] }, has(server.env) ? { environment: server.env } : {});
    return raw;
  }
  if (http) {
    raw[a.mcp.urlKey || 'url'] = server.url;
    if (a.mcp.httpType) raw.type = a.mcp.httpType;
    if (has(server.headers)) raw[a.mcp.style === 'codex' ? 'http_headers' : 'headers'] = server.headers;
  } else {
    if (raw.type && raw.type !== 'stdio') delete raw.type;
    raw.command = server.command;
    if ((server.args || []).length) raw.args = server.args;
    if (has(server.env)) raw.env = server.env;
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
  return { supported: true, scopes };
}

function planMcp(body) {
  const name = String(body.name || '').trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw bad('Server name may only contain letters, digits, dot, dash and underscore.');
  const scope = body.scope === 'project' ? 'project' : 'global';
  const proj = scope === 'project' ? checkProject(body.project) : '';
  if (scope === 'project' && !proj) throw bad('Pick a project in Scope first.');
  const changes = [];
  const warnings = [];
  for (const id of body.harnesses || [body.harness]) {
    const a = adapter(id);
    const file = a.mcp && scopedFile(a.mcp, proj, scope);
    if (!file) { warnings.push(`${a.name} has no ${scope} MCP config AgentDeck can write; skipped.`); continue; }
    const before = fsx.readText(file);
    const servers = rawServers(a, file);
    let after;
    if (a.mcp.style === 'codex') {
      after = body.remove ? toml.removeTable(before || '', ['mcp_servers', name]) : toml.setTable(before || '', ['mcp_servers', name], toRaw(a, body.server, servers[name]));
    } else {
      const doc = loadJsonDoc(file);
      const next = { ...servers };
      if (body.remove) delete next[name];
      else next[name] = toRaw(a, body.server, servers[name]);
      setKey(doc, a.mcp.key, next);
      after = dumpJson(doc);
    }
    if (path.basename(file) === '.claude.json') warnings.push('Claude Code rewrites .claude.json while it is running. Close Claude Code before applying, or the change may be overwritten.');
    changes.push({ path: file, before, after });
  }
  if (!body.remove && body.server.transport !== 'http') warnings.push(`This makes the harness run "${body.server.command}" on your machine each session. Only add servers you trust.`);
  return { changes, warnings };
}

function applyMcp(body) {
  const plan = planMcp(body);
  return { results: plan.changes.map(c => fsx.writeSafe(c.path, c.after)), warnings: plan.warnings };
}

// ---- hooks ----------------------------------------------------------------------
// Claude-style layout: { Event: [ { matcher, hooks: [ { type: 'command', command, timeout } ] } ] }

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
      const tree = getKey(loadJsonDoc(file), a.hooks.key) || {};
      for (const [event, groups] of Object.entries(tree)) {
        (Array.isArray(groups) ? groups : []).forEach((g, gi) => (Array.isArray(g.hooks) ? g.hooks : []).forEach((hk, hi) => entry.hooks.push({
          id: `${event}/${gi}/${hi}`, event, matcher: g.matcher || '', type: hk.type || 'command',
          command: hk.command || hk.prompt || hk.url || '', timeout: hk.timeout ?? '', editable: (hk.type || 'command') === 'command',
        })));
      }
    } catch (e) { entry.error = e.message; }
    scopes.push(entry);
  }
  return { supported: true, events: a.hooks.events, scopes };
}

function planHook(body) {
  const a = adapter(body.harness);
  if (!a.hooks) throw bad(`${a.name} hooks are not supported.`);
  const scope = body.scope === 'project' ? 'project' : 'global';
  const proj = scope === 'project' ? checkProject(body.project) : '';
  const file = scopedFile(a.hooks, proj, scope);
  if (!file) throw bad(`${a.name} has no ${scope} hooks file. Pick a project in Scope first.`);
  const before = fsx.readText(file);
  const doc = loadJsonDoc(file);
  const tree = { ...(getKey(doc, a.hooks.key) || {}) };

  if (body.id) {
    const [event, gi, hi] = String(body.id).split('/');
    const groups = Array.isArray(tree[event]) ? tree[event].map(g => ({ ...g, hooks: [...(g.hooks || [])] })) : null;
    if (!groups || !groups[gi] || !groups[gi].hooks[hi]) throw bad('That hook no longer exists. Reload and try again.', 409);
    groups[gi].hooks.splice(Number(hi), 1);
    const kept = groups.filter(g => g.hooks.length);
    if (kept.length) tree[event] = kept; else delete tree[event];
  }
  if (!body.remove) {
    const hk = body.hook || {};
    if (!a.hooks.events.includes(hk.event)) throw bad('Pick an event.');
    if (!String(hk.command || '').trim()) throw bad('A hook needs a command.');
    const entry = { type: 'command', command: String(hk.command).trim() };
    const timeout = Number(hk.timeout);
    if (hk.timeout !== '' && hk.timeout != null && Number.isFinite(timeout) && timeout > 0) entry.timeout = timeout;
    const group = { hooks: [entry] };
    if (String(hk.matcher || '').trim()) group.matcher = String(hk.matcher).trim();
    tree[hk.event] = [...(tree[hk.event] || []), { ...(group.matcher ? { matcher: group.matcher } : {}), hooks: group.hooks }];
  }
  setKey(doc, a.hooks.key, Object.keys(tree).length ? tree : undefined);
  const warnings = body.remove ? [] : ['A hook runs its shell command automatically, with your permissions, every time the event fires.'];
  return { changes: [{ path: file, before, after: dumpJson(doc) }], warnings };
}

function applyHook(body) {
  const plan = planHook(body);
  return { results: plan.changes.map(c => fsx.writeSafe(c.path, c.after)), warnings: plan.warnings };
}

// ---- projects added by hand -----------------------------------------------------

function addProject({ harness, path: p }) {
  const a = adapter(harness);
  const dir = String(p || '').trim().replace(/^"|"$/g, '');
  if (!path.isAbsolute(dir) || !fsx.isDir(dir)) throw bad('That is not an existing folder. Paste the full path, e.g. C:\\code\\my-app.');
  const state = fsx.loadState();
  const list = ((state.manualProjects = state.manualProjects || {})[a.id] = state.manualProjects[a.id] || []);
  if (!list.some(x => norm(x) === norm(dir))) list.push(path.resolve(dir));
  fsx.saveState(state);
  return { ok: true };
}

function removeProject({ harness, path: p }) {
  const state = fsx.loadState();
  const list = (state.manualProjects || {})[harness] || [];
  state.manualProjects = { ...(state.manualProjects || {}), [harness]: list.filter(x => norm(x) !== norm(p)) };
  fsx.saveState(state);
  return { ok: true };
}

module.exports = {
  listMcp, planMcp, applyMcp, listHooks, planHook, applyHook, addProject, removeProject,
  scan, leverCatalog: levers.catalog,
  getProfile, planProfile, applyProfile,
  listItems, planItem, saveItem, deleteItem,
  readFile, writeFile,
  listBackups, restoreBackup, listPresets, savePreset, deletePreset,
};
