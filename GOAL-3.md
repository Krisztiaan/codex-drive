# Goal 3: fix codex-drive's rough edges

**Scope:** make codex-drive dependable for an orchestrator running many goals at
once across Codex accounts. Fix the rough edges below, find and fix the others
you hit, and fill the gaps an orchestrator needs. Keep the design as it is: a
thin, schema-validated client of the installed `codex app-server`. Don't build
a second runtime.

Worktree: `/Users/krisztiaan/dev/codex-drive-goals/polish`, branch `goal/polish`.
Model: `gpt-6.1-sol`, high effort.

## Critical: the live installation is in use

`~/.local/bin/codex-drive` symlinks to the **main checkout**
(`/Users/krisztiaan/dev/codex-drive/src/cli.mjs`), not your worktree. A shared
server on `127.0.0.1:4700` is driving at least six live goal sessions right now,
your own included. That means:

- Never stop, restart, kill or reconfigure the server on port 4700.
- Never touch saved state for sessions you didn't create. State lives under
  `CODEX_DRIVE_HOME`, by default `~/.codex-drive`.
- Run everything from your worktree (`node src/cli.mjs …`) against your own
  server on another port (e.g. `--port 4870`) with a temp `CODEX_DRIVE_HOME`.
- Don't re-run the installer and don't edit the main checkout. The orchestrator
  merges your branch after review.
- Model turns cost real usage. Prove behaviour with the existing test-support
  fakes and unit tests. Use at most a few tiny real turns on your own isolated
  server.

## Read first

`README.md`, `BRIEF.md`, `GOAL-2.md`, `PROOF.md`, `src/`, `test/`,
`test-support/`.

## Known rough edges, observed in production use on 2026-11-05

1. **Stale account after an external account switch.**
   - What happened: the user switched the active Codex account with
     `codex-auth switch`, which rewrites `~/.codex/auth.json`. The long-running
     `serve` process (started a day earlier) kept the old account. New goals
     then failed with exit 76 "usage limit" while the active account was
     unused. The orchestrator could only notice by running `codex-drive account`.
   - Make this visible and recoverable:
     - Detect that the server's account differs from the current auth on disk
       before `start`/`resume`, and at `serve` health checks.
     - Report it clearly.
     - Offer a safe way to move onto the current account: for example, a
       graceful restart that refuses while turns are active (see 3), or a
       second server for the new account. Saved sessions must keep working.
   - Find out from the app-server schema/source what is supported (`account/*`,
     `account/updated`) rather than guessing.
2. **`status` without a name dumps every session ever** as one huge JSON array
   (439 KB here, including old projects).
   - Add a compact human table by default: name, status, model, cwd tail, last
     event age, a short last message, and usage remaining.
   - Add filters: `--active`, `--cwd <prefix>`, `--since <dur>`, `--name <glob>`.
   - Keep `--json` for scripts. Don't break existing single-name JSON output
     that scripts rely on; if you must change it, add a flag instead.
3. **Restarting the server is unsafe.** `serve --stop` stops it even with turns
   in flight. Add:
   - a refusal or confirmation when turns are active
   - `serve --restart` that waits for idle, or an explicit `--force`
   - a clear message listing the sessions affected

   Session `resume`/`wait` must survive a server restart, re-attaching by
   thread id.
4. **Waiting on many goals.** Orchestrators run several goals and currently
   spawn one `wait` per goal in shell loops.
   - Support `wait a b c` with `--all` (the default) or `--any`, printing a
     line per completion.
   - Return a combined exit code, documented: e.g. the worst code, or 76 if any
     hit a usage limit.
   - Keep the existing single-name output and exit codes.
5. **Usage visibility.**
   - `rate-limits` and `account` print raw JSON. Add a readable summary: the
     account, plan, each window's used % and reset time in local time, and
     whether ordinary usage is allowed.
   - Warn at `start`/`resume` when the account is at or near its limit, before
     dispatching. Don't block by default.
6. **Steer bookkeeping.** `steer` changes a running goal's instructions, but
   nothing records it next to the session. Persist steers, with time and text,
   in the session state, and show them in `status <name>`.
7. **Anything else you find** while using it as an orchestrator would. Look at:
   - errors that only show raw JSON
   - `tail` readability
   - names colliding across projects
   - log growth and cleanup (`prune` of old sessions/logs, dry-run by default)
   - timeouts
   - Node version requirements versus what's installed (`engines` says ≥26;
     the machine has v24.21.0)
   - `--help` accuracy

   Fix what's clearly broken. List the rest in the Outcome with a
   recommendation.

## Deliverables

- Each item above fixed or explicitly ruled out with the reason, with tests
  using the fakes in `test-support/`.
- README updated for every changed or added command.
- `npm test` green; the proof scripts that don't need real turns still pass.
- Commits in reviewable steps on `goal/polish`; nothing left uncommitted.
- An `## Outcome` appended to this brief and committed. It covers:
  - what changed
  - how it was verified
  - backwards-compatibility notes for scripts that parse current output
  - the merge/upgrade steps the orchestrator should take: when it's safe to
    swap the live installation, and whether the running server must be
    restarted

## Rules

- No changes to the user's Codex account state: no login, logout or switch,
  and no `codex-auth` commands that write. Reading `~/.codex/auth.json`
  identity metadata (account id/email, never tokens) to detect a mismatch is
  fine. Never print tokens.
- Carry it through to done without checking in. If blocked, commit what exists,
  record the blocker in the Outcome and stop.

## Outcome

Implemented on `goal/polish`; the live installation, shared driver state, account
credentials and port 4700 were not changed. No billable model turns were used.

- **Account drift:** start/resume (including detached callers) and existing-server
  serve health checks compare server usage `accountId` with auth metadata, falling
  back to email. Mismatches warn with explicit recovery commands. Unavailable
  comparisons remain unknown. Server metadata now retains `CODEX_HOME`; legacy
  listeners require the launch environment when checking identity. The generated
  schema supports account reads and login/logout, but no reload-current-auth
  operation; `account/updated` provides auth mode/plan, not identity. Automatic
  login/token injection was therefore ruled out. Explicit idle restart or another
  server port provides recovery without changing saved thread IDs.
- **Status:** compact table by default; conjunctive active/cwd/since/name-glob
  filters; current quota headroom; unavailable rows instead of losing the whole
  inventory when one server is down. Single-name JSON remains JSON. Usage values
  describe observed quotas, never inferred permission to spend.
- **Lifecycle:** stop checks every server-loaded thread, including unsaved ones,
  and refuses active turns or failed inspection. Restart waits for idle (30-second
  default idle budget, configurable); force lists affected sessions and permits
  interruption. Driver start/resume dispatch and server controls share a home/port
  lock. Existing thread-ID reconnect is retained and tested across process restart.
  TCP probe timeouts cannot bypass inspection; listener replacement during
  inspection refuses shutdown. Independent raw clients or different driver homes must coordinate dispatch;
  the protocol has no atomic drain-and-shutdown operation.
- **Many-goal waits:** concurrent observers, default all or explicit any, one JSON
  line per observed result. Any cancels observers without interrupting goals.
  Usage failure takes exit 76 precedence; otherwise the largest observed exit
  code wins. Single-goal output/codes remain unchanged.
- **Usage:** account/rate-limits summaries show account, plan, windows, local reset
  times and backend ordinary-usage permission. Start/resume warn at 90% or when
  ordinary usage is disallowed, without blocking or adding usage retries.
- **Steers:** accepted text, turn ID and timestamp persist in a per-thread journal
  under the driver home and appear in status, avoiding concurrent state-writer
  overwrites. A bookkeeping failure after acceptance explicitly says not to resend.
- **Other rough edges:** prune is dry-run by default; apply rechecks terminal state
  under the writer lock, retains advanced turns, and removes only local state,
  steering records and unshared logs in the managed logs directory. It preserves
  server history and external logs. Concurrent inventory tolerates removed files.
  Existing collision protections remain; use project-prefixed aliases or separate
  driver homes. Node requirement lowered to 24; help and README cover the new UX.
  Generated schema refreshed independently from installed codex-cli 0.166.0:
  179 client methods and 11 server request methods.

Verification:

- `npm run protocol` passed; generated-schema validation passed.
- Final `npm test` on Node 24.21.0: **128 passed, zero failed**, with file
  concurrency bounded to two. Full output:
  `/tmp/codex-drive-polish-gate.txt`. Earlier Node 26.13.0 gate: 125 passed,
  zero failed before the final race/safety regressions were added.
- `node scripts/account-proof.mjs` passed with empty temporary Codex/driver homes,
  no credentials and no model turns on Node 24.21.0 (also passed on 26.13.0).
  It checked native account summary, unknown
  identity, JSON inventory, idle restart with a different PID, and verified final
  listener removal on port 60602. Evidence:
  [native account proof](evidence/goal-3-account-summary.json); full run at
  `/tmp/codex-drive-proof/account-8UnKDE/evidence.json`.
- Fake-server tests cover stale accounts and detached warnings, usage permission,
  table/JSON/filter compatibility, unavailable servers, all/any combined exits,
  steering with a concurrent logger, conservative pruning, active/untracked
  shutdown refusal, forced shutdown, and restart recovery by saved thread ID.
  Existing failure, request broker, adoption, fork and recovery coverage remains.
- Early overlapping test runs exceeded two pre-existing 2-second subprocess
  deadlines. Those tests now allow 10 seconds (still below the 30-second RPC
  timeout) while preserving their behavioral assertions. An old aggregate-status
  test was updated to request `--json` explicitly. A Node 24 shutdown-test
  failure exposed the unsafe TCP-probe gate; inspection is now required for
  every listener PID that might be signalled, with a focused regression. An
  orphan from the initial failed fake-server cleanup (port 57755, PID 31288)
  was verified against its owned temporary cwd/listener and stopped explicitly.
  The default test gate now runs two files at once, with a 10-second fixture
  startup allowance: an unrestricted 128-test run hit the old 5-second snapshot
  startup allowance under load despite the prior 127-test gate passing. The
  backend/RPC behavioral assertions remain unchanged.
- Existing model-based proof scripts were inspected but not rerun: they require
  multiple billable loop turns. Installer tests run only against temporary paths;
  the live symlink/installer was not operated. `git diff --check` passed.

Compatibility and upgrade:

- Scripts parsing aggregate status, account or rate-limits must add `--json`.
  Raw `call`, single-session status, single wait and existing state files retain
  their shapes/codes, with additive status fields for steering. Aggregate JSON
  can now include `refreshError` when a server is unavailable. Multi-wait is JSONL.
- Merge these commits into the main checkout after review; do not rerun the
  installer, since its symlink already targets that checkout. Prefer an idle
  maintenance point so old loggers and new clients do not overlap an upgrade.
  CLI conveniences do not themselves require a server restart. Loading changed
  auth or a newer app-server executable does: wait for live goals to finish, then
  run the upgraded `serve --restart --port 4700` from the orchestrator's normal
  state/auth environment. This session did not perform that action. Do not use
  force to upgrade live work. Saved thread IDs remain addressable afterward.

Remaining recommendations: tail/events still scan logs, preserving readable
agent/command/lifecycle output and corrupt-record checks; measure large-log costs
before adding indexing/rotation. Prune deliberately retains generic calls/server
logs and external logs; remove these manually only after their owners no longer
need them. Generic protocol errors remain full JSON to preserve server data;
use their message/code rather than parsing prose. Auth IDs/emails may be absent,
so unknown identity is not proof of a match. Reconnect cannot reconstruct events
missed while disconnected and remains bounded; inspect status and explicitly
resume/adopt if the outage exceeds its recovery window. No live account-switch
or forced-interruption acceptance is claimed from fake/unauthenticated proofs.
