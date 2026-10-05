// AgentDeck hook recipe: block destructive shell commands.
// The event arrives as JSON on stdin. Exit code 2 blocks the command and shows the agent
// the message on stderr. This is a safety net against mistakes, not a sandbox: a
// determined command can always be disguised. Keep your harness's sandbox on as well.
if (require.main === module) {
  let input = '';
  process.stdin.on('data', d => { input += d; }).on('end', () => {
    let event = {};
    try { event = JSON.parse(input); } catch { /* not JSON: nothing to check */ }
    const command = String((event.tool_input && (event.tool_input.command || event.tool_input.cmd)) || '');
    const why = check(command);
    if (why) {
      process.stderr.write(`Blocked by the AgentDeck guard: ${why}. Do not retry or work around it. Tell the user the exact command so they can run it themselves.\n`);
      process.exit(2);
    }
    process.exit(0);
  });
}

// Split into simple commands, then into words, so that text inside an argument
// (a commit message, a grep pattern) is never mistaken for the command itself.
function words(segment) {
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(segment))) out.push({ text: m[1] != null ? m[1] : m[2] != null ? m[2] : m[3], quoted: m[3] == null });
  return out;
}

function segments(command) {
  const out = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) { cur += c; if (c === '\\' && quote === '"') cur += command[++i] || ''; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === ';' || c === '\n' || c === '|' || c === '&') { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

// A root, home folder, drive, the current or a parent folder, optionally with a trailing
// slash or wildcard:  /  /*  ~  ~/  $HOME/  .  ./*  ../..  *  C:\  C:\*
const ROOTISH = /^((\.\.?[\\/])*\.\.?|\/|~|\$HOME|\$\{HOME\}|\$env:USERPROFILE|%USERPROFILE%|[A-Za-z]:)?[\\/]*\*?$/i;
const isRootish = t => t !== '' && ROOTISH.test(t);
const DB_CLIENTS = /^(psql|mysql|mariadb|sqlite3|sqlcmd|mongosh|mongo|clickhouse-client|bq|duckdb)$/i;
const WRAPPERS = /^(sudo|doas|env|command|nohup|time|exec|nice|xargs)$/;

function check(command) {
  // Download piped straight into a shell: look at the whole line, since it spans a pipe.
  if (/\b(curl|wget|iwr|Invoke-WebRequest)\b[^|;&]*\|\s*(sudo\s+(-\S+\s+)*)?((ba|z|da|fi|k)?sh|iex|Invoke-Expression)\b/i.test(command)) return 'piping a download straight into a shell';

  for (const segment of segments(command)) {
    let w = words(segment);
    // Skip wrappers, their options and VAR=value prefixes to reach the real command.
    while (w.length && (WRAPPERS.test(w[0].text) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0].text) || (w[0].text.startsWith('-') && !w[0].quoted))) w = w.slice(1);
    if (!w.length) continue;
    const cmd = w[0].text.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '');
    const args = w.slice(1);
    const flags = args.filter(a => !a.quoted && a.text.startsWith('-') && a.text !== '--').map(a => a.text);
    const rest = args.filter(a => a.quoted || !a.text.startsWith('-')).map(a => a.text);
    const has = re => flags.some(f => re.test(f));

    if (/^(rm|rmdir|del|rd|ri|Remove-Item|erase)$/i.test(cmd)) {
      const recursive = has(/^-[a-zA-Z]*[rR][a-zA-Z]*$/) || has(/^--recursive$/) || has(/^-rec(u(r(s(e)?)?)?)?$/i) || has(/^\/s$/i) || rest.some(t => /^\/s$/i.test(t));
      if (recursive && rest.some(isRootish)) return 'recursive delete of a root, home, parent, drive or wildcard path';
      if (has(/^--no-preserve-root$/)) return 'rm with --no-preserve-root';
    }
    if (cmd === 'git') {
      // The subcommand is the first plain word, skipping global options such as -C <dir>.
      let at = 0;
      while (at < args.length && !args[at].quoted && args[at].text.startsWith('-')) at += /^(-C|-c|--git-dir|--work-tree|--namespace)$/.test(args[at].text) ? 2 : 1;
      const sub = args[at] ? args[at].text : '';
      const after = args.slice(at + 1);
      const flag = re => after.some(a => !a.quoted && re.test(a.text));
      if (sub === 'push' && (flag(/^--force$/) || flag(/^-[a-zA-Z]*f[a-zA-Z]*$/))) return 'force push (use --force-with-lease yourself if it is really needed)';
      if (sub === 'reset' && flag(/^--hard$/)) return 'git reset --hard discards uncommitted work';
      if (sub === 'clean' && flag(/^-[a-zA-Z]*f/)) return 'git clean deletes untracked files';
      if ((sub === 'checkout' || sub === 'restore') && after.some(a => a.text === '.' || a.text === ':/')) return `git ${sub} . discards uncommitted work`;
    }
    if (DB_CLIENTS.test(cmd) && /\b(drop|truncate)\s+(table|database|schema)\b/i.test(segment)) return 'dropping or truncating a table or database';
    if (/^mkfs(\.|$)/.test(cmd)) return 'formatting a file system';
    if (cmd === 'dd' && args.some(a => /^of=\/dev\/(sd|hd|vd|nvme|mmcblk|disk|rdisk|xvd)/.test(a.text))) return 'overwriting a disk';
    if (/^format$/i.test(cmd) && rest.some(t => /^[A-Za-z]:$/.test(t))) return 'formatting a drive';
    if (cmd === 'chmod' && has(/^-[a-zA-Z]*R/) && rest.includes('777')) return 'making a whole tree world-writable';
  }
  return null;
}

module.exports = { check };
