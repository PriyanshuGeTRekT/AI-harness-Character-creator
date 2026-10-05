// Terminal commands that need no browser: agentdeck scan | doctor | usage | help.
const core = require('./core');
const insights = require('./insights');

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = s => paint('1', s);
const dim = s => paint('2', s);
const green = s => paint('32', s);
const yellow = s => paint('33', s);
const red = s => paint('31', s);

const num = n => (n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n)));
const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - String(s).length));

function table(rows) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map(r => String(r[i]).length)));
  return rows.map((r, n) => r.map((c, i) => (n === 0 ? bold(pad(c, widths[i])) : pad(c, widths[i]))).join('  ')).join('\n');
}

function scan() {
  const s = core.scan();
  const on = s.harnesses.filter(h => h.installed);
  console.log(bold(`\nAgentDeck ${s.version}`) + dim(`  ·  ${on.length} of ${s.harnesses.length} harnesses detected\n`));
  if (!on.length) { console.log('No AI coding harness was found on this machine.\n'); return 0; }
  console.log(table([['Harness', 'Projects', 'Tuned', 'Found by'], ...on.map(h => [h.name, h.projects.length, h.tuned ? 'yes' : '-', h.evidence.join(', ')])]));
  console.log(dim(`\nNot installed: ${s.harnesses.filter(h => !h.installed).map(h => h.name).join(', ')}\n`));
  return 0;
}

function doctor() {
  core.scan();
  const h = insights.health();
  const colour = h.score >= 85 ? green : h.score >= 60 ? yellow : red;
  console.log(bold('\nAgentDeck doctor') + `  ·  config health ${colour(h.score + '/100')}\n`);
  if (!h.findings.length) { console.log(green('No problems found.\n')); return 0; }
  for (const f of h.findings) {
    const tag = f.level === 'high' ? red('HIGH') : f.level === 'warn' ? yellow('WARN') : dim('INFO');
    const who = f.harness ? ` ${dim('[' + core.adapter(f.harness).name + ']')}` : '';
    console.log(`${tag}${who} ${bold(f.title)}\n     ${f.detail}`);
  }
  console.log(dim('\nRun "agentdeck" to fix these in the app.\n'));
  return h.counts.high ? 1 : 0;
}

function usage(args) {
  const days = Number(args[0]) || 30;
  const u = insights.usage({ days });
  if (!u.available) { console.log('\n' + u.reason + '\n'); return 0; }
  const t = u.totals;
  console.log(bold(`\nClaude Code usage, last ${u.window} days`) + dim(`  ·  ${u.sessions} sessions\n`));
  console.log(table([
    ['', 'Input', 'Output', 'Cache read', 'Cache write', 'Cost'],
    ['Total', num(t.input), num(t.output), num(t.cacheRead), num(t.cacheWrite), '$' + t.cost.toFixed(2)],
  ]));
  if (u.models.length) console.log('\n' + table([['Model', 'Output', 'Cost'], ...u.models.slice(0, 8).map(m => [m.name, num(m.output), '$' + m.cost.toFixed(2)])]));
  if (u.projects.length) console.log('\n' + table([['Project', 'Sessions', 'Output', 'Cost'], ...u.projects.slice(0, 10).map(p => [p.label, p.sessions, num(p.output), '$' + p.cost.toFixed(2)])]));
  console.log(dim(`\n${u.costNote}\n`));
  return 0;
}

function help() {
  console.log(`
${bold('AgentDeck')} ${core.VERSION}: one control panel for every AI coding agent on this machine.

  agentdeck                 open the app in its own window
  agentdeck --browser       open it in your default browser instead
  agentdeck scan            list detected harnesses and their projects
  agentdeck doctor          check your agent config for problems (exit 1 on serious ones)
  agentdeck usage [days]    Claude Code tokens and cost, by model and project
  agentdeck --port 5000     use another port (or set AGENTDECK_PORT)
  agentdeck --version
`);
  return 0;
}

const COMMANDS = { scan, doctor, usage, help };

// Returns an exit code when argv named a command, or null to start the server.
function run(argv) {
  const [cmd, ...rest] = argv.filter(a => !a.startsWith('-'));
  if (argv.includes('--version') || argv.includes('-v')) { console.log(core.VERSION); return 0; }
  if (argv.includes('--help') || argv.includes('-h')) return help();
  if (!cmd) return null;
  if (!COMMANDS[cmd]) { console.error(`Unknown command "${cmd}".`); help(); return 2; }
  return COMMANDS[cmd](rest);
}

module.exports = { run };
