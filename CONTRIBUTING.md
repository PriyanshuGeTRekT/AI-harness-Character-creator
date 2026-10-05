# Contributing

The most useful contribution is a new or corrected harness adapter. Most are a few lines.

## Run it

```bash
npm run demo     # UI against a throwaway home folder with sample data
npm test         # every test file runs against its own fake home
```

Neither touches your real config. To try a change against your real setup, run `node server.js`: nothing is written until you click Apply on a diff.

## Adding or fixing a harness

Everything about a harness lives in one entry in `lib/adapters.js`:

| Key | Meaning |
|---|---|
| `id`, `name`, `vendor` | Identity. `id` is permanent: it is stored in users' state. |
| `detect` | `bins` (on `PATH`), `dirs` (config folders), `extensions` (editor extension id prefixes). Any hit counts. Only list evidence that belongs to this tool alone. |
| `instructions` | `global` and `project`: the file the behavior block is written into. `null` when the tool has none. |
| `settings.main` | `global`, `project` and `format` (`json` or `toml`) of the config file behind `native`. |
| `native` | Enforced settings shown on the Settings tab: `key` (dotted path), `label`, `kind` (`text`, `number`, `toggle`, `select`, `list`), `options`, `help`, `group`. Mark options that remove safety checks with `danger()`. |
| `items` | `agents`, `skills`, `commands`: `global` and `project` folders (a string, or an array of candidates), `layout` (`file` or `dir`), `ext`, `fields`. Use `format: 'toml'` with `bodyKey` for TOML files. |
| `mcp` | Where MCP servers live: `global`, `project`, `key` path, `style` (`standard`, `opencode`, `codex`), `urlKey`, `httpType`, `disable`. |
| `hooks` | `global`, `project`, `key` path (`[]` when the file itself is the event map) and the `events` the tool supports. |
| `context` | Extra instruction sources the tool loads, for the "what the agent loads" view. |
| `projects` | A function returning `[{ path, lastUsed, sessions }]` from the tool's session history. Must never throw. |
| `files` | Raw files offered on the Files tab. |

Rules:

1. **Cite the docs.** Every path, key and allowed value needs a link to the tool's documentation in the pull request. If the docs are silent, say so and leave the feature out rather than guess.
2. **Never write a format you cannot round-trip.** If a config file is JSONC or YAML, expose it under `files` only.
3. `npm test` must pass. `test/insights.test.js` checks every adapter for consistency, and `npm run docs` regenerates the README table.

## Adding a lever

Levers are in `lib/levers.js`. A lever compiles to one plain instruction per option; the neutral option compiles to nothing. Keep instructions short, concrete and checkable, and give a source for any claim about what works. If the behavior can be enforced, point `enforce` at a hook recipe.

## Code style

Plain JavaScript, no dependencies, no build step. Match the surrounding code. Every write to a user's file goes through `fsx.writeSafe` or `fsx.removeSafe` inside a `withBatch`, so it is backed up and undoable, and every write is reachable only through a preview endpoint that returns the diff.
