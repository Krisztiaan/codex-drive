# Server ownership, accounts, pruning & limits

## Server lifecycle & multi-account routing

```sh
codex-drive serve                         # reuse active login's server or start one on a free port
codex-drive account [--json]              # active login + account on each known port
codex-drive serve --restart [--timeout 30]
codex-drive serve --prune                 # stop idle servers belonging to other accounts
codex-drive serve --stop [--port <p>] [--force]
```

- Endpoints always bind to `ws://127.0.0.1:<port>`.
- Active identity comes from `$CODEX_HOME/auth.json` (identity fields only; tokens are never refreshed for detection).
- Saved threads bind to their recorded port and account; threads cannot move between accounts. To target another account explicitly, pass both `--port <port>` and `--allow-other-account`.
- Active turns prevent `serve --stop` / `--prune` unless `--force` is given.
- Servers launch from `$CODEX_DRIVE_HOME` (default `~/.codex-drive`) so deleting a worktree never breaks later resumes.

## State & pruning

- State lives under `$CODEX_DRIVE_HOME` (`threads/`, `logs/`, `outbox/`, `steers/`, `requests/`). Keep it private (`0700`/`0600`).
- Local thread names are unique per driver home; prefix them (`<project>-<slug>`).
- `codex-drive prune [--older-than 30d] [--apply]` dry-runs by default and removes confirmed terminal local sessions (never deletes server rollouts). `prune --calls` cleans legacy `calls/*.jsonl` files.

## Verification & known limits

```sh
npm test                                  # offline fake-server suite (--test-concurrency=2)
node scripts/account-proof.mjs            # unauthenticated server/account proof (no billing)
npm run proof                             # live native proofs (billable)
```

Deliberately omitted: bespoke UX per protocol method, interactive TUI prompt, realtime audio, and live takeover of an active external `codex exec`/TUI process (finish the external turn first, then `adopt`).
