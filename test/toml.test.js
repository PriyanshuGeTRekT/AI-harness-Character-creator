const assert = require('assert');
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

const o = t.parse(src);
assert.strictEqual(o.model, 'gpt-5');
assert.strictEqual(o.n, 1000);
assert.deepStrictEqual(o.arr, ['a', 'b']);
assert.strictEqual(o.ml, 'line1\nline "q" 2');
assert.strictEqual(o.projects['C:\\Users\\x'].trust_level, 'trusted');
assert.deepStrictEqual(o.mcp_servers.fs, { command: 'npx', args: ['-y', 'srv'], env: { KEY: 'v' }, extra: { a: 1 } });
assert.strictEqual(o.skills.config[0].path, 'p');

const removed = t.parse(t.removeTable(src, ['mcp_servers', 'fs']));
assert(!removed.mcp_servers.fs && removed.mcp_servers.other.url === 'https://x' && removed.model === 'gpt-5');
assert.strictEqual(removed.skills.config[0].path, 'p');

const set = t.setTable(src, ['mcp_servers', 'fs'], { command: 'uvx', args: ['x'], env: { A: '1' } });
assert.deepStrictEqual(t.parse(set).mcp_servers.fs, { command: 'uvx', args: ['x'], env: { A: '1' } });
assert(set.startsWith('model = "gpt-5" # comment'));

const doc = { name: 'a', developer_instructions: 'You are\na """tricky""" C:\\path one.\n', model: 'x', skills: { config: 1 } };
assert.deepStrictEqual(t.parse(t.stringify(doc)), doc);
console.log('toml ok');
