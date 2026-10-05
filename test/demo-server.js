// Serves the UI against a throwaway fake home, for trying things without touching real config.
const fs = require('fs'), path = require('path'), os = require('os');
const H = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-demo-'));
process.env.USERPROFILE = H; process.env.HOME = H; process.env.APPDATA = path.join(H, 'AppData', 'Roaming');
for (const d of ['.claude/projects/p1', 'demo-project', '.codex', '.gemini']) fs.mkdirSync(path.join(H, d), { recursive: true });
fs.writeFileSync(path.join(H, '.claude/projects/p1/a.jsonl'), JSON.stringify({ type: 'user', cwd: path.join(H, 'demo-project') }) + '\n');
fs.writeFileSync(path.join(H, '.claude/CLAUDE.md'), '# My rules\n\n- Use pnpm, not npm.\n');
fs.writeFileSync(path.join(H, '.claude/settings.json'), JSON.stringify({ permissions: { allow: ['Bash(ls)'] } }, null, 2));
fs.writeFileSync(path.join(H, '.codex/config.toml'), 'model = "gpt-5"\n');
process.argv.push('--no-open');
console.log('Demo home:', H);
require('../server.js');
