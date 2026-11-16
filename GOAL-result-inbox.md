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

## Outcome
- `result <name|threadId> [--turn <id>] [--json]`: header `name status turnId [failure class]`, then the full final
  agent message of the latest settled turn or `--turn`. Reads the server; falls back to the session log only when
  the server is unreachable or reports a missing thread (`thread not found`, `no rollout found for thread id`).
  Recovery records in the log carry the snapshot's status, error, full message and completion time. A saved
  same-turn failure wins over a snapshot that lost its error. Exits 0 completed, 1 failed or interrupted, 2 unknown
  name or turn, 3 not finished. In `--help` and the README.
- Outbox (revised in two review rounds; requirement changes from the original goal: no message preview, and one
  file per completion instead of an append-only rotated log): `outbox/<threadId>-<turnId>.json`, temp file
  published with `link()` (EEXIST = already recorded), so one physical file per turn. Fields: name, thread, turn,
  cwd, status, failure class, exit code, `finishedAt` (server completion time when known). One idempotent
  `recordCompletion`, called by the logger, `wait` and `result`; failures go to a non-throwing sink. Pruned at
  write time past 14 days or 2,000 distinct turns (`CODEX_DRIVE_OUTBOX_MAX_AGE`, `CODEX_DRIVE_OUTBOX_MAX_ENTRIES`).
  No PID locks.
- `inbox [--follow] [--since <time>|--unread] [--ack]`: ordered by `finishedAt`; `--ack` writes an empty
  `<threadId>-<turnId>.acked` marker; `--follow` does baseline scan, watch, rescan, and prints each entry once.
- Tests (`test/result-inbox.test.mjs`, 19): result cases, log-only and recovered completions, missing-thread
  versus other RPC errors, disconnect/complete/recover/server-loss, logger entry with no client, adopt writes
  nothing, repair by wait/result with server completion times, idempotency on disk, simultaneous publication by
  eight processes (physical files asserted), crash between temp write and link, finish-time order and distinct
  pruning, unread/ack/since, follow startup gap (in-process), follow over 60 entries, prune, outbox failure keeps
  the exit code. The fixture waits for detached loggers it started before removing its home.
- Known limits: a follower alone does not learn of a dead logger's turn until `wait` or `result` runs; two
  followers can both print an entry before acknowledging it.
