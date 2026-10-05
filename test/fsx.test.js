const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { fakeHome, test, done } = require('./helpers');
const home = fakeHome();
const f = require('../lib/fsx');

test('frontmatter: typed scalars, quotes and lists', () => {
  const { data, body } = f.parseFrontmatter('---\nname: a\nreadonly: true\nn: 3\ntemp: 0.3\nq: "say \\"hi\\": now"\ns: \'it\'\'s\'\ntools: [Read, "a, b"]\nlist:\n- x\n- y\nempty:\n---\nbody\n');
  assert.deepStrictEqual(data, { name: 'a', readonly: true, n: 3, temp: 0.3, q: 'say "hi": now', s: "it's", tools: ['Read', 'a, b'], list: ['x', 'y'], empty: '' });
  assert.strictEqual(body, 'body\n');
});

test('frontmatter: block scalars and nested structures', () => {
  const text = '---\nname: reviewer\ndescription: |\n  Reviews code.\n  Twice.\ntools:\n  write: false\n  bash: false\nhooks:\n  PreToolUse:\n    - matcher: Bash\nmodel: sonnet\n---\n\nbody\n';
  const p = f.parseFrontmatter(text);
  assert.strictEqual(p.data.description, 'Reviews code.\nTwice.');
  assert(f.isComplex(p.data.tools) && f.isComplex(p.data.hooks));
  // changing one key leaves every other line byte-for-byte as it was
  const out = f.buildFrontmatter({ ...p.data, model: 'opus' }, p.body, p);
  assert.strictEqual(out, text.replace('model: sonnet', 'model: opus'));
  // and an untouched file round-trips exactly
  assert.strictEqual(f.buildFrontmatter(p.data, p.body, p), text);
});

test('frontmatter: removing and adding keys, comments survive', () => {
  const p = f.parseFrontmatter('---\n# header comment\nname: x\ncolor: blue # inline\nold: 1\n---\nb\n');
  const { old, ...rest } = p.data;
  const out = f.buildFrontmatter({ ...rest, added: 'yes: quoted', multi: 'a\nb' }, p.body, p);
  assert.strictEqual(out, '---\n# header comment\nname: x\ncolor: blue # inline\nadded: "yes: quoted"\nmulti: |-\n  a\n  b\n---\n\nb\n');
  assert.strictEqual(f.parseFrontmatter(out).data.multi, 'a\nb');
});

test('frontmatter: fresh output quotes what YAML would misread', () => {
  const out = f.buildFrontmatter({ a: 'true', b: '12', c: '- dash', d: 'plain text', e: true, n: 5 }, 'x');
  assert.deepStrictEqual(f.parseFrontmatter(out).data, { a: 'true', b: '12', c: '- dash', d: 'plain text', e: true, n: 5 });
  assert.strictEqual(f.parseFrontmatter('no frontmatter').body, 'no frontmatter');
  assert.strictEqual({}.polluted, undefined);
});

test('managed block: add, replace, merge duplicates, remove, CRLF', () => {
  const user = '# Mine\n\n- keep\n';
  const one = f.setBlock(user, '- a');
  assert(one.startsWith(user) && f.getBlock(one) === '- a');
  const two = f.setBlock(one, '- b');
  assert.strictEqual(f.blocks(two).length, 1);
  assert.strictEqual(f.getBlock(two), '- b');
  assert.strictEqual(f.setBlock(two, ''), user);
  // two stale blocks collapse into one
  const dup = `${one}\nmiddle\n\n${f.BLOCK_START}\n- old\n${f.BLOCK_END}\n`;
  const merged = f.setBlock(dup, '- new');
  assert.strictEqual(f.blocks(merged).length, 1);
  assert(merged.includes('middle') && merged.includes('- keep') && !merged.includes('- old'));
  // line endings and untouched files are preserved
  const crlf = f.setBlock('# Mine\r\n\r\n- keep\r\n', '- a');
  assert(!/[^\r]\n/.test(crlf) && crlf.includes('- keep\r\n\r\n<!--'));
  assert.strictEqual(f.setBlock('  leading\n\n\n', ''), '  leading\n\n\n');
  assert.strictEqual(f.getBlock('nothing here'), null);
});

test('setPath: nested set, unset prunes empty parents, unsafe keys rejected', () => {
  assert.deepStrictEqual(f.setPath({ a: 1 }, 'env.X', '2'), { a: 1, env: { X: '2' } });
  assert.deepStrictEqual(f.setPath({ a: 1 }, 'env.X', ''), { a: 1 });
  assert.deepStrictEqual(f.setPath({ env: { X: '1' }, p: { allow: ['x'], mode: 'm' } }, 'env.X', ''), { p: { allow: ['x'], mode: 'm' } });
  assert.deepStrictEqual(f.setPath({ p: { allow: ['x'] } }, 'p.allow', []), {});
  assert.throws(() => f.setPath({}, '__proto__.polluted', true), /not allowed/);
  assert.strictEqual(f.getPath({ a: {} }, 'a.constructor'), undefined);
});

test('backups: unique names, batches, undo of edits and created files', () => {
  const files = Array.from({ length: 25 }, (_, i) => home.p('b', `p${i}`, 'settings.json'));
  files.forEach((file, i) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `v${i}`); });
  const r = f.withBatch('edit many', () => ({ results: files.map((file, i) => f.writeSafe(file, `new${i}`)) }));
  const created = home.p('b', 'created.txt');
  const r2 = f.withBatch('create', () => ({ results: [f.writeSafe(created, 'x')] }));
  const index = f.listBackups();
  assert.strictEqual(new Set(index.filter(e => e.file).map(e => e.file)).size, index.filter(e => e.file).length);
  f.undoBatch(r.batch);
  files.forEach((file, i) => assert.strictEqual(fs.readFileSync(file, 'utf8'), `v${i}`));
  f.undoBatch(r2.batch);
  assert(!fs.existsSync(created));
  assert.throws(() => f.undoBatch('nope'), /Nothing to undo/);
});

test('backups: a deleted folder can be restored', () => {
  const dir = home.p('skills', 'demo');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), 'hello');
  f.removeSafe(dir);
  assert(!fs.existsSync(dir));
  f.restoreBackup(f.listBackups().find(e => e.isDir).id);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), 'hello');
});

test('writeSafe: keeps CRLF and BOM, skips no-op writes', () => {
  const file = home.p('w', 'a.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '﻿{\r\n  "a": 1\r\n}\r\n');
  assert.strictEqual(f.writeSafe(file, '{\n  "a": 1\n}\n').changed, false);
  f.writeSafe(file, '{\n  "a": 2\n}\n');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '﻿{\r\n  "a": 2\r\n}\r\n');
});

test('state: defaults, damaged file is set aside not overwritten', () => {
  assert.deepStrictEqual(Object.keys(f.loadState()).sort(), ['dismissed', 'manualProjects', 'presets', 'profiles']);
  fs.mkdirSync(f.APP_DIR, { recursive: true });
  fs.writeFileSync(f.STATE_FILE, '[1, 2');
  assert.deepStrictEqual(f.loadState().profiles, {});
  assert(fs.readdirSync(f.APP_DIR).some(n => n.startsWith('state.json.broken-')));
  fs.writeFileSync(f.STATE_FILE, '{"profiles": "oops", "presets": {"a": {}}}');
  const s = f.loadState();
  assert.deepStrictEqual([s.profiles, s.presets], [{}, { a: {} }]);
});

done('fsx');
