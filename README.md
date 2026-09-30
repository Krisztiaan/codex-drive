# codex-drive

A small Node 26 CLI that starts Codex turns and lets a person or orchestrator steer them while they run. It uses a standalone Codex app-server over loopback WebSocket, with no npm dependencies. Requires `codex` on PATH, authenticated Codex access, and the system `lsof` and `ps` commands (tested on macOS).

## Install

Install the executable symlink on PATH:

```sh
node scripts/install.mjs
codex-drive --help
```

The installer links `~/.local/bin/codex-drive` to this checkout's `src/cli.mjs`. It leaves the correct link in place on repeat runs and refuses to overwrite a file, directory, or foreign symlink, including a broken symlink. Ensure `~/.local/bin` is in your shell's PATH (`export PATH="$HOME/.local/bin:$PATH"` if needed). No build step or npm installation is needed. Moving the checkout requires updating the link manually.

The executable also works directly as `/path/to/codex-drive/src/cli.mjs`, and `npm link` remains an alternative. The installed symlink was verified with `codex-drive --help` from `/tmp/codex-drive-proof/`.

## Commands

```sh
codex-drive serve [--port 4700]
codex-drive serve --stop [--port 4700]
codex-drive start --cwd /path/to/project --model gpt-6.1-sol --effort low \
  --name goal --log /path/to/goal.jsonl "Your prompt"
codex-drive steer goal "Change direction now"
codex-drive interrupt goal
codex-drive status [goal]
codex-drive tail goal [-n 20]
codex-drive resume goal [--detach] "Continue with a new task"
codex-drive wait goal [--timeout 300]
```

`start` requires cwd, model, effort, log, and one prompt. Both `start` and `resume` accept `--detach`. `--cd` is an alias for `--cwd`. Repeat `--add-dir /absolute/path` to extend a workspace-write turn's writable roots. `--name` is optional; every command also accepts the printed thread ID. Names cannot contain path separators, overwrite an existing thread, or shadow another thread ID. Canonical IDs take precedence when reading older ambiguous files. Use `--` before a prompt that starts with dashes.

All server commands except `tail` accept `--port`; start defaults to 4700 and subsequent commands use the port saved with the thread. An explicit port that differs from the saved server is rejected before connecting. `steer` and `interrupt` accept `--turn <turnId>` as an explicit precondition. They check the live thread and fail clearly when no turn runs. `resume` requires a finished turn and starts a new turn on the same thread.

`start` and `resume` immediately print one JSON object containing `threadId` and `turnId`, then stay attached until completion by default. With `--detach`, they start that same attached logger in a detached child, wait only for accepted turn IDs and persisted state, print the IDs, and return. Worker startup errors fail the invoking command; subsequent errors and warnings are JSONL `driver/diagnostic` records in the log. Full-access warnings also remain visible on the invoking stderr. The optional saved `driverPid` records the detached logger at startup; it remains informational after completion and must not be treated as proof of a live owner. Their stdout is machine-readable; diagnostics go to stderr. An interrupted attached process exits 130; failed turns and command errors exit nonzero. `status` returns JSON, including status (`running`, `completed`, `interrupted`, or `failed`), the last received event time, and the current turn's last nonempty agent message line, or `null` before that turn produces a message. A resumed turn never inherits the previous turn's message. It refreshes turn status from the server and therefore requires a live server; `tail` reads the local log without connecting and ignores an unfinished final append; malformed newline-terminated records still fail.

`wait` reconnects to the saved server and observes the current turn even when no attached logger is running. It pins the turn selected by its first server snapshot, so a later resume cannot change which turn it is waiting for. An already-ended turn returns after that initial check. Wait refreshes the turn snapshot internally, records the receipt time of observed thread events in its returned JSON, and reconnects on transport drops without starting or steering a turn; it never writes the state file.

`wait` prints one final status JSON object and exits 0 for completed, 1 for failed or command errors, and 130 for interrupted. `--timeout` accepts positive seconds, including fractions, within Node's timer range. The deadline covers connections and outstanding RPCs; expiration prints the last observed status with `timedOut: true` and exits **124**. A timeout leaves the Codex turn running. Without the flag there is no overall deadline, although repeated transport failures are bounded to 15 retries. Orchestrators should use a timeout when they need a bounded wait.

`serve` returns after launching the server and records its actual listener PID. It reuses a listener already on that port. `serve --stop` stops only the recorded listener or its verified child; if no record exists, it finds the listener by the specified loopback port. A different listener causes refusal. Server startup is serialized within a state directory, and launcher ancestry is verified before recording ownership. Processes are never selected by name.

## Safety and persistence

The defaults are `--sandbox workspace-write --approval on-request`, with approval review routed to the user. `--sandbox read-only` is also available. This is a noninteractive driver: approval requests are explicitly declined, permission requests grant nothing, and unsupported client requests return an error with a diagnostic. Requests for user answers return no answers. Choose a policy appropriate to an unattended goal; the driver never silently grants an approval.

Full access requires an explicit `--sandbox danger-full-access`; unattended full access uses both flags below and prints a warning:

```sh
codex-drive start --cwd /tmp/my-goal --model gpt-6.1-sol --effort low \
  --sandbox danger-full-access --approval never --name experiment \
  --log /tmp/experiment.jsonl "Your prompt"
```

The WebSocket URL is always `ws://127.0.0.1:<port>`. The CLI does not use or change the shared Codex daemon or edit Codex configuration. The standalone server normally inherits `CODEX_HOME` and Codex configuration. To isolate its runtime files, set `CODEX_HOME` before `serve`.

State lives in `~/.codex-drive/threads/<name-or-threadId>.json`, with private files, atomic creation and replacements, and one attached writer per thread. Existing state files remain readable; no migration is required. Set `CODEX_DRIVE_HOME` to relocate driver state and server PID/log files. Turn events are appended as JSONL with a local `receivedAt` timestamp and the original server fields. Logs can contain prompts, agent output, and command output; choose a private log location.

An attached driver reconnects after a WebSocket drop, repeats the handshake, rejoins with `thread/resume`, and refreshes the current turn. It never replays a mutating request. Even a lost `turn/start` reply is recovered by inspecting the known thread, rather than submitting the prompt twice. Disconnects and recovery snapshots are marked in the log. Events emitted during a connection gap may be missing; the log is not a lossless audit trail. Recovery is bounded to 15 attempts. If the driver fails, the turn may still run on the server: inspect `status` and use `steer` or `interrupt`. Unknown start outcomes fail clearly and require inspection before retrying.

## Orchestrator example

```sh
codex-drive serve
codex-drive start --cwd /path/to/project --model gpt-6.1-sol --effort low \
  --name goal --log /path/to/goal.jsonl --detach "Implement the bounded task"
codex-drive status goal
codex-drive tail goal -n 20
codex-drive steer goal "Stop after the current check and report"
codex-drive wait goal --timeout 300
codex-drive resume goal --detach "Continue with the next bounded task"
codex-drive interrupt goal
codex-drive wait goal --timeout 30  # exits 130 after interruption
codex-drive serve --stop
```

The detached invocation returns only after its IDs and state are ready, so subsequent commands can address the thread directly. Use `wait`'s exit code and JSON to decide whether to resume, retry, or report failure. Keep the server running while goals need steering, then stop the server you own. Attached mode and backgrounding remain available for callers that prefer to own the logger process.

## Deliberately unchanged

Aggregate `status` still fails if any saved server is unavailable, rather than silently presenting stale results. `tail` reads the full log before selecting readable events; large-log optimization is deferred until measured. Reconnect gaps are explicit and cannot guarantee replay of every missed notification. Approval handling remains noninteractive and never silently grants permissions.

## Verification

```sh
npm test
npm run proof
node scripts/orchestrator-proof.mjs
node scripts/generate-protocol.mjs
```

The live proof is billable and requires access to `gpt-6.1-sol`. It uses low effort and explicit full access in fresh directories under `/tmp/codex-drive-proof/`. It creates an isolated Codex home with a private copy of authentication that is removed during cleanup, starts a fresh loopback server, and stops it in cleanup. It verifies steering after tick 2, interrupt after tick 2, a new turn on the finished thread, a completed-thread steer error, ID lookup, WebSocket recovery, and recovery of an accepted start whose reply is lost. Results and JSONL logs remain under that run directory. The script never stops a pre-existing listener.

The additional orchestrator proof verifies detached start/resume, status, timeout, steering, interruption, completed/interrupted waits, and waiting after the logger exits. Both proof scripts assert a port other than 4700 and use temporary `CODEX_DRIVE_HOME` and isolated authentication. They never access shared driver state. CLI regressions use a controllable WebSocket app-server boundary, not a real model; native proof results are recorded separately.

[PROOF.md](PROOF.md) records the inspected live results. [protocol/README.md](protocol/README.md) records the generated protocol version. Runtime code is plain ESM; the checked-in generated types are the reference for method and parameter names.
