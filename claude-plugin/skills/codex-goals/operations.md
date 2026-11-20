# Operations

## Inspecting sessions and lanes

```sh
codex-drive status --active            # table: status, model, cwd, event age, last line, usage LEFT
codex-drive status <name>              # JSON: turn status, error, failure, pending requests, steers
codex-drive result <name> [--turn id]  # full final message of latest or named turn (exit 0/1/2/3)
codex-drive inbox --unread             # unacknowledged completions across sessions
codex-drive lanes                      # check .worktrees/ for STALLED lanes (exit 1 if stalled)
codex-drive tail <name> -n 30          # readable recent events
codex-drive pending <name>             # server requests waiting for an answer
```

`wait` settles on one turn. A thread that starts further turns on its own is finished only when `status <name>` is
no longer `running`.

## Exit codes from `wait`

| Exit | Meaning | Action |
|---|---|---|
| `0` | completed | read `codex-drive result <name>`, verify commits and checks |
| `1` | failed | inspect `error` and `failure` in `status <name>`, fix cause, `resume` same thread |
| `75` | capacity | not a stop: `resume <name> --retry-capacity 5 --detach "Continue from where you stopped."` |
| `76` | usage limit | pause all Codex dispatches on this account; see below |
| `124` | timeout | turn is still running; wait again or check for a stall |
| `130` | interrupted | someone stopped it; resume only when the reason is known |

## Usage limits

1. Dispatch and resume nothing on that account. Never auto-retry exit `76`.
2. Run `codex-drive rate-limits` (used percent and reset time). Note that `status` shows usage **left**.
3. Report to the owner: current state, what landed, reset time, and the exact `resume` commands, then wait.
4. After an account switch: a running server keeps the old credentials. When idle, run
   `codex-drive serve --restart` and resume each paused goal. If turns are still running on the old account, start
   a separate server (`codex-drive serve --port 4701`) for new work.

Check `codex-drive rate-limits` during long runs and warn the owner around 5% remaining.

## Stalls

A stall is a running turn whose event age in `status --active` keeps growing, or a worktree flagged `STALLED` by
`codex-drive lanes`. Read `tail <name>` for the last command. If waiting on something external, fix the blocker and
`codex-drive steer <name> "<what changed>"`. If wedged, `codex-drive interrupt <name>` and `resume` with what
changed.

## Stopping

`codex-drive interrupt <name>` stops the turn while keeping the thread resumable. `codex-drive serve --stop` refuses
while any turn is active; use `--force` only on the owner's instruction.

## Adopting external sessions

`codex-drive adopt <threadId> --name <name>` takes over a thread from `codex exec` or the TUI once its turn has
ended; find threads with `codex-drive list --param 'sourceKinds=["exec","cli","appServer"]'`.

## Permissions & global instructions

`codex-drive` defaults to full access with automatic approvals. Use `--role` (read-only roles set `--sandbox read-only`)
or pass `--sandbox read-only` explicitly for reviewers and planners. Keep Codex on its built-in base prompt: place
personal rules in `~/.codex/AGENTS.md` (additive), never in `model_instructions_file` (which replaces the vendor
base prompt).
