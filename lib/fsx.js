// File helpers: every write goes through writeSafe(), which backs up the previous content first.
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const APP_DIR = path.join(HOME, '.agentdeck');
const BACKUP_DIR = path.join(APP_DIR, 'backups');
const BACKUP_INDEX = path.join(BACKUP_DIR, 'index.json');
const STATE_FILE = path.join(APP_DIR, 'state.json');

const BLOCK_START = '<!-- agentdeck:start (managed block, edit in AgentDeck) -->';
const BLOCK_END = '<!-- agentdeck:end -->';
const BLOCK_RE = /\n*<!-- agentdeck:start[^>]*-->[\s\S]*?<!-- agentdeck:end -->\n*/;

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

// Copies p (file or folder) into BACKUP_DIR and records where it came from.
function backup(p) {
  if (!exists(p)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = `${stamp}__${path.basename(p)}`;
  const dest = path.join(BACKUP_DIR, name);
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const dir = isDir(p);
  if (dir) fs.cpSync(p, dest, { recursive: true });
  else fs.copyFileSync(p, dest);
  const index = readJson(BACKUP_INDEX) || [];
  index.push({ file: name, original: path.resolve(p), time: Date.now(), isDir: dir });
  fs.writeFileSync(BACKUP_INDEX, JSON.stringify(index, null, 2), 'utf8');
  return dest;
}

function writeSafe(p, content) {
  const prev = readText(p);
  if (prev === content) return { path: p, changed: false, backup: null };
  const saved = backup(p);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.agentdeck-tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, p);
  return { path: p, changed: true, backup: saved, created: prev == null };
}

function removeSafe(p) {
  if (!exists(p)) return { path: p, changed: false };
  const saved = backup(p);
  fs.rmSync(p, { recursive: true, force: true });
  return { path: p, changed: true, backup: saved, removed: true };
}

// --- managed instruction block -------------------------------------------------

function getBlock(text) {
  if (!text) return null;
  const m = text.match(BLOCK_RE);
  if (!m) return null;
  return m[0].replace(/<!-- agentdeck:start[^>]*-->/, '').replace(BLOCK_END, '').trim();
}

function setBlock(text, body) {
  const base = (text || '').replace(BLOCK_RE, '\n\n').replace(/\s+$/, '');
  if (!body || !body.trim()) return base ? base + '\n' : '';
  const block = `${BLOCK_START}\n${body.trim()}\n${BLOCK_END}\n`;
  return base ? `${base}\n\n${block}` : block;
}

// --- frontmatter (flat YAML subset: scalars and inline/dash lists) ---------------

function parseFrontmatter(text) {
  const m = (text || '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { data: {}, body: text || '' };
  const data = {};
  let listKey = null;
  for (const line of m[1].split(/\r?\n/)) {
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && listKey) { data[listKey].push(unquote(item[1])); continue; }
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, raw] = kv;
    if (raw === '') { data[key] = []; listKey = key; continue; }
    listKey = null;
    if (/^\[.*\]$/.test(raw)) data[key] = raw.slice(1, -1).split(',').map(s => unquote(s.trim())).filter(Boolean);
    else data[key] = unquote(raw);
  }
  for (const k of Object.keys(data)) if (Array.isArray(data[k]) && data[k].length === 0) data[k] = '';
  return { data, body: m[2] };
}

function unquote(s) {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

function yamlScalar(v) {
  const s = String(v);
  if (s === '' || /[:#\[\]{}&*!|>'"%@`,]|^\s|\s$|^(true|false|null|yes|no|~)$/i.test(s)) return JSON.stringify(s);
  return s;
}

function buildFrontmatter(data, body) {
  const lines = [];
  for (const [k, v] of Object.entries(data)) {
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) continue;
    if (Array.isArray(v)) lines.push(`${k}: [${v.map(yamlScalar).join(', ')}]`);
    else if (typeof v === 'boolean' || typeof v === 'number') lines.push(`${k}: ${v}`);
    else lines.push(`${k}: ${yamlScalar(v)}`);
  }
  return `---\n${lines.join('\n')}\n---\n\n${(body || '').trim()}\n`;
}

// --- dotted-path helpers for JSON settings --------------------------------------

function getPath(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function setPath(obj, dotted, value) {
  const keys = dotted.split('.');
  const unset = value === undefined || value === null || value === '';
  let o = obj;
  for (const k of keys.slice(0, -1)) {
    if (typeof o[k] !== 'object' || o[k] == null || Array.isArray(o[k])) {
      if (unset) return obj; // nothing to remove, and don't leave empty parents behind
      o[k] = {};
    }
    o = o[k];
  }
  const last = keys[keys.length - 1];
  if (unset) delete o[last];
  else o[last] = value;
  return obj;
}

// --- TOML: read/set top-level scalar keys without disturbing the rest ------------

function tomlValue(v) {
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  return JSON.stringify(String(v));
}

function tomlTopLevelEnd(lines) {
  const i = lines.findIndex(l => /^\s*\[/.test(l));
  return i === -1 ? lines.length : i;
}

function tomlGet(text, key) {
  const lines = (text || '').split(/\r?\n/);
  const end = tomlTopLevelEnd(lines);
  const re = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*(.+?)\\s*(#.*)?$`);
  for (let i = 0; i < end; i++) {
    const m = lines[i].match(re);
    if (!m) continue;
    const raw = m[1];
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
    return unquote(raw);
  }
  return undefined;
}

function tomlSet(text, key, value) {
  const lines = (text || '').split(/\r?\n/);
  const end = tomlTopLevelEnd(lines);
  const re = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`);
  const unset = value === undefined || value === null || value === '';
  for (let i = 0; i < end; i++) {
    if (!re.test(lines[i])) continue;
    if (unset) lines.splice(i, 1);
    else lines[i] = `${key} = ${tomlValue(value)}`;
    return lines.join('\n');
  }
  if (unset) return text || '';
  let at = end;
  while (at > 0 && lines[at - 1].trim() === '') at--;
  lines.splice(at, 0, `${key} = ${tomlValue(value)}`);
  if (at === lines.length - 1) lines.push('');
  return lines.join('\n');
}

// --- app state -------------------------------------------------------------------

function loadState() {
  return readJson(STATE_FILE) || { profiles: {}, presets: {} };
}

function saveState(state) {
  fs.mkdirSync(APP_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

function slug(s) {
  return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}

module.exports = {
  HOME, APP_DIR, BACKUP_DIR, BACKUP_INDEX, BLOCK_START, BLOCK_END,
  expand, exists, isDir, readText, readJson, listDir, mtime,
  backup, writeSafe, removeSafe,
  getBlock, setBlock, parseFrontmatter, buildFrontmatter,
  getPath, setPath, tomlGet, tomlSet,
  loadState, saveState, slug,
};
