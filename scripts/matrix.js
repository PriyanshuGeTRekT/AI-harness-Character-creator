// Regenerates the "Supported harnesses" table in README.md from lib/adapters.js, so the
// docs can never drift from what the code does:  npm run docs
const fs = require('fs');
const path = require('path');
const { ADAPTERS } = require('../lib/adapters');

const yes = v => (v ? 'yes' : '');
const rows = ADAPTERS.map(a => {
  const items = Object.keys(a.items || {}).join(', ');
  const file = [a.instructions.global, a.instructions.project].filter(Boolean).map(f => '`' + path.posix.basename(f.replace(/\\/g, '/')) + '`').filter((v, i, arr) => arr.indexOf(v) === i).join(' / ');
  return `| ${a.name} | ${file} | ${yes((a.native || []).length)} | ${items} | ${yes(a.mcp)} | ${yes(a.hooks)} | ${yes(a.projects)} |`;
});
const table = ['| Harness | Instruction file | Settings | Agents, skills, commands | MCP | Hooks | Finds projects |', '|---|---|---|---|---|---|---|', ...rows].join('\n');

const readme = path.join(__dirname, '..', 'README.md');
const text = fs.readFileSync(readme, 'utf8');
const next = text.replace(/(<!-- matrix:start -->)[\s\S]*?(<!-- matrix:end -->)/, `$1\n${table}\n$2`);
if (next === text && !text.includes(table)) { console.error('README.md has no matrix markers.'); process.exit(1); }
fs.writeFileSync(readme, next);
console.log(`README matrix updated: ${ADAPTERS.length} harnesses.`);
