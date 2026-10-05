// AgentDeck hook recipe: format files after every edit.
// Usage: node format-on-edit.js "<formatter command with {file}>"
let input = '';
process.stdin.on('data', d => { input += d; }).on('end', () => {
  let event = {};
  try { event = JSON.parse(input); } catch { /* not JSON */ }
  const t = event.tool_input || {};
  const file = t.file_path || t.path;
  if (!file) process.exit(0);
  // The path goes through a shell, so quote it for that shell. A file name must never be
  // able to run a command or expand a variable.
  let quoted;
  if (process.platform === 'win32') {
    if (/["%!^&|<>\r\n]/.test(file)) process.exit(0); // cannot be quoted safely for cmd.exe: skip
    quoted = `"${file}"`;
  } else quoted = `'${String(file).replace(/'/g, "'\\''")}'`;
  const command = (process.argv[2] || 'npx prettier --write {file}').split('{file}').join(quoted);
  try { require('child_process').execSync(command, { cwd: event.cwd || process.cwd(), stdio: 'ignore', timeout: 55000 }); } catch { /* formatting is best effort */ }
  process.exit(0);
});
