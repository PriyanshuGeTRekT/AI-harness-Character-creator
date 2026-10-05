// Harness registry. One entry per AI coding harness: how to detect it, where its
// instruction file, settings, agents, skills and commands live, and how to list the
// projects it has worked in. Paths checked against each tool's docs in October 2026.
//
// instructions: { global, project }   file the managed behavior block is written into
// settings.main: { global, project, format }   'json' or 'toml'; drives the `native` controls
// items.<agents|skills|commands>: { global, project, layout: 'file'|'dir', ext, fields, nameInFrontmatter,
//                                   format: 'toml' + bodyKey for harnesses that use TOML files }
//   global/project may be an array of candidate folders (all are read; the first existing one is written)
// mcp: { global, project, key: [path], style: 'standard'|'opencode'|'codex', urlKey, httpType, disable }
// context: extra instruction sources the harness loads (projectFiles, projectDirs, globalDirs, maxBytes)
// hooks: { global, project, key: [path], events }   Claude-style {Event: [{matcher, hooks: [{type, command}]}]}
const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');
const fsx = require('./fsx');

const WIN = process.platform === 'win32';
const sel = (...values) => values.map(v => (typeof v === 'object' ? v : { value: v, label: String(v) }));
const danger = (value, label) => ({ value, label: label || value, danger: true });

// ---- project discovery helpers --------------------------------------------------

function jsonlCwd(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(65536);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const m = buf.toString('utf8', 0, n).match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    return m ? JSON.parse(`"${m[1]}"`) : null;
  } catch { return null; }
}

// Codex compresses older rollouts with zstd; Node can read those from 22.15 on.
function zstCwd(file) {
  try {
    const zlib = require('zlib');
    if (!zlib.zstdDecompressSync || fsx.size(file) > 20 * 1024 * 1024) return null;
    const m = zlib.zstdDecompressSync(fs.readFileSync(file)).toString('utf8', 0, 65536).match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    return m ? JSON.parse(`"${m[1]}"`) : null;
  } catch { return null; }
}

// Session folders that each hold *.jsonl transcripts for one project (Claude Code, Pi).
function sessionFolders(root) {
  const out = [];
  for (const e of fsx.listDir(root)) {
    if (!e.isDirectory()) continue;
    const dir = path.join(root, e.name);
    const files = fsx.listDir(dir).filter(f => f.isFile() && f.name.endsWith('.jsonl'))
      .map(f => ({ file: path.join(dir, f.name), t: fsx.mtime(path.join(dir, f.name)) }))
      .sort((a, b) => b.t - a.t);
    if (!files.length) continue;
    let cwd = null;
    for (const f of files.slice(0, 3)) if ((cwd = jsonlCwd(f.file))) break;
    if (cwd) out.push({ path: cwd, lastUsed: files[0].t, sessions: files.length });
  }
  return out;
}

// Date-nested rollout files (Codex): newest first, read the cwd from each header.
function rolloutProjects(root, limit = 200) {
  const files = [];
  const walk = (dir, depth) => {
    for (const e of fsx.listDir(dir)) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && depth < 4) walk(full, depth + 1);
      else if (e.isFile() && /\.jsonl(\.zst)?$/.test(e.name)) files.push(full);
    }
  };
  walk(root, 0);
  files.sort().reverse();
  return files.slice(0, limit).map(f => ({ path: f.endsWith('.zst') ? zstCwd(f) : jsonlCwd(f), lastUsed: fsx.mtime(f), sessions: 1 })).filter(p => p.path);
}

// VS Code family editors record each opened folder in workspaceStorage/<id>/workspace.json.
function editorWorkspaces(appName) {
  const root = WIN ? fsx.expand(`%APPDATA%/${appName}/User/workspaceStorage`)
    : process.platform === 'darwin' ? fsx.expand(`~/Library/Application Support/${appName}/User/workspaceStorage`)
    : fsx.expand(`~/.config/${appName}/User/workspaceStorage`);
  const out = [];
  for (const e of fsx.listDir(root)) {
    if (!e.isDirectory()) continue;
    const meta = fsx.readJson(path.join(root, e.name, 'workspace.json'));
    if (!meta || typeof meta.folder !== 'string' || !meta.folder.startsWith('file:')) continue;
    try { out.push({ path: fileURLToPath(meta.folder), lastUsed: fsx.mtime(path.join(root, e.name)) }); } catch { /* remote or malformed URI */ }
  }
  return out;
}

const isScratch = p => /[\\/]scratch-workspaces[\\/]/i.test(p);

function claudeProjects() {
  const out = sessionFolders(fsx.expand('~/.claude/projects'));
  for (const file of ['~/.claude.json', '~/.claude/.claude.json']) {
    const cfg = fsx.readJson(fsx.expand(file));
    for (const p of Object.keys((cfg && cfg.projects) || {})) out.push({ path: p });
  }
  return out.filter(p => !isScratch(p.path));
}

function codexProjects() {
  const out = [...rolloutProjects(fsx.expand('~/.codex/sessions')), ...rolloutProjects(fsx.expand('~/.codex/archived_sessions'), 100)];
  const toml = fsx.readText(fsx.expand('~/.codex/config.toml')) || '';
  for (const m of toml.matchAll(/^\s*\[projects\.(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\]/gm)) {
    try { out.push({ path: m[1] != null ? JSON.parse(`"${m[1]}"`) : m[2] }); } catch { /* skip odd escapes */ }
  }
  return out;
}

function geminiLikeProjects(dir) {
  const out = [];
  const projects = fsx.readJson(path.join(dir, 'projects.json'));
  for (const p of Object.keys((projects && projects.projects) || {})) out.push({ path: p });
  const trusted = fsx.readJson(path.join(dir, 'trustedFolders.json'));
  for (const [p, level] of Object.entries(trusted || {})) if (level === 'TRUST_FOLDER' || level === true) out.push({ path: p });
  return out.filter(p => path.isAbsolute(p.path));
}

function copilotProjects() {
  const cfg = fsx.readJson(fsx.expand('~/.copilot/permissions-config.json'));
  const out = Object.keys((cfg && cfg.locations) || {}).filter(p => path.isAbsolute(p)).map(p => ({ path: p }));
  return out.concat(sessionFolders(fsx.expand('~/.copilot/session-state')));
}

// Read one text column from a SQLite file (Node's built-in driver; absent on older Node).
function sqliteColumn(file, sql) {
  if (!fsx.exists(file)) return [];
  let db;
  try {
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(file, { readOnly: true });
    return db.prepare(sql).all().map(row => Object.values(row)[0]).filter(v => typeof v === 'string');
  } catch { return []; } finally { try { if (db) db.close(); } catch { /* already closed */ } }
}

// The storage layouts below are not documented by their tools, so each is best effort:
// when a layout does not match, the harness simply lists no projects (add them by hand).
function opencodeProjects() {
  const data = fsx.expand('~/.local/share/opencode');
  const out = [];
  for (const dir of [path.join(data, 'storage', 'project'), path.join(data, 'project')]) {
    for (const e of fsx.listDir(dir)) {
      if (!e.isFile() || !e.name.endsWith('.json')) continue;
      const meta = fsx.readJson(path.join(dir, e.name));
      if (meta && typeof meta.worktree === 'string') out.push({ path: meta.worktree, lastUsed: (meta.time && (meta.time.updated || meta.time.created)) || 0 });
    }
  }
  for (const p of sqliteColumn(path.join(data, 'opencode.db'), 'SELECT worktree FROM project')) out.push({ path: p });
  return out.filter(p => path.isAbsolute(p.path) && p.path !== path.parse(p.path).root);
}

function qwenProjects() {
  const root = fsx.expand('~/.qwen/projects');
  const out = sessionFolders(root); // transcripts directly inside each project folder
  for (const e of fsx.listDir(root)) if (e.isDirectory()) out.push(...sessionFolders(path.join(root, e.name))); // or one level down (chats/)
  return out;
}

function continueProjects() {
  const list = fsx.readJson(fsx.expand('~/.continue/sessions/sessions.json'));
  return (Array.isArray(list) ? list : []).filter(s => s && typeof s.workspaceDirectory === 'string')
    .map(s => { try { return { path: s.workspaceDirectory.startsWith('file:') ? fileURLToPath(s.workspaceDirectory) : s.workspaceDirectory, lastUsed: Number(s.dateCreated) || 0, sessions: 1 }; } catch { return null; } })
    .filter(Boolean);
}

function gooseProjects() {
  const db = WIN ? fsx.expand('%APPDATA%/Block/goose/data/sessions/sessions.db') : fsx.expand('~/.local/share/goose/sessions/sessions.db');
  return sqliteColumn(db, 'SELECT DISTINCT working_dir FROM sessions').map(p => ({ path: p }));
}

const CLAUDE_HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SubagentStop', 'SessionStart', 'SessionEnd', 'PreCompact', 'Notification'];

// ---- shared field sets ----------------------------------------------------------

const EFFORT = sel('low', 'medium', 'high', 'xhigh');
const CODEX_EFFORT = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const HOOK_PROTOCOL_NOTE = name => `${name} documents the same hook protocol as Claude Code; the recipes are written for that protocol and have not been run against a live ${name} install.`;
const PERM = 'Permissions';
const OPENCODE_AGENT_FIELDS = [
  { key: 'mode', label: 'Mode', options: ['primary', 'subagent', 'all'] },
  { key: 'model', label: 'Model', placeholder: 'provider/model' },
  { key: 'temperature', label: 'Temperature', num: true, placeholder: '0 to 1', help: 'Only honoured by models that still accept it.' },
  { key: 'steps', label: 'Max steps', num: true, placeholder: 'e.g. 20' },
];
const std = (label, p, scope = 'global') => (scope === 'global' ? { label, path: p, scope } : { label, rel: p, scope });

// ---- registry -------------------------------------------------------------------

const ADAPTERS = [
  {
    id: 'claude', name: 'Claude Code', vendor: 'Anthropic',
    detect: { bins: ['claude'], dirs: ['~/.claude'], extensions: ['anthropic.claude-code'] },
    instructions: { global: '~/.claude/CLAUDE.md', project: 'CLAUDE.md' },
    settings: { main: { global: '~/.claude/settings.json', project: '.claude/settings.json', format: 'json' } },
    native: [
      { key: 'model', label: 'Model', kind: 'text', placeholder: 'e.g. opus, sonnet, opusplan, or a model id' },
      { key: 'effortLevel', label: 'Reasoning effort', kind: 'select', options: EFFORT, help: 'How hard the model thinks. Higher costs more tokens and time.' },
      { key: 'outputStyle', label: 'Output style', kind: 'select', options: sel('Proactive', 'Concise', 'Explanatory', 'Learning'), help: 'Built-in styles. Custom ones live in output-styles folders.' },
      { key: 'permissions.defaultMode', label: 'Approval mode', kind: 'select', danger: true, group: PERM,
        options: sel({ value: 'plan', label: 'Plan only (read-only)' }, { value: 'default', label: 'Ask before each action' }, { value: 'acceptEdits', label: 'Auto-accept file edits' }, { value: 'auto', label: 'Auto (classifier-reviewed)' }, { value: 'dontAsk', label: 'Deny anything not pre-approved' }, danger('bypassPermissions', 'Bypass all permission checks')),
        help: 'Auto and bypass only take effect from the global file, not a project file.' },
      { key: 'permissions.allow', label: 'Always allow', kind: 'list', group: PERM, placeholder: 'Bash(npm test:*)', help: 'One rule per line. These run without a prompt. Fewer prompts, same safety, if the rules are narrow.' },
      { key: 'permissions.ask', label: 'Always ask', kind: 'list', group: PERM, placeholder: 'Bash(git push:*)', help: 'Prompts even in auto-accept modes.' },
      { key: 'permissions.deny', label: 'Never allow', kind: 'list', group: PERM, placeholder: 'Read(./.env)', help: 'Deny wins over everything, in every mode.' },
      { key: 'alwaysThinkingEnabled', label: 'Extended thinking always on', kind: 'toggle' },
      { key: 'autoCompactEnabled', label: 'Auto-compact context', kind: 'toggle' },
      { key: 'language', label: 'Response language', kind: 'text', placeholder: 'e.g. japanese' },
      { key: 'cleanupPeriodDays', label: 'Keep transcripts (days)', kind: 'number' },
      { key: 'env.CLAUDE_CODE_MAX_OUTPUT_TOKENS', label: 'Max output tokens', kind: 'text', help: 'Hard cap per response. It truncates; it does not make the model concise.' },
      { key: 'env.BASH_MAX_OUTPUT_LENGTH', label: 'Max shell output kept (chars)', kind: 'text', help: 'Lower values cut input tokens from noisy commands.' },
      { key: 'env.CLAUDE_CODE_SUBAGENT_MODEL', label: 'Subagent model', kind: 'text', placeholder: 'e.g. haiku' },
    ],
    items: {
      agents: { global: '~/.claude/agents', project: '.claude/agents', layout: 'file', fields: [
        { key: 'model', label: 'Model', options: ['inherit', 'opus', 'sonnet', 'haiku'] },
        { key: 'tools', label: 'Allowed tools', list: true, placeholder: 'Read, Grep, Glob (empty = all)' },
        { key: 'permissionMode', label: 'Permission mode', options: ['default', 'acceptEdits', 'plan', 'dontAsk'] },
        { key: 'effort', label: 'Reasoning effort', options: ['low', 'medium', 'high', 'xhigh', 'max'] },
      ] },
      skills: { global: '~/.claude/skills', project: '.claude/skills', layout: 'dir', fields: [
        { key: 'allowed-tools', label: 'Allowed tools', list: true, placeholder: 'empty = all' },
      ] },
      commands: { global: '~/.claude/commands', project: '.claude/commands', layout: 'file', nameInFrontmatter: false, note: 'Invoked as /name. $ARGUMENTS inserts what you type after it.', fields: [
        { key: 'argument-hint', label: 'Argument hint', placeholder: '[file]' },
        { key: 'model', label: 'Model' },
      ] },
    },
    files: [std('Global instructions (CLAUDE.md)', '~/.claude/CLAUDE.md'), std('Global settings', '~/.claude/settings.json'),
      std('Project instructions (CLAUDE.md)', 'CLAUDE.md', 'project'), std('Project settings', '.claude/settings.json', 'project'),
      std('Project local settings', '.claude/settings.local.json', 'project'), std('Project MCP servers', '.mcp.json', 'project')],
    permissionPresets: [
      { name: 'Safe dev loop', description: 'No prompts for read-only git, listing files and running tests or lint. Blocks secrets and destructive commands.',
        allow: ['Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git branch:*)', 'Bash(ls:*)', 'Bash(npm test:*)', 'Bash(npm run test:*)', 'Bash(npm run lint:*)', 'Bash(npm run build:*)'],
        ask: ['Bash(git push:*)', 'Bash(git commit:*)'],
        deny: ['Read(./.env)', 'Read(./.env.*)', 'Read(./secrets/**)', 'Bash(rm -rf:*)', 'Bash(git push --force:*)', 'Bash(git reset --hard:*)'] },
      { name: 'Protect secrets', description: 'Only adds deny rules for env files, keys and credential folders.',
        allow: [], ask: [], deny: ['Read(./.env)', 'Read(./.env.*)', 'Read(./secrets/**)', 'Read(**/*.pem)', 'Read(**/id_rsa)', 'Read(~/.ssh/**)', 'Read(~/.aws/**)'] },
      { name: 'Read-only explorer', description: 'Reading and searching never prompt; every edit and command asks.',
        allow: ['Read', 'Glob', 'Grep', 'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(ls:*)'], ask: ['Edit', 'Write', 'Bash'], deny: [] },
    ],
    context: { projectFiles: ['.claude/CLAUDE.md', 'CLAUDE.local.md'], projectDirs: ['.claude/rules'], globalDirs: ['~/.claude/rules'], note: 'Files in subfolders load on demand when the agent works there. AGENTS.md is read only when no CLAUDE.md exists.' },
    mcp: { global: '~/.claude.json', project: '.mcp.json', key: ['mcpServers'], httpType: 'http' },
    hooks: { global: '~/.claude/settings.json', project: '.claude/settings.json', key: ['hooks'], events: CLAUDE_HOOK_EVENTS },
    projects: claudeProjects,
  },
  {
    id: 'codex', name: 'Codex CLI', vendor: 'OpenAI',
    detect: { bins: ['codex'], dirs: ['~/.codex'], extensions: ['openai.chatgpt'] },
    instructions: { global: '~/.codex/AGENTS.md', project: 'AGENTS.md' },
    settings: { main: { global: '~/.codex/config.toml', project: '.codex/config.toml', format: 'toml' } },
    native: [
      { key: 'model', label: 'Model', kind: 'text' },
      { key: 'model_reasoning_effort', label: 'Reasoning effort', kind: 'select', options: sel(...CODEX_EFFORT), help: 'Which levels exist depends on the model.' },
      { key: 'model_verbosity', label: 'Verbosity', kind: 'select', options: sel('low', 'medium', 'high'), help: 'A real output-length control, enforced by the model API.' },
      { key: 'model_reasoning_summary', label: 'Reasoning summaries', kind: 'select', options: sel('auto', 'concise', 'detailed', 'none') },
      { key: 'personality', label: 'Personality', kind: 'select', options: sel('none', 'friendly', 'pragmatic') },
      { key: 'approval_policy', label: 'Approval policy', kind: 'select', group: PERM, options: sel({ value: 'on-request', label: 'Ask when needed' }, { value: 'never', label: 'Never ask' }) },
      { key: 'sandbox_mode', label: 'Sandbox', kind: 'select', danger: true, group: PERM, options: sel({ value: 'read-only', label: 'Read-only' }, { value: 'workspace-write', label: 'Write inside the project' }, danger('danger-full-access', 'Full access, no sandbox')) },
      { key: 'web_search', label: 'Web search', kind: 'select', options: sel('disabled', 'cached', 'indexed', 'live') },
      { key: 'model_auto_compact_token_limit', label: 'Auto-compact at (tokens)', kind: 'number' },
      { key: 'project_doc_max_bytes', label: 'Max instruction file size (bytes)', kind: 'number' },
    ],
    items: {
      agents: { global: '~/.codex/agents', project: '.codex/agents', layout: 'file', ext: '.toml', format: 'toml', bodyKey: 'developer_instructions', fields: [
        { key: 'model', label: 'Model' },
        { key: 'model_reasoning_effort', label: 'Reasoning effort', options: CODEX_EFFORT },
        { key: 'sandbox_mode', label: 'Sandbox', options: ['read-only', 'workspace-write'] },
      ] },
      skills: { global: '~/.agents/skills', project: '.agents/skills', layout: 'dir' },
    },
    context: { maxBytes: 32768, projectFiles: ['AGENTS.override.md'], note: 'An AGENTS.override.md in a folder replaces that folder\'s AGENTS.md.' },
    mcp: { global: '~/.codex/config.toml', project: '.codex/config.toml', style: 'codex', disable: 'enabled' },
    hooks: { global: '~/.codex/hooks.json', project: '.codex/hooks.json', key: ['hooks'], note: HOOK_PROTOCOL_NOTE('Codex'),
      events: ['PreToolUse', 'PermissionRequest', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'Interrupt', 'SubagentStart', 'SubagentStop', 'SessionStart', 'SessionEnd', 'PreCompact', 'PostCompact'] },
    files: [std('Global instructions (AGENTS.md)', '~/.codex/AGENTS.md'), std('Global config', '~/.codex/config.toml'),
      std('Project instructions (AGENTS.md)', 'AGENTS.md', 'project'), std('Project config', '.codex/config.toml', 'project')],
    projects: codexProjects,
  },
  {
    id: 'gemini', name: 'Gemini CLI', vendor: 'Google',
    detect: { bins: ['gemini', 'agy'], dirs: ['~/.gemini'] },
    instructions: { global: '~/.gemini/GEMINI.md', project: 'GEMINI.md' },
    settings: { main: { global: '~/.gemini/settings.json', project: '.gemini/settings.json', format: 'json' } },
    native: [
      { key: 'model.name', label: 'Model', kind: 'text' },
      { key: 'general.defaultApprovalMode', label: 'Approval mode', kind: 'select', group: PERM, options: sel({ value: 'plan', label: 'Plan only' }, { value: 'default', label: 'Ask before each action' }, { value: 'auto_edit', label: 'Auto-accept edits' }) },
      { key: 'model.maxSessionTurns', label: 'Max turns per session', kind: 'number' },
      { key: 'model.compressionThreshold', label: 'Compress context at (0 to 1)', kind: 'number', help: 'Fraction of the context window. Lower compresses sooner.' },
      { key: 'tools.sandbox', label: 'Sandbox tools', kind: 'toggle', group: PERM },
      { key: 'tools.allowed', label: 'Tools that never prompt', kind: 'list', group: PERM, placeholder: 'run_shell_command(git status)', help: 'One per line.' },
      { key: 'tools.exclude', label: 'Tools the agent may not use', kind: 'list', group: PERM, placeholder: 'run_shell_command(rm)', help: 'One per line.' },
    ],
    items: {
      agents: { global: '~/.gemini/agents', project: '.gemini/agents', layout: 'file', fields: [
        { key: 'model', label: 'Model', placeholder: 'inherit or a model id' },
        { key: 'tools', label: 'Allowed tools', list: true },
        { key: 'temperature', label: 'Temperature', num: true, placeholder: '0 to 2' },
        { key: 'max_turns', label: 'Max turns', num: true },
      ] },
      skills: { global: ['~/.gemini/skills', '~/.agents/skills'], project: ['.gemini/skills', '.agents/skills'], layout: 'dir' },
      commands: { global: '~/.gemini/commands', project: '.gemini/commands', layout: 'file', ext: '.toml', format: 'toml', bodyKey: 'prompt', nameInFrontmatter: false, note: 'Invoked as /name. {{args}} inserts what you type after it.' },
    },
    mcp: { global: '~/.gemini/settings.json', project: '.gemini/settings.json', key: ['mcpServers'], urlKey: 'httpUrl' },
    hooks: { global: '~/.gemini/settings.json', project: '.gemini/settings.json', key: ['hooks'], events: ['BeforeTool', 'AfterTool', 'BeforeToolSelection', 'BeforeAgent', 'AfterAgent', 'BeforeModel', 'AfterModel', 'SessionStart', 'SessionEnd', 'PreCompress', 'Notification'] },
    files: [std('Global instructions (GEMINI.md)', '~/.gemini/GEMINI.md'), std('Global settings', '~/.gemini/settings.json'),
      std('Project instructions (GEMINI.md)', 'GEMINI.md', 'project'), std('Project settings', '.gemini/settings.json', 'project')],
    projects: () => geminiLikeProjects(fsx.expand('~/.gemini')),
  },
  {
    id: 'pi', name: 'Pi', vendor: 'Mario Zechner',
    detect: { dirs: ['~/.pi/agent'] },
    instructions: { global: '~/.pi/agent/AGENTS.md', project: 'AGENTS.md' },
    settings: { main: { global: '~/.pi/agent/settings.json', project: '.pi/settings.json', format: 'json' } },
    native: [
      { key: 'defaultProvider', label: 'Provider', kind: 'text' },
      { key: 'defaultModel', label: 'Model', kind: 'text' },
      { key: 'defaultThinkingLevel', label: 'Thinking level', kind: 'select', options: sel('off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max') },
      { key: 'compaction.enabled', label: 'Auto-compact context', kind: 'toggle' },
      { key: 'compaction.reserveTokens', label: 'Compaction: reserve tokens', kind: 'number' },
      { key: 'compaction.keepRecentTokens', label: 'Compaction: keep recent tokens', kind: 'number' },
    ],
    items: {
      skills: { global: '~/.pi/agent/skills', project: '.pi/skills', layout: 'dir' },
      commands: { global: '~/.pi/agent/prompts', project: '.pi/prompts', layout: 'file', nameInFrontmatter: false, note: 'Pi calls these prompt templates. Pi has no permission system: it runs everything.', fields: [
        { key: 'argument-hint', label: 'Argument hint' },
      ] },
    },
    files: [std('Global instructions (AGENTS.md)', '~/.pi/agent/AGENTS.md'), std('Global settings', '~/.pi/agent/settings.json'),
      std('Appended system prompt', '~/.pi/agent/APPEND_SYSTEM.md'), std('Project instructions (AGENTS.md)', 'AGENTS.md', 'project'), std('Project settings', '.pi/settings.json', 'project')],
    projects: () => sessionFolders(fsx.expand('~/.pi/agent/sessions')),
  },
  {
    id: 'opencode', name: 'OpenCode', vendor: 'SST',
    detect: { bins: ['opencode'], dirs: ['~/.config/opencode', '~/.local/share/opencode'] },
    instructions: { global: '~/.config/opencode/AGENTS.md', project: 'AGENTS.md' },
    settings: { main: { global: '~/.config/opencode/opencode.json', project: 'opencode.json', format: 'json' } },
    native: [
      { key: 'model', label: 'Model', kind: 'text', placeholder: 'provider/model' },
      { key: 'small_model', label: 'Small model (cheap tasks)', kind: 'text', placeholder: 'provider/model' },
      { key: 'default_agent', label: 'Default agent', kind: 'text', placeholder: 'build, plan, ...' },
      { key: 'permission.edit', label: 'File edits', kind: 'select', group: PERM, options: sel('allow', 'ask', 'deny') },
      { key: 'permission.bash', label: 'Shell commands', kind: 'select', group: PERM, options: sel('allow', 'ask', 'deny') },
      { key: 'permission.webfetch', label: 'Web fetch', kind: 'select', group: PERM, options: sel('allow', 'ask', 'deny') },
      { key: 'compaction.auto', label: 'Auto-compact context', kind: 'toggle' },
      { key: 'compaction.prune', label: 'Prune old tool output', kind: 'toggle' },
      { key: 'share', label: 'Session sharing', kind: 'select', options: sel('manual', 'auto', 'disabled') },
    ],
    items: {
      agents: { global: ['~/.config/opencode/agents', '~/.config/opencode/agent'], project: ['.opencode/agents', '.opencode/agent'], layout: 'file', nameInFrontmatter: false, fields: OPENCODE_AGENT_FIELDS },
      skills: { global: ['~/.config/opencode/skills', '~/.config/opencode/skill'], project: ['.opencode/skills', '.opencode/skill'], layout: 'dir' },
      commands: { global: ['~/.config/opencode/commands', '~/.config/opencode/command'], project: ['.opencode/commands', '.opencode/command'], layout: 'file', nameInFrontmatter: false, fields: [
        { key: 'agent', label: 'Run with agent' }, { key: 'model', label: 'Model' },
      ] },
    },
    files: [std('Global instructions (AGENTS.md)', '~/.config/opencode/AGENTS.md'), std('Global config', '~/.config/opencode/opencode.json'),
      std('Project instructions (AGENTS.md)', 'AGENTS.md', 'project'), std('Project config', 'opencode.json', 'project')],
    mcp: { global: '~/.config/opencode/opencode.json', project: 'opencode.json', key: ['mcp'], style: 'opencode', disable: 'enabled' },
    projects: opencodeProjects,
  },
  {
    id: 'cursor', name: 'Cursor', vendor: 'Anysphere',
    note: 'Cursor keeps its global "User Rules" inside the app, not in a file, so behavior tuning is per project (written to AGENTS.md).',
    detect: { bins: ['cursor', 'cursor-agent'], dirs: ['~/.cursor', '%APPDATA%/Cursor'] },
    instructions: { global: null, project: 'AGENTS.md' },
    settings: { main: { global: '~/.cursor/cli-config.json', format: 'json' } },
    native: [
      { key: 'model', label: 'CLI model', kind: 'text' },
      { key: 'approvalMode', label: 'CLI approval mode', kind: 'select', danger: true, options: sel({ value: 'allowlist', label: 'Allowlist only' }, { value: 'auto-review', label: 'Auto-review' }, danger('unrestricted', 'Unrestricted')) },
    ],
    items: {
      agents: { global: '~/.cursor/agents', project: '.cursor/agents', layout: 'file', fields: [
        { key: 'model', label: 'Model', placeholder: 'inherit or a model id' },
        { key: 'readonly', label: 'Read-only', bool: true, options: ['true', 'false'] },
      ] },
      skills: { global: '~/.cursor/skills', project: '.cursor/skills', layout: 'dir' },
      commands: { project: '.cursor/commands', layout: 'file', nameInFrontmatter: false, note: 'Cursor commands are per project: pick one in Scope.' },
    },
    files: [std('CLI config', '~/.cursor/cli-config.json'), std('Global MCP servers', '~/.cursor/mcp.json'),
      std('Project instructions (AGENTS.md)', 'AGENTS.md', 'project'), std('Project MCP servers', '.cursor/mcp.json', 'project')],
    context: { projectDirs: ['.cursor/rules'], ancestors: false, note: 'Rules in .cursor/rules load according to their own alwaysApply and globs settings.' },
    mcp: { global: '~/.cursor/mcp.json', project: '.cursor/mcp.json', key: ['mcpServers'] },
    projects: () => editorWorkspaces('Cursor'),
  },
  {
    id: 'windsurf', name: 'Windsurf / Devin Desktop', vendor: 'Cognition',
    note: 'Global rules are capped at about 6,000 characters by Windsurf.',
    detect: { bins: ['windsurf', 'devin-desktop', 'surf'], dirs: ['~/.codeium/windsurf'] },
    instructions: { global: '~/.codeium/windsurf/memories/global_rules.md', project: 'AGENTS.md' },
    items: {
      skills: { global: '~/.codeium/windsurf/skills', project: ['.windsurf/skills', '.devin/skills'], layout: 'dir' },
      commands: { global: '~/.codeium/windsurf/global_workflows', project: ['.windsurf/workflows', '.devin/workflows'], layout: 'file', nameInFrontmatter: false, note: 'Windsurf calls these workflows; run them with /name.' },
    },
    files: [std('Global rules', '~/.codeium/windsurf/memories/global_rules.md'), std('MCP servers', '~/.codeium/windsurf/mcp_config.json'),
      std('Project instructions (AGENTS.md)', 'AGENTS.md', 'project')],
    context: { projectDirs: ['.devin/rules', '.windsurf/rules'], ancestors: false },
    mcp: { global: '~/.codeium/windsurf/mcp_config.json', key: ['mcpServers'], urlKey: 'serverUrl', disable: 'disabled' },
    projects: () => editorWorkspaces('Windsurf'),
  },
  {
    id: 'copilot', name: 'GitHub Copilot CLI', vendor: 'GitHub',
    detect: { bins: ['copilot'], dirs: ['~/.copilot'] },
    instructions: { global: '~/.copilot/copilot-instructions.md', project: '.github/copilot-instructions.md' },
    settings: { main: { global: '~/.copilot/settings.json', format: 'json' } },
    native: [{ key: 'model', label: 'Model', kind: 'text', placeholder: 'auto or a model id' }],
    items: {
      agents: { global: '~/.copilot/agents', project: '.github/agents', layout: 'file', ext: '.agent.md', fields: [
        { key: 'model', label: 'Model' }, { key: 'tools', label: 'Allowed tools', list: true },
      ] },
      skills: { global: '~/.copilot/skills', project: '.github/skills', layout: 'dir' },
    },
    files: [std('Global instructions', '~/.copilot/copilot-instructions.md'), std('Settings', '~/.copilot/settings.json'), std('MCP servers', '~/.copilot/mcp-config.json'),
      std('Project instructions', '.github/copilot-instructions.md', 'project')],
    mcp: { global: '~/.copilot/mcp-config.json', key: ['mcpServers'] },
    projects: copilotProjects,
  },
  {
    id: 'qwen', name: 'Qwen Code', vendor: 'Alibaba',
    detect: { bins: ['qwen'], dirs: ['~/.qwen'] },
    instructions: { global: '~/.qwen/QWEN.md', project: 'QWEN.md' },
    settings: { main: { global: '~/.qwen/settings.json', project: '.qwen/settings.json', format: 'json' } },
    native: [
      { key: 'model.name', label: 'Model', kind: 'text' },
      { key: 'model.reasoningEffort', label: 'Reasoning effort', kind: 'select', options: sel('low', 'medium', 'high', 'xhigh', 'max') },
      { key: 'model.generationConfig.samplingParams.temperature', label: 'Temperature', kind: 'number', help: 'Lower is more deterministic. One of the few harnesses that still exposes this.' },
      { key: 'model.generationConfig.samplingParams.top_p', label: 'Top-p', kind: 'number' },
      { key: 'model.generationConfig.samplingParams.max_tokens', label: 'Max output tokens', kind: 'number' },
      { key: 'tools.approvalMode', label: 'Approval mode', kind: 'select', danger: true, group: PERM, options: sel({ value: 'plan', label: 'Plan only' }, { value: 'default', label: 'Ask before each action' }, { value: 'auto-edit', label: 'Auto-accept edits' }, { value: 'auto', label: 'Auto' }, danger('yolo', 'YOLO (never ask)')) },
      { key: 'context.autoCompactThreshold', label: 'Auto-compact at (0 to 1)', kind: 'number' },
    ],
    items: {
      agents: { global: '~/.qwen/agents', project: '.qwen/agents', layout: 'file', fields: [
        { key: 'model', label: 'Model', placeholder: 'inherit, fast, or a model id' },
        { key: 'tools', label: 'Allowed tools', list: true },
        { key: 'approvalMode', label: 'Approval mode', options: ['default', 'plan', 'auto-edit'] },
        { key: 'maxTurns', label: 'Max turns', num: true },
      ] },
      skills: { global: '~/.qwen/skills', project: '.qwen/skills', layout: 'dir' },
    },
    files: [std('Global instructions (QWEN.md)', '~/.qwen/QWEN.md'), std('Global settings', '~/.qwen/settings.json'),
      std('Project instructions (QWEN.md)', 'QWEN.md', 'project'), std('Project settings', '.qwen/settings.json', 'project')],
    mcp: { global: '~/.qwen/settings.json', project: '.qwen/settings.json', key: ['mcpServers'], urlKey: 'httpUrl' },
    projects: qwenProjects,
  },
  {
    id: 'droid', name: 'Factory Droid', vendor: 'Factory',
    detect: { bins: ['droid'], dirs: ['~/.factory'] },
    instructions: { global: '~/.factory/AGENTS.md', project: 'AGENTS.md' },
    settings: { main: { global: '~/.factory/settings.json', project: '.factory/settings.json', format: 'json' } },
    native: [
      { key: 'model', label: 'Model', kind: 'text' },
      { key: 'reasoningEffort', label: 'Reasoning effort', kind: 'select', options: sel('none', 'dynamic', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'), help: 'Which levels exist depends on the model.' },
      { key: 'outputStyle', label: 'Output style', kind: 'select', options: sel('default', 'concise') },
      { key: 'sessionDefaultSettings.autonomyLevel', label: 'Autonomy level', kind: 'select', group: PERM, options: sel('off', 'low', 'medium', 'high') },
      { key: 'sessionDefaultSettings.interactionMode', label: 'Interaction mode', kind: 'select', options: sel({ value: 'auto', label: 'Auto' }, { value: 'spec', label: 'Spec first' }) },
    ],
    items: {
      agents: { global: '~/.factory/droids', project: '.factory/droids', layout: 'file', note: 'Factory calls subagents "droids".', fields: [
        { key: 'model', label: 'Model', placeholder: 'inherit or a model id' },
        { key: 'reasoningEffort', label: 'Reasoning effort', options: ['low', 'medium', 'high'] },
        { key: 'tools', label: 'Tools', placeholder: 'read-only, edit, execute or web' },
      ] },
      skills: { global: '~/.factory/skills', project: '.factory/skills', layout: 'dir' },
      commands: { global: '~/.factory/commands', project: '.factory/commands', layout: 'file', nameInFrontmatter: false, fields: [{ key: 'argument-hint', label: 'Argument hint' }] },
    },
    files: [std('Global instructions (AGENTS.md)', '~/.factory/AGENTS.md'), std('Global settings', '~/.factory/settings.json'),
      std('Project instructions (AGENTS.md)', 'AGENTS.md', 'project'), std('Project settings', '.factory/settings.json', 'project')],
    mcp: { global: '~/.factory/mcp.json', project: '.factory/mcp.json', key: ['mcpServers'] },
    hooks: { global: '~/.factory/hooks.json', project: '.factory/hooks.json', key: [], events: CLAUDE_HOOK_EVENTS, note: HOOK_PROTOCOL_NOTE('Factory Droid') },
    projects: () => rolloutProjects(fsx.expand('~/.factory/sessions')),
  },
  {
    id: 'codewhale', name: 'Codewhale (DeepSeek TUI)', vendor: 'Hmbown',
    note: 'No global instruction file; behavior tuning is per project (AGENTS.md).',
    detect: { bins: ['codewhale'], dirs: ['~/.codewhale'] },
    instructions: { global: null, project: 'AGENTS.md' },
    settings: { main: { global: '~/.codewhale/config.toml', format: 'toml' } },
    native: [
      { key: 'default_text_model', label: 'Model', kind: 'text' },
      { key: 'reasoning_effort', label: 'Reasoning effort', kind: 'select', options: sel('off', 'low', 'medium', 'high', 'max') },
      { key: 'approval_policy', label: 'Approval policy', kind: 'select', group: PERM, options: sel({ value: 'untrusted', label: 'Ask for untrusted commands' }, { value: 'on-request', label: 'Ask when needed' }, { value: 'never', label: 'Never ask' }) },
      { key: 'sandbox_mode', label: 'Sandbox', kind: 'select', danger: true, group: PERM, options: sel('read-only', 'workspace-write', danger('danger-full-access', 'Full access, no sandbox')) },
      { key: 'auto_compact', label: 'Auto-compact context', kind: 'toggle' },
      { key: 'auto_compact_threshold_percent', label: 'Auto-compact at (%)', kind: 'number' },
      { key: 'max_subagents', label: 'Max subagents', kind: 'number' },
    ],
    files: [std('Config', '~/.codewhale/config.toml'), std('Project instructions (AGENTS.md)', 'AGENTS.md', 'project')],
    projects: () => rolloutProjects(fsx.expand('~/.codewhale/sessions')),
  },
  {
    id: 'kilo', name: 'Kilo Code', vendor: 'Kilo',
    note: 'Kilo has no global rules folder (global rules are listed in kilo.jsonc), so behavior tuning is per project.',
    detect: { bins: ['kilo'], dirs: ['~/.config/kilo', '~/.kilocode'], extensions: ['kilocode.kilo-code'] },
    instructions: { global: null, project: '.kilo/rules/agentdeck.md' },
    items: {
      agents: { global: ['~/.config/kilo/agent', '~/.config/kilo/agents'], project: ['.kilo/agents', '.kilo/agent'], layout: 'file', nameInFrontmatter: false, fields: OPENCODE_AGENT_FIELDS },
      skills: { global: '~/.kilo/skills', project: '.kilo/skills', layout: 'dir' },
      commands: { global: '~/.config/kilo/commands', project: '.kilo/commands', layout: 'file', nameInFrontmatter: false, fields: [{ key: 'agent', label: 'Run with agent' }, { key: 'model', label: 'Model' }] },
    },
    files: [std('Global config (JSONC)', '~/.config/kilo/kilo.jsonc'), std('Project config (JSONC)', 'kilo.jsonc', 'project')],
  },
  {
    id: 'cline', name: 'Cline', vendor: 'Cline',
    detect: { bins: ['cline'], dirs: ['~/.cline'], extensions: ['saoudrizwan.claude-dev'] },
    instructions: { global: '~/.cline/rules/agentdeck.md', project: 'AGENTS.md' },
    items: { skills: { global: '~/.cline/skills', project: '.cline/skills', layout: 'dir' } },
    files: [std('MCP servers', '~/.cline/data/settings/cline_mcp_settings.json'), std('Project instructions (AGENTS.md)', 'AGENTS.md', 'project')],
    mcp: { global: '~/.cline/data/settings/cline_mcp_settings.json', key: ['mcpServers'], disable: 'disabled' },
  },
  {
    id: 'kiro', name: 'Kiro', vendor: 'AWS',
    detect: { bins: ['kiro-cli', 'kiro'], dirs: ['~/.kiro'] },
    instructions: { global: '~/.kiro/steering/agentdeck.md', project: '.kiro/steering/agentdeck.md' },
    items: { skills: { global: '~/.kiro/skills', project: '.kiro/skills', layout: 'dir' } },
    files: [std('CLI settings', '~/.kiro/settings/cli.json'), std('Global MCP servers', '~/.kiro/settings/mcp.json'), std('Project MCP servers', '.kiro/settings/mcp.json', 'project')],
    mcp: { global: '~/.kiro/settings/mcp.json', project: '.kiro/settings/mcp.json', key: ['mcpServers'], disable: 'disabled' },
  },
  {
    id: 'goose', name: 'Goose', vendor: 'Block',
    detect: { bins: ['goose'], dirs: ['%APPDATA%/Block/goose', '~/.config/goose'] },
    instructions: { global: WIN ? '%APPDATA%/Block/goose/config/.goosehints' : '~/.config/goose/.goosehints', project: '.goosehints' },
    items: { skills: { global: '~/.agents/skills', project: '.agents/skills', layout: 'dir' } },
    files: [std('Config (YAML)', WIN ? '%APPDATA%/Block/goose/config/config.yaml' : '~/.config/goose/config.yaml'), std('Project hints', '.goosehints', 'project')],
    needsSqlite: true,
    projects: gooseProjects,
  },
  {
    id: 'amp', name: 'Amp', vendor: 'Sourcegraph',
    detect: { bins: ['amp'], dirs: ['~/.config/amp'] },
    instructions: { global: '~/.config/amp/AGENTS.md', project: 'AGENTS.md' },
    items: { skills: { global: '~/.config/amp/skills', project: '.agents/skills', layout: 'dir' } },
    files: [std('Global instructions (AGENTS.md)', '~/.config/amp/AGENTS.md'), std('Settings', '~/.config/amp/settings.json'), std('Project instructions (AGENTS.md)', 'AGENTS.md', 'project')],
    mcp: { global: '~/.config/amp/settings.json', project: '.amp/settings.json', key: ['amp.mcpServers'] },
  },
  {
    id: 'crush', name: 'Crush', vendor: 'Charm',
    detect: { bins: ['crush'], dirs: ['~/.config/crush'] },
    instructions: { global: '~/.config/crush/CRUSH.md', project: 'AGENTS.md' },
    items: { skills: { global: '~/.config/crush/skills', project: '.crush/skills', layout: 'dir' } },
    files: [std('Global instructions (CRUSH.md)', '~/.config/crush/CRUSH.md'), std('Config (crushrc)', '~/.config/crush/crushrc'), std('Project instructions (AGENTS.md)', 'AGENTS.md', 'project')],
  },
  {
    id: 'zed', name: 'Zed Agent', vendor: 'Zed',
    note: 'In a project, Zed reads only the first rules file it finds (.rules, .cursorrules, ... then AGENTS.md).',
    detect: { bins: ['zed'], dirs: ['%APPDATA%/Zed', '~/.config/zed'] },
    instructions: { global: WIN ? '%APPDATA%/Zed/AGENTS.md' : '~/.config/zed/AGENTS.md', project: 'AGENTS.md' },
    items: { skills: { global: '~/.agents/skills', project: '.agents/skills', layout: 'dir' } },
    files: [std('Settings (JSONC)', WIN ? '%APPDATA%/Zed/settings.json' : '~/.config/zed/settings.json'), std('Project instructions (AGENTS.md)', 'AGENTS.md', 'project')],
  },
  {
    id: 'continue', name: 'Continue', vendor: 'Continue',
    detect: { bins: ['cn'], dirs: ['~/.continue'], extensions: ['continue.continue'] },
    instructions: { global: '~/.continue/rules/agentdeck.md', project: '.continue/rules/agentdeck.md' },
    files: [std('Config (YAML)', '~/.continue/config.yaml')],
    projects: continueProjects,
  },
  {
    id: 'aider', name: 'Aider', vendor: 'Aider',
    note: 'Aider does not auto-load an instruction file. After applying, add "read: [CONVENTIONS.md]" to .aider.conf.yml (Files tab) so it is picked up.',
    detect: { bins: ['aider'] },
    instructions: { global: null, project: 'CONVENTIONS.md' },
    files: [std('Global config (YAML)', '~/.aider.conf.yml'), std('Project config (YAML)', '.aider.conf.yml', 'project'), std('Project conventions', 'CONVENTIONS.md', 'project')],
  },
  {
    id: 'roo', name: 'Roo Code (discontinued)', vendor: 'Roo',
    note: 'Roo Code was reported shut down in May 2026. Existing installs still read these rule files.',
    detect: { dirs: ['~/.roo'], extensions: ['rooveterinaryinc.roo-cline'] },
    instructions: { global: '~/.roo/rules/agentdeck.md', project: '.roo/rules/agentdeck.md' },
    files: [],
  },
];

module.exports = { ADAPTERS };
