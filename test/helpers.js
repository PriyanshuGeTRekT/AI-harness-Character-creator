// Every test file runs in its own process against a throwaway home folder, so nothing
// here can touch real harness config. Call fakeHome() before requiring anything in lib/.
const fs = require('fs');
const path = require('path');
const os = require('os');

function fakeHome(dirs = []) {
  const H = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-test-')));
  const bin = path.join(H, 'empty-bin');
  fs.mkdirSync(bin);
  // No real PATH: detection must not depend on what this machine has installed.
  Object.assign(process.env, { USERPROFILE: H, HOME: H, APPDATA: path.join(H, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(H, 'AppData', 'Local'), PATH: bin });
  for (const d of dirs) fs.mkdirSync(path.join(H, d), { recursive: true });
  process.on('exit', () => { try { fs.rmSync(H, { recursive: true, force: true }); } catch { /* best effort */ } });
  return {
    H,
    p: (...parts) => path.join(H, ...parts),
    write: (rel, text) => { fs.mkdirSync(path.dirname(path.join(H, rel)), { recursive: true }); fs.writeFileSync(path.join(H, rel), text); },
    read: rel => fs.readFileSync(path.join(H, rel), 'utf8'),
    has: rel => fs.existsSync(path.join(H, rel)),
  };
}

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; }
  catch (e) { console.error(`FAIL  ${name}\n${e.stack}`); process.exitCode = 1; }
}
async function testAsync(name, fn) {
  try { await fn(); passed++; }
  catch (e) { console.error(`FAIL  ${name}\n${e.stack}`); process.exitCode = 1; }
}
const done = label => console.log(`${process.exitCode ? 'FAILED' : 'ok'}  ${label} (${passed} passed)`);

module.exports = { fakeHome, test, testAsync, done };
