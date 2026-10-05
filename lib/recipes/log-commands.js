// AgentDeck hook recipe: keep a log of every shell command the agent runs.
// Appends "time <tab> folder <tab> command" to ~/.agentdeck/command-log.txt.
let input = '';
process.stdin.on('data', d => { input += d; }).on('end', () => {
  let event = {};
  try { event = JSON.parse(input); } catch { /* not JSON */ }
  const command = String((event.tool_input && (event.tool_input.command || event.tool_input.cmd)) || '');
  if (command) {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(require('os').homedir(), '.agentdeck');
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, 'command-log.txt'), `${new Date().toISOString()}\t${event.cwd || ''}\t${command.replace(/\r?\n/g, ' ⏎ ')}\n`);
    } catch { /* logging must never block the agent */ }
  }
  process.exit(0);
});
