// Serves the UI against a throwaway fake home with sample data, for trying things (and
// taking screenshots) without touching real config:  node test/demo-server.js [port]
const fs = require('fs');
const path = require('path');
const os = require('os');

const H = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-demo-'));
Object.assign(process.env, { USERPROFILE: H, HOME: H, APPDATA: path.join(H, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(H, 'AppData', 'Local') });
const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(H, rel)), { recursive: true }); fs.writeFileSync(path.join(H, rel), text); };
const projects = ['web-shop', 'api-gateway', 'mobile-app'].map(n => path.join(H, 'code', n));
projects.forEach(p => fs.mkdirSync(p, { recursive: true }));

// Claude Code: instruction file, settings, an agent, MCP servers, and a month of sessions.
write('.claude/CLAUDE.md', '# My rules\n\n- Use pnpm, not npm.\n- Never commit directly to main.\n');
write('.claude/settings.json', JSON.stringify({ model: 'opus', permissions: { allow: ['Bash(ls:*)'] } }, null, 2));
write('.claude/agents/reviewer.md', '---\nname: reviewer\ndescription: Reviews code changes for bugs. Use after edits.\ntools:\n- Read\n- Grep\nmodel: sonnet\n---\n\nYou are a senior code reviewer.\n');
write('.claude.json', JSON.stringify({ mcpServers: { github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: 'ghp_exampleexampleexampleexample1234' } }, docs: { type: 'http', url: 'https://mcp.example.com/docs' } } }, null, 2));
const models = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5'];
let n = 0;
projects.forEach((cwd, pi) => {
  for (let s = 0; s < 6 + pi * 3; s++) {
    const lines = [];
    const day = (s * 5 + pi * 3) % 30;
    let cost = 0;
    for (let m = 0; m < 12 + ((s * 7) % 20); m++) {
      const model = models[(s + m) % 7 === 0 ? 2 : (s % 3 === 0 ? 1 : 0)];
      const out = 300 + ((m * 977 + s * 131) % 2400);
      const cacheRead = 40000 + ((m * 7919) % 90000);
      cost += out * (model.includes('opus') ? 0.000075 : model.includes('sonnet') ? 0.000015 : 0.000005) + cacheRead * 0.0000015;
      lines.push(JSON.stringify({ type: 'assistant', cwd, timestamp: new Date(Date.now() - day * 86400000 - m * 60000).toISOString(), requestId: `r${++n}`, message: { id: `m${n}`, model, role: 'assistant', usage: { input_tokens: 800 + (m % 5) * 300, output_tokens: out, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 2000 } } }));
    }
    lines.push(JSON.stringify({ type: 'cost-state', totalCostUSD: Number(cost.toFixed(4)) }));
    write(`.claude/projects/p${pi}/s${s}.jsonl`, lines.join('\n') + '\n');
  }
});

// Codex, Gemini CLI and Cursor: enough to be detected and to share two of the projects.
write('.codex/config.toml', `model = "gpt-5.5"\nmodel_reasoning_effort = "medium"\n\n[projects.'${projects[0]}']\ntrust_level = "trusted"\n\n[projects.'${projects[1]}']\ntrust_level = "trusted"\n`);
write('.gemini/settings.json', JSON.stringify({ model: { name: 'gemini-3-pro' } }, null, 2));
write('.gemini/trustedFolders.json', JSON.stringify({ [projects[0]]: 'TRUST_FOLDER' }));
write('.cursor/mcp.json', JSON.stringify({ mcpServers: {} }, null, 2));

const port = Number(process.argv[2]) || Number(process.env.AGENTDECK_PORT) || undefined;
require('../server.js').start({ port }).then(s => console.log(`Demo AgentDeck: ${s.url}\nFake home: ${H}`));
