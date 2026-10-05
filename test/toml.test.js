const assert = require('assert');
const { test, done } = require('./helpers');
const t = require('../lib/toml');

const src = [
  'model = "gpt-5" # comment',
  'n = 1_000',
  'flag = true',
  'arr = ["a",',
  '  "b"]',
  'ml = """',
  'line1',
  'line \\"q\\" 2"""',
  '',
  "[projects.'C:\\Users\\x']",
  'trust_level = "trusted"',
  '',
  '[mcp_servers.fs]',
  'command = "npx"',
  'args = ["-y", "srv"]',
  'env = { KEY = "v" }',
  '',
  '[mcp_servers.fs.extra]',
  'a = 1',
  '',
  '[mcp_servers.other]',
  'url = "https://x"',
  '',
  '[[skills.config]]',
  'path = "p"',
  '',
].join('\n');

test('parse: scalars, arrays, tables, arrays of tables', () => {
  const o = t.parse(src);
  assert.strictEqual(o.model, 'gpt-5');
  assert.strictEqual(o.n, 1000);
  assert.deepStrictEqual(o.arr, ['a', 'b']);
  assert.strictEqual(o.ml, 'line1\nline "q" 2');
  assert.strictEqual(o.projects['C:\\Users\\x'].trust_level, 'trusted');
  assert.deepStrictEqual(o.mcp_servers.fs, { command: 'npx', args: ['-y', 'srv'], env: { KEY: 'v' }, extra: { a: 1 } });
  assert.strictEqual(o.skills.config[0].path, 'p');
});

test('parse: number forms, special floats, date-times, hash inside strings', () => {
  const o = t.parse('a = 0xFF\nb = -1.5e3\nc = inf\nd = 1979-05-27 07:32:00\ne = "x # not a comment" # real\nf = 0o17\ng = +7');
  assert.deepStrictEqual([o.a, o.b, o.c, o.d, o.e, o.f, o.g], [255, -1500, Infinity, '1979-05-27 07:32:00', 'x # not a comment', 15, 7]);
});

test('parse: an escaped backslash before a newline is kept', () => {
  assert.strictEqual(t.parse('s = """\npath C:\\\\\nnext"""').s, 'path C:\\\nnext');
  assert.strictEqual(t.parse('s = """\none \\\n   two"""').s, 'one two');
});

test('parse: rejects keys that would reach the prototype', () => {
  assert.throws(() => t.parse('[__proto__]\npolluted = true'), /not allowed/);
  assert.throws(() => t.parse('a.constructor.b = 1'), /not allowed/);
  assert.strictEqual({}.polluted, undefined);
});

test('stringify round-trips awkward strings', () => {
  for (const body of ['You are\na """tricky""" C:\\path one.\n', 'ends with a quote"\nand "', 'trailing backslash \\\nnext', 'tab\there\nbell\u0007\n', 'x\n""""']) {
    const doc = { name: 'a', developer_instructions: body, model: 'x', n: 3, on: false, list: ['a', 'b'], skills: { config: 1 } };
    assert.deepStrictEqual(t.parse(t.stringify(doc)), doc, JSON.stringify(body));
  }
  assert.deepStrictEqual(t.parse(t.stringify({ x: Infinity, items: [{ a: 1 }, { a: 2 }] })), { x: Infinity, items: [{ a: 1 }, { a: 2 }] });
});

test('removeTable / setTable touch only their own section', () => {
  const removed = t.parse(t.removeTable(src, ['mcp_servers', 'fs']));
  assert(!removed.mcp_servers.fs && removed.mcp_servers.other.url === 'https://x' && removed.model === 'gpt-5');
  assert.strictEqual(removed.skills.config[0].path, 'p');
  const set = t.setTable(src, ['mcp_servers', 'fs'], { command: 'uvx', args: ['x'], env: { A: '1' } });
  assert.deepStrictEqual(t.parse(set).mcp_servers.fs, { command: 'uvx', args: ['x'], env: { A: '1' } });
  assert(set.startsWith('model = "gpt-5" # comment'));
  // a prefix is not a match: fs must not remove fs2
  assert(t.parse(t.removeTable('[mcp_servers.fs2]\na = 1\n', ['mcp_servers', 'fs'])).mcp_servers.fs2);
});

test('headers inside multi-line strings and arrays are not headers', () => {
  const text = 'notes = """\n[mcp_servers.fs]\nnot a table\n"""\nlist = [\n  "[x]",\n]\n\n[mcp_servers.fs]\ncommand = "a"\n';
  const out = t.removeTable(text, ['mcp_servers', 'fs']);
  assert.strictEqual(t.parse(out).notes, '[mcp_servers.fs]\nnot a table\n');
  assert.strictEqual(t.parse(out).mcp_servers, undefined);
});

test('setTable refuses when the table is written inline', () => {
  assert.throws(() => t.setTable('[mcp_servers]\nfs = { command = "a" }\n', ['mcp_servers', 'fs'], { command: 'b' }), /inline/);
  assert.throws(() => t.setTable('mcp_servers.fs.command = "a"\n', ['mcp_servers', 'fs'], { command: 'b' }), /inline/);
});

test('top-level get/set: values, multi-line values, CRLF, unset', () => {
  for (const [k, v] of [['model', 'a#b'], ['n', 1000], ['f', -1.5], ['s', "it's"], ['b', true], ['arr', ['x', 'y']]]) {
    assert.deepStrictEqual(t.getTopLevel(t.setTopLevel('', k, v), k), v);
  }
  assert.strictEqual(t.getTopLevel('n = 120_000\n', 'n'), 120000);
  const crlf = 'model = "a"\r\n# keep\r\n\r\n[t]\r\nmodel = "inner"\r\n';
  const out = t.setTopLevel(crlf, 'model', 'b');
  assert.strictEqual(out, 'model = "b"\r\n# keep\r\n\r\n[t]\r\nmodel = "inner"\r\n');
  assert.strictEqual(t.setTopLevel(crlf, 'effort', 'high'), 'model = "a"\r\n# keep\r\neffort = "high"\r\n\r\n[t]\r\nmodel = "inner"\r\n');
  const multi = 'x = """\nmodel = "trap"\n"""\nmodel = "real"\n';
  assert.strictEqual(t.setTopLevel(multi, 'model', 'new'), 'x = """\nmodel = "trap"\n"""\nmodel = "new"\n');
  assert.strictEqual(t.setTopLevel('a = [\n  1,\n  2,\n]\nb = 1\n', 'a', ''), 'b = 1\n');
  assert.strictEqual(t.setTopLevel('b = 1\n', 'a', []), 'b = 1\n');
});

done('toml');
