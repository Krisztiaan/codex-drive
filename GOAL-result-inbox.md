# Goal: full results and a completion inbox

codex-drive drives Codex workers for a Claude Code integrator. Today the integrator reads a finished worker's final
message by parsing the JSONL log, because `status` keeps only the last line of it (`src/state.mjs`,
`lastAgentMessage`). Nothing announces that a worker has finished, except a `wait` the caller started in the
background, and that wait is lost if Claude exits. The app-server already keeps the work itself durable. Research
behind this goal: ~/.local/state/janus/audit-2026-11-09/agent-tooling-research-2026-11-16.md, items 1-3.

## Done criteria
1. **`codex-drive result <name|threadId> [--turn <id>] [--json]`** prints the full final agent message of the
   latest completed turn, or of the named turn, together with the turn status and the thread name.
   - It works for live sessions and for log-only sessions.
   - Exit codes: 0 completed; 1 failed (still prints what exists); 2 unknown name; 3 not finished yet.
   - Document the exit codes in `--help` and the README.
2. **Completion outbox.** Each turn completion (completed, failed, interrupted, or a usage limit) appends one JSON
   line to a durable outbox under codex-drive's state directory: name, thread id, turn id, status, finished time,
   and the first 300 characters of the final message.
   - The app-server-side monitor writes it, so the outbox fills even when no client is waiting.
   - **`codex-drive inbox [--follow] [--since <time>|--unread] [--ack]`** lists entries. With `--follow`, it prints
     one line per new completion and keeps running; it suits a Claude Code background task or monitor.
3. **Bounded and safe.**
   - The outbox is append-only, rotated at a size limit, with no secrets.
   - Concurrent writers are safe.
   - Existing commands are unchanged.
4. **Tests** in `test/` cover: `result` (multi-line message, failed turn, unknown name, unfinished); outbox written
   on completion with no client attached; `inbox --unread`/`--ack`; and `--follow` emitting a new line.
   `npm test` passes.
5. **README:** a short section, "Integrating with Claude Code", that shows the recommended pattern: start
   `--detach`; run `inbox --follow` as a background task or monitor; on each line, run `result <name>`.

## Boundaries
- Keep changes small and in codex-drive's existing style.
- Don't change the app-server protocol schema (`protocol/`).
- Don't touch other worktrees; never signal processes you didn't start.
- Run headless; never open windows.
- Commit on `goal/result-inbox`. Do not merge to main; the integrator lands it after review.
