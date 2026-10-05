#!/usr/bin/env node
// AgentDeck: local control panel for AI coding-agent harnesses. Zero dependencies.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec, spawn } = require('child_process');
const os = require('os');
const core = require('./lib/core');
const integrations = require('./lib/integrations');
const insights = require('./lib/insights');

const HOST = '127.0.0.1';
const DEFAULT_PORT = 4517;
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon', '.png': 'image/png' };
const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const routes = {
  'GET /api/scan': () => core.scan(),
  'GET /api/overview': () => insights.overview(),
  'GET /api/usage': q => insights.usage(q),
  'GET /api/health': () => insights.health(),
  'POST /api/health/dismiss': (q, body) => insights.dismissFinding(body),
  'GET /api/drift': () => insights.drift(),
  'GET /api/context': q => insights.contextStack(q),
  'GET /api/levers': () => core.leverCatalog(),
  'GET /api/profile': q => core.getProfile(q),
  'POST /api/profile/preview': (q, body) => core.planProfile(body),
  'POST /api/profile/apply': (q, body) => core.applyProfile(body),
  'GET /api/items': q => core.listItems(q),
  'POST /api/items/preview': (q, body) => core.planItem(body),
  'POST /api/items': (q, body) => core.saveItem(body),
  'POST /api/items/delete': (q, body) => core.deleteItem(body),
  'GET /api/mcp': q => integrations.listMcp(q),
  'POST /api/mcp/preview': (q, body) => integrations.planMcp(body),
  'POST /api/mcp': (q, body) => integrations.applyMcp(body),
  'GET /api/hooks': q => integrations.listHooks(q),
  'POST /api/hooks/preview': (q, body) => integrations.planHook(body),
  'POST /api/hooks': (q, body) => integrations.applyHook(body),
  'POST /api/projects/add': (q, body) => core.addProject(body),
  'POST /api/projects/remove': (q, body) => core.removeProject(body),
  'GET /api/file': q => core.readFile(q),
  'POST /api/file/preview': (q, body) => core.planFile(body),
  'POST /api/file': (q, body) => core.writeFile(body),
  'GET /api/backups': () => core.listBackups(),
  'POST /api/backups/preview': (q, body) => core.planRestore(body),
  'POST /api/backups/restore': (q, body) => core.restoreBackup(body),
  'POST /api/undo': (q, body) => core.undo(body),
  'GET /api/presets': () => core.listPresets(),
  'POST /api/presets': (q, body) => core.savePreset(body),
  'POST /api/presets/delete': (q, body) => core.deletePreset(body),
  'GET /api/export': () => core.exportBundle(),
  'POST /api/import': (q, body) => core.importBundle(body),
};

function send(res, status, data, type = 'application/json') {
  const payload = type === 'application/json' ? JSON.stringify(data) : data;
  res.writeHead(status, {
    'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': CSP,
  });
  res.end(payload);
}

const httpError = (message, status) => Object.assign(new Error(message), { status });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let over = false;
    const chunks = [];
    req.on('data', c => {
      if (over) return; // keep draining so the client can read the 413 instead of a reset
      size += c.length;
      if (size > 5e6) { over = true; chunks.length = 0; reject(httpError('Request too large.', 413)); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reject(httpError('Invalid JSON body.', 400)); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return reject(httpError('The request body must be a JSON object.', 400));
      resolve(body);
    });
    req.on('error', reject);
  });
}

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep) || rel.includes('\0')) return send(res, 403, 'Forbidden', 'text/plain');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    send(res, 200, buf, MIME[path.extname(file)] || 'application/octet-stream');
  });
}

function createServer(ctx) {
  return http.createServer(async (req, res) => {
    // Reject DNS-rebinding and cross-origin callers: only our own host may talk to us.
    const host = (req.headers.host || '').toLowerCase();
    if (host !== `${HOST}:${ctx.port}` && host !== `localhost:${ctx.port}`) return send(res, 403, { error: 'Bad host' });
    let url;
    try { url = new URL(req.url, `http://${host}`); } catch { return send(res, 400, { error: 'Bad URL' }); }

    // Lets a second launch recognise an AgentDeck that is already running.
    if (url.pathname === '/api/ping') return send(res, 200, { app: 'agentdeck', version: core.VERSION });
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', 'text/plain');
      return serveStatic(res, url.pathname);
    }

    // Hash both sides so the comparison is constant-time whatever bytes were sent.
    const digest = v => crypto.createHash('sha256').update(String(v)).digest();
    if (!crypto.timingSafeEqual(digest(req.headers['x-agentdeck-token'] || ''), digest(ctx.token))) {
      return send(res, 401, { error: 'This page has no valid session key. Open AgentDeck from its launcher, or run "agentdeck" again.' });
    }
    if (req.method === 'POST' && url.pathname === '/api/alive') { ctx.lastBeat = Date.now(); return send(res, 200, { ok: true }); }
    if (req.method === 'POST' && url.pathname === '/api/quit') { send(res, 200, { ok: true }); setTimeout(() => process.exit(0), 150); return; }
    const handler = routes[`${req.method} ${url.pathname}`];
    if (!handler) return send(res, 404, { error: 'Unknown endpoint' });

    try {
      const body = req.method === 'POST' ? await readBody(req) : {};
      send(res, 200, await handler(Object.fromEntries(url.searchParams), body));
    } catch (err) {
      const status = Number.isInteger(err.status) ? err.status : 500;
      if (status === 500) console.error(err);
      send(res, status, { error: status === 500 ? `Unexpected error: ${err.message}` : err.message });
    }
  });
}

// ---- opening a window ------------------------------------------------------------

function findBrowser() {
  const home = os.homedir();
  const win = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean)
    .flatMap(root => ['Microsoft\\Edge\\Application\\msedge.exe', 'Google\\Chrome\\Application\\chrome.exe', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe', 'Chromium\\Application\\chrome.exe'].map(rel => path.join(root, rel)));
  const mac = ['Google Chrome.app/Contents/MacOS/Google Chrome', 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge', 'Brave Browser.app/Contents/MacOS/Brave Browser', 'Chromium.app/Contents/MacOS/Chromium']
    .flatMap(app => [`/Applications/${app}`, path.join(home, 'Applications', app)]);
  const linuxNames = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable', 'brave-browser'];
  const linux = [...(process.env.PATH || '').split(path.delimiter).filter(Boolean), '/usr/bin', '/usr/local/bin', '/snap/bin', '/var/lib/flatpak/exports/bin'].flatMap(dir => linuxNames.map(n => path.join(dir, n)));
  const candidates = process.platform === 'win32' ? win : process.platform === 'darwin' ? mac : linux;
  return candidates.find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}

function openTab(address) {
  const opener = process.platform === 'win32' ? `start "" "${address}"` : process.platform === 'darwin' ? `open "${address}"` : `xdg-open "${address}"`;
  exec(opener, () => {});
}

// A chromeless Chromium window with its own profile is a separate process, so we can
// tell when the user closes it. Returns false when no such browser is installed.
function openWindow(address, onClose) {
  const browser = findBrowser();
  if (!browser) return false;
  const profile = path.join(os.homedir(), '.agentdeck', 'window-profile');
  const child = spawn(browser, [`--app=${address}`, `--user-data-dir=${profile}`, '--window-size=1320,880', '--no-first-run', '--no-default-browser-check'], { stdio: 'ignore' });
  child.on('error', () => openTab(address));
  if (onClose) child.on('exit', onClose);
  return true;
}

function ping(port) {
  return new Promise(resolve => {
    const req = http.get({ host: HOST, port, path: '/api/ping', timeout: 800 }, res => {
      let s = '';
      res.on('data', d => { s += d; }).on('end', () => { try { resolve(JSON.parse(s).app === 'agentdeck'); } catch { resolve(false); } });
    });
    req.on('error', () => resolve(false)).on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// ---- start ----------------------------------------------------------------------

// The session key is never served over HTTP (any local user could fetch it). It is passed
// to the window we open, and kept in a file only this user can read so that launching
// AgentDeck again can reopen the copy that is already running.
const SESSION_FILE = path.join(os.homedir(), '.agentdeck', 'session.json');
const keyed = (address, token) => `${address}/?k=${token}`;

function saveSession(ctx) {
  try {
    fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
    fs.writeFileSync(SESSION_FILE, JSON.stringify({ port: ctx.port, token: ctx.token, pid: process.pid }), { mode: 0o600 });
    process.on('exit', () => { try { if (JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')).pid === process.pid) fs.unlinkSync(SESSION_FILE); } catch { /* already gone */ } });
    for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
  } catch { /* a second launch will just start its own copy */ }
}

function runningSession(port) {
  try { const s = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')); return s.port === port && typeof s.token === 'string' ? s.token : null; } catch { return null; }
}

// Listens on the first free port from `port` upward. If an AgentDeck is already running
// on one of them, resolves with { existing: address } instead of starting a second copy.
function start({ port = DEFAULT_PORT, fixed = false, persist = false } = {}) {
  return new Promise((resolve, reject) => {
    const attempt = n => {
      const ctx = { port: n, token: crypto.randomBytes(24).toString('hex'), lastBeat: 0 };
      const server = createServer(ctx);
      server.once('error', async err => {
        if (err.code !== 'EADDRINUSE') return reject(err);
        if (await ping(n)) { const token = runningSession(n); return resolve({ existing: `http://${HOST}:${n}`, url: token ? keyed(`http://${HOST}:${n}`, token) : `http://${HOST}:${n}` }); }
        if (fixed || n >= port + 20) return reject(Object.assign(new Error(`Port ${n} is in use by another program. Pick another with --port.`), { code: 'EADDRINUSE' }));
        attempt(n + 1);
      });
      server.listen(n, HOST, () => { if (persist) saveSession(ctx); resolve({ server, ctx, address: `http://${HOST}:${n}`, url: keyed(`http://${HOST}:${n}`, ctx.token) }); });
    };
    attempt(port);
  });
}

async function main(argv) {
  const code = require('./lib/cli').run(argv);
  if (code !== null) process.exit(code);

  const flag = argv.indexOf('--port');
  const wanted = flag !== -1 ? argv[flag + 1] : process.env.AGENTDECK_PORT;
  const port = wanted == null || wanted === '' ? DEFAULT_PORT : Number(wanted);
  if (!Number.isInteger(port) || port < 1 || port > 65535) { console.error(`"${wanted}" is not a valid port (1-65535).`); process.exit(2); }
  const mode = argv.includes('--no-open') ? 'none' : argv.includes('--browser') ? 'tab' : 'window';

  let started;
  try { started = await start({ port, fixed: wanted != null && wanted !== '', persist: true }); }
  catch (e) { console.error(e.message); process.exit(1); }

  const address = started.url;
  if (started.existing) console.log(`AgentDeck is already running at ${started.existing}. Opening it.`);
  else console.log(`AgentDeck ${core.VERSION} running at ${started.address}  (Ctrl+C to stop)`);

  if (mode === 'none') { console.log(`Open ${address}`); return; }
  const done = () => process.exit(0);
  if (mode === 'window' && openWindow(address, started.existing ? done : done)) return;
  if (mode === 'window') console.log('No Chrome, Edge, Brave or Chromium was found for a standalone window, so AgentDeck opened in your default browser. Close the tab to stop it.');
  openTab(address);
  if (started.existing) return done();
  // Opened as a browser tab with nobody watching the console: stop once the page has gone.
  if (mode === 'window') {
    setInterval(() => { if (started.ctx.lastBeat && Date.now() - started.ctx.lastBeat > 120000) process.exit(0); }, 30000).unref();
  }
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { start, routes, DEFAULT_PORT };
