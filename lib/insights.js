// Read-only views over what is already on disk: token usage and cost, config health,
// drift between harnesses, and the instruction files a harness will actually load.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const fsx = require('./fsx');
const levers = require('./levers');
const core = require('./core');
const integrations = require('./integrations');

const { adapter, list, checkProject, ADAPTERS } = core;

// ---- usage and cost (Claude Code transcripts) -----------------------------------
// Claude Code writes one JSONL file per session. Assistant lines carry token usage and
// a "cost-state" line carries the session's cost as Claude Code itself computed it, so
// nothing here depends on a price table.

const USAGE_CACHE = path.join(fsx.APP_DIR, 'usage-cache.json');
const MAX_TRANSCRIPT = 300 * 1024 * 1024;

function transcriptFiles(root) {
  const out = [];
  const walk = (dir, depth) => {
    for (const e of fsx.listDir(dir)) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && depth < 4) walk(full, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full);
    }
  };
  walk(root, 0);
  return out;
}

const dayOf = ts => {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// One transcript -> { cwd, cost, days: { day: { model: [in, out, cacheRead, cacheWrite, messages] } } }
function summarizeTranscript(file) {
  const out = { cwd: null, cost: 0, costs: {}, days: {}, last: 0 };
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }
  const seen = new Set();
  for (const line of text.split('\n')) {
    const isAssistant = line.includes('"type":"assistant"');
    const isCost = !isAssistant && line.includes('"type":"cost-state"');
    if (!isAssistant && !isCost) {
      if (!out.cwd) { const m = line.match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/); if (m) try { out.cwd = JSON.parse(`"${m[1]}"`); } catch { /* skip */ } }
      continue;
    }
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (isCost) {
      // Running totals: the last line is the session's final figure, split by model.
      if (typeof o.totalCostUSD === 'number' && o.totalCostUSD >= out.cost) {
        out.cost = o.totalCostUSD;
        out.costs = {};
        for (const [m, v] of Object.entries(o.modelUsage && typeof o.modelUsage === 'object' ? o.modelUsage : {})) if (v && typeof v.costUSD === 'number') out.costs[m] = v.costUSD;
      }
      continue;
    }
    const msg = o.message;
    const u = msg && msg.usage;
    if (!u || typeof u !== 'object') continue;
    if (!out.cwd && typeof o.cwd === 'string') out.cwd = o.cwd;
    // A streamed reply is written several times with the same ids; count it once.
    const id = `${msg.id || ''}|${o.requestId || ''}`;
    if (id !== '|') { if (seen.has(id)) continue; seen.add(id); }
    const day = dayOf(o.timestamp);
    if (!day) continue;
    if (!(Number(u.input_tokens) || Number(u.output_tokens) || Number(u.cache_read_input_tokens) || Number(u.cache_creation_input_tokens))) continue;
    const model = typeof msg.model === 'string' && msg.model !== '<synthetic>' ? msg.model : 'unknown';
    const slot = ((out.days[day] = out.days[day] || {})[model] = out.days[day][model] || [0, 0, 0, 0, 0]);
    slot[0] += Number(u.input_tokens) || 0;
    slot[1] += Number(u.output_tokens) || 0;
    slot[2] += Number(u.cache_read_input_tokens) || 0;
    slot[3] += Number(u.cache_creation_input_tokens) || 0;
    slot[4] += 1;
    out.last = Math.max(out.last, Date.parse(o.timestamp) || 0);
  }
  return out;
}

function usage({ days: span } = {}) {
  const window = Math.min(Math.max(Number(span) || 30, 1), 365);
  const root = fsx.expand('~/.claude/projects');
  if (!fsx.isDir(root)) return { available: false, reason: 'No Claude Code session history was found on this machine. Usage is read from Claude Code transcripts.' };
  const cache = fsx.readJson(USAGE_CACHE) || {};
  const next = {};
  const files = transcriptFiles(root);
  for (const file of files) {
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    if (st.size > MAX_TRANSCRIPT) continue;
    const stamp = `v2:${st.size}:${Math.round(st.mtimeMs)}`;
    const hit = cache[file];
    next[file] = hit && hit.stamp === stamp ? hit : { stamp, ...summarizeTranscript(file) };
  }
  try { fsx.writeAtomic(USAGE_CACHE, JSON.stringify(next)); } catch { /* cache is optional */ }

  const since = dayOf(Date.now() - (window - 1) * 86400000);
  const blank = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0, cost: 0 });
  const add = (t, s, cost) => { t.input += s[0]; t.output += s[1]; t.cacheRead += s[2]; t.cacheWrite += s[3]; t.messages += s[4]; t.cost += cost; };
  const totals = blank();
  const byDay = {};
  const byModel = {};
  const byProject = {};
  let sessions = 0;
  let uncosted = 0;
  for (const [file, s] of Object.entries(next)) {
    // Claude Code records cost per model for the whole session; each day gets its share of
    // that model's cost in proportion to the tokens it produced that day.
    const perModel = {};
    for (const models of Object.values(s.days)) for (const [model, slot] of Object.entries(models)) perModel[model] = (perModel[model] || 0) + slot[0] + slot[1];
    const sessionTokens = Object.values(perModel).reduce((n, x) => n + x, 0) || 1;
    const costKeys = Object.keys(s.costs || {});
    const modelCost = model => { const k = costKeys.find(c => c === model || model.startsWith(c) || c.startsWith(model)); return k ? s.costs[k] : null; };
    const isSub = /[\\/]subagents[\\/]/.test(file);
    let counted = false;
    for (const [day, models] of Object.entries(s.days)) {
      if (day < since) continue;
      for (const [model, slot] of Object.entries(models)) {
        const known = costKeys.length ? modelCost(model) : null;
        const cost = known != null ? known * ((slot[0] + slot[1]) / (perModel[model] || 1)) : costKeys.length ? 0 : (s.cost || 0) * ((slot[0] + slot[1]) / sessionTokens);
        add(totals, slot, cost);
        add((byDay[day] = byDay[day] || blank()), slot, cost);
        add((byModel[model] = byModel[model] || blank()), slot, cost);
        const key = s.cwd || '(unknown folder)';
        const p = (byProject[key] = byProject[key] || { ...blank(), sessions: 0, last: 0 });
        add(p, slot, cost);
        p.last = Math.max(p.last, s.last || 0);
        if (!counted && !isSub) { p.sessions++; sessions++; counted = true; if (!s.cost) uncosted++; }
      }
    }
  }
  const series = [];
  for (let i = window - 1; i >= 0; i--) { const d = dayOf(Date.now() - i * 86400000); series.push({ day: d, ...(byDay[d] || blank()) }); }
  const rank = obj => Object.entries(obj).map(([name, v]) => ({ name, ...v })).sort((a, b) => (b.cost - a.cost) || (b.output - a.output));
  const cacheable = totals.input + totals.cacheRead + totals.cacheWrite;
  return {
    available: true, harness: 'Claude Code', window, sessions, files: files.length,
    totals: { ...totals, cacheHitRate: cacheable ? totals.cacheRead / cacheable : 0 },
    days: series, models: rank(byModel),
    projects: rank(byProject).slice(0, 30).map(p => ({ ...p, label: p.name === '(unknown folder)' ? p.name : path.basename(p.name) })),
    uncosted,
    costNote: (totals.cost > 0 ? 'Cost is what Claude Code recorded for each session (list prices; on a subscription this is the equivalent value, not a bill).' : 'These transcripts carry no cost figures, so only tokens are shown.')
      + (uncosted && totals.cost > 0 ? ` ${uncosted} of ${sessions} sessions have no recorded cost (still open, or on a model Claude Code had no price for), so the real total is higher.` : ''),
  };
}

// ---- context stack: what a harness loads for a scope -----------------------------

function fileInfo(file, role) {
  const text = fsx.readText(file);
  return { path: file, role, exists: text != null, bytes: text == null ? 0 : Buffer.byteLength(text, 'utf8'), lines: text ? text.split(/\r?\n/).length : 0, tokens: fsx.tokens(text), managed: !!text && fsx.blocks(text).length > 0 };
}

function contextStack({ harness, project }) {
  const a = adapter(harness);
  const proj = checkProject(project);
  const ctx = a.context || {};
  const files = [];
  const pushDir = (dir, role) => {
    for (const e of fsx.listDir(dir)) if (e.isFile() && /\.(md|mdc)$/i.test(e.name)) files.push(fileInfo(path.join(dir, e.name), role));
  };
  if (a.instructions.global) files.push(fileInfo(fsx.expand(a.instructions.global), 'Global instructions'));
  for (const d of list(ctx.globalDirs)) pushDir(fsx.expand(d), 'Global rule');
  if (proj) {
    const names = [a.instructions.project, ...list(ctx.projectFiles)].filter(Boolean);
    if (ctx.ancestors !== false && a.instructions.project) {
      // Most harnesses also read the same file name in every parent folder.
      const chain = [];
      for (let dir = path.dirname(proj); dir !== path.dirname(dir) && chain.length < 12; dir = path.dirname(dir)) chain.unshift(dir);
      for (const dir of chain) {
        const f = path.join(dir, a.instructions.project);
        if (fsx.exists(f) && core.norm(dir) !== core.norm(fsx.HOME)) files.push(fileInfo(f, 'Parent folder'));
      }
    }
    for (const n of names) files.push(fileInfo(path.join(proj, n), n === a.instructions.project ? 'Project instructions' : 'Project (extra)'));
    for (const d of list(ctx.projectDirs)) pushDir(path.join(proj, d), 'Project rule');
  }
  const present = files.filter(f => f.exists);
  const bytes = present.reduce((n, f) => n + f.bytes, 0);
  const notes = [];
  if (ctx.maxBytes && bytes > ctx.maxBytes) notes.push(`${a.name} reads at most ${Math.round(ctx.maxBytes / 1024)} KB of instructions; this stack is ${Math.round(bytes / 1024)} KB, so the last files are cut off.`);
  if (ctx.note) notes.push(ctx.note);
  return { files: files.filter(f => f.exists || /^(Global|Project) instructions$/.test(f.role)), tokens: present.reduce((n, f) => n + f.tokens, 0), bytes, notes };
}

// ---- drift: is every harness saying the same thing? ------------------------------

const hash = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 10);

function drift() {
  const scan = core.currentScan();
  const state = fsx.loadState();
  const active = scan.harnesses.filter(h => h.installed);
  const scopes = [{ key: 'global', label: 'Global', path: '' }];
  const seen = new Set();
  for (const h of active) for (const p of h.projects) {
    if (!p.exists || seen.has(core.norm(p.path))) continue;
    seen.add(core.norm(p.path));
    scopes.push({ key: core.norm(p.path), label: p.name, path: p.path });
  }
  const rows = scopes.slice(0, 60).map(scope => {
    const cells = {};
    for (const h of active) {
      const a = adapter(h.id);
      if (scope.path && !h.projects.some(p => core.norm(p.path) === scope.key)) { cells[h.id] = { status: 'na' }; continue; }
      const st = core.blockStatus(a, scope.path, state);
      cells[h.id] = st.status === 'unsupported' ? { status: 'na' } : { status: st.status, hash: st.block ? hash(st.block) : '', tokens: fsx.tokens(st.block) };
    }
    const hashes = new Set(Object.values(cells).filter(c => c.hash).map(c => c.hash));
    const applied = Object.values(cells).filter(c => c.hash).length;
    const possible = Object.values(cells).filter(c => c.status !== 'na').length;
    return { ...scope, cells, state: !applied ? 'empty' : hashes.size > 1 ? 'differs' : applied < possible ? 'partial' : 'same', conflicts: Object.values(cells).some(c => c.status === 'edited' || c.status === 'missing') };
  });
  return { harnesses: active.map(h => ({ id: h.id, name: h.name })), rows };
}

// ---- health check ---------------------------------------------------------------

function health() {
  const scan = core.currentScan();
  const state = fsx.loadState();
  const findings = [];
  const add = (level, harness, title, detail, go) => findings.push({ id: hash(`${level}|${harness}|${title}|${detail}`), level, harness, title, detail, go: go || null });

  for (const h of scan.harnesses.filter(x => x.installed)) {
    const a = adapter(h.id);
    const scopes = [{ proj: '', label: 'global' }, ...h.projects.filter(p => p.exists).slice(0, 40).map(p => ({ proj: p.path, label: p.name }))];
    for (const { proj, label } of scopes) {
      const st = core.blockStatus(a, proj, state);
      if (st.target && st.text) {
        for (const msg of core.lintInstructions(a, st.text, st.target)) add('warn', h.id, `Instruction file needs attention (${label})`, msg, { tab: 'behavior', scope: proj });
        if (st.status === 'edited') add('warn', h.id, `Managed block was edited by hand (${label})`, `${st.target} no longer matches what AgentDeck applied. Applying again overwrites the manual edit.`, { tab: 'behavior', scope: proj });
        if (st.status === 'missing') add('warn', h.id, `Applied profile is gone (${label})`, `The AgentDeck block was removed from ${st.target}, so the tuned behavior is not active.`, { tab: 'behavior', scope: proj });
      }
      // Settings files that cannot be parsed are silently ignored by most harnesses.
      for (const s of Object.values(a.settings || {})) {
        const file = proj ? (s.project && path.join(proj, s.project)) : (s.global && fsx.expand(s.global));
        const text = file && fsx.readText(file);
        if (!text || !text.trim()) continue;
        try { if (s.format === 'toml') require('./toml').parse(text); else JSON.parse(text); }
        catch (e) { if (s.format === 'toml' || !/\/\/|\/\*/.test(text)) add('high', h.id, `Settings file does not parse (${label})`, `${file}: ${e.message}`, { tab: 'files', scope: proj }); }
      }
      for (const def of a.native || []) {
        const t = core.settingsTarget(a, def, proj);
        if (!t) continue;
        const value = core.readSetting(t, def.key);
        const opt = (def.options || []).find(o => o.danger && String(o.value) === String(value));
        if (opt) add('high', h.id, `Safety checks are off (${label})`, `${def.label} is set to "${opt.label}" in ${t.path}. The agent can act without asking.`, { tab: 'native', scope: proj });
      }
      if (a.mcp) {
        let mcp = { scopes: [] };
        try { mcp = integrations.listMcp({ harness: h.id, project: proj }); } catch { /* unreadable: reported below */ }
        const sc = mcp.scopes.find(x => x.scope === (proj ? 'project' : 'global'));
        if (sc && sc.error) add('warn', h.id, `MCP config could not be read (${label})`, sc.error, { tab: 'mcp', scope: proj });
        const leaky = sc ? sc.servers.filter(s => s.secrets.length) : [];
        if (leaky.length) add(proj ? 'high' : 'warn', h.id, `Plain-text secrets in MCP config (${label})`, `${leaky.map(s => `${s.name} (${s.secrets.join(', ')})`).join('; ')} in ${sc.file}.${proj ? ' This file sits inside the project: check it is not committed.' : ''}`, { tab: 'mcp', scope: proj });
        const on = sc ? sc.servers.filter(s => !s.disabled).length : 0;
        if (on > 8) add('info', h.id, `${on} MCP servers enabled (${label})`, 'Every enabled server adds its tool list to each request. Removing unused ones cuts input tokens.', { tab: 'mcp', scope: proj });
      }
      if (a.hooks) {
        let hk = { scopes: [] };
        try { hk = integrations.listHooks({ harness: h.id, project: proj }); } catch { /* skip */ }
        const sc = hk.scopes.find(x => x.scope === (proj ? 'project' : 'global'));
        for (const x of sc ? sc.hooks : []) {
          const m = x.command.match(/node "([^"]*\/\.agentdeck\/hooks\/[^"]+)"/);
          if (m && !fsx.exists(m[1])) add('high', h.id, `Hook script is missing (${label})`, `${x.event} hook points at ${m[1]}, which no longer exists, so the hook fails every time.`, { tab: 'hooks', scope: proj });
        }
      }
    }
    for (const p of h.projects.filter(x => !x.exists && x.manual)) add('info', h.id, 'Project folder is missing', `${p.path} was added by hand but no longer exists.`, { tab: 'projects', scope: '' });
    if (h.needsSqlite && !scan.sqlite) add('info', h.id, 'Project discovery needs a newer Node', `${h.name} keeps its history in SQLite. Run AgentDeck on Node 22.13 or later to list its projects automatically, or add them by hand.`, { tab: 'projects', scope: '' });
  }

  const d = drift();
  for (const row of d.rows.filter(r => r.state === 'differs')) add('warn', '', `Harnesses disagree (${row.label})`, `The behavior applied to ${Object.entries(row.cells).filter(([, c]) => c.hash).map(([id]) => adapter(id).name).join(', ')} is not the same${row.path ? ` in ${row.path}` : ''}.`, { view: 'sync' });

  const dismissed = state.dismissed || {};
  const open = findings.filter(f => !dismissed[f.id]);
  const weight = { high: 20, warn: 7, info: 1 };
  const score = Math.max(0, 100 - open.reduce((n, f) => n + weight[f.level], 0));
  const order = { high: 0, warn: 1, info: 2 };
  open.sort((x, y) => order[x.level] - order[y.level]);
  return { score, findings: open, dismissed: findings.length - open.length, counts: { high: open.filter(f => f.level === 'high').length, warn: open.filter(f => f.level === 'warn').length, info: open.filter(f => f.level === 'info').length } };
}

function dismissFinding({ id, restore }) {
  const state = fsx.loadState();
  if (restore) state.dismissed = {};
  else if (typeof id === 'string' && /^[0-9a-f]{10}$/.test(id)) state.dismissed[id] = Date.now();
  fsx.saveState(state);
  return { ok: true };
}

// ---- overview -------------------------------------------------------------------

function overview() {
  const scan = core.scan();
  const state = fsx.loadState();
  const cards = scan.harnesses.filter(h => h.installed).map(h => {
    const a = adapter(h.id);
    const st = core.blockStatus(a, '', state);
    const model = (a.native || []).filter(d => /model/i.test(d.key) && d.kind === 'text').map(d => { const t = core.settingsTarget(a, d, ''); return t ? core.readSetting(t, d.key) : undefined; }).find(v => typeof v === 'string' && v);
    let mcp = 0;
    try { if (a.mcp) mcp = integrations.listMcp({ harness: h.id, project: '' }).scopes.reduce((n, s) => n + s.servers.length, 0); } catch { /* unreadable */ }
    let hooks = 0;
    try { if (a.hooks) hooks = integrations.listHooks({ harness: h.id, project: '' }).scopes.reduce((n, s) => n + s.hooks.length, 0); } catch { /* unreadable */ }
    let items = 0;
    try { items = Object.values(core.listItems({ harness: h.id, project: '' })).reduce((n, v) => n + v.length, 0); } catch { /* unreadable */ }
    const fileTokens = st.text ? fsx.tokens(st.text) : 0;
    return { id: h.id, name: h.name, vendor: h.vendor, evidence: h.evidence, projects: h.projects.length, status: st.status, blockTokens: fsx.tokens(st.block), fileTokens, model: model || '', mcp, hooks, items };
  });
  const projects = new Set(scan.harnesses.flatMap(h => h.projects.filter(p => p.exists).map(p => core.norm(p.path))));
  return {
    version: scan.version, node: scan.node, home: scan.home,
    counts: { detected: cards.length, supported: scan.harnesses.length, projects: projects.size, configTokens: cards.reduce((n, c) => n + c.fileTokens, 0) },
    cards, health: health(), firstRun: !Object.keys(state.profiles).length,
  };
}

module.exports = { usage, contextStack, drift, health, dismissFinding, overview, levers };
