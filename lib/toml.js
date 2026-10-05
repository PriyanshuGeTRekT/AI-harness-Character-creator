// Small TOML reader/writer: enough for harness config (strings, numbers, booleans, arrays,
// inline tables, [tables], [[arrays of tables]]). Dates are kept as raw strings.
function parse(text) {
  const src = String(text || '');
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
  const basic = s => s.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (m, e) => {
    if (e[0] === 'u' || e[0] === 'U') return String.fromCodePoint(parseInt(e.slice(1), 16));
    return { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\' }[e] ?? e;
  });
  const str = () => {
    const q = src[i];
    if (src.startsWith(q.repeat(3), i)) {
      i += 3;
      if (src[i] === '\r') i++;
      if (src[i] === '\n') i++;
      let end = i;
      for (;;) {
        end = src.indexOf(q.repeat(3), end);
        if (end === -1) throw err('unterminated multi-line string');
        if (q === '"' && src[end - 1] === '\\' && src[end - 2] !== '\\') { end++; continue; }
        break;
      }
      const raw = src.slice(i, end);
      i = end + 3;
      return q === '"' ? basic(raw.replace(/\\\r?\n\s*/g, '')) : raw;
    }
    i++;
    let out = '';
    while (i < src.length && src[i] !== q) {
      if (src[i] === '\n') throw err('unterminated string');
      if (q === '"' && src[i] === '\\') { out += src[i] + src[i + 1]; i += 2; } else out += src[i++];
    }
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
      skip(false);
      if (src[i] === '.') { i++; continue; }
      return parts;
    }
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
    if (m[0] === 'true') return true;
    if (m[0] === 'false') return false;
    const n = Number(m[0].replace(/_/g, ''));
    return Number.isFinite(n) && /^[+-]?[\d._eE+-]+$/.test(m[0]) ? n : m[0];
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

const bareKey = k => (/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k));
const isTable = v => v != null && typeof v === 'object' && !Array.isArray(v);

function inline(v) {
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `[${v.map(inline).join(', ')}]`;
  if (isTable(v)) return `{ ${Object.entries(v).map(([k, x]) => `${bareKey(k)} = ${inline(x)}`).join(', ')} }`;
  return '""';
}

function scalar(v) {
  if (typeof v === 'string' && v.includes('\n')) return `"""\n${v.replace(/\\/g, '\\\\').replace(/"""/g, '""\\"')}"""`;
  return inline(v);
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
    else top.push(`${bareKey(k)} = ${scalar(v)}`);
  }
  return [top.join('\n'), ...sections].filter(Boolean).join('\n\n').replace(/\n*$/, '\n');
}

function headerPath(line) {
  const m = line.match(/^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/);
  if (!m) return null;
  const parts = [];
  const re = /\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*(\.|$)/y;
  let hit;
  while (re.lastIndex < m[1].length && (hit = re.exec(m[1]))) parts.push(hit[1] != null ? JSON.parse(`"${hit[1]}"`) : hit[2] != null ? hit[2] : hit[3]);
  return parts.length ? parts : null;
}

// Remove [prefix] and every [prefix.*] section, leaving the rest of the file untouched.
function removeTable(text, prefix) {
  const out = [];
  let dropping = false;
  for (const line of String(text || '').split(/\r?\n/)) {
    const p = headerPath(line);
    if (p) dropping = p.length >= prefix.length && prefix.every((seg, idx) => p[idx] === seg);
    if (!dropping) out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

function setTable(text, pathParts, obj) {
  const base = removeTable(text, pathParts).replace(/\s*$/, '');
  return (base ? base + '\n\n' : '') + table(pathParts, obj);
}

module.exports = { parse, stringify, removeTable, setTable };
