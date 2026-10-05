// AgentDeck hook recipe: keep the agent out of secret files.
// Exit code 2 blocks the tool call and shows the agent the message on stderr.
let input = '';
process.stdin.on('data', d => { input += d; }).on('end', () => {
  let event = {};
  try { event = JSON.parse(input); } catch { /* not JSON: nothing to check */ }
  const t = event.tool_input || {};
  const file = String(t.file_path || t.path || t.notebook_path || '').replace(/\\/g, '/');
  const base = file.split('/').pop() || '';
  const secret = (/^\.env(\..*)?$/.test(base) && !/\.(example|sample|template|dist)$/.test(base))
    || /\.(pem|key|p12|pfx|keystore|jks)$/i.test(base)
    || /^id_(rsa|dsa|ecdsa|ed25519)$/.test(base)
    || /^(credentials|\.npmrc|\.pypirc|\.netrc|\.pgpass)$/i.test(base)
    || /(^|\/)(secrets?|\.aws|\.ssh|\.gnupg)(\/|$)/i.test(file);
  if (secret) {
    process.stderr.write(`Blocked by the AgentDeck guard: ${base || file} looks like a secrets file. Do not read or change it. Ask the user for the specific value you need.\n`);
    process.exit(2);
  }
  process.exit(0);
});
