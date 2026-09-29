# codex-drive

A small Node 26 CLI that starts Codex turns and lets a person or orchestrator steer them while they run. It uses a standalone Codex app-server over loopback WebSocket, with no npm dependencies. Requires `codex` on PATH, authenticated Codex access, and the system `lsof` and `ps` commands (tested on macOS).

## Install

Use the executable directly:

```sh
/path/to/codex-drive/src/cli.mjs serve
```

Or run `npm link` in this repository to install the `codex-drive` command. No build step is needed.

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
codex-drive resume goal "Continue with a new task"
```

`start` requires cwd, model, effort, log, and one prompt. `--cd` is an alias for `--cwd`. Repeat `--add-dir /absolute/path` to extend a workspace-write turn's writable roots. `--name` is optional; every command also accepts the printed thread ID. Names cannot contain path separators and cannot overwrite an existing thread. Use `--` before a prompt that starts with dashes.

All server commands except `tail` accept `--port`; start defaults to 4700 and subsequent commands use the port saved with the thread. `steer` and `interrupt` accept `--turn <turnId>` as an explicit precondition. They check the live thread and fail clearly when no turn runs. `resume` requires a finished turn and starts a new turn on the same thread.

`start` and `resume` immediately print one JSON object containing `threadId` and `turnId`, then stay attached until completion. Their stdout is machine-readable; diagnostics go to stderr. An interrupted attached process exits 130; failed turns and command errors exit nonzero. `status` returns JSON, including status (`running`, `completed`, `interrupted`, or `failed`), the last received event time, and the last agent message line. It refreshes turn status from the server and therefore requires a live server; `tail` reads the local log without connecting.

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

State lives in `~/.codex-drive/threads/<name-or-threadId>.json`, with private files, atomic replacements, and one attached writer per thread. Set `CODEX_DRIVE_HOME` to relocate driver state and server PID/log files. Turn events are appended as JSONL with a local `receivedAt` timestamp and the original server fields. Logs can contain prompts, agent output, and command output; choose a private log location.

An attached driver reconnects after a WebSocket drop, repeats the handshake, rejoins with `thread/resume`, and refreshes the current turn. It never replays a mutating request. Even a lost `turn/start` reply is recovered by inspecting the known thread, rather than submitting the prompt twice. Disconnects and recovery snapshots are marked in the log. Events emitted during a connection gap may be missing; the log is not a lossless audit trail. Recovery is bounded to 15 attempts. If the driver fails, the turn may still run on the server: inspect `status` and use `steer` or `interrupt`. Unknown start outcomes fail clearly and require inspection before retrying.

## Orchestrator example

```sh
codex-drive serve
codex-drive start --cwd /path/to/project --model gpt-6.1-sol --effort low \
  --name goal --log /path/to/goal.jsonl "Implement the bounded task" \
  > /path/to/goal.ids.json 2> /path/to/goal.driver.log &
driver_pid=$!
codex-drive status goal
codex-drive tail goal -n 20
codex-drive steer goal "Stop after the current check and report"
# Or cancel the current turn:
codex-drive interrupt goal
wait "$driver_pid"
codex-drive serve --stop
```

Wait until the IDs file contains the first JSON line before addressing a newly started thread. The background PID belongs to the attached driver; interrupt the turn through the CLI. Keep the server running while goals need steering, then stop the server you own.

## Verification

```sh
npm test
npm run proof
node scripts/generate-protocol.mjs
```

The live proof is billable and requires access to `gpt-6.1-sol`. It uses low effort and explicit full access in fresh directories under `/tmp/codex-drive-proof/`. It creates an isolated Codex home with a private copy of authentication that is removed during cleanup, starts a fresh loopback server, and stops it in cleanup. It verifies steering after tick 2, interrupt after tick 2, a new turn on the finished thread, a completed-thread steer error, ID lookup, WebSocket recovery, and recovery of an accepted start whose reply is lost. Results and JSONL logs remain under that run directory. The script never stops a pre-existing listener.

[PROOF.md](PROOF.md) records the inspected live results. [protocol/README.md](protocol/README.md) records the generated protocol version. Runtime code is plain ESM; the checked-in generated types are the reference for method and parameter names.
