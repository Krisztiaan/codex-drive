# codex-drive

Node 24+ multi-model worker driver, role-based orchestration suite, leveled review ensemble, and guardrail hooks for Codex app-server, Claude Code, and Codex CLI.

Requires Node 24+, `codex` on PATH, and `lsof`/`ps` for server/lane ownership (tested on macOS).

## Quick start

```sh
npm install -g codex-drive
codex-drive setup --roles --codex --claude
codex-drive serve
codex-drive start --role implementer --cwd .worktrees/feat --name proj-feat --detach "Read BRIEF.md and execute it."
```

## Explore on demand

Everything is designed for progressive disclosure — run `codex-drive help <topic>` or open only the guide you need:

| Area | CLI help | Guide |
|---|---|---|
| Turns, sessions, roles, parallel worktrees & Claude plugin | `codex-drive help turns` / `roles` / `inbox` | [docs/orchestration.md](docs/orchestration.md) |
| Leveled multi-model review (`0..3`, `design`, custom lenses) | `codex-drive help review` | [docs/review.md](docs/review.md) |
| Schema-validated RPC (`call`, `methods`), events, approvals | `codex-drive help protocol` | [docs/protocol.md](docs/protocol.md) |
| Server ownership, multi-account routing, pruning, limits | `codex-drive help server` | [docs/server.md](docs/server.md) |
| Stalled-worktree watchdog & `PreToolUse` wait/stash guards | `codex-drive help lanes` / `hooks` | [docs/orchestration.md#guardrails](docs/orchestration.md#guardrails) |

## Role-based routing

Never hardcode model names in briefs or prompts. Override models in one place as providers evolve:

1. Built-in defaults: [templates/roles.json](templates/roles.json)
2. User overrides: `~/.codex-drive/roles.json` (or `$CODEX_DRIVE_HOME/roles.json`)
3. Repo overrides: `<cwd>/.codex-drive/roles.json`

Inspect active mappings with `codex-drive roles`. Explicit `--model`, `--effort`, or `--sandbox` flags always win.

## Bundled packs & templates

| Pack | Path | Contents |
|---|---|---|
| **Claude Code plugin** | [claude-plugin/](claude-plugin/) | `SessionStart` summary, live completion monitor, `/codex-workers`, `codex-goals` skill, `PreToolUse` wait/stash guards |
| **Codex pack** | [codex-pack/](codex-pack/) | `bounded-handoff` skill, `code_mapper` / `mechanical_worker` / `risk_reviewer` TOML presets, `hooks.json` |
| **Review prompts** | [review-prompts/](review-prompts/) | Generic leveled `REVIEW-PROMPT.md` + 5 lenses (`state`, `invariants`, `inventory`, `tests`, `record`) |
| **Templates** | [templates/](templates/) | Additive `AGENTS.md` (never `model_instructions_file`), `CLAUDE.md`, `BRIEF.md`, `roles.json` |

## Local checkout & verification

```sh
npm ci && node scripts/install.mjs   # symlink ~/.local/bin/codex-drive -> src/cli.mjs
npm test                             # 200+ offline CLI, plugin, protocol & workflow tests
npm run protocol                     # regenerate protocol/schema.json after upgrading Codex
```

License: [MIT](LICENSE).
