// Overview: what is on this machine, how healthy the config is, and where to start.
import { h, api, fail, modal, confirmChanges, num, money, plural } from '../ui.js';
import { state, go } from '../state.js';

export const PRESET_BLURBS = {
  'Token saver': 'Short answers, small diffs, no narration. Cuts output tokens.',
  'Caveman': 'Maximum compression: fragments, no filler. Code and commands stay exact.',
  'Lazy senior dev': 'Writes the least code that works; reuses what already exists.',
  'Careful and grounded': 'Reads before claiming, cites file:line, admits uncertainty, verifies.',
  'Karpathy guidelines': 'State assumptions, keep it simple, surgical changes, verify before done.',
  'Autonomous builder': 'Keeps going on routine decisions, adds tests, delegates searches.',
  'Teacher': 'Explains the why, comments richly, offers alternatives.',
};

const STATUS = {
  synced: ['Tuned', 'ok'], edited: ['Edited by hand', 'danger'], missing: ['Profile removed', 'danger'],
  untracked: ['Has a block', 'warn'], none: ['Not tuned', ''], unsupported: ['Per project only', ''],
};
export const statusTag = s => h('span', { class: `tag ${(STATUS[s] || STATUS.none)[1]}` }, (STATUS[s] || STATUS.none)[0]);

export function quickSetup() {
  const targets = state.scan.harnesses.filter(x => x.installed && x.globalInstruction);
  if (!targets.length) { fail(new Error('No detected harness has a global instruction file. Open a harness and tune a project instead.')); return; }
  const picked = new Set(targets.map(x => x.id));
  let preset = 'Karpathy guidelines';
  const all = { ...state.catalog.presets, ...state.presets };
  const list = h('div', { class: 'list', role: 'radiogroup', 'aria-label': 'Preset' });
  const draw = () => list.replaceChildren(...Object.keys(all).map(name => h('button', { class: 'item', role: 'radio', 'aria-checked': String(name === preset), style: name === preset ? 'border-color:var(--accent);background:var(--accent-soft)' : '', onclick: () => { preset = name; draw(); } },
    h('div', { class: 'i-main', style: 'text-align:left' }, h('div', { class: 'i-name' }, name), h('div', { class: 'i-desc' }, PRESET_BLURBS[name] || 'Your saved preset.')))));
  draw();
  const body = h('div', {},
    h('p', { class: 'muted', style: 'margin-top:0' }, 'Pick how your agents should behave. AgentDeck writes it into each harness\'s own instruction file, shows you the exact change first, and keeps a backup.'),
    list,
    h('div', { class: 'field', style: 'margin-top:14px' }, h('span', {}, 'Apply to'),
      h('div', { class: 'checks' }, targets.map(x => h('label', {}, h('input', { type: 'checkbox', checked: true, onchange: e => (e.target.checked ? picked.add(x.id) : picked.delete(x.id)) }), x.name)))));
  modal('Quick setup', body, [
    { label: 'Cancel' },
    { label: 'Review changes', class: 'primary', action: async () => {
      if (!picked.size) throw new Error('Pick at least one harness.');
      const values = { ...state.catalog.defaults, ...all[preset] };
      return (await confirmChanges(`Apply "${preset}"`, '/api/profile/preview', '/api/profile/apply', { harnesses: [...picked], project: '', values })) != null;
    } },
  ]);
}

function healthCard(health, rerender) {
  const cls = health.score >= 85 ? '' : health.score >= 60 ? ' mid' : ' low';
  const nameOf = id => (state.scan.harnesses.find(x => x.id === id) || {}).name || '';
  const open = f => (f.go && f.go.view ? go({ view: f.go.view }) : go({ view: 'harness', harnessId: f.harness, tab: f.go.tab, scope: f.go.scope || '' }));
  return h('div', { class: 'card' },
    h('div', { class: 'card-head', style: 'margin-bottom:8px' },
      h('div', { class: 'score' + cls, role: 'img', 'aria-label': `Config health ${health.score} out of 100` }, health.score),
      h('div', { style: 'flex:1' }, h('h2', {}, 'Config health'),
        h('div', { class: 'muted', style: 'font-size:12.5px' }, health.findings.length ? `${plural(health.findings.length, 'thing')} to look at across your harnesses.` : 'Nothing needs attention. Checked: instruction files, settings syntax, safety modes, MCP secrets, hooks and drift.')),
      health.dismissed ? h('button', { class: 'small ghost', onclick: async () => { await api('POST', '/api/health/dismiss', { restore: true }); rerender(); } }, `Show ${health.dismissed} dismissed`) : null),
    health.findings.map(f => h('div', { class: 'finding' },
      h('div', { class: `lvl ${f.level}` }, f.level === 'high' ? 'HIGH' : f.level === 'warn' ? 'CHECK' : 'INFO'),
      h('div', { class: 'f-main' }, h('div', {}, h('b', {}, f.title), f.harness ? h('span', { class: 'tag' }, nameOf(f.harness)) : null), h('div', { class: 'f-detail' }, f.detail)),
      h('div', { class: 'actions' },
        f.go ? h('button', { class: 'small', onclick: () => open(f) }, 'Open') : null,
        h('button', { class: 'small ghost', title: 'Hide this finding', onclick: async () => { try { await api('POST', '/api/health/dismiss', { id: f.id }); rerender(); } catch (e) { fail(e); } } }, 'Dismiss')))));
}

export async function overviewView({ rerender }) {
  const o = await api('GET', '/api/overview');
  state.healthCount = o.health.counts;
  const costTile = h('button', { class: 'tile', onclick: () => go({ view: 'usage' }) }, h('div', { class: 't-num' }, '…'), h('div', { class: 't-lbl' }, 'Claude Code, last 7 days'), h('div', { class: 't-sub' }, 'reading transcripts'));
  api('GET', '/api/usage?days=7').then(u => {
    const [n, , sub] = costTile.children;
    if (!u.available) { n.textContent = '–'; sub.textContent = 'no Claude Code history'; return; }
    n.textContent = u.totals.cost > 0 ? money(u.totals.cost) : num(u.totals.output);
    sub.textContent = `${num(u.totals.output)} output tokens · ${plural(u.sessions, 'session')}`;
  }).catch(() => { costTile.children[0].textContent = '–'; });

  const hero = o.cards.length === 0
    ? h('div', { class: 'hero' }, h('h2', {}, 'No AI coding harness found yet'),
      h('p', {}, `AgentDeck looked for ${o.counts.supported} harnesses (Claude Code, Codex, Gemini CLI, Cursor and more) and found none. Install one, or pick it from the sidebar to prepare its files in advance.`),
      h('button', { class: 'primary', onclick: () => window.dispatchEvent(new Event('agentdeck:changed')) }, 'Scan again'))
    : o.firstRun
      ? h('div', { class: 'hero' }, h('h2', {}, `Found ${plural(o.cards.length, 'harness').replace('harnesss', 'harnesses')} on this machine`),
        h('p', {}, 'Make them all behave the way you want in one step: pick a preset, review the exact changes, apply. Behavior levers are instructions the agent reads; Settings and Hooks are enforced by the harness itself.'),
        h('div', { class: 'actions' }, h('button', { class: 'primary', onclick: quickSetup }, 'Quick setup'), h('button', { onclick: () => go({ view: 'harness', harnessId: o.cards[0].id }) }, `Tune ${o.cards[0].name} by hand`)))
      : null;

  return h('div', { class: 'wrap' },
    h('div', { class: 'head' }, h('div', { class: 'grow' }, h('h1', {}, 'Overview'), h('div', { class: 'sub' }, `AgentDeck ${o.version} · everything here is read from, and written to, files on this machine.`)),
      o.cards.length && !o.firstRun ? h('button', { onclick: quickSetup }, 'Quick setup…') : null),
    hero,
    h('div', { class: 'tiles' },
      h('div', { class: 'tile' }, h('div', { class: 't-num' }, `${o.counts.detected}`), h('div', { class: 't-lbl' }, 'harnesses detected'), h('div', { class: 't-sub' }, `of ${o.counts.supported} supported`)),
      h('div', { class: 'tile' }, h('div', { class: 't-num' }, o.counts.projects), h('div', { class: 't-lbl' }, 'projects found'), h('div', { class: 't-sub' }, 'from session history')),
      h('button', { class: 'tile', onclick: () => go({ view: 'sync' }), title: 'Global instruction files are sent with every request' }, h('div', { class: 't-num' }, '~' + num(o.counts.configTokens)), h('div', { class: 't-lbl' }, 'instruction tokens per request'), h('div', { class: 't-sub' }, 'global files, all harnesses')),
      costTile),
    o.cards.length ? healthCard(o.health, rerender) : null,
    o.cards.length ? h('h2', { style: 'font-size:15px;margin:22px 0 10px' }, 'Your harnesses') : null,
    h('div', { class: 'grid3' }, o.cards.map(c => h('button', { class: 'hcard', onclick: () => go({ view: 'harness', harnessId: c.id, tab: 'behavior', scope: '' }) },
      h('div', { class: 'h-top' }, h('b', {}, c.name), statusTag(c.status)),
      h('div', { class: 'muted', style: 'font-size:12.5px' }, c.model ? `Model: ${c.model}` : c.vendor),
      h('div', { class: 'h-stats' },
        h('span', {}, plural(c.projects, 'project')),
        c.fileTokens ? h('span', {}, `~${num(c.fileTokens)} tokens/request`) : null,
        c.items ? h('span', {}, `${c.items} agents/skills`) : null,
        c.mcp ? h('span', {}, `${c.mcp} MCP`) : null,
        c.hooks ? h('span', {}, plural(c.hooks, 'hook')) : null)))));
}
