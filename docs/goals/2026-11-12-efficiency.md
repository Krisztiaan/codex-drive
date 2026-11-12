# Goal: make codex-drive cheap on the app-server (efficiency pass)

Repo: this one (codex-drive, node >=24, `npm test` = `node --test --test-concurrency=2`). Work on branch `goal/efficiency`
in this worktree. Do not merge to main; stop with everything committed and the Outcome written.

## Why

The `codex app-server` on port 4701 sits at ~200% CPU while `codex-drive wait a b c d e f g --any` runs. A sample showed it in
`sqlite3_step`/`pread` under `codex_thread_store::local::thread_history::read::stored_thread_item`, then
`serialize_outgoing_message`; the node waiter itself used ~50-60% CPU. `thread_history_1.sqlite` is 17.7 GB (indexes present,
no bloat: the cost is the access pattern, not the DB). Two independent reviews (Opus, then Codex) agree on the causes below.
They are verified against code, not measured; part of your job is to measure the request mix before and after in the fixture.

Causes (file:line refer to main at the time of writing; re-check):
1. `waitForTurn` (`src/turns.mjs` ~233-290) loops `snapshot()` + `delay(100)`. After the first poll it requests
   `thread/turns/list` with `limit:20, itemsView:'full'` (line ~30): full item hydration of 20 turns, ~10x/s, per waited thread,
   one connection per thread.
2. Every `thread/resume` hydrates the whole thread history with full items unless `excludeTurns:true` is passed. Internal callers
   never pass it and ignore `thread.turns` (`turns.mjs` ~123, 146, 171-189, 266; `cli.mjs` ~243). Explicit user overrides in
   `src/params.mjs` ~28-43 and raw `call` output (`cli.mjs` ~227-239) must keep working.
3. `serve --restart` inspection calls `thread/read includeTurns:true` for every loaded thread every 500 ms
   (`src/server.mjs` ~57-87).
4. Every `connection()` journals every received event (deltas included) to `~/.codex-drive/calls/<uuid>.jsonl`
   (`src/client.mjs` ~9-21); ~8 GB / 144k files today; nothing prunes it.
5. The resume logger runs `store.save` (pretty JSON + rename) and a synchronous `appendFileSync` on every thread event,
   deltas included (`turns.mjs` ~103, `state.mjs` ~62-76).
6. Waiters receive streaming delta notifications they never use.
7. Fragility under load (in scope because overload is what this fixes): with `--any` one waiter's error cancels all the others
   (`cli.mjs` ~143-154); a 30 s request timeout on an open socket is rethrown instead of retried (`rpc.mjs` ~44,
   `turns.mjs` ~279); reconnects use fixed 100/500 ms sleeps with no jitter.

## Deliverables (contracts)

A. **Resumes skip history.** Internal `thread/resume` calls send `excludeTurns:true` (waiter connect/reconnect, logger start and
   recovery, steer/interrupt, runAttached defaults). An explicit user/option override still wins. Nothing that reads
   `thread.turns` from a resume may break; grep and prove it. Confirm `excludeTurns` is in `protocol/schema.json` and that
   token-usage/status data the CLI shows still comes through (warm resume replay can differ: check and cover).

B. **Cheap polling, target-aware.** Polls use `itemsView:'notLoaded'` (status and error stay populated). Keep correct target-turn
   resolution when the target is not the latest turn (steer, a newer turn, rollback): paging may use `limit:1` per page but must
   not fall back to `full` or hydrate items to find it. `lastAgentMessage` must come from the event stream captured by
   `applyEvent`; when a terminal snapshot has none, fetch it once for the target turn only (prefer `thread/items/list` or a
   one-turn `summary`/`full` read; check which exists in `protocol/schema.json` and which is cheapest). Document that
   `summary` can drop commentary-phase messages, so do not use it as the only source for failed/interrupted turns.

C. **Events are the primary completion signal.** Install listeners before resume. Events wake the waiter (today they only
   update state). Cache completions by thread+turn. Take an immediate snapshot on connect and on every reconnect (completions
   before subscribe or while disconnected are not replayed by the server). Backstop poll interval adaptive 1 s doubling to 10 s,
   with a hard maximum time between reconciliation snapshots that continuous event traffic cannot postpone. Completion latency
   must not get worse than today's.

D. **Waiters opt out of unused notifications.** Use `initialize.capabilities.optOutNotificationMethods` to drop streaming deltas
   the waiter and its state logic do not need (candidates in the schema: `item/agentMessage/delta`,
   `item/commandExecution/outputDelta`, `item/fileChange/outputDelta`, `item/plan/delta`, `item/reasoning/summaryTextDelta`,
   `item/reasoning/textDelta`; verify names and that nothing in `applyEvent`, completion capture or `lastAgentMessage` depends on
   them). Do NOT opt out of anything the resume logger or `follow`/`tail` users rely on; opt-out applies to wait connections
   and other pure observers only. Make the opt-out list one named constant.

E. **I/O diet.** Logger saves state only on lifecycle events (`turn/*`, completed agentMessage items, rate limits, status
   changes) and otherwise at most once per second (flush on exit); `lastEventTime` may be up to 1 s stale; document it. Wait
   connections stop journaling every event to `calls/` (keep error and lifecycle records). `events --follow` reads incrementally
   from a byte offset instead of re-reading the whole log every 100 ms. Add an opt-in `prune --calls [--older-than <days>]`
   path. **Never delete anything automatically, and never run any prune or delete against `~/.codex-drive` or `~/.codex`
   yourself**: the owner keeps all history deliberately. Your tests use temp homes only.

F. **serve lifecycle.** Replace the per-loaded-thread `thread/read includeTurns:true` inspection with a metadata-only status
   check (`includeTurns:false`, test `thread.status`), preserving the existing fail-closed behaviour (unknown/unreadable thread
   state blocks stop/restart). Note in the Outcome that approval-waiting threads now count as active, if that is what happens.

G. **Robust waits.** In `--any`, only a real settle chooses the winner; one waiter's error is reported without cancelling the
   others (all-error still exits non-zero with the right code). Wait reconnects use ~500 ms plus jitter and a larger budget
   (match the logger). A request timeout on an open socket is retryable during a wait. Keep exit codes 0/1/75/76/124/130 intact.

H. **Tests and proof.** Make `test-support/app-server.mjs` honour `itemsView`, `excludeTurns`, `optOutNotificationMethods`, and
   count requests by method/params so tests can assert them. Add tests that fail without the change: resume sends
   `excludeTurns`; polls send `notLoaded`; steady-state request rate per waited thread is bounded (e.g. <= 1 snapshot/s after
   warm-up with no events); completion by event wakes the waiter promptly; completion missed during a disconnect is found by
   the reconnect snapshot; completion between resume and first snapshot is found; target turn older than latest is resolved
   without `full`; failed/interrupted turns keep error and exit codes; `--any` error does not cancel peers; serve restart
   inspection sends no `includeTurns:true`. Existing tests must still pass (flag a wrong test instead of working around it).
   Run `npm ci` first if `node_modules` is missing. Add a small script or test output that prints the request mix
   (method x itemsView counts per second) for a 7-thread `--any` wait in the fixture, before (main) vs after, and put the numbers
   in the Outcome.

I. Update README and any docs that describe polling, `calls/`, serve inspection or opt-outs.

## Done means

All of A-I implemented; `npm test` green (and `npm run proof` if it runs offline against the fixture); new tests demonstrably fail
on main's behaviour for A, B, C, G and F; commits per deliverable with nothing uncommitted; `## Outcome` appended to this file
(what changed, measured request mix before/after, behaviour changes such as `lastEventTime` staleness, and anything you
deliberately did not do) and committed.

## Boundaries

- Own: `src/`, `test/`, `test-support/`, `README.md`, `docs/goals/`. Read-only: `protocol/` (regenerate nothing), `evidence/`.
- Do not touch, restart, signal or attach to any running process: app-servers on ports 4700/4701 drive live goals; the running
  `codex-drive` processes execute `src/` from the main checkout, not this worktree. Do not run `codex-drive` commands against
  those ports or `~/.codex-drive`; all runs use the fixture and temp homes.
- Do not open windows, take focus, or activate any app; run everything headless in the background.
- Out-of-scope problems you notice (shared connection for multi-wait, legacy-history replay cost, server-side issues): list them
  in the Outcome, do not fix them.
- Stop line: do not merge, do not push, do not edit the main checkout, do not start a second goal.

## Process

- Bias to action; carry this through to done without checking in; make reasonable calls and note them in the Outcome.
  You have full permission to run the local toolchain and commit on this branch.
- Commit after each deliverable once its tests pass.
- Never sleep or wait longer than a few minutes. If something external blocks, commit what exists, record the blocker in the
  Outcome, and stop.
- Allowed early stops: a protocol fact that contradicts this brief (record it in the Outcome), or a test that looks wrong.
- Short final report.

## Outcome

Completed A–I on `goal/efficiency`; stopped with commits only, without merging or pushing.

- **A:** Internal resumes default to `excludeTurns:true`, including reconnect, lost-start recovery and steer/interrupt. Explicit composed overrides also survive logger recovery; raw calls remain unchanged. Inspection of every `thread/resume` consumer found no dependency on returned `thread.turns`. The remaining `thread.turns` inspection was serve's read path and is removed by F. The checked-in schema explicitly supports metadata plus live-resume state with `excludeTurns`. CLI status/error still comes from turn metadata; warm-resume rate-limit replay has fixture coverage. Token-usage notifications remain enabled; current CLI views do not consume/display `thread/tokenUsage/updated`. No live-server replay qualification was attempted.
- **B–D:** Snapshots page one turn at a time with `itemsView:'notLoaded'`, preserving target identity, status and errors without item hydration. Completed agent-message events supply the last message. If absent at settlement, a single target-only search uses descending `thread/items/list` pages, stopping at the first nonblank agent message. `summary` can omit commentary and is not used as the sole failed/interrupted-message source. Listeners are installed before resume; observed completions are cached per thread's turn, and every connect/reconnect immediately snapshots. Backstop intervals are 1/2/4/8/10 seconds, with a deadline unaffected by continuous traffic. Wait observers alone use the named six-method delta opt-out list; attached loggers retain the full stream.
- **E:** Logger state saves and buffered raw-journal appends flush on lifecycle events, otherwise at most once per second, and on exit. Persisted `lastEventTime` may be one second stale. Wait call journals retain lifecycle/error/server-request records rather than all events. `events --follow` reads appended bytes and decodes UTF-8 incrementally. `prune --calls` is explicit and dry-run by default; `--apply` removes only age-selected call `.jsonl` files. No automatic retention policy was introduced; pruning tests ran only against temporary fixture homes. No prune/delete was run against either real history directory.
- **F:** Loaded-thread inspection uses `thread/read includeTurns:false` and `thread.status`. Only known idle status permits an ordinary stop/restart; active threads, including approval-waiting threads, count as active. Unknown, not-loaded, system-error and unreadable status fail closed.
- **G:** `--any` prints an observer error without cancelling peers; only a settled turn wins, and its code determines success/failure. All-error remains nonzero; timeouts do not win over a later settlement. Open-socket RPC timeouts are retryable only within the wait recovery flow. Wait/logger reconnect delays are 500–750 ms with jitter and 15 retries; this increases wait's reconnect-delay budget from about 1.5 seconds to 7.5–11.25 seconds, excluding connection/request time. Mutations are never replayed. Exit-code coverage retains 0/1/75/76/124/130.
- **H–I:** The fixture now honours history exclusion, item views, metadata status and notification opt-outs; it records method/params/timestamps and exposes grouped request counts. Fixed its extended WebSocket-frame decoder: a decoded payload length of 127 must not be interpreted again as a 64-bit length marker. Added offline request-mix/baseline regression tooling and README guidance.

### Measured request mix

Source: `node test-support/request-mix.mjs edf0a93 --regressions`, comparing main at `edf0a93d59b48479514f08d9a0483f226380df61` with this implementation. Seven concurrent threads, one running turn each, `wait --any`, no streaming traffic, fixture server and temporary homes. The steady window starts after all seven initial snapshots; each window lasted 4.001 seconds and ended with an event-driven completion. Both CLI runs exited 0.

| Method / view | Main steady count | After steady count | Main requests/s | After requests/s |
| --- | ---: | ---: | ---: | ---: |
| `thread/turns/list / full` | 272 | 0 | 67.98 | 0 |
| `thread/turns/list / notLoaded` | 0 | 14 | 0 | 3.50 |
| All other methods | 0 | 0 | 0 | 0 |

Inputs: 272 / 4.001 seconds versus 14 / 4.001 seconds; per waited thread about 9.71/s versus 0.50/s. Reduction in steady reconciliation requests: `(272 - 14) / 272 = 94.9%`. Across the entire runs, initialize and resume were seven requests each on both sides; turn-list requests were 286 full before versus 21 notLoaded after. Neither run needed a terminal item fetch because the message was captured from the event stream. These are fixture request counts, not CPU, latency-distribution, history-byte, cost or live-database measurements.

### Verification and limits

- Installed dependencies with `npm ci` because `node_modules` was missing. Its audit reported one moderate dependency vulnerability; dependency upgrades were outside this pass.
- Final `npm test`: **144 passed, 0 failed**, Node 26.13.0 (repository requires >=24), file concurrency 2. Focused efficiency suite: 16 cases, including prompt event completion without another poll, continuous-traffic reconciliation, missed/disconnected completions, older targets, open-socket timeout recovery, logger write coalescing, warm replay and explicit override recovery. Existing failure/recovery tests retain structured error and exit-code coverage.
- Baseline proof: all **five selected A/B/C/G/F tests fail** against the temporary main source copy (0 passed / 5 failed), and pass against the implementation. No main checkout edits were used. `git diff --check` passed.
- `npm run proof` was deliberately **not run**: `scripts/proof.mjs` declares itself live and billable, copies authentication and launches a real app-server. It does not meet this brief's offline-fixture condition. All executed servers were owned fixtures on ephemeral ports; no live port 4700/4701 process was attached to, signalled or restarted.
- Deliberately unchanged: one connection per waited thread, legacy-history replay cost inside the server, server-side SQLite/storage behaviour, existing serve inspection cadence, real history retention, protocol generation and dependencies. Buffered non-lifecycle logger events can be lost on a hard kill; graceful exits flush. Live app-server CPU and warm-resume replay details remain unmeasured.
