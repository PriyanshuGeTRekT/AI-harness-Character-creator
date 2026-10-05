# AgentDeck

A local control panel for AI coding-agent harnesses. It finds the harnesses installed on
this machine, lists the projects each has worked in, and lets you tune how their agents
behave from one GUI.

## Run

Double-click `AgentDeck.vbs`. AgentDeck opens in its own window (Edge or Chrome in app
mode, no console); closing the window stops it. To get Desktop and Start-menu shortcuts,
run once:

    powershell -ExecutionPolicy Bypass -File install-shortcuts.ps1

Other ways to start it:

    node server.js --window    # same standalone window, from a terminal
    node server.js             # open in your default browser instead (or start.cmd)

Node 18+ is the only requirement; there is nothing to install. Project discovery for
Goose and newer OpenCode builds reads SQLite and needs Node 22.5+.

To try it without touching your real config: `node test/demo-server.js` (uses a throwaway
fake home folder). Tests: `npm test`.

## What it does

- **Detects harnesses**: Claude Code, Codex CLI, Gemini CLI, Pi, OpenCode, Cursor,
  Windsurf / Devin Desktop, GitHub Copilot CLI, Qwen Code, Factory Droid, Codewhale
  (DeepSeek TUI), Kilo Code, Cline, Kiro, Goose, Amp, Crush, Zed, Continue, Aider, Roo Code.
- **Lists projects** from each harness's own session history, and lets you tune globally
  or per project.
- **Behavior tab**: about 25 levers (verbosity, grounding, scope, code volume, planning,
  testing, autonomy, ...) plus presets. They compile to plain instructions written into a
  marked block in the harness's instruction file (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, ...).
  Your own content in that file is left alone.
- **Native settings tab**: settings the harness actually enforces (model, reasoning effort,
  approval mode, sandbox, compaction, output caps), written to its own config file.
- **Agents / Skills / Commands**: create from templates, edit, delete, and attach one
  definition to several harnesses at once, each in its own location and format.
  Codex agents and Gemini commands are written in their TOML formats.
- **MCP servers**: add, edit and remove servers per harness, globally or per project, and
  add one server to several harnesses at once (each has its own config shape).
- **Hooks** (Claude Code, Codex, Gemini CLI, Factory Droid): shell commands the harness
  runs at fixed points. This is how you enforce something, e.g. tests must pass before
  the agent may finish.
- **Projects**: discovered from each harness's history; add any other folder by hand.
- **Files**: raw editor for the harness's known config files.
- **Backups**: every write is previewed as a diff and backed up to `~/.agentdeck/backups`
  first; restore from the Backups button.

## Honest limits

Behavior levers are prompt instructions. Models usually follow them; nothing guarantees it.
There is no real "hallucination rate" or "creativity" dial, and most current models no
longer accept a temperature setting. Only the Native settings tab is enforced.

## Adding a harness

Add one entry to `lib/adapters.js`. Levers live in `lib/levers.js`.
