# Goal: stop the calls/ journal from growing; verify and fix its biggest costs

Repo: this one (codex-drive, node >=24, `npm test`). Work on branch `goal/calls-journal` in this worktree. Do not merge or push;
stop with everything committed and the Outcome written.

## Context

`~/.codex-drive/calls/` holds one `<uuid>.jsonl` per `connection()` (see `src/client.mjs`): a raw journal of every event the
connection received. It is 8.2 GB in ~146k files. The owner says these journals are not needed ("we don't need to keep
anything" in this directory); they duplicate the `--log` files and nothing reads them back except possibly debugging.
A first efficiency pass (merged as `079ce7c`, see `docs/goals/2026-11-12-efficiency.md` and its Outcome) made wait observers
journal only lifecycle events, but `lifecycleEvent()` matches every `turn/*` method, including `turn/diff/updated`.

Measured on the six largest existing journals (all ~130-890 MB, each a connection open ~4 h): `turn/diff/updated` was 8,933 events
= ~1.34 GB, about 80% of those files. Each event carries the whole cumulative diff of the turn, so size grows through a turn. One
file held 1,287 of them in 866 MB. `item/completed` (215 MB), `item/started` (51 MB), deltas (~100 MB) and `thread/tokenUsage/updated`
(11 MB) follow. The other ~145k files are tiny (median ~396 bytes): one per short-lived connection, holding ambient events like
`account/rateLimits/updated`, `remoteControl/status/changed`, `thread/goal/cleared`, `account/updated`.
These numbers come from a sample analysis, not a rigorous measurement; verify them yourself first.

## Your job

1. **Verify** the above: re-measure on the real directory read-only (sizes by method, by connection kind: wait observer vs
   attached logger vs one-shot call vs serve/status), and check which code paths still write large journals after the merge
   (e.g. does `turn/diff/updated` still reach the journal for observers? for loggers? for one-shot connections? how many files per
   hour does a typical orchestration session create and why?). Say what is wrong in this brief's numbers if anything.
2. **Decide and implement what you judge best** to make the journal cheap, bounded and not wasteful, without losing things
   `codex-drive` needs. Options to weigh (not a recipe): opt observers out of `turn/diff/updated` and other unused notifications;
   stop creating a file per short-lived connection (reuse one daily or per-process journal, or journal only errors and
   server-request records for one-shots); do not journal `turn/diff/updated` at all anywhere except where a feature needs it
   (check the attached logger and `--log` consumers such as `tail`, `events`, status views before touching them: the `--log`
   files are the real logs and must keep working as today); size or age bounds with cheap automatic retention for `calls/`
   only; making journaling opt-in via env var or flag if nothing depends on it. Choose, justify briefly, keep the diff reviewable.
3. **Tests** that fail without the change (event volume per connection kind, file count per N short calls, retention behaviour in
   temp homes), full `npm test` green, and a before/after measurement from the fixture (bytes and files per scenario) in the Outcome.
4. Update README where it describes `calls/`, journaling or `prune`.

## Deletion authority (narrow)

- You may add code that deletes old files inside `calls/` (automatic or via `prune --calls`), tested only against temp homes.
- You must NOT run any delete against the real `~/.codex-drive/calls` yourself: the orchestrator will do that after review.
- Never touch, move or delete anything else under `~/.codex-drive` (threads/, logs/, locks, state, pending requests) or `~/.codex`,
  and never touch any `--log` files such as `/tmp/codex-goal-*.jsonl`. Retention code must refuse to act outside the `calls/`
  directory of the configured state home and must never follow symlinks out of it.

## Boundaries

- Own: `src/`, `test/`, `test-support/`, `README.md`, `docs/goals/`. Read-only: `protocol/`, `evidence/`.
- Do not attach to, restart or signal any running process; app-servers on ports 4700/4701 drive live goals and the running
  `codex-drive` processes read `src/` from the main checkout, not this worktree. Do not run `codex-drive` commands against those
  ports; all runs use the fixture and temp homes. Reading `~/.codex-drive/calls` for measurement is fine.
- No windows, no focus changes, no app activation; run headless.
- Out-of-scope findings go in the Outcome, not into the diff.

## Done means

Verification written up; chosen change implemented and committed per logical step; new tests fail on main's behaviour and pass now;
`npm test` green; README updated; before/after measurement and justification in `## Outcome` appended to this file and committed.

## Process

Bias to action; carry through to done without checking in; make reasonable calls and note them in the Outcome. Full permission to
run the local toolchain and commit on this branch. Never wait or sleep more than a few minutes; if blocked, commit what exists,
record the blocker, stop. Short final report.
