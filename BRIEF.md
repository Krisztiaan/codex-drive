# Goal: codex-drive, a steerable driver for Codex sessions

**Why.** `codex exec` runs the agent in its own process, so a running goal can't be steered. A message queued with
`codex queue --thread <id>` is taken off the queue but never acted on mid-turn (tested with codex-cli 0.159.0 on
2026-09-29). The Codex app-server protocol supports real steering: `turn/steer` (params `threadId`,
`expectedTurnId`, `input`), `turn/interrupt` (`threadId`, `turnId`) and `thread/injectItems`. A standalone app-server
handshakes over stdio, and `codex app-server --listen ws://IP:PORT` serves the same protocol over WebSocket.

The owner wants long-running Codex goals that an orchestrator (Claude) or a person can steer mid-turn.

**Build `codex-drive` in this repository** (`~/dev/codex-drive`): a small, dependency-free Node 26 CLI (TypeScript run
natively, or plain ESM). Generate the protocol types with `codex app-server generate-ts` or `generate-json-schema`,
and use the real method and parameter names. Don't guess.

## Commands

- **`codex-drive serve [--port 4700]`**
  - Starts `codex app-server --listen ws://127.0.0.1:<port>` if nothing listens there, records the pid, and returns.
  - Also `serve --stop`, which stops it by the recorded pid or by port. Never kill processes by name.
  - Binds only to 127.0.0.1.
- **`codex-drive start --cwd <dir> --model <m> --effort <e> [--sandbox …] [--approval …] [--add-dir …] [--name <n>]
  --log <file.jsonl> "<prompt>"`**
  - Calls `thread/start` then `turn/start`.
  - Prints `{ threadId, turnId }` at once, and writes a small state file (`~/.codex-drive/threads/<name|threadId>.json`:
    thread, current turn, cwd, model, log path, status).
  - Stays attached and appends every server event to the log as JSONL until the turn completes, then updates the
    state.
  - Sandbox and approval are explicit flags, with safe defaults (`workspace-write`, approval `on-request`). Full access
    must be asked for explicitly (`--sandbox danger-full-access --approval never`) and printed as a warning line.
  - Expose the equivalents of `codex exec`'s `--add-dir` and `--cd`.
- **`codex-drive steer <name|threadId> "<text>"`:** `turn/steer` against the thread's current turn (from the state
  file, or `--turn`). Prints the result. It must fail clearly when no turn is running.
- **`codex-drive interrupt <name|threadId>`:** `turn/interrupt`.
- **`codex-drive status [<name|threadId>]`:** running, completed or failed; the last event time; the last agent message
  line.
- **`codex-drive tail <name|threadId> [-n 20]`:** readable last events from the log (agent messages, commands run,
  errors).
- **`codex-drive resume <name|threadId> "<text>"`:** a new turn on a completed thread (`turn/start` on the same
  `threadId`), attached as in `start`.
- Handle the handshake (`initialize`, then `initialized`), reconnect when the WebSocket drops (the thread lives on the
  server), and exit with non-zero codes on errors.

## Done when (prove each; don't assume)

1. **The live steering proof.** Start a real turn on `gpt-6.1-sol` with `--effort low` and full access in a throwaway
   directory under `/tmp/codex-drive-proof/`, with the prompt: "Repeat 8 times: run `sleep 15; date`, then write
   `tick N`. When done, say FINISHED." After tick 2, `steer` it: "Stop the loop now, write STEERED-OK, and finish."
   Show from the log that it stopped early and wrote STEERED-OK. Save the evidence to `PROOF.md`.
2. **Interrupt:** the same proof with `interrupt`.
3. **Resume:** a new turn on the finished thread.
4. **Unit tests** for argument parsing and state files. An integration test script for the proof, which the owner can
   re-run.
5. **`README.md`:** install (`npm link` or a bin path), the commands, the safety defaults, and how an orchestrator
   uses it: `start` in the background, `steer`, `status`, `tail`, `interrupt`.
6. Commit in this repository (plain messages, no attribution lines). Don't push.

## Boundaries

- Never touch the shared Codex daemon (`codex app-server daemon …`) or `~/.codex` configuration.
- Don't run an app-server on anything but 127.0.0.1. Stop everything you start: servers by pid or port, never by name.
- Work only in this repository and `/tmp/codex-drive-proof/`.
- Stop when it's done, and end with a short report: the commands, the proof results, the test results, the head
  commit.
