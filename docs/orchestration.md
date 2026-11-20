# Orchestration, turns, roles & guardrails

## Turns and sessions

```sh
codex-drive serve
codex-drive start --role implementer --cwd /path/to/worktree --name proj-task --detach "Read BRIEF.md and execute it."
codex-drive status --active
codex-drive steer proj-task "Stop after the current check and report"
codex-drive result proj-task            # full final agent message (exit 0/1/2/3)
codex-drive resume proj-task --detach "Fix findings 1 and 2"
codex-drive interrupt proj-task
```

- **Defaults:** `--cwd .`, `--sandbox danger-full-access`, `--approval never`, `--request-policy approve`. Pass `--role` (read-only roles set `--sandbox read-only`) or explicit `--sandbox read-only --approval on-request --request-policy manual`.
- **Detached execution:** `--detach` spawns a detached logger, waits for `{threadId,turnId}` and persisted state, prints IDs, and returns. Stopping an attached logger does not interrupt the turn.
- **Adopt & fork:** `adopt <threadId> --name <n>` loads persisted `exec`/`cli` histories from the same `CODEX_HOME`; `fork <name> --name <branch>` branches history independently.
- **Full parameter pass-through:** `--thread-params <json>|@file|-`, `--turn-params <json>|@file|-`, and `--param [thread.|turn.]key=<json>` forward any field in the generated schema (images, output schemas, reasoning, service tiers).

## Results, inbox & Claude Code integration

Each settled turn writes one idempotent metadata record to `$CODEX_DRIVE_HOME/outbox/<threadId>@<turnId>.json` (pruned past 14 days / 2,000 entries; configurable via `CODEX_DRIVE_OUTBOX_MAX_AGE` and `CODEX_DRIVE_OUTBOX_MAX_ENTRIES`).

- **With the Claude Code plugin ([claude-plugin/README.md](../claude-plugin/README.md)):** start workers `--detach`; the plugin monitor streams completions automatically and `SessionStart` recovers missed completions on restart. Pass `--quiet` when a caller will `wait` itself.
- **Without the plugin:** run `codex-drive wait <name> --timeout <s>` (or `wait a b c --any`) in the background, or stream `codex-drive inbox --follow --unread --ack`.
- **Reading output:** `codex-drive result <name> [--turn <id>] [--json]` reads the server (falling back to the local log if the server no longer holds the thread). Exits `0` completed, `1` failed/interrupted, `2` unknown, `3` still running (never substitutes an older turn).

## Wait exit codes & retries

| Exit | Meaning | Action |
|---|---|---|
| `0` | Completed | Read `codex-drive result <name>` and verify |
| `1` | Failed / error | Inspect `status <name>`, fix cause, `resume` same thread |
| `75` | Capacity (`serverOverloaded` / `flexUnavailable`) | Retry with `--retry-capacity <n>` (1, 2, 4…30s backoff) |
| `76` | Usage limit | Never auto-retry; check `codex-drive rate-limits` and pause account |
| `124` | Timeout | Turn still running; wait again or inspect `tail` / `lanes` |
| `130` | Interrupted | Resume only after confirming why |

## Guardrails

- **Lane watchdog:** `codex-drive lanes [--dir .worktrees] [--minutes 60] [--json]` classifies each worktree as `active`, `idle`, or `STALLED` (exits `1` if any lane is stalled with uncommitted work).
- **PreToolUse hooks:** `codex-drive hook <wait-guard|stash-guard|all> [--agent claude|codex]` blocks blind `sleep N` / `until` / `pgrep -f` polling loops and mutating `git stash` commands across shared worktrees.
