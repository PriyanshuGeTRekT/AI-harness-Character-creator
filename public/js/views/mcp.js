// MCP servers tab.
import { h, api, modal, reviewFrom, confirmChanges, fail, baseName, field } from '../ui.js';
import { state } from '../state.js';

const TEMPLATES = [
  { label: 'Blank', name: '', transport: 'stdio', command: '', args: '' },
  { label: 'Filesystem (folder access)', name: 'filesystem', transport: 'stdio', command: 'npx', args: '-y\n@modelcontextprotocol/server-filesystem\n/path/to/folder' },
  { label: 'Memory (knowledge graph)', name: 'memory', transport: 'stdio', command: 'npx', args: '-y\n@modelcontextprotocol/server-memory' },
  { label: 'Playwright (browser control)', name: 'playwright', transport: 'stdio', command: 'npx', args: '-y\n@playwright/mcp@latest' },
  { label: 'Context7 (library docs)', name: 'context7', transport: 'stdio', command: 'npx', args: '-y\n@upstash/context7-mcp' },
  { label: 'Fetch (web pages)', name: 'fetch', transport: 'stdio', command: 'uvx', args: 'mcp-server-fetch' },
  { label: 'Remote server (URL)', name: '', transport: 'http', url: 'https://' },
];

const pairsToText = (obj, sep) => Object.entries(obj || {}).map(([k, v]) => `${k}${sep}${v}`).join('\n');
function textToPairs(text, sep) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const at = line.indexOf(sep);
    if (at > 0) out[line.slice(0, at).trim()] = line.slice(at + sep.length).trim();
  }
  return out;
}

// Accepts what people actually paste: {"mcpServers": {name: {...}}}, {name: {...}} or one server.
function parsePasted(text) {
  let j;
  try { j = JSON.parse(text); } catch { throw new Error('That is not valid JSON.'); }
  if (j && j.mcpServers && typeof j.mcpServers === 'object') j = j.mcpServers;
  let name = '';
  if (j && typeof j === 'object' && !j.command && !j.url && !j.httpUrl && !j.serverUrl) { [name] = Object.keys(j); j = j[name]; }
  if (!j || typeof j !== 'object') throw new Error('No server definition found in that JSON.');
  const url = j.url || j.httpUrl || j.serverUrl || '';
  const cmd = Array.isArray(j.command) ? j.command : [j.command, ...(Array.isArray(j.args) ? j.args : [])];
  return { name, transport: url ? (j.type === 'sse' ? 'sse' : 'http') : 'stdio', command: String(cmd[0] || ''), args: cmd.slice(1).join('\n'), env: pairsToText(j.env || j.environment, '='), url, headers: pairsToText(j.headers, ': ') };
}

export async function mcpTab(x) {
  const data = await api('GET', `/api/mcp?harness=${encodeURIComponent(x.id)}&project=${encodeURIComponent(state.scope)}`);
  const wrap = h('div', {},
    h('div', { class: 'banner' }, 'MCP servers give the agent extra tools (browsers, databases, docs). Every enabled server also adds its tool list to each request, so fewer servers means fewer input tokens.'),
    h('div', { class: 'actions', style: 'margin-bottom:14px' }, h('button', { class: 'primary', onclick: () => mcpDialog(x, data, null, null) }, '+ Add server')));
  for (const sc of data.scopes) {
    wrap.append(h('div', { class: 'card' },
      h('h2', {}, sc.scope === 'global' ? 'Global' : `Project: ${baseName(state.scope)}`), h('div', { class: 'note path' }, sc.file),
      sc.error ? h('div', { class: 'banner warn' }, sc.error) : null,
      sc.servers.length ? h('div', { class: 'list' }, sc.servers.map(sv => h('div', { class: 'item' },
        h('div', { class: 'i-main' },
          h('div', { class: 'i-name' }, sv.name, h('span', { class: 'tag' }, sv.transport === 'stdio' ? 'local command' : sv.transport === 'sse' ? 'remote (SSE)' : 'remote'), sv.disabled ? h('span', { class: 'tag warn' }, 'disabled') : null,
            sv.secrets.length ? h('span', { class: 'tag danger', title: `${sv.secrets.join(', ')} stored in plain text in this file` }, 'plain-text secret') : null),
          h('div', { class: 'path' }, sv.transport === 'stdio' ? [sv.command, ...sv.args].join(' ') : sv.url),
          Object.keys(sv.env).length ? h('div', { class: 'i-desc' }, `env: ${Object.keys(sv.env).join(', ')}`) : null),
        h('div', { class: 'actions' },
          h('button', { class: 'small', onclick: () => mcpDialog(x, data, sv, sc.scope) }, 'Edit'),
          h('button', { class: 'small', title: 'Add this server to other harnesses', onclick: () => mcpDialog(x, data, null, sc.scope, sv) }, 'Copy to…'),
          h('button', { class: 'small danger', onclick: () => confirmChanges('Remove MCP server', '/api/mcp/preview', '/api/mcp',
            { harness: x.id, project: state.scope, scope: sc.scope, name: sv.name, remove: true }, { applyLabel: 'Remove' }).catch(fail) }, 'Remove')))))
        : (sc.error ? null : h('div', { class: 'muted' }, 'No servers here.'))));
  }
  return wrap;
}

function mcpDialog(x, data, existing, existingScope, seed) {
  const from = existing || seed;
  const d = from ? { ...from, args: from.args.join('\n'), env: pairsToText(from.env, '='), headers: pairsToText(from.headers, ': ') }
    : { name: '', transport: 'stdio', command: '', args: '', env: '', url: '', headers: '', disabled: false };
  const initial = JSON.stringify(d);
  let scope = existingScope || (state.scope && x.mcp.project ? 'project' : 'global');
  let reveal = false;
  const attach = new Set(seed ? [] : [x.id]);
  const others = existing ? [] : state.scan.harnesses.filter(o => (seed || o.id !== x.id) && o.mcp);
  const body = h('div', {});
  // Secret-looking values are hidden until asked for, so a screen share does not leak them.
  const mask = text => (reveal ? text : String(text || '').split('\n').map(l => l.replace(/^(\s*[^=:]+[=:]\s*)(.{4})(.{6,})$/, (m, a, b, c) => a + b + '•'.repeat(Math.min(c.length, 12)))).join('\n'));
  const secretArea = (key, placeholder) => {
    const hidden = !reveal && from && d[key];
    return h('textarea', { rows: 3, placeholder, readonly: hidden || null, title: hidden ? 'Click "Show values" to edit' : null, oninput: e => { d[key] = e.target.value; } }, hidden ? mask(d[key]) : d[key]);
  };
  const draw = () => {
    const stdio = d.transport === 'stdio';
    body.replaceChildren(...[
      from ? null : h('div', { class: 'grid2' },
        field('Start from a template', h('select', { onchange: e => { Object.assign(d, { command: '', args: '', url: '' }, TEMPLATES[Number(e.target.value)]); delete d.label; draw(); } }, TEMPLATES.map((t, i) => h('option', { value: i }, t.label)))),
        field('Or paste a config', h('button', { onclick: () => {
          const area = h('textarea', { rows: 9, placeholder: '{ "mcpServers": { "name": { "command": "npx", "args": ["..."] } } }' });
          modal('Paste an MCP server config', area, [{ label: 'Cancel' }, { label: 'Use it', class: 'primary', action: () => { Object.assign(d, parsePasted(area.value)); reveal = true; draw(); } }], { narrow: true });
        } }, 'Paste JSON…'))),
      h('div', { class: 'grid2' },
        field('Name', h('input', { type: 'text', value: d.name, disabled: !!existing, placeholder: 'letters, digits, dashes', oninput: e => { d.name = e.target.value; } })),
        field('Type', h('select', { onchange: e => { d.transport = e.target.value; draw(); } },
          [['stdio', 'Local command'], ['http', 'Remote URL (HTTP)'], ['sse', 'Remote URL (SSE, older servers)']].map(([v, l]) => h('option', { value: v, selected: d.transport === v }, l))))),
      stdio ? field('Command', h('input', { type: 'text', value: d.command, placeholder: 'npx', oninput: e => { d.command = e.target.value; } })) : null,
      stdio ? field('Arguments', h('textarea', { rows: 4, oninput: e => { d.args = e.target.value; } }, d.args), 'One per line.') : null,
      stdio ? field('Environment variables', secretArea('env', 'API_KEY=...'), 'One KEY=value per line. Stored in plain text in the harness config.') : null,
      stdio ? null : field('URL', h('input', { type: 'text', value: d.url, placeholder: 'https://example.com/mcp', oninput: e => { d.url = e.target.value; } })),
      stdio ? null : field('Headers', secretArea('headers', 'Authorization: Bearer ...'), 'One "Name: value" per line. Stored in plain text in the harness config.'),
      from && (d.env || d.headers) && !reveal ? h('button', { class: 'small', onclick: () => { reveal = true; draw(); } }, 'Show values') : null,
      data.canDisable ? h('label', { class: 'checks', style: 'margin:10px 0' }, h('input', { type: 'checkbox', checked: d.disabled, onchange: e => { d.disabled = e.target.checked; } }), 'Keep it configured but switched off') : null,
      existing ? null : field('Scope', h('select', { onchange: e => { scope = e.target.value; } },
        h('option', { value: 'global', selected: scope === 'global' }, 'Global (all projects)'),
        state.scope ? h('option', { value: 'project', selected: scope === 'project' }, `Project: ${baseName(state.scope)}`) : null)),
      others.length ? h('div', { class: 'field' }, h('span', {}, seed ? 'Copy to' : 'Also add to'),
        h('div', { class: 'checks' }, others.map(o => h('label', {},
          h('input', { type: 'checkbox', checked: attach.has(o.id), onchange: e => (e.target.checked ? attach.add(o.id) : attach.delete(o.id)) }), o.name,
          o.installed ? null : h('span', { class: 'muted' }, '(not installed)')))),
        h('small', {}, 'Each harness gets the server in its own config format.')) : null,
    ].filter(Boolean));
  };
  draw();
  modal(existing ? `Edit MCP server: ${existing.name}` : seed ? `Copy MCP server: ${seed.name}` : 'Add MCP server', body, [
    { label: 'Cancel' },
    { label: 'Review changes', class: 'primary', action: () => {
      if (!attach.size && !existing) throw new Error('Pick at least one harness.');
      const server = { transport: d.transport, command: (d.command || '').trim(), args: (d.args || '').split('\n').map(s => s.trim()).filter(Boolean),
        env: textToPairs(d.env, '='), url: (d.url || '').trim(), headers: textToPairs(d.headers, ':'), disabled: !!d.disabled };
      const payload = { harnesses: existing ? [x.id] : [...attach], project: scope === 'project' ? state.scope : '', scope, name: (d.name || '').trim(), server };
      return reviewFrom(existing ? 'Update MCP server' : 'Add MCP server', '/api/mcp/preview', '/api/mcp', payload);
    } },
  ], { guard: () => JSON.stringify(d) !== initial });
}
