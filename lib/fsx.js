// File helpers. Every change to a user's file goes through writeSafe()/removeSafe(), which
// back up the previous version first and record it so the change can be undone.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const toml = require('./toml');

const HOME = os.homedir();
const APP_DIR = path.join(HOME, '.agentdeck');
const BACKUP_DIR = path.join(APP_DIR, 'backups');
const BACKUP_INDEX = path.join(BACKUP_DIR, 'index.json');
const STATE_FILE = path.join(APP_DIR, 'state.json');
const MAX_BACKUPS = 400;

const BLOCK_START = '<!-- agentdeck:start (managed by AgentDeck: change it there, edits here are overwritten) -->';
const BLOCK_END = '<!-- agentdeck:end -->';
const BLOCK_ANY = /<!-- agentdeck:start[^>]*-->[\s\S]*?<!-- agentdeck:end -->/g;

function fail(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function expand(p) {
  if (!p) return p;
  let out = p.replace(/^~(?=[\\/]|$)/, HOME);
  out = out.replace(/%([A-Za-z_()0-9]+)%/g, (m, name) => process.env[name] || m);
  return path.normalize(out);
}

function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function readText(p) {
  try { return fs.readFileSync(p, 'utf8').replace(/^﻿/, ''); } catch { return null; }
}

function readJson(p) {
  const text = readText(p);
  if (text == null) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function listDir(p) {
  try { return fs.readdirSync(p, { withFileTypes: true }); } catch { return []; }
}

function mtime(p) {
  try { return fs.statSync(p).mtimeMs; } catch { return 0; }
}

function size(p) {
  try { return fs.statSync(p).size; } catch { return 0; }
}

function writeAtomic(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.agentdeck-tmp`;
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, p);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
    throw e;
  }
}

// ---- backups and undo -----------------------------------------------------------

let seq = 0;
let batch = null; // { id, label } while a user action is being applied

function loadIndex() {
  const index = readJson(BACKUP_INDEX);
  return Array.isArray(index) ? index.filter(e => e && typeof e.original === 'string') : [];
}

function saveIndex(index) {
  const dropped = index.length > MAX_BACKUPS ? index.splice(0, index.length - MAX_BACKUPS) : [];
  for (const e of dropped) if (e.file) try { fs.rmSync(path.join(BACKUP_DIR, e.file), { recursive: true, force: true }); } catch { /* already gone */ }
  writeAtomic(BACKUP_INDEX, JSON.stringify(index, null, 2));
}

function record(entry) {
  const index = loadIndex();
  index.push({ id: crypto.randomBytes(6).toString('hex'), time: Date.now(), batch: batch ? batch.id : null, label: batch ? batch.label : '', ...entry });
  saveIndex(index);
}

// Copy p (file or folder) into BACKUP_DIR. Returns the backup's file name, or null.
function backup(p) {
  if (!exists(p)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const hash = crypto.createHash('sha1').update(path.resolve(p)).digest('hex').slice(0, 8);
  const name = `${stamp}-${String(seq++).padStart(4, '0')}-${hash}__${path.basename(p)}`;
  const dest = path.join(BACKUP_DIR, name);
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const dir = isDir(p);
  if (dir) fs.cpSync(p, dest, { recursive: true, errorOnExist: true, force: false });
  else fs.copyFileSync(p, dest, fs.constants.COPYFILE_EXCL);
  record({ file: name, original: path.resolve(p), isDir: dir });
  return name;
}

function friendly(e, p) {
  if (['EPERM', 'EBUSY', 'EACCES', 'EROFS'].includes(e.code)) return fail(`Could not write ${p}: it is read-only or open in another program. Nothing was changed.`, 409);
  if (e.code === 'EEXIST' || e.code === 'ENOTDIR') return fail(`Could not write ${p}: a file is in the way of a folder it needs.`, 409);
  return e;
}

function writeSafe(p, content) {
  // Write through symlinks (dotfile managers) instead of replacing the link with a file.
  let target = p;
  try { target = fs.realpathSync(p); } catch { /* new file */ }
  let raw = null;
  try { raw = fs.readFileSync(target, 'utf8'); } catch { /* new file */ }
  const prev = raw == null ? null : raw.replace(/^﻿/, '');
  // Keep the file's own line endings and byte-order mark.
  if (prev != null && /\r\n/.test(prev) && !/\r\n/.test(content)) content = content.replace(/\n/g, '\r\n');
  if (prev === content) return { path: p, changed: false };
  let mode = null;
  try { mode = fs.statSync(target).mode; } catch { /* new file */ }
  try {
    const saved = backup(target);
    if (prev == null) record({ file: null, original: path.resolve(target), created: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.agentdeck-tmp`;
    try {
      fs.writeFileSync(tmp, (raw != null && raw.startsWith('﻿') ? '﻿' : '') + content, 'utf8');
      if (mode != null) try { fs.chmodSync(tmp, mode); } catch { /* not supported here */ }
      fs.renameSync(tmp, target);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
      throw e;
    }
    return { path: p, changed: true, backup: saved, created: prev == null };
  } catch (e) { throw friendly(e, p); }
}

function removeSafe(p) {
  if (!exists(p)) return { path: p, changed: false };
  try {
    const saved = backup(p);
    fs.rmSync(p, { recursive: true, force: true });
    return { path: p, changed: true, backup: saved, removed: true };
  } catch (e) { throw friendly(e, p); }
}

// Group every write made by fn() so the whole action can be undone at once.
function withBatch(label, fn) {
  const outer = batch;
  batch = outer || { id: crypto.randomBytes(6).toString('hex'), label };
  try { return { ...fn(), batch: batch.id }; } finally { batch = outer; }
}

function restoreEntry(entry) {
  if (entry.created) return removeSafe(entry.original);
  const src = path.join(BACKUP_DIR, entry.file);
  if (!exists(src)) throw fail('That backup file is missing.', 404);
  if (entry.isDir) {
    if (exists(entry.original)) removeSafe(entry.original);
    fs.cpSync(src, entry.original, { recursive: true });
    return { path: entry.original, changed: true, restoredDir: true };
  }
  return writeSafe(entry.original, fs.readFileSync(src, 'utf8').replace(/^﻿/, ''));
}

function restoreBackup(id) {
  const entry = loadIndex().find(e => e.id === id || e.file === id);
  if (!entry) throw fail('Unknown backup.', 404);
  return withBatch('Restore backup', () => ({ results: [restoreEntry(entry)] }));
}

// Put back everything one action changed: restore edited files, remove created ones.
function undoBatch(id) {
  const entries = loadIndex().filter(e => e.batch === id);
  if (!entries.length) throw fail('Nothing to undo for that change.', 404);
  return withBatch('Undo', () => ({ results: entries.reverse().map(restoreEntry) }));
}

function listBackups() {
  return loadIndex().reverse();
}

// ---- managed instruction block ---------------------------------------------------

function blocks(text) {
  return text ? [...text.matchAll(BLOCK_ANY)].map(m => m[0]) : [];
}

// The newest managed block's body (files should hold one; older strays are cleaned on write).
function getBlock(text) {
  const all = blocks(text);
  if (!all.length) return null;
  return all[all.length - 1].replace(/^<!-- agentdeck:start[^>]*-->/, '').replace(BLOCK_END, '').trim();
}

function setBlock(text, body) {
  const src = text || '';
  const eol = /\r\n/.test(src) ? '\r\n' : '\n';
  const pieces = src.replace(/\r\n/g, '\n').split(BLOCK_ANY);
  if (pieces.length === 1 && !(body && body.trim())) return src; // no block to remove, none to add
  // The user's own text keeps its leading whitespace; only the seams around blocks are tidied.
  const base = pieces.map((s, i) => (i === 0 ? s.trimEnd() : s.trim())).filter(s => s.trim()).join('\n\n');
  let out;
  if (!body || !body.trim()) out = base ? base + '\n' : '';
  else {
    const block = `${BLOCK_START}\n${body.trim()}\n${BLOCK_END}\n`;
    out = base ? `${base}\n\n${block}` : block;
  }
  return eol === '\n' ? out : out.replace(/\n/g, eol);
}

// ---- frontmatter ----------------------------------------------------------------
// A deliberately small YAML reader. It understands scalars, inline lists, dash lists and
// block scalars. Anything else (nested maps, lists of maps) is kept as COMPLEX and its
// original lines are written back untouched, so editing one key never damages another.

const COMPLEX = Object.freeze({ complex: true });
const isComplex = v => v === COMPLEX;

function scalarValue(raw) {
  let t = raw.trim();
  if (t.startsWith('"')) {
    const end = t.match(/^"((?:[^"\\]|\\.)*)"/);
    if (end) { try { return JSON.parse(end[0]); } catch { return end[1]; } }
  }
  if (t.startsWith("'")) {
    const end = t.match(/^'((?:[^']|'')*)'/);
    if (end) return end[1].replace(/''/g, "'");
  }
  t = t.replace(/\s+#.*$/, '');
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === '' || t === '~' || t === 'null') return '';
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return Number(t);
  return t;
}

function splitInlineList(inner) {
  const out = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (quote) { cur += c; if (c === '\\' && quote === '"') cur += inner[++i] ?? ''; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === ',') { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out.map(scalarValue).filter(v => v !== '');
}

function entryValue(first, rest) {
  const lines = rest.filter(l => l.trim() !== '' && !/^\s*#/.test(l));
  if (/^[|>][+-]?\d*$/.test(first)) {
    const indent = Math.min(...rest.filter(l => l.trim()).map(l => l.match(/^\s*/)[0].length), 99);
    const body = rest.map(l => l.slice(Math.min(indent, l.length)));
    while (body.length && !body[body.length - 1].trim()) body.pop();
    return first[0] === '|' ? body.join('\n') : body.join('\n').replace(/([^\n])\n(?!\n)/g, '$1 ').replace(/\n\n/g, '\n');
  }
  if (first === '') {
    if (!lines.length) return '';
    const items = lines.map(l => l.match(/^\s*-\s+(.*)$/));
    if (items.every(Boolean) && items.every(m => !/^[A-Za-z0-9_.-]+:(\s|$)/.test(m[1]) && !/^[[{]/.test(m[1]))) return items.map(m => scalarValue(m[1]));
    return COMPLEX;
  }
  if (lines.length) return COMPLEX; // a scalar followed by continuation lines: leave alone
  if (/^\[.*\]$/.test(first)) return /[{[]/.test(first.slice(1, -1)) ? COMPLEX : splitInlineList(first.slice(1, -1));
  if (/^\{/.test(first)) return COMPLEX;
  return scalarValue(first);
}

function parseFrontmatter(text) {
  const src = text || '';
  const m = src.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/) || src.match(/^---[ \t]*\r?\n()---[ \t]*(?:\r?\n|$)([\s\S]*)$/);
  if (!m) return { data: {}, body: src, raw: {}, head: [] };
  const data = {};
  const raw = {};
  const head = [];
  let key = null;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_.-]+):(?:[ \t]+(.*))?[ \t]*$/);
    if (kv && !['__proto__', 'constructor', 'prototype'].includes(kv[1])) { key = kv[1]; raw[key] = [line]; continue; }
    if (key) raw[key].push(line); else head.push(line);
  }
  for (const [k, lines] of Object.entries(raw)) {
    while (lines.length > 1 && !lines[lines.length - 1].trim()) lines.pop();
    const first = (lines[0].match(/^[^:]+:(?:[ \t]+(.*))?$/)[1] || '').trim();
    data[k] = entryValue(first, lines.slice(1));
  }
  return { data, body: m[2], raw, head };
}

function yamlScalar(v) {
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  const s = String(v);
  if (s === '' || /[:#[\]{}&*!|>'"%@`,\\]|^\s|\s$|^[-?]/.test(s) || /^(true|false|null|yes|no|on|off|~)$/i.test(s) || /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return JSON.stringify(s);
  return s;
}

function yamlEntry(k, v, indent = '') {
  if (Array.isArray(v)) return [`${indent}${k}: [${v.map(yamlScalar).join(', ')}]`];
  if (v && typeof v === 'object') return [`${indent}${k}:`, ...Object.entries(v).flatMap(([kk, vv]) => yamlEntry(kk, vv, indent + '  '))];
  if (typeof v === 'string' && v.includes('\n')) return [`${indent}${k}: |-`, ...v.split('\n').map(l => (l ? `${indent}  ${l}` : ''))];
  return [`${indent}${k}: ${yamlScalar(v)}`];
}

const sameValue = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);

// prev is the parseFrontmatter() result of the file being edited. Keys whose value did not
// change are written back exactly as they were, including comments and nested structure.
function buildFrontmatter(data, body, prev) {
  const lines = prev ? [...prev.head] : [];
  const order = [...(prev ? Object.keys(prev.raw) : []), ...Object.keys(data)].filter((k, i, a) => a.indexOf(k) === i);
  for (const k of order) {
    if (!(k in data)) continue;
    const v = data[k];
    if (prev && k in prev.data && sameValue(prev.data[k], v)) { lines.push(...prev.raw[k]); continue; }
    if (v == null || v === '' || isComplex(v) || (Array.isArray(v) && !v.length)) continue;
    lines.push(...yamlEntry(k, v));
  }
  return `---\n${lines.join('\n')}\n---\n\n${String(body || '').trim()}\n`;
}

// ---- dotted-path helpers for JSON settings --------------------------------------

const UNSAFE_KEY = /^(__proto__|constructor|prototype)$/;

function getPath(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null || typeof o !== 'object' || !Object.prototype.hasOwnProperty.call(o, k) ? undefined : o[k]), obj);
}

function setPath(obj, dotted, value) {
  const keys = dotted.split('.');
  if (keys.some(k => UNSAFE_KEY.test(k))) throw fail('That setting name is not allowed.');
  const unset = value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length);
  let o = obj;
  const trail = [];
  for (const k of keys.slice(0, -1)) {
    if (typeof o[k] !== 'object' || o[k] == null || Array.isArray(o[k])) {
      if (unset) return obj; // nothing to remove
      o[k] = {};
    }
    trail.push([o, k]);
    o = o[k];
  }
  const last = keys[keys.length - 1];
  if (!unset) { o[last] = value; return obj; }
  if (!Object.prototype.hasOwnProperty.call(o, last)) return obj;
  delete o[last];
  // Drop parents this removal left empty, so unsetting leaves no "env": {} behind.
  for (const [parent, k] of trail.reverse()) { if (Object.keys(parent[k]).length) break; delete parent[k]; }
  return obj;
}

// ---- app state -------------------------------------------------------------------

const plain = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

function loadState() {
  const text = readText(STATE_FILE);
  let s = null;
  if (text != null) {
    try { s = JSON.parse(text); } catch { s = null; }
    if (!s || typeof s !== 'object' || Array.isArray(s)) {
      // Never overwrite a damaged file silently: set it aside and start clean.
      try { fs.renameSync(STATE_FILE, `${STATE_FILE}.broken-${Date.now()}`); } catch { /* leave it */ }
      s = null;
    }
  }
  s = s || {};
  return { ...s, profiles: plain(s.profiles), presets: plain(s.presets), manualProjects: plain(s.manualProjects), dismissed: plain(s.dismissed) };
}

function saveState(state) {
  writeAtomic(STATE_FILE, JSON.stringify(state, null, 2));
}

function slug(s) {
  return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}

// Rough token estimate (about 4 characters per token for English and code).
const tokens = text => Math.ceil(String(text || '').length / 4);

module.exports = {
  HOME, APP_DIR, BACKUP_DIR, BACKUP_INDEX, STATE_FILE, BLOCK_START, BLOCK_END,
  fail, expand, exists, isDir, readText, readJson, listDir, mtime, size, writeAtomic,
  backup, writeSafe, removeSafe, withBatch, restoreBackup, undoBatch, listBackups,
  blocks, getBlock, setBlock,
  parseFrontmatter, buildFrontmatter, COMPLEX, isComplex,
  getPath, setPath, tomlGet: toml.getTopLevel, tomlSet: toml.setTopLevel,
  loadState, saveState, slug, tokens,
};
