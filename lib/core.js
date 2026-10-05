// Engine: detection, behavior profiles, native settings, agents/skills/commands, raw files,
// backups and presets. MCP servers and hooks live in integrations.js; usage, health, drift
// and the context stack live in insights.js.
const fs = require('fs');
const path = require('path');
const fsx = require('./fsx');
const levers = require('./levers');
const toml = require('./toml');
const { ADAPTERS } = require('./adapters');

const VERSION = require('../package.json').version;

const KIND_META = {
  agents: { label: 'Agents', noun: 'agent' },
  skills: { label: 'Skills', noun: 'skill' },
  commands: { label: 'Commands', noun: 'command' },
};

const bad = fsx.fail;

// Windows and macOS file systems ignore case; Linux does not.
const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';
const norm = p => (CASE_INSENSITIVE ? path.resolve(p).toLowerCase() : path.resolve(p));
const adapter = id => ADAPTERS.find(a => a.id === id) || (() => { throw bad(`Unknown harness: ${id}`); })();
const list = v => (v == null ? [] : Array.isArray(v) ? v : [v]);

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
  for (const bin of d.bins || []) if (findOnPath(bin)) evidence.push(`${bin} on PATH`);
  for (const dir of d.dirs || []) if (fsx.exists(fsx.expand(dir))) evidence.push(dir);
  for (const ext of d.extensions || []) if (editorExtensions().some(n => n.startsWith(ext.toLowerCase()))) evidence.push(`editor extension ${ext}`);
  return evidence;
}

function hasSqlite() {
  try { require('node:sqlite'); return true; } catch { return false; }
}

let known = null; // normalized project paths seen in the last scan; the only folders we write into
let lastScan = null;

function scan() {
  extensionDirs = null;
  const state = fsx.loadState();
  const seen = new Set();
  const harnesses = ADAPTERS.map(a => {
    const evidence = detect(a);
    let projects = [];
    try { projects = a.projects ? a.projects() : []; } catch { projects = []; }
    for (const p of list(state.manualProjects[a.id])) projects.push({ path: p, manual: true });
    const byPath = new Map();
    for (const p of projects) {
      // A relative or root "project" would let a transcript point us at the wrong folder.
      if (!p || typeof p.path !== 'string' || !path.isAbsolute(p.path)) continue;
      const full = path.resolve(p.path);
      if (full === path.parse(full).root || norm(full) === norm(fsx.HOME)) continue;
      const key = norm(full);
      const prev = byPath.get(key);
      if (!prev) byPath.set(key, { ...p, path: full });
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
      tuned: !!state.profiles[`${a.id}|global`],
      hasNative: (a.native || []).length > 0,
      permissionPresets: a.permissionPresets || [],
      mcp: a.mcp ? { project: !!a.mcp.project } : null,
      hooks: a.hooks ? { project: !!a.hooks.project, events: a.hooks.events, recipes: a.hooks.events.includes('PreToolUse') } : null,
      needsSqlite: !!a.needsSqlite,
      itemKinds: Object.entries(a.items || {}).map(([type, k]) => ({ type, ...KIND_META[type], fields: k.fields || [], note: k.note || '', project: !!k.project, global: !!k.global })),
      files: (a.files || []).map(f => ({ label: f.label, scope: f.scope, path: f.path ? fsx.expand(f.path) : null, rel: f.rel || null })),
    };
  });
  known = seen;
  harnesses.sort((x, y) => Number(y.installed) - Number(x.installed));
  lastScan = { home: fsx.HOME, version: VERSION, node: process.versions.node, sqlite: hasSqlite(), platform: process.platform, sep: path.sep, harnesses };
  return lastScan;
}

const currentScan = () => lastScan || scan();

function checkProject(project) {
  if (!project) return '';
  if (!known) scan();
  if (typeof project !== 'string' || !known.has(norm(project))) throw bad('That folder is not a project any detected harness has worked in. Add it from the Projects tab first.', 403);
  return path.resolve(project);
}

const knownProjects = () => { if (!known) scan(); return [...known]; };

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

const profileKey = (id, proj) => `${id}|${proj ? norm(proj) : 'global'}`;

// How the managed block in a file relates to what AgentDeck last applied there.
//   none: nothing applied, no block   synced: block matches the saved profile
//   edited: block was changed by hand  untracked: a block exists but no saved profile
function blockStatus(a, proj, state) {
  const target = instructionTarget(a, proj);
  if (!target) return { target: null, status: 'unsupported' };
  const text = fsx.readText(target);
  const block = fsx.getBlock(text);
  const saved = state.profiles[profileKey(a.id, proj)];
  const expected = saved ? levers.compile(saved) : '';
  let status = 'none';
  if (block != null && !saved) status = 'untracked';
  else if (saved && (block || '') === expected.trim()) status = expected ? 'synced' : 'none';
  else if (saved) status = block == null ? 'missing' : 'edited';
  return { target, text, block: block || '', status, saved: saved || null, blockCount: fsx.blocks(text).length };
}

function lintInstructions(a, text, target) {
  const out = [];
  if (!text) return out;
  const lines = text.split(/\r?\n/).length;
  const bytes = Buffer.byteLength(text, 'utf8');
  const cap = a.context && a.context.maxBytes;
  if (cap && bytes > cap) out.push(`${path.basename(target)} is ${Math.round(bytes / 1024)} KB; ${a.name} stops reading at ${Math.round(cap / 1024)} KB, so the end of the file is ignored.`);
  else if (lines > 200) out.push(`${path.basename(target)} is ${lines} lines long. Long instruction files are followed less reliably and cost tokens on every request.`);
  if (fsx.blocks(text).length > 1) out.push('This file contains more than one AgentDeck block. Applying will merge them into one.');
  return out;
}

function getProfile({ harness, project }) {
  const a = adapter(harness);
  const proj = checkProject(project);
  const state = fsx.loadState();
  const st = blockStatus(a, proj, state);
  const native = [];
  for (const def of a.native || []) {
    const t = settingsTarget(a, def, proj);
    if (!t) continue;
    const { file, ...rest } = def;
    let value = readSetting(t, def.key);
    let help = rest.help;
    if (def.kind === 'list') value = Array.isArray(value) ? value.map(String) : [];
    else if (value && typeof value === 'object') { value = undefined; help = `${help ? help + ' ' : ''}Currently a custom rule set in the file; choosing a value here replaces it.`; }
    native.push({ ...rest, help, file: t.path, value });
  }
  const text = st.text || '';
  return {
    target: st.target, exists: st.text != null,
    block: st.block || '', status: st.status,
    hasOtherContent: !!text && fsx.setBlock(text, '').trim().length > 0,
    fileTokens: fsx.tokens(text), fileLines: text ? text.split(/\r?\n/).length : 0,
    lint: st.target ? lintInstructions(a, text, st.target) : [],
    values: st.saved || {},
    native,
  };
}

function coerce(def, value) {
  if (def.kind === 'list') {
    const items = (Array.isArray(value) ? value : String(value || '').split(/\r?\n/)).map(s => String(s).trim()).filter(Boolean);
    return [...new Set(items)];
  }
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

function parseJsonSettings(file, text) {
  if (text == null || !text.trim()) return {};
  let obj;
  try { obj = JSON.parse(text); } catch { throw bad(`${file} is not plain JSON (it has comments or a syntax error), so AgentDeck will not rewrite it. Edit it from the Files tab.`, 409); }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw bad(`${file} does not contain a JSON object. Edit it from the Files tab.`, 409);
  return obj;
}

function planProfile(body) {
  const ids = list(body.harnesses || body.harness);
  if (!ids.length) throw bad('Pick at least one harness.');
  const proj = checkProject(body.project);
  const changes = [];
  const warnings = [];
  const values = body.values && typeof body.values === 'object' ? body.values : null;
  const block = values ? levers.compile(values) : '';

  for (const id of ids) {
    const a = adapter(id);
    if (values) {
      const target = instructionTarget(a, proj);
      if (!target) warnings.push(`${a.name} has no ${proj ? 'project' : 'global'} instruction file; skipped.`);
      else {
        const before = fsx.readText(target);
        const after = fsx.setBlock(before, block);
        if (before == null && !after.trim()) { /* nothing to write: don't create an empty file */ }
        else if (before != null && !after.trim() && fsx.blocks(before).length) changes.push({ path: target, before, after: null, removed: true });
        else changes.push({ path: target, before, after });
      }
    }
    if (body.native && typeof body.native === 'object') {
      const byFile = new Map();
      for (const def of a.native || []) {
        if (!Object.prototype.hasOwnProperty.call(body.native, def.key)) continue;
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
        if (target.format === 'toml') {
          after = edits.reduce((text, [k, v]) => {
            const cur = fsx.tomlGet(text, k);
            // e.g. [approval_policy.granular]: a scalar with the same name would be invalid TOML
            if (v !== undefined && cur && typeof cur === 'object' && !Array.isArray(cur)) throw bad(`"${k}" is a table with its own settings in ${target.path}. Edit it from the Files tab.`, 409);
            return fsx.tomlSet(text, k, v);
          }, before || '');
        }
        else {
          const obj = parseJsonSettings(target.path, before);
          for (const [k, v] of edits) fsx.setPath(obj, k, v);
          after = JSON.stringify(obj, null, 2) + '\n';
          if (before == null && Object.keys(obj).length === 0) after = null;
        }
        const same = after == null || (before || '').replace(/\r\n/g, '\n') === after;
        // Reformatting alone is not a change worth writing.
        const sameData = !same && target.format !== 'toml' && before != null && JSON.stringify(parseJsonSettings(target.path, before)) === JSON.stringify(JSON.parse(after));
        if (!same && !sameData) changes.push({ path: target.path, before, after });
      }
    }
  }
  return { changes, warnings, block, blockTokens: fsx.tokens(block) };
}

function applyChanges(changes) {
  return changes.map(c => (c.removed ? fsx.removeSafe(c.path) : fsx.writeSafe(c.path, c.after)));
}

function applyProfile(body) {
  const plan = planProfile(body);
  return fsx.withBatch(body.native ? 'Native settings' : 'Behavior profile', () => {
    const results = applyChanges(plan.changes);
    if (body.values && typeof body.values === 'object') {
      const state = fsx.loadState();
      for (const id of list(body.harnesses || body.harness)) {
        if (instructionTarget(adapter(id), body.project ? path.resolve(body.project) : '')) state.profiles[profileKey(id, body.project)] = body.values;
      }
      fsx.saveState(state);
    }
    return { results, warnings: plan.warnings };
  });
}

// ---- agents, skills, commands ---------------------------------------------------

const itemFile = k => k.file || 'SKILL.md';
const itemExt = k => k.ext || '.md';

// A kind may list several candidate folders (older and newer names). All are read;
// new items go into the first that exists, else the first listed.
function itemDirs(a, type, proj) {
  const k = a.items && a.items[type];
  if (!k) return [];
  const dirs = [];
  for (const g of list(k.global)) dirs.push({ dir: fsx.expand(g), scope: 'global' });
  if (proj) for (const p of list(k.project)) dirs.push({ dir: path.join(proj, p), scope: 'project' });
  return dirs;
}

function writeDir(k, proj) {
  const dirs = proj ? list(k.project).map(p => path.join(proj, p)) : list(k.global).map(fsx.expand);
  return dirs.find(fsx.isDir) || dirs[0] || null;
}

// What a stored value looks like in the edit form (and so what "unchanged" means).
const formText = v => (Array.isArray(v) ? v.join(', ') : v == null ? '' : String(v));

function readItem(file, k, scope) {
  const text = fsx.readText(file);
  if (text == null) return null;
  const fallback = k.layout === 'dir' ? path.basename(path.dirname(file)) : path.basename(file).slice(0, -itemExt(k).length);
  const base = { path: file, scope };
  if (k.format === 'toml') {
    let data;
    try { data = toml.parse(text); } catch { return { ...base, name: fallback, description: 'Could not parse this file; open it from Files.', fields: {}, body: '', readOnly: true, source: 'unreadable', complex: [] }; }
    const { name, description, [k.bodyKey]: body, ...rest } = data;
    const fields = {};
    const complex = [];
    for (const [key, v] of Object.entries(rest)) { if (v && typeof v === 'object' && !Array.isArray(v)) complex.push(key); else fields[key] = formText(v); }
    return { ...base, name: formText(name) || fallback, description: formText(description), fields, body: formText(body), complex };
  }
  const { data, body } = fsx.parseFrontmatter(text);
  const fields = {};
  const complex = [];
  for (const [key, v] of Object.entries(data)) {
    if (key === 'name' || (key === 'description' && !fsx.isComplex(v))) continue;
    if (fsx.isComplex(v)) complex.push(key); else fields[key] = formText(v);
  }
  return { ...base, name: formText(data.name) || fallback, description: fsx.isComplex(data.description) ? '' : formText(data.description), fields, body, complex };
}

const SKIP_ITEM = /^(readme|license|changelog|contributing|_|\.)/i;

function listItems({ harness, project }) {
  const a = adapter(harness);
  const proj = checkProject(project);
  const out = {};
  for (const [type, k] of Object.entries(a.items || {})) {
    out[type] = [];
    const seenFiles = new Set();
    for (const { dir, scope } of itemDirs(a, type, proj)) {
      for (const e of fsx.listDir(dir)) {
        if (SKIP_ITEM.test(e.name)) continue;
        let file = null;
        if (k.layout === 'dir' && e.isDirectory()) file = path.join(dir, e.name, itemFile(k));
        else if (k.layout !== 'dir' && e.isFile() && e.name.toLowerCase().endsWith(itemExt(k))) file = path.join(dir, e.name);
        if (!file || seenFiles.has(norm(file))) continue;
        seenFiles.add(norm(file));
        const item = readItem(file, k, scope);
        if (item) out[type].push(item);
      }
    }
    out[type].sort((x, y) => x.name.localeCompare(y.name));
  }
  return out;
}

// Resolve a path the client sent back to an item file we actually own.
function ownedItem(p) {
  if (!p || typeof p !== 'string') throw bad('Missing path.');
  const target = norm(p);
  const projects = knownProjects();
  for (const a of ADAPTERS) {
    for (const [type, k] of Object.entries(a.items || {})) {
      const dirs = list(k.global).map(fsx.expand);
      for (const rel of list(k.project)) for (const proj of projects) dirs.push(path.join(proj, rel));
      for (const dir of dirs) {
        const rel = path.relative(norm(dir), target);
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
        const parts = rel.split(path.sep);
        const want = CASE_INSENSITIVE ? itemFile(k).toLowerCase() : itemFile(k);
        const ok = k.layout === 'dir' ? parts.length === 2 && parts[1] === want : parts.length === 1 && parts[0].endsWith(itemExt(k));
        if (ok) return { a, type, k };
      }
    }
  }
  throw bad('That path is not an agent, skill or command file managed by a known harness.', 403);
}

function fieldValue(f, v) {
  if (f.list) return (Array.isArray(v) ? v : String(v).split(',')).map(s => String(s).trim()).filter(Boolean);
  if (f.bool) return v === true || v === 'true';
  if (f.num && Number.isFinite(Number(v))) return Number(v);
  return v;
}

// Build an item file. prevText is the file being edited: keys the form does not know
// about, and keys whose value did not change, are written back exactly as they were.
function itemContent(k, body, prevText) {
  const editing = prevText != null;
  const description = String(body.description || '').trim();
  const fields = body.fields && typeof body.fields === 'object' ? body.fields : {};

  if (k.format === 'toml' && editing) {
    // Line-level edits: comments, key order and string styles in the file are kept.
    let data;
    try { data = toml.parse(prevText); } catch { throw bad('This file could not be parsed, so AgentDeck will not overwrite it. Open it from the Files tab.', 409); }
    let text = prevText;
    const put = (key, value) => {
      if (data[key] && typeof data[key] === 'object' && !Array.isArray(data[key])) throw bad(`"${key}" is a table in this file. Edit it from the Files tab.`, 409);
      text = toml.setTopLevel(text, key, value);
    };
    if (k.nameInFrontmatter !== false && !data.name) put('name', fsx.slug(body.name));
    if (formText(data.description) !== description) put('description', description);
    for (const f of k.fields || []) {
      const v = fields[f.key];
      if (v == null || v === '') { if (f.key in data) put(f.key, ''); } else if (formText(data[f.key]) !== String(v)) put(f.key, fieldValue(f, v));
    }
    const nextBody = String(body.body || '').trim();
    if (formText(data[k.bodyKey]).trim() !== nextBody) put(k.bodyKey, nextBody + '\n');
    return text;
  }
  if (k.format === 'toml') {
    const data = {};
    if (k.nameInFrontmatter !== false) data.name = fsx.slug(body.name);
    data.description = description;
    for (const f of k.fields || []) {
      const v = fields[f.key];
      if (v == null || v === '') delete data[f.key];
      else if (formText(data[f.key]) !== String(v)) data[f.key] = fieldValue(f, v);
    }
    const { name, description: d, [k.bodyKey]: _old, ...rest } = data;
    const simple = Object.fromEntries(Object.entries(rest).filter(([, v]) => !(v && typeof v === 'object' && !Array.isArray(v))));
    const tables = Object.fromEntries(Object.entries(rest).filter(([, v]) => v && typeof v === 'object' && !Array.isArray(v)));
    return toml.stringify({ ...(name != null ? { name } : {}), description: d, ...simple, [k.bodyKey]: String(body.body || '').trim() + '\n', ...tables });
  }

  const prev = editing ? fsx.parseFrontmatter(prevText) : null;
  const data = prev ? { ...prev.data } : {};
  // Only a new item gets a slugged name; an existing name is the harness's identifier.
  if (k.nameInFrontmatter !== false && !(prev && prev.data.name)) data.name = fsx.slug(body.name);
  // A description the reader could not represent (shown empty in the form) is only
  // replaced when the user typed a new one; otherwise its original lines are kept.
  const hadDesc = prev ? prev.data.description : undefined;
  if (fsx.isComplex(hadDesc)) { if (description) data.description = description; }
  else if (!(prev && formText(hadDesc) === description)) data.description = description;
  for (const f of k.fields || []) {
    const v = fields[f.key];
    const had = prev ? prev.data[f.key] : undefined;
    if (v == null || v === '') { if (!fsx.isComplex(had)) delete data[f.key]; continue; }
    if (had !== undefined && !fsx.isComplex(had) && formText(had) === formText(v)) continue; // unchanged
    data[f.key] = fieldValue(f, v);
  }
  if (!data.description) delete data.description;
  return fsx.buildFrontmatter(data, body.body, prev);
}

function planItem(body) {
  if (body.remove) {
    const { k } = ownedItem(body.path);
    const file = path.resolve(body.path);
    const target = k.layout === 'dir' ? path.dirname(file) : file;
    return { changes: [{ path: target, before: fsx.readText(file), after: null, removed: true }], warnings: [] };
  }
  const changes = [];
  const warnings = [];
  if (body.path) {
    const { k } = ownedItem(body.path);
    const file = path.resolve(body.path);
    const before = fsx.readText(file);
    if (before == null) throw bad('That file no longer exists. Reload and try again.', 409);
    changes.push({ path: file, before, after: itemContent(k, body, before) });
    return { changes, warnings };
  }
  const name = fsx.slug(body.name);
  if (!name) throw bad('Name must contain letters or digits.');
  if (!KIND_META[body.type]) throw bad('Unknown item type.');
  const proj = body.scope === 'project' ? checkProject(body.project) : '';
  if (body.scope === 'project' && !proj) throw bad('Pick a project in Scope first.');
  for (const id of list(body.harnesses)) {
    const a = adapter(id);
    const k = a.items && a.items[body.type];
    if (!k) { warnings.push(`${a.name} does not support ${body.type}; skipped.`); continue; }
    const base = writeDir(k, proj);
    if (!base) { warnings.push(`${a.name} has no ${proj ? 'project' : 'global'} location for ${body.type}; skipped.`); continue; }
    const file = k.layout === 'dir' ? path.join(base, name, itemFile(k)) : path.join(base, name + itemExt(k));
    if (changes.some(c => norm(c.path) === norm(file))) continue; // several harnesses share this location
    if (k.layout === 'dir' && fsx.exists(path.dirname(file)) && !fsx.isDir(path.dirname(file))) throw bad(`${path.dirname(file)} exists as a file, so a ${KIND_META[body.type].noun} folder cannot be created there. Pick another name.`, 409);
    const before = fsx.readText(file);
    if (before != null) warnings.push(`${file} already exists and will be overwritten.`);
    changes.push({ path: file, before, after: itemContent(k, body, null) });
  }
  if (!changes.length && !warnings.length) throw bad('Pick at least one harness.');
  return { changes, warnings };
}

function saveItem(body) {
  const plan = planItem({ ...body, remove: false });
  return fsx.withBatch(`Save ${KIND_META[body.type] ? KIND_META[body.type].noun : 'item'}`, () => ({ results: applyChanges(plan.changes), warnings: plan.warnings }));
}

function deleteItem(body) {
  const plan = planItem({ path: body.path, remove: true });
  return fsx.withBatch('Delete item', () => ({ results: applyChanges(plan.changes) }));
}

// ---- raw files ------------------------------------------------------------------

function ownedFile(p) {
  if (!p || typeof p !== 'string') throw bad('Missing path.');
  const target = norm(p);
  const projects = knownProjects();
  for (const a of ADAPTERS) {
    for (const f of a.files || []) {
      if (f.scope === 'global' && f.path && norm(fsx.expand(f.path)) === target) return path.resolve(p);
      if (f.scope === 'project' && f.rel) for (const proj of projects) if (norm(path.join(proj, f.rel)) === target) return path.resolve(p);
    }
  }
  throw bad('That file is not one of a known harness\'s config files.', 403);
}

function readFile({ path: p }) {
  const file = ownedFile(p);
  const content = fsx.readText(file);
  return { path: file, exists: content != null, content: content || '' };
}

function syntaxWarning(file, content) {
  try {
    if (/\.json$/i.test(file) && content.trim()) JSON.parse(content);
    if (/\.toml$/i.test(file)) toml.parse(content);
  } catch (e) { return `This does not parse as ${/\.toml$/i.test(file) ? 'TOML' : 'JSON'} (${e.message}). The harness may refuse to read it.`; }
  return null;
}

function planFile({ path: p, content }) {
  const file = ownedFile(p);
  if (typeof content !== 'string') throw bad('Missing content.');
  const warning = syntaxWarning(file, content);
  return { changes: [{ path: file, before: fsx.readText(file), after: content }], warnings: warning ? [warning] : [] };
}

function writeFile(body) {
  const plan = planFile(body);
  return fsx.withBatch('Edit file', () => ({ results: applyChanges(plan.changes), warnings: plan.warnings }));
}

// ---- backups and undo -----------------------------------------------------------

function listBackups() {
  return { dir: fsx.BACKUP_DIR, backups: fsx.listBackups().slice(0, 300) };
}

function planRestore({ id }) {
  const entry = fsx.listBackups().find(b => b.id === id);
  if (!entry) throw bad('Unknown backup.', 404);
  if (entry.created) return { changes: [{ path: entry.original, before: fsx.readText(entry.original), after: null, removed: true }], warnings: ['This file did not exist before that change, so undoing it removes the file.'] };
  if (entry.isDir) return { changes: [{ path: entry.original, before: null, after: '(folder restored from backup)' }], warnings: fsx.exists(entry.original) ? ['The current folder is replaced (and backed up first).'] : [] };
  return { changes: [{ path: entry.original, before: fsx.readText(entry.original), after: fsx.readText(path.join(fsx.BACKUP_DIR, entry.file)) }], warnings: [] };
}

const restoreBackup = ({ id }) => fsx.restoreBackup(id);
const undo = ({ batch }) => fsx.undoBatch(String(batch || ''));

// ---- presets, export and import -------------------------------------------------

const safeName = n => String(n || '').trim().slice(0, 60);
const reserved = n => /^(__proto__|constructor|prototype)$/.test(n);

// Keep only values for levers that exist, so a shared preset cannot smuggle anything else in.
function cleanValues(values) {
  const out = {};
  if (!values || typeof values !== 'object') return out;
  for (const l of levers.LEVERS) {
    if (!Object.prototype.hasOwnProperty.call(values, l.id)) continue;
    const v = values[l.id];
    if (l.kind === 'choice') { if (l.options.some(o => o.value === v)) out[l.id] = v; }
    else if (l.kind === 'toggle') out[l.id] = v === true;
    else if (typeof v === 'string' || typeof v === 'number') out[l.id] = String(v).slice(0, 8000);
  }
  return out;
}

function listPresets() {
  return { presets: fsx.loadState().presets };
}

function savePreset({ name, values }) {
  const n = safeName(name);
  if (!n || reserved(n) || !values || typeof values !== 'object') throw bad('Preset needs a name and values.');
  const state = fsx.loadState();
  state.presets = { ...state.presets, [n]: cleanValues(values) };
  fsx.saveState(state);
  return { presets: state.presets };
}

function deletePreset({ name }) {
  const state = fsx.loadState();
  if (Object.prototype.hasOwnProperty.call(state.presets, name)) delete state.presets[name];
  fsx.saveState(state);
  return { presets: state.presets };
}

function exportBundle() {
  const state = fsx.loadState();
  return { agentdeck: 1, exported: new Date().toISOString(), presets: state.presets, global: Object.fromEntries(Object.entries(state.profiles).filter(([k]) => k.endsWith('|global')).map(([k, v]) => [k.split('|')[0], v])) };
}

// Imports presets (and each harness's global profile as a preset). Nothing is written to
// harness files: the user reviews and applies from the Behavior tab as usual.
function importBundle({ bundle }) {
  const b = typeof bundle === 'string' ? (() => { try { return JSON.parse(bundle); } catch { throw bad('That is not valid JSON.'); } })() : bundle;
  if (!b || typeof b !== 'object') throw bad('That is not an AgentDeck export.');
  const incoming = {};
  if (b.values && typeof b.values === 'object') incoming[safeName(b.name) || 'Imported preset'] = b.values; // a single shared preset
  for (const [n, v] of Object.entries(b.presets && typeof b.presets === 'object' ? b.presets : {})) incoming[safeName(n)] = v;
  for (const [id, v] of Object.entries(b.global && typeof b.global === 'object' ? b.global : {})) incoming[`${safeName(id)} profile (imported)`] = v;
  const state = fsx.loadState();
  let count = 0;
  for (const [n, v] of Object.entries(incoming)) {
    const values = cleanValues(v);
    if (!n || reserved(n) || !Object.keys(values).length) continue;
    state.presets[n] = values;
    count++;
  }
  if (!count) throw bad('No presets found in that data.');
  fsx.saveState(state);
  return { presets: state.presets, imported: count };
}

// ---- projects added by hand -----------------------------------------------------

function addProject({ harness, path: p }) {
  const dir = String(p || '').trim().replace(/^["']|["']$/g, '');
  if (!path.isAbsolute(dir) || !fsx.isDir(dir)) throw bad('That is not an existing folder. Paste the full path of the project folder.');
  const full = path.resolve(dir);
  if (full === path.parse(full).root || norm(full) === norm(fsx.HOME)) throw bad('Pick a project folder, not a drive or your home folder.');
  const ids = harness === '*' ? currentScan().harnesses.filter(x => x.installed).map(x => x.id) : [adapter(harness).id];
  const state = fsx.loadState();
  for (const id of ids) {
    const items = list(state.manualProjects[id]);
    if (!items.some(x => norm(x) === norm(full))) items.push(full);
    state.manualProjects[id] = items;
  }
  fsx.saveState(state);
  scan();
  return { ok: true, path: full };
}

function removeProject({ harness, path: p }) {
  const a = adapter(harness);
  const state = fsx.loadState();
  state.manualProjects[a.id] = list(state.manualProjects[a.id]).filter(x => norm(x) !== norm(String(p || '')));
  fsx.saveState(state);
  scan();
  return { ok: true };
}

module.exports = {
  VERSION, ADAPTERS, bad, norm, adapter, list, checkProject, knownProjects, currentScan,
  instructionTarget, settingsTarget, readSetting, blockStatus, lintInstructions, profileKey, applyChanges, parseJsonSettings,
  scan, leverCatalog: levers.catalog,
  getProfile, planProfile, applyProfile,
  listItems, planItem, saveItem, deleteItem,
  readFile, planFile, writeFile,
  listBackups, planRestore, restoreBackup, undo,
  listPresets, savePreset, deletePreset, exportBundle, importBundle,
  addProject, removeProject,
};
