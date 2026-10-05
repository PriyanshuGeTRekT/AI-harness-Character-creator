// Behavior levers. Each one compiles to instruction text written into the harness's
// instruction file (CLAUDE.md, AGENTS.md, ...). These are prompt-level nudges: the model
// usually follows them, nothing enforces them. Enforced settings live in adapters.js (native).
//
// kind: 'choice' (options[], first with text:'' is the neutral default), 'toggle', 'number', 'text'.

const GROUPS = [
  { id: 'output', label: 'Output and token usage', note: 'How much the agent writes and how it reads.' },
  { id: 'accuracy', label: 'Accuracy and grounding', note: 'Reduces made-up answers. It cannot eliminate them; there is no hallucination dial.' },
  { id: 'code', label: 'Code style and scope', note: 'How much code it writes and how far it strays from the task.' },
  { id: 'process', label: 'Process and autonomy', note: 'Planning, testing, and when it stops to ask.' },
  { id: 'custom', label: 'Custom rules', note: 'Anything else, added verbatim.' },
];

const LEVERS = [
  // ---- output ----
  {
    id: 'verbosity', group: 'output', label: 'Verbosity', kind: 'choice', default: 'normal',
    help: 'Affects output tokens only, which are usually the smaller part of an agent bill.',
    options: [
      { value: 'caveman', label: 'Caveman', text: 'Answer first. No greetings, hedges, recaps or closing offers. Short words, fragments allowed, drop articles when meaning survives. Keep negations and quantifiers. Keep code, commands, paths, numbers and error text exact. Use full sentences for security warnings, destructive actions, ordered steps, and anything written to files or commits.' },
      { value: 'terse', label: 'Terse', text: 'Lead with the answer. No preamble, no recap, no closing offer. Keep code, commands, paths and errors exact.' },
      { value: 'concise', label: 'Concise', text: 'First sentence states the result. Simple questions get 1-3 sentences. Skip narration of what you are about to do.' },
      { value: 'normal', label: 'Normal', text: '' },
      { value: 'detailed', label: 'Detailed', text: 'Explain the reasoning behind each non-obvious choice and name the alternatives you rejected.' },
    ],
  },
  {
    id: 'lengthCap', group: 'output', label: 'Reply length cap (lines)', kind: 'number', default: '', min: 1, max: 500,
    help: 'A request, not a hard limit. Leave empty for none.',
    text: v => `Keep replies under ${v} lines unless I ask for more.`,
  },
  {
    id: 'formatting', group: 'output', label: 'Formatting', kind: 'choice', default: 'markdown',
    options: [
      { value: 'markdown', label: 'Markdown', text: '' },
      { value: 'prose', label: 'Prose', text: 'Write in paragraphs. No headers or bullets unless I ask; use code blocks only for code.' },
      { value: 'plain', label: 'Plain terminal', text: 'No markdown, tables or emoji in replies.' },
    ],
  },
  {
    id: 'tone', group: 'output', label: 'Tone', kind: 'choice', default: 'neutral',
    options: [
      { value: 'neutral', label: 'Neutral', text: '' },
      { value: 'blunt', label: 'Blunt reviewer', text: 'Do not praise. If my approach is wrong or a simpler one exists, say so before doing anything. Do not change a correct position because I push back; change it only on new evidence.' },
      { value: 'teacher', label: 'Teacher', text: 'Teach as you go: explain the concept behind each step briefly, and point out what I should learn from it.' },
      { value: 'friendly', label: 'Friendly', text: 'Keep a warm, encouraging tone, without padding the answer.' },
    ],
  },
  {
    id: 'language', group: 'output', label: 'Reply language', kind: 'text', default: '', placeholder: 'e.g. Hindi (empty = match the user)',
    text: v => `Reply in ${v}; keep code, identifiers and error text unchanged.`,
  },
  {
    id: 'noNarration', group: 'output', label: 'No announcements or end summaries', kind: 'toggle', default: false,
    text: 'Do not announce what you are about to do. Do not summarise what you did afterwards; the diff is the summary.',
  },

  // ---- accuracy ----
  {
    id: 'allowUnknown', group: 'accuracy', label: 'Admit uncertainty', kind: 'toggle', default: false,
    text: 'If you are not sure, or the information is not in the repo, say so plainly rather than guessing.',
  },
  {
    id: 'readFirst', group: 'accuracy', label: 'Read before claiming', kind: 'toggle', default: false,
    text: 'Never speculate about code you have not opened. If I name a file, read it before answering.',
  },
  {
    id: 'quoteFirst', group: 'accuracy', label: 'Quote evidence with file:line', kind: 'toggle', default: false,
    text: 'When answering questions about the codebase, first find the exact lines that matter and cite them as file:line. Base the answer only on those.',
  },
  {
    id: 'citeOrRetract', group: 'accuracy', label: 'Cite or retract', kind: 'toggle', default: false,
    text: 'After drafting an answer, check each factual claim against the source. Remove any claim you cannot support.',
  },
  {
    id: 'checkDocs', group: 'accuracy', label: 'Check current docs for library APIs', kind: 'toggle', default: false,
    text: 'Before using a library API you have not seen in this repo, check its current documentation or installed source rather than relying on memory.',
  },
  {
    id: 'cove', group: 'accuracy', label: 'Chain of verification', kind: 'toggle', default: false,
    help: 'Strongest of the group and the most expensive: the agent double-checks itself, which costs extra tokens.',
    text: 'For non-trivial answers: draft, list the questions that would verify the draft, answer each one independently by checking the source, then revise.',
  },
  {
    id: 'noTestGaming', group: 'accuracy', label: 'No test gaming', kind: 'toggle', default: false,
    text: 'Do not hard-code values or special-case inputs to satisfy tests. If a test looks wrong, tell me instead of working around it.',
  },

  // ---- code ----
  {
    id: 'scope', group: 'code', label: 'Scope discipline', kind: 'choice', default: 'normal',
    options: [
      { value: 'surgical', label: 'Surgical', text: 'Touch only what the task requires. Match existing style. No refactors, renames or reformatting of code you were not asked to change. Mention unrelated problems; do not fix them.' },
      { value: 'normal', label: 'Normal', text: '' },
      { value: 'boyscout', label: 'Tidy as you go', text: 'Clean up code you touch: fix nearby naming, dead code and obvious smells, and say what you tidied.' },
    ],
  },
  {
    id: 'codeVolume', group: 'code', label: 'Code volume', kind: 'choice', default: 'normal',
    help: 'The "lazy senior dev" ladder popularised by Ponytail.',
    options: [
      { value: 'minimal', label: 'Minimal', text: 'Before writing code, check in order: is it needed at all, does it already exist in this codebase, the standard library, the platform, an installed dependency. Write the smallest thing that works. Never cut input validation at trust boundaries, error handling that prevents data loss, security, or anything I explicitly asked for.' },
      { value: 'normal', label: 'Normal', text: '' },
      { value: 'thorough', label: 'Thorough', text: 'Prefer complete implementations: handle edge cases, validate inputs and cover error paths even when not asked.' },
    ],
  },
  {
    id: 'creativity', group: 'code', label: 'Creativity', kind: 'choice', default: 'balanced',
    help: 'Most current models no longer accept a temperature setting, so this is done by instruction.',
    options: [
      { value: 'conventional', label: 'Conventional', text: 'Follow the existing patterns in this repo exactly; prefer the most boring solution that works.' },
      { value: 'balanced', label: 'Balanced', text: '' },
      { value: 'exploratory', label: 'Exploratory', text: 'For design decisions, propose 2-3 distinct approaches with trade-offs before choosing one.' },
    ],
  },
  {
    id: 'comments', group: 'code', label: 'Code comments', kind: 'choice', default: 'default',
    options: [
      { value: 'none', label: 'None', text: 'Add no comments or docstrings.' },
      { value: 'minimal', label: 'Minimal', text: 'Comment only where the logic is not self-evident. Do not add comments, docstrings or type annotations to code you did not change.' },
      { value: 'default', label: 'Default', text: '' },
      { value: 'rich', label: 'Rich', text: 'Give every public function a docstring; explain why, not what.' },
    ],
  },

  // ---- process ----
  {
    id: 'planning', group: 'process', label: 'Planning depth', kind: 'choice', default: 'none',
    options: [
      { value: 'none', label: 'Just do it', text: '' },
      { value: 'assumptions', label: 'State assumptions', text: 'State your assumptions and success criteria in 2-3 lines before coding.' },
      { value: 'approve', label: 'Plan, then approval', text: 'For any change beyond a few lines, write a numbered plan and wait for my approval before editing files.' },
    ],
  },
  {
    id: 'testing', group: 'process', label: 'Testing rigor', kind: 'choice', default: 'none',
    options: [
      { value: 'none', label: 'Unspecified', text: '' },
      { value: 'run', label: 'Run existing', text: 'Run the existing tests after changes and report the command and result.' },
      { value: 'add', label: 'Add tests', text: 'Add or update tests for every behavior change, then run them and report the result.' },
      { value: 'tdd', label: 'Test first', text: 'Write a failing test first, watch it fail, then write the minimum code to make it pass.' },
    ],
  },
  {
    id: 'verifyDone', group: 'process', label: 'Verify before saying done', kind: 'toggle', default: false,
    text: 'Do not say a task is done until you have run it or its tests and seen it work. If you could not verify something, say exactly what is unverified.',
  },
  {
    id: 'autonomy', group: 'process', label: 'Ask vs proceed', kind: 'choice', default: 'balanced',
    help: 'Separate from the enforced approval mode under Native settings.',
    options: [
      { value: 'ask', label: 'Ask first', text: 'Do not change files until I confirm. If my intent is ambiguous, give options and wait.' },
      { value: 'balanced', label: 'Balanced', text: '' },
      { value: 'proceed', label: 'Keep going', text: 'Make reasonable assumptions on routine decisions and keep going; state them. Still confirm before deleting data or touching shared or production systems.' },
    ],
  },
  {
    id: 'delegation', group: 'process', label: 'Subagent delegation', kind: 'choice', default: 'default',
    options: [
      { value: 'never', label: 'Never', text: 'Do all work in this conversation; do not spawn subagents.' },
      { value: 'default', label: 'Default', text: '' },
      { value: 'aggressive', label: 'Aggressive', text: 'Delegate independent searches and multi-file reads to subagents in parallel.' },
    ],
  },

  // ---- custom ----
  {
    id: 'custom', group: 'custom', label: 'Extra instructions', kind: 'textarea', default: '', placeholder: 'One rule per line.',
    text: v => v,
  },
];

const PRESETS = {
  'Token saver': { verbosity: 'terse', noNarration: true, codeVolume: 'minimal', comments: 'minimal', scope: 'surgical', delegation: 'never' },
  'Caveman': { verbosity: 'caveman', noNarration: true },
  'Lazy senior dev': { codeVolume: 'minimal', scope: 'surgical', creativity: 'conventional', comments: 'minimal' },
  'Careful and grounded': { allowUnknown: true, readFirst: true, quoteFirst: true, citeOrRetract: true, checkDocs: true, noTestGaming: true, verifyDone: true, testing: 'run' },
  'Karpathy guidelines': { planning: 'assumptions', codeVolume: 'minimal', scope: 'surgical', verifyDone: true, allowUnknown: true },
  'Autonomous builder': { autonomy: 'proceed', testing: 'add', verifyDone: true, delegation: 'aggressive', verbosity: 'concise' },
  'Teacher': { tone: 'teacher', verbosity: 'detailed', comments: 'rich', creativity: 'exploratory' },
};

function defaults() {
  return Object.fromEntries(LEVERS.map(l => [l.id, l.default]));
}

function leverText(lever, value) {
  if (value === undefined || value === null || value === '' || value === false) return '';
  if (lever.kind === 'choice') return (lever.options.find(o => o.value === value) || {}).text || '';
  if (lever.kind === 'toggle') return value ? lever.text : '';
  if (lever.kind === 'number') {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? lever.text(Math.round(n)) : '';
  }
  return lever.text(String(value).trim());
}

// Compile lever values into the markdown body of the managed block.
function compile(values) {
  const v = { ...defaults(), ...(values || {}) };
  const sections = [];
  for (const group of GROUPS) {
    const lines = [];
    for (const lever of LEVERS.filter(l => l.group === group.id)) {
      const text = leverText(lever, v[lever.id]);
      if (!text) continue;
      if (lever.kind === 'textarea') lines.push(...text.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(s => `- ${s.replace(/^[-*]\s+/, '')}`));
      else lines.push(`- ${text}`);
    }
    if (lines.length) sections.push(`## ${group.label}\n${lines.join('\n')}`);
  }
  if (!sections.length) return '';
  return `# Working preferences\n\n${sections.join('\n\n')}`;
}

function catalog() {
  return {
    groups: GROUPS,
    levers: LEVERS.map(({ text, ...rest }) => rest),
    presets: PRESETS,
    defaults: defaults(),
  };
}

module.exports = { GROUPS, LEVERS, PRESETS, defaults, compile, catalog };
