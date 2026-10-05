// AgentDeck hook recipe: tests must pass before the agent finishes.
// Usage: node tests-before-done.js "<test command>"
// Exit code 2 stops the agent from finishing and shows it the failing output.
let input = '';
process.stdin.on('data', d => { input += d; }).on('end', () => {
  let event = {};
  try { event = JSON.parse(input); } catch { /* not JSON */ }
  if (event.stop_hook_active) process.exit(0); // already sent back once: let it stop and report
  const command = process.argv[2] || 'npm test';
  try {
    require('child_process').execSync(command, { cwd: event.cwd || process.cwd(), stdio: 'pipe', timeout: 570000 });
    process.exit(0);
  } catch (e) {
    const output = String((e.stdout || '') + (e.stderr || '') || e.message).slice(-4000);
    process.stderr.write(`The checks failed (${command}). Fix the cause, do not edit the tests to pass, then finish.\n${output}\n`);
    process.exit(2);
  }
});
