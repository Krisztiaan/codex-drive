# Goal 2: codex-drive as a full, faithful client of the Codex app-server

**Why.** codex-drive exists so that an orchestrator (Claude) or a person can run Codex sessions in tandem, with full
control. The owner does not want a set of bespoke wrappers that each re-implement a slice of Codex. They want
codex-drive to:
- wrap the app-server as completely as it can;
- use its whole control surface;
- pass through everything that can be passed through.

It should also be able to pick up any session, including one started by `codex exec` or the TUI, and fork sessions.
Then codex-drive can bootstrap itself: its own development can be driven through it.

## Principles

1. **The protocol is the authority.** Generate the protocol types or schema from the installed Codex:
   `codex app-server generate-ts` / `generate-json-schema`.
   - Methods, parameters, notifications, server-to-client requests and error types all come from that output.
   - Don't hand-copy them, and don't guess.
   - When Codex is upgraded, a regeneration step refreshes the schema, and new methods work without code changes.
2. **Pass through by default.**
   - A generic command reaches every client request, with the parameters as JSON.
   - Named commands exist only where they add orchestration value. Each is a small composition of protocol calls.
   - Where a named command maps onto a protocol request, it forwards every parameter that request accepts, not a
     hand-picked subset. It also keeps a raw escape hatch.
3. **Full control surface, including what the server asks for.** Server-to-client requests must never hang silently:
   approvals, elicitations and any others the schema defines.
   - Surface them: in the log, in `status`, and as a pending item.
   - Let the caller answer them.
   - Optionally, let a policy flag answer them.
4. **Greenfield.** Remove code that the pass-through design supersedes. Keep the existing proven commands' behaviour
   where it's still right, but rebuild it on the generic core.

## Scope

Decide the exact command set from the schema. At least:

- **Generic calls.**
  - `call <method> [params-json | @file | -]` for any client request. It prints the result JSON and exits non-zero on
    a protocol error, which it prints in full.
  - Validate method names and parameters against the generated schema, so mistakes fail clearly.
- **Events.** `events <name|threadId> [--follow]` streams the server's notifications as JSONL, unfiltered, alongside
  the existing readable `tail`.
- **Server requests.** A way to list pending server-to-client requests and answer them (for example
  `respond <requestId> <result-json>`), plus an approval policy option on start and resume.
- **Sessions.**
  - Adopt or attach any existing thread by id, including threads from `codex exec` and the TUI: list, read, resume.
  - Fork (`thread/fork` or the schema's equivalent).
  - Whatever else the schema offers for thread management: rollback, compaction, archive, names.
  - Adopted threads get state files like native ones, so `status`, `wait`, `steer`, `interrupt` and `resume` work on
    them.
- **Server and account facts:** model listing, rate limits and account or usage state, where the schema exposes them.
  Record rate-limit notifications in the thread state.
- **Turn options:** everything `thread/start`, `thread/resume` and `turn/start` accept: model, effort, sandbox,
  approval, cwd, config overrides, instructions, output schema and so on. Keep `--param <key>=<json>` as the escape
  hatch.
- **Failures.** Classify from the protocol's error information (for example its error-info type), never from message
  text:
  - **Capacity** (model at capacity or overloaded): a temporary error. Offer an opt-in `--retry-capacity <n>` with
    backoff, which continues the same thread with a short "continue from where you stopped" turn.
  - **Usage limit:** never retried automatically; the owner decides when to spend more. Record it in the state, with
    the reset time when the server gives one.
  - **Other failures.**
  - `status` reports the class, and `wait` exits with a distinct, documented code per class.
- **The first-round conveniences** (`wait`, `--detach`, the per-turn last message, the PATH link) stay, rebuilt on the
  core where that's cleaner.

## Done when (prove each; don't assume)

1. **Schema regeneration** is one command and is documented. The generic `call` works for a method you never wrapped.
2. **Adopt:** a throwaway `codex exec` session, started in `/tmp/codex-drive-proof/`, is adopted, steered mid-turn and
   waited on through codex-drive.
3. **Fork:** a thread is forked, and both branches continue independently.
4. **Server requests:** an approval request is surfaced and answered through codex-drive, under an approval mode that
   asks.
5. **Failure classes:** each class and its exit code is tested against a fake app-server that emits protocol-conformant
   messages taken from the generated schema. A live capacity or limit hit isn't needed.
6. **Tests pass** (`npm test`), and the earlier proofs still pass: steer, interrupt, resume.
7. **`README.md`** covers the pass-through model, the regeneration step, the commands, the exit codes and the
   orchestrator pattern: `start --detach`, `wait`, `steer`, respond to server requests, adopt and fork.
8. **Commits** in this repository, with plain messages and no attribution lines. Don't push.

## Live constraint

A real session named `gate-speed` is running through the app-server on `127.0.0.1:4700`, with its state in
`~/.codex-drive`.
- Don't stop, restart or connect test clients to that server.
- Don't touch that thread or its state file.
- Stay compatible with the existing state files.
- Use other ports and a temporary `CODEX_DRIVE_HOME`, plus a temporary Codex home where needed, under
  `/tmp/codex-drive-proof/`.
- Stop what you start by pid or port, never by name.

## Report

End with a short report:
- the command set, and how it maps onto the schema;
- what is passed through and what is wrapped;
- the proofs;
- the tests;
- anything deliberately left out, and why;
- the head commit.
