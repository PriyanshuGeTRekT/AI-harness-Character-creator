// Small TOML reader/writer: enough for harness config (strings, numbers, booleans, arrays,
// inline tables, [tables], [[arrays of tables]]). Dates are kept as raw strings.
// Text edits (setTopLevel, setTable, removeTable) change only the lines they own, so
// comments, ordering and line endings in the user's file survive.

const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

function parse(text) {
  const src = String(text || '').replace(/^﻿/, '');
  const root = {};
  let cur = root;
  let i = 0;
  const err = msg => new Error(`TOML: ${msg} at offset ${i}`);
  const skip = newlines => {
    for (;;) {
      const c = src[i];
      if (c === ' ' || c === '\t' || c === '\r' || (newlines && c === '\n')) i++;
      else if (c === '#') while (i < src.length && src[i] !== '\n') i++;
      else break;
    }
  };
  // One left-to-right pass, so an escaped backslash is consumed before anything after it.
  const basic = s => s.replace(/\\(\r?\n[ \t\r\n]*|[ \t]+\r?\n[ \t\r\n]*|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|[\s\S])/g, (m, e) => {
    if (e[0] === '\n' || e[0] === '\r' || e[0] === ' ' || e[0] === '\t') return /\n/.test(e) ? '' : e;
    if ((e[0] === 'u' || e[0] === 'U') && e.length > 1) return String.fromCodePoint(parseInt(e.slice(1), 16));
    return { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', e: '\x1b', '"': '"', '\\': '\\' }[e] ?? e;
  });
  const str = () => {
    const q = src[i];
    if (src.startsWith(q.repeat(3), i)) {
      i += 3;
      if (src[i] === '\r') i++;
      if (src[i] === '\n') i++;
      let raw = '';
      for (;;) {
        if (i >= src.length) throw err('unterminated multi-line string');
        const c = src[i];
        if (q === '"' && c === '\\') { raw += c + (src[i + 1] ?? ''); i += 2; continue; }
        if (c === q) {
          // Up to two quotes may sit directly before the closing delimiter.
          let run = 0;
          while (src[i + run] === q && run < 5) run++;
          if (run >= 3) { raw += q.repeat(run - 3); i += run; break; }
          raw += q.repeat(run); i += run; continue;
        }
        raw += c; i++;
      }
      return q === '"' ? basic(raw) : raw;
    }
    i++;
    let out = '';
    while (i < src.length && src[i] !== q) {
      if (src[i] === '\n') throw err('unterminated string');
      if (q === '"' && src[i] === '\\') { out += src[i] + (src[i + 1] ?? ''); i += 2; } else out += src[i++];
    }
    if (i >= src.length) throw err('unterminated string');
    i++;
    return q === '"' ? basic(out) : out;
  };
  const key = () => {
    const parts = [];
    for (;;) {
      skip(false);
      if (src[i] === '"' || src[i] === "'") parts.push(str());
      else {
        const m = /^[A-Za-z0-9_-]+/.exec(src.slice(i, i + 200));
        if (!m) throw err('bad key');
        parts.push(m[0]);
        i += m[0].length;
      }
      if (FORBIDDEN.has(parts[parts.length - 1])) throw err(`key "${parts[parts.length - 1]}" is not allowed`);
      skip(false);
      if (src[i] === '.') { i++; continue; }
      return parts;
    }
  };
  const bare = tok => {
    if (tok === 'true') return true;
    if (tok === 'false') return false;
    if (/^[+-]?inf$/.test(tok)) return tok[0] === '-' ? -Infinity : Infinity;
    if (/^[+-]?nan$/.test(tok)) return NaN;
    if (/^0x[0-9a-fA-F_]+$/.test(tok)) return parseInt(tok.slice(2).replace(/_/g, ''), 16);
    if (/^0o[0-7_]+$/.test(tok)) return parseInt(tok.slice(2).replace(/_/g, ''), 8);
    if (/^0b[01_]+$/.test(tok)) return parseInt(tok.slice(2).replace(/_/g, ''), 2);
    if (/^[+-]?(\d[\d_]*)(\.\d[\d_]*)?([eE][+-]?\d+)?$/.test(tok)) return Number(tok.replace(/_/g, ''));
    return tok; // dates, times and anything else stay as written
  };
  const value = () => {
    skip(false);
    const c = src[i];
    if (c === '"' || c === "'") return str();
    if (c === '[') {
      i++;
      const arr = [];
      for (;;) {
        skip(true);
        if (i >= src.length) throw err('unterminated array');
        if (src[i] === ']') { i++; return arr; }
        arr.push(value());
        skip(true);
        if (src[i] === ',') i++;
      }
    }
    if (c === '{') {
      i++;
      const obj = {};
      for (;;) {
        skip(true);
        if (i >= src.length) throw err('unterminated inline table');
        if (src[i] === '}') { i++; return obj; }
        const k = key();
        if (src[i] !== '=') throw err('expected =');
        i++;
        assign(obj, k, value());
        skip(true);
        if (src[i] === ',') i++;
      }
    }
    const m = /^[^\s,\]}#]+/.exec(src.slice(i, i + 200));
    if (!m) throw err('bad value');
    i += m[0].length;
    let tok = m[0];
    // "1979-05-27 07:32:00" is one date-time with a space in it.
    if (/^\d{4}-\d{2}-\d{2}$/.test(tok)) {
      const t = /^ (\d{2}:\d{2}[^\s,\]}#]*)/.exec(src.slice(i, i + 40));
      if (t) { tok += ' ' + t[1]; i += t[0].length; }
    }
    return bare(tok);
  };
  const descend = (obj, parts) => {
    for (const p of parts) {
      if (Array.isArray(obj[p])) obj = obj[p][obj[p].length - 1];
      else { if (typeof obj[p] !== 'object' || obj[p] == null) obj[p] = {}; obj = obj[p]; }
    }
    return obj;
  };
  function assign(obj, parts, v) { descend(obj, parts.slice(0, -1))[parts[parts.length - 1]] = v; }

  for (;;) {
    skip(true);
    if (i >= src.length) break;
    if (src.startsWith('[[', i)) {
      i += 2;
      const k = key();
      if (!src.startsWith(']]', i)) throw err('expected ]]');
      i += 2;
      const parent = descend(root, k.slice(0, -1));
      const last = k[k.length - 1];
      if (!Array.isArray(parent[last])) parent[last] = [];
      parent[last].push(cur = {});
    } else if (src[i] === '[') {
      i++;
      const k = key();
      if (src[i] !== ']') throw err('expected ]');
      i++;
      cur = descend(root, k);
    } else {
      const k = key();
      if (src[i] !== '=') throw err('expected =');
      i++;
      assign(cur, k, value());
    }
  }
  return root;
}

// ---- writing --------------------------------------------------------------------

const bareKey = k => (/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k));
const isTable = v => v != null && typeof v === 'object' && !Array.isArray(v);

function number(v) {
  if (Number.isNaN(v)) return 'nan';
  if (!Number.isFinite(v)) return v < 0 ? '-inf' : 'inf';
  return String(v);
}

function inline(v) {
  if (typeof v === 'string') return JSON.stringify(v).replace(/\u007f/g, '\\u007F');
  if (typeof v === 'number') return number(v);
  if (typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `[${v.map(inline).join(', ')}]`;
  if (isTable(v)) return `{ ${Object.entries(v).map(([k, x]) => `${bareKey(k)} = ${inline(x)}`).join(', ')} }`;
  return '""';
}

function scalar(v) {
  if (typeof v !== 'string' || !v.includes('\n')) return inline(v);
  const body = v.replace(/\\/g, '\\\\').replace(/"""/g, '""\\"')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ch => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
  return `"""\n${body}"""`;
}

// One [table] with its keys; nested tables become inline tables.
function table(pathParts, obj) {
  const lines = [`[${pathParts.map(bareKey).join('.')}]`];
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null) lines.push(`${bareKey(k)} = ${scalar(v)}`);
  return lines.join('\n') + '\n';
}

// Whole document: top-level values first, then one section per table value.
function stringify(obj) {
  const top = [];
  const sections = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    if (isTable(v)) sections.push(table([k], v));
    else if (Array.isArray(v) && v.length && v.every(isTable)) for (const item of v) sections.push(table([k], item).replace(/^\[(.*)\]/, '[[$1]]'));
    else top.push(`${bareKey(k)} = ${scalar(v)}`);
  }
  return [top.join('\n'), ...sections].filter(Boolean).join('\n\n').replace(/\n*$/, '\n');
}

// ---- line-level edits -----------------------------------------------------------

// For each line: does it start inside a multi-line string, array or inline table?
// Header and key detection must skip those lines.
function lineStates(lines) {
  const inside = [];
  let ml = null;   // open multi-line string delimiter
  let depth = 0;   // open [ or { in a value
  for (const line of lines) {
    inside.push(ml !== null || depth > 0);
    const isHeader = ml === null && depth === 0 && /^\s*\[/.test(line);
    let i = 0;
    while (i < line.length) {
      if (ml) {
        if (ml === '"""' && line[i] === '\\') { i += 2; continue; }
        if (line.startsWith(ml, i)) {
          let run = 3;
          while (line[i + run] === ml[0] && run < 5) run++;
          i += run; ml = null; continue;
        }
        i++; continue;
      }
      const c = line[i];
      if (c === '#') break;
      if (line.startsWith('"""', i) || line.startsWith("'''", i)) { ml = line.substr(i, 3); i += 3; continue; }
      if (c === '"' || c === "'") {
        i++;
        while (i < line.length && line[i] !== c) i += (c === '"' && line[i] === '\\') ? 2 : 1;
        i++; continue;
      }
      if (!isHeader) {
        if (c === '[' || c === '{') depth++;
        else if ((c === ']' || c === '}') && depth > 0) depth--;
      }
      i++;
    }
  }
  return inside;
}

function headerPath(line) {
  const m = line.match(/^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/);
  if (!m) return null;
  const parts = [];
  const re = /\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*(\.|$)/y;
  let hit;
  while (re.lastIndex < m[1].length && (hit = re.exec(m[1]))) {
    try { parts.push(hit[1] != null ? JSON.parse(`"${hit[1]}"`) : hit[2] != null ? hit[2] : hit[3]); } catch { return null; }
  }
  return parts.length ? parts : null;
}

function split(text) {
  const src = String(text || '');
  const eol = /\r\n/.test(src) ? '\r\n' : '\n';
  const lines = src.split(/\r?\n/);
  return { lines, eol, inside: lineStates(lines) };
}

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Index of the first [table] header: everything before it is top level.
function topLevelEnd(lines, inside) {
  for (let i = 0; i < lines.length; i++) if (!inside[i] && /^\s*\[/.test(lines[i])) return i;
  return lines.length;
}

function getTopLevel(text, key) {
  try {
    const doc = parse(text);
    return Object.prototype.hasOwnProperty.call(doc, key) ? doc[key] : undefined;
  } catch { return undefined; }
}

function setTopLevel(text, key, value) {
  const { lines, eol, inside } = split(text);
  const end = topLevelEnd(lines, inside);
  const re = new RegExp(`^\\s*${escapeRe(bareKey(key))}\\s*=`);
  const unset = value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length);
  const line = unset ? null : `${bareKey(key)} = ${inline(value)}`;
  for (let i = 0; i < end; i++) {
    if (inside[i] || !re.test(lines[i])) continue;
    let last = i; // a multi-line value owns the lines that follow it
    while (last + 1 < lines.length && inside[last + 1]) last++;
    if (unset) lines.splice(i, last - i + 1);
    else lines.splice(i, last - i + 1, line);
    return lines.join(eol);
  }
  if (unset) return String(text || '');
  let at = end;
  while (at > 0 && lines[at - 1].trim() === '') at--;
  lines.splice(at, 0, line);
  if (at === lines.length - 1) lines.push('');
  return lines.join(eol);
}

// Remove [prefix] and every [prefix.*] section, leaving the rest of the file untouched.
function removeTable(text, prefix) {
  const { lines, eol, inside } = split(text);
  const out = [];
  let dropping = false;
  lines.forEach((line, idx) => {
    const p = inside[idx] ? null : headerPath(line);
    if (p) dropping = p.length >= prefix.length && prefix.every((seg, n) => p[n] === seg);
    if (!dropping) out.push(line);
  });
  return out.join(eol).replace(/(\r?\n){3,}/g, eol + eol);
}

const lookup = (doc, parts) => parts.reduce((o, k) => (o != null && typeof o === 'object' ? o[k] : undefined), doc);

// True when pathParts is defined some way other than its own [header], e.g. an inline
// table or dotted keys. Appending a [header] for it would then define it twice.
function definedInline(text, pathParts) {
  try { return lookup(parse(removeTable(text, pathParts)), pathParts) !== undefined; } catch { return false; }
}

function setTable(text, pathParts, obj) {
  if (definedInline(text, pathParts)) {
    throw Object.assign(new Error(`${pathParts.join('.')} is written as an inline table or dotted keys in this file. Edit it from the Files tab.`), { status: 409 });
  }
  const { eol } = split(text);
  const base = removeTable(text, pathParts).replace(/\s*$/, '');
  return (base ? base + eol + eol : '') + table(pathParts, obj).replace(/\n/g, eol);
}

module.exports = { parse, stringify, removeTable, setTable, getTopLevel, setTopLevel, definedInline };
