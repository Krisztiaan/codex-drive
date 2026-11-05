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
