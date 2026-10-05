# Changelog

## 1.0.0

First public release.

- Detects 21 AI coding harnesses and the projects each has worked in.
- Behavior levers and presets, compiled into a managed block in each harness's instruction file, globally or per project.
- Enforced settings and permission lists written to each harness's own config.
- Agents, skills and commands: create from templates, edit, copy across harnesses.
- MCP servers for twelve harnesses, each in its own config shape, with paste-to-import and secret masking.
- Hooks, with five cross-platform recipes (destructive-command guard, secret-file guard, tests before done, format on edit, command log).
- Usage and cost from Claude Code transcripts, by day, model and project.
- Config health check, drift detection across harnesses, and "what the agent loads".
- Diff preview before every write, backups, per-action undo, per-file restore.
- Terminal commands: `scan`, `doctor`, `usage`.
