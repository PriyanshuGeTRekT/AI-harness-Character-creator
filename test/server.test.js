// HTTP layer: host and token checks, static files, error statuses, port handling, CLI.
const assert = require('assert');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const { fakeHome, testAsync, done } = require('./helpers');
const home = fakeHome(['.claude']);
home.write('.claude/CLAUDE.md', '# Mine\n');
const { start } = require('../server');

function call(port, method, url, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: { host: `127.0.0.1:${port}`, ...headers } }, res => {
      let s = '';
      res.on('data', d => { s += d; }).on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: s, json: (() => { try { return JSON.parse(s); } catch { return null; } })() }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

(async () => {
  const { server, ctx } = await start({ port: 47170 });
  const port = ctx.port;
  const auth = { 'x-agentdeck-token': ctx.token, 'content-type': 'application/json' };

  await testAsync('static: index carries the token, security headers are set', async () => {
    const r = await call(port, 'GET', '/');
    assert.strictEqual(r.status, 200);
    assert(r.headers['content-type'].startsWith('text/html'));
    assert(!r.text.includes(ctx.token), 'the session key must never be served: any local user could fetch it');
    assert(r.headers['content-security-policy'].includes("script-src 'self'") && r.headers['x-frame-options'] === 'DENY');
    assert.strictEqual((await call(port, 'GET', '/js/app.js')).headers['content-type'], 'text/javascript; charset=utf-8');
    assert.strictEqual((await call(port, 'GET', '/favicon.svg')).status, 200);
  });

  await testAsync('static: no escaping the public folder, no writes', async () => {
    for (const p of ['/../server.js', '/..%2f..%2fserver.js', '/%2e%2e/package.json', '/js/../../lib/core.js', '/nope.js']) assert([403, 404].includes((await call(port, 'GET', p)).status), p);
    assert.strictEqual((await call(port, 'POST', '/index.html')).status, 405);
  });

  await testAsync('API: wrong host, missing token and unknown routes are refused', async () => {
    assert.strictEqual((await call(port, 'GET', '/api/scan', { headers: { ...auth, host: 'evil.example:' + port } })).status, 403);
    assert.strictEqual((await call(port, 'GET', '/', { headers: { host: 'evil.example' } })).status, 403);
    assert.strictEqual((await call(port, 'GET', '/api/scan')).status, 401);
    assert.strictEqual((await call(port, 'GET', '/api/scan', { headers: { 'x-agentdeck-token': 'x'.repeat(48) } })).status, 401);
    assert.strictEqual((await call(port, 'GET', '/api/scan', { headers: { 'x-agentdeck-token': Buffer.from('\u00e9'.repeat(48), 'utf8').toString('latin1') } })).status, 401);
    assert.strictEqual((await call(port, 'GET', '/api/ping')).status, 200, 'the server survived a malformed key');
    assert.strictEqual((await call(port, 'GET', '/api/nope', { headers: auth })).status, 404);
    assert.deepStrictEqual((await call(port, 'GET', '/api/ping')).json.app, 'agentdeck');
  });

  await testAsync('API: bodies are validated and errors carry the right status', async () => {
    assert.strictEqual((await call(port, 'POST', '/api/profile/preview', { headers: auth, body: '{nope' })).status, 400);
    for (const body of ['[]', 'null', '"x"', '7']) assert.strictEqual((await call(port, 'POST', '/api/profile/preview', { headers: auth, body })).status, 400, body);
    // The server answers 413 as soon as the limit is passed. A client still uploading may
    // see that reply or, on some platforms, a reset connection; both mean "refused".
    const big = await call(port, 'POST', '/api/profile/preview', { headers: auth, body: 'x'.repeat(6e6) }).catch(e => ({ refused: /ECONNRESET|EPIPE/.test(e.code || e.message) }));
    assert(big.status === 413 || big.refused, JSON.stringify(big));
    assert.strictEqual((await call(port, 'GET', '/api/ping')).status, 200);
    assert.strictEqual((await call(port, 'GET', '/api/profile?harness=nope', { headers: auth })).status, 400);
    assert.strictEqual((await call(port, 'GET', '/api/profile?harness=claude&project=' + encodeURIComponent(home.p('elsewhere')), { headers: auth })).status, 403);
    assert.strictEqual((await call(port, 'POST', '/api/backups/restore', { headers: auth, body: { id: 'nope' } })).status, 404);
  });

  await testAsync('API: a full preview, apply and undo round trip', async () => {
    const scan = (await call(port, 'GET', '/api/scan', { headers: auth })).json;
    assert.deepStrictEqual(scan.harnesses.filter(h => h.installed).map(h => h.id), ['claude']);
    const payload = { harness: 'claude', project: '', values: { verbosity: 'terse' } };
    const plan = (await call(port, 'POST', '/api/profile/preview', { headers: auth, body: payload })).json;
    assert(plan.changes[0].after.includes('Lead with the answer') && home.read('.claude/CLAUDE.md') === '# Mine\n');
    const applied = (await call(port, 'POST', '/api/profile/apply', { headers: auth, body: payload })).json;
    assert(home.read('.claude/CLAUDE.md').includes('Lead with the answer'));
    assert.strictEqual((await call(port, 'POST', '/api/undo', { headers: auth, body: { batch: applied.batch } })).status, 200);
    assert.strictEqual(home.read('.claude/CLAUDE.md'), '# Mine\n');
    for (const url of ['/api/overview', '/api/health', '/api/drift', '/api/usage', '/api/levers', '/api/presets', '/api/backups', '/api/export', '/api/context?harness=claude&project=', '/api/items?harness=claude&project=', '/api/mcp?harness=claude&project=', '/api/hooks?harness=claude&project=']) {
      assert.strictEqual((await call(port, 'GET', url, { headers: auth })).status, 200, url);
    }
  });

  await testAsync('ports: a second copy finds the first; a foreign program is stepped over', async () => {
    assert.strictEqual((await start({ port })).existing, `http://127.0.0.1:${port}`);
    // A launched copy leaves a per-user session file, so a second launch gets a keyed URL.
    const first = await start({ port: port + 300, persist: true });
    assert.strictEqual(first.url, `http://127.0.0.1:${port + 300}/?k=${first.ctx.token}`);
    assert.strictEqual((await start({ port: port + 300 })).url, first.url);
    assert.strictEqual((await call(port + 300, 'GET', '/api/scan', { headers: { 'x-agentdeck-token': first.ctx.token } })).status, 200);
    first.server.close();
    const foreign = http.createServer((req, res) => res.end('not agentdeck')).listen(47190, '127.0.0.1');
    await new Promise(r => foreign.once('listening', r));
    const next = await start({ port: 47190 });
    assert.strictEqual(next.ctx.port, 47191);
    await assert.rejects(start({ port: 47190, fixed: true }), /in use by another program/);
    next.server.close(); foreign.close();
  });

  await testAsync('CLI: scan, doctor, usage, version and bad input', async () => {
    const run = (...args) => spawnSync(process.execPath, [path.join(__dirname, '..', 'server.js'), ...args], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
    assert(/1 of \d+ harnesses detected/.test(run('scan').stdout) && run('scan').stdout.includes('Claude Code'));
    const doctor = run('doctor');
    assert(doctor.status === 0 && doctor.stdout.includes('config health'));
    assert(run('usage').stdout.includes('No Claude Code session history') || run('usage').stdout.includes('Claude Code usage'));
    assert.strictEqual(run('--version').stdout.trim(), require('../package.json').version);
    assert.strictEqual(run('frobnicate').status, 2);
    assert.strictEqual(run('--port', 'abc', '--no-open').status, 2);
    assert(run('--port', '5000', '--version').status === 0, '--port takes a value; it is not a command');
    assert(run('--help').stdout.includes('agentdeck doctor'));
  });

  server.close();
  done('server');
})();
