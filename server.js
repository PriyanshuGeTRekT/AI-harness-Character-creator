#!/usr/bin/env node
// AgentDeck: local control panel for AI coding-agent harnesses. Zero dependencies.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec, spawn } = require('child_process');
const os = require('os');
const core = require('./lib/core');

const PORT = Number(process.env.AGENTDECK_PORT) || 4317;
const HOST = '127.0.0.1';
const PUBLIC = path.join(__dirname, 'public');
// Per-run token: the page gets it inlined, so other sites/processes can't drive the API.
const TOKEN = crypto.randomBytes(24).toString('hex');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

const routes = {
  'GET /api/scan': () => core.scan(),
  'GET /api/levers': () => core.leverCatalog(),
  'GET /api/profile': q => core.getProfile(q),
  'POST /api/profile/preview': (q, body) => core.planProfile(body),
  'POST /api/profile/apply': (q, body) => core.applyProfile(body),
  'GET /api/items': q => core.listItems(q),
  'POST /api/items/preview': (q, body) => core.planItem(body),
  'POST /api/items': (q, body) => core.saveItem(body),
  'POST /api/items/delete': (q, body) => core.deleteItem(body),
  'GET /api/mcp': q => core.listMcp(q),
  'POST /api/mcp/preview': (q, body) => core.planMcp(body),
  'POST /api/mcp': (q, body) => core.applyMcp(body),
  'GET /api/hooks': q => core.listHooks(q),
  'POST /api/hooks/preview': (q, body) => core.planHook(body),
  'POST /api/hooks': (q, body) => core.applyHook(body),
  'POST /api/projects/add': (q, body) => core.addProject(body),
  'POST /api/projects/remove': (q, body) => core.removeProject(body),
  'GET /api/file': q => core.readFile(q),
  'POST /api/file': (q, body) => core.writeFile(body),
  'GET /api/backups': () => core.listBackups(),
  'POST /api/backups/restore': (q, body) => core.restoreBackup(body),
  'GET /api/presets': () => core.listPresets(),
  'POST /api/presets': (q, body) => core.savePreset(body),
  'POST /api/presets/delete': (q, body) => core.deletePreset(body),
};

function send(res, status, data, type = 'application/json') {
  const payload = type === 'application/json' ? JSON.stringify(data) : data;
  res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > 5e6) { reject(new Error('Request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'Forbidden', 'text/plain');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    const ext = path.extname(file);
    let out = buf;
    if (rel === 'index.html') out = buf.toString('utf8').replace('__AGENTDECK_TOKEN__', TOKEN);
    send(res, 200, out, MIME[ext] || 'application/octet-stream');
  });
}

const server = http.createServer(async (req, res) => {
  // Reject DNS-rebinding and cross-origin callers: only our own host may talk to us.
  const host = (req.headers.host || '').toLowerCase();
  if (host !== `${HOST}:${PORT}` && host !== `localhost:${PORT}`) return send(res, 403, { error: 'Bad host' });

  const url = new URL(req.url, `http://${host}`);
  if (!url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET') return send(res, 405, 'Method not allowed', 'text/plain');
    return serveStatic(res, url.pathname);
  }

  if (req.headers['x-agentdeck-token'] !== TOKEN) return send(res, 401, { error: 'Missing or stale session token. Reload the page.' });
  const handler = routes[`${req.method} ${url.pathname}`];
  if (!handler) return send(res, 404, { error: 'Unknown endpoint' });

  try {
    const body = req.method === 'POST' ? await readBody(req) : {};
    const result = await handler(Object.fromEntries(url.searchParams), body);
    send(res, 200, result);
  } catch (err) {
    send(res, err.status || 500, { error: err.message });
  }
});

const ADDRESS = `http://${HOST}:${PORT}`;
const WINDOW = process.argv.includes('--window');

// --window: show the UI in its own chromeless Edge/Chrome window (app mode) with a private
// browser profile, so the window is a separate process and closing it stops AgentDeck.
function findBrowser() {
  const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  const rels = ['Microsoft\\Edge\\Application\\msedge.exe', 'Google\\Chrome\\Application\\chrome.exe'];
  const candidates = process.platform === 'win32' ? rels.flatMap(rel => roots.map(root => path.join(root, rel)))
    : process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
    : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];
  return candidates.find(p => fs.existsSync(p)) || null;
}

function openBrowserTab() {
  const opener = process.platform === 'win32' ? `start "" "${ADDRESS}"` : process.platform === 'darwin' ? `open "${ADDRESS}"` : `xdg-open "${ADDRESS}"`;
  exec(opener, () => {});
}

function openWindow(onClose) {
  const browser = findBrowser();
  if (!browser) { openBrowserTab(); return; }
  const profile = path.join(os.homedir(), '.agentdeck', 'window-profile');
  const child = spawn(browser, [`--app=${ADDRESS}`, `--user-data-dir=${profile}`, '--window-size=1280,860', '--no-first-run', '--no-default-browser-check'], { stdio: 'ignore' });
  child.on('error', openBrowserTab);
  if (onClose) child.on('exit', onClose);
}

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    // Already running: just show its window again.
    if (WINDOW) { openWindow(() => process.exit(0)); return; }
    console.error(`Port ${PORT} is in use. Set AGENTDECK_PORT to another port, or close the other AgentDeck window.`);
  } else console.error(err.message);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`AgentDeck running at ${ADDRESS}  (Ctrl+C to stop)`);
  if (WINDOW) openWindow(() => process.exit(0));
  else if (!process.argv.includes('--no-open')) openBrowserTab();
});
