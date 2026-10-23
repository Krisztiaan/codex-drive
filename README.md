# codex-drive

A Node 26 command-line client for the installed Codex app-server. An orchestrator or person can make any generated protocol request, own a turn's event stream, answer server requests, adopt sessions and fork them. Named commands compose the same validated RPC core; they do not implement a separate Codex runtime.

Requires `codex` on PATH, authenticated access for model turns, and `lsof`/`ps` for server ownership (tested on macOS). Runtime validation uses Ajv and the checked-in generated JSON Schema.

## Install and regenerate

```sh
npm ci
node scripts/install.mjs
codex-drive --help
npm run protocol
```

The installer symlinks `~/.local/bin/codex-drive` to this checkout's executable `src/cli.mjs`. It is repeatable and refuses to replace files, directories or foreign symlinks, including broken links. Ensure `~/.local/bin` is on PATH. No build step is required. Moving the checkout requires updating the link manually. Direct invocation and `npm link` also work.

`npm run protocol` runs `codex app-server generate-json-schema --experimental` and replaces [protocol/schema.json](protocol/schema.json) with the complete canonical bundle. It contains client requests, notifications, server requests, response types and error types. The current installed version produces **167 client methods and 11 server request methods**; [protocol/README.md](protocol/README.md) records its version. Regenerate after upgrading Codex. New client methods and parameters become available without changing runtime code. The generation step checks that every server request has a generated response schema. The former partial TypeScript reference tree has been removed.

## Pass-through commands

```sh
codex-drive methods
codex-drive call configRequirements/read null --port 4800
codex-drive call model/list '{"limit":10,"includeHidden":true}' --port 4800
codex-drive call thread/read @read-params.json --port 4800
printf '%s\n' '{"threadId":"UUID"}' | codex-drive call thread/read - --port 4800
```

`methods` lists all generated client request names. `call <method> [params-json|@file|-]` validates the exact JSON type and fields, sends the request, prints the result JSON and exits. Omitted parameters default to `{}`, or `null` for a null-only parameter type. `--param key=<json>` adds or replaces a top-level parameter. Unknown methods, misspelled struct fields and invalid values fail clearly; explicit maps such as `config`, output schemas and metadata remain open. Semantic restrictions described by the protocol but not encoded in JSON Schema remain server checks. Protocol errors print the full original error object, including `data`, to stderr and exit 1. Transport failures never replay a mutation. `call initialize` uses the supplied initialization parameters for its single handshake.

Connections enable the experimental API because it is included in the generated schema. Notifications are not filtered by a maintained list of known methods. Every connection journals raw server envelopes under the thread's log or `CODEX_DRIVE_HOME/calls/`. Generic calls are short-lived: if a method starts asynchronous work, use `adopt --detach` to keep an owner for its subsequent events and server requests. A server request received during the call is surfaced while the call is pending; normal connection closure explicitly rejects any outstanding request.

Small aliases forward **every** parameter of their mapped request via `--param`, returning its raw result:

| Command | Protocol method |
| --- | --- |
| `list` | `thread/list` |
| `read <name|id>` | `thread/read` |
| `archive <name|id>` / `unarchive <name|id>` | `thread/archive` / `thread/unarchive` |
| `rollback <name|id>` | `thread/revert` (requires `--param beforeTurnId='"TURN"'`) |
| `compact <name|id>` | `thread/compact/start` |
| `name <name|id> <server-name>` | `thread/name/set` |
| `models` | `model/list` |
| `account` / `rate-limits` | `account/read` / `account/rateLimits/read` |

Rollback changes conversation history; it does not revert files. Server names and local driver aliases are separate; --name assigns an alias only when local state is first created. Pagination and filters are passed through, rather than fetched automatically. The server defaults `thread/list` to interactive sources: include `exec` explicitly to discover exec histories, for example `list --param 'sourceKinds=["cli","exec","appServer"]'`. Account usage, realtime, tools, queues, configuration, filesystem, process and other APIs remain available through `call`; they need no dedicated wrappers.

## Turns and sessions

```sh
codex-drive serve --port 4800
codex-drive start --port 4800 --cwd /path/to/project --model gpt-6.1-sol --effort low \
  --name goal --log /path/to/goal.jsonl --detach "Implement the task"
codex-drive status goal
codex-drive steer goal "Stop after the current check and report"
codex-drive wait goal --timeout 300
codex-drive resume goal --detach "Continue with the next task"
codex-drive interrupt goal
```

`start` composes `thread/start` and `turn/start`. Cwd defaults to the current directory, sandbox to `danger-full-access`, approval mode to `never`, and request handling to `approve` (the equivalent of `codex --yolo`). Model and effort may be inherited from server configuration; providing them explicitly makes orchestration reproducible. A private log under the driver home is created if `--log` is omitted. `--cd` aliases `--cwd`; repeated `--add-dir` extends roots when `--sandbox workspace-write` is selected. Full access emits a warning. Start, resume, adopt/attach and fork accept `--sandbox` and `--approval` to opt into stricter settings, for example `--sandbox read-only --approval on-request --request-policy manual`. `--approval` sets when Codex asks; it is distinct from the client's `--request-policy` for answering those requests.

`resume <name|threadId> "text"` composes `thread/resume` and a new `turn/start`, rejecting an already-running turn. Without text or raw input it attaches to the existing turn. Saved per-thread sandbox, approval and request-policy settings remain in effect unless explicitly overridden. A thread ID without local state is adopted during resume and uses the same defaults as start. `adopt` (also spelled `attach`) loads an existing thread using `thread/resume`, persists local state, refreshes its current turn and logs it until it ends. Adopted threads support status, wait, steer, interrupt and resume like native threads. Exec and TUI histories must be in the app-server's `CODEX_HOME`; this loads persisted history into that runtime, and does not take over a turn running in a separate exec/TUI process. Finish that external turn before continuing it through this server.

```sh
codex-drive list --port 4800 --param 'sourceKinds=["exec","cli"]'
codex-drive adopt THREAD_ID --port 4800 --name imported --detach
codex-drive resume imported --detach "Continue this history"
codex-drive fork imported --name branch
codex-drive resume branch --detach "Explore the alternative"
```

`fork` makes a `thread/fork` request and persists the returned branch under its new ID or `--name`. The original and fork can continue independently. All fork parameters, including history boundaries and configuration, are forwarded. Local names cannot overwrite state or shadow a canonical ID. Canonical IDs take precedence when reading older ambiguous files. Existing state files remain compatible; no migration is required. Adoption and forks without local state use the same defaults as start; forks of saved threads inherit their settings. Explicit protocol settings override these defaults, and effective server sandbox and permission-profile settings are retained.

Start/resume support the **entire** `thread/start`, `thread/resume` and `turn/start` parameter surfaces:

```sh
codex-drive start --port 4800 --detach --name structured \
  --thread-params '{"developerInstructions":"Use the repository gates","config":{"features.web_search":false}}' \
  --param 'model="gpt-6.1-sol"' --param 'effort="low"' \
  --param 'turn.outputSchema={"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"],"additionalProperties":false}' \
  "Return the result"
```

`--thread-params` and `--turn-params` take JSON, `@file` or `-` for stdin. Raw values override convenience defaults; repeated `--param` overrides those blobs. Unqualified keys route to every composed request whose generated parameter schema accepts them; use `thread.key` or `turn.key` to scope a value. `input` can be supplied as protocol JSON instead of a text prompt. This covers images, skills, instructions, provider/configuration overrides, service tiers, reasoning, permission profiles and output schemas without adding flags for each field. Addressed thread identity is pinned in turn compositions; use `call` for a raw request. JSON is validated before creating/resuming a thread. Use `--` before a text prompt beginning with dashes. Adopting accepts thread-resume parameters; fork accepts thread-fork parameters via `--thread-params` or `--param`.

Start, resume and adopt print one `{threadId,turnId}` object; adopt may have a null turn ID. They stay attached until the observed turn ends by default. `--detach` launches the same logger as a detached child, waits for accepted IDs and persisted state, prints those IDs and returns. The child writes events and diagnostics to the log. Startup failures fail the parent; later failures are read through status/wait. Optional `driverPid` is informational after completion. Stopping an attached logger closes its connection and does not issue `turn/interrupt`. Commands that address saved threads use their saved port; a conflicting explicit `--port` is rejected.

## Events and server requests

```sh
codex-drive events goal              # raw server envelopes, JSONL
codex-drive events goal --follow     # follow the logger's append-only stream
codex-drive tail goal -n 20          # readable agent/command/lifecycle lines
codex-drive pending goal
codex-drive respond REQUEST_ID '{"decision":"accept"}'
codex-drive respond REQUEST_ID @response.json
codex-drive respond REQUEST_ID '{"code":-32601,"message":"Unsupported request"}' --error
```

`events` prints all journaled server notifications and requests, with their original fields and an added `receivedAt`; driver diagnostics are omitted. Follow continues until the caller stops it. It reads the logger's journal, so keep an attached or detached owner if live event collection is needed. `tail` remains a readable local view. Both ignore an unfinished final append and reject corrupt complete records.

Every server-to-client request is logged, announced on stderr (or detached diagnostic log), exposed by `pending [name|threadId]`, and included in `status.pendingRequests`. A local UUID identifies the request; the envelope also includes its original protocol ID, method, parameters, thread and owning connection. `respond` routes through that owner's private Unix socket and validates the result against the generated response schema before sending it. Invalid responses leave the item pending. `--error` sends a full JSON-RPC error instead, including for a future method whose response schema is not yet available. Requests without a thread association appear in unfiltered `pending`.

The default `--request-policy approve` automatically answers command/file/permission approvals that still arrive. Use `--request-policy manual` to answer requests yourself, or `--request-policy decline` to decline approvals and MCP elicitations. Policies validate their responses and leave a request manual if its shape is unsupported. User questions, dynamic tools, token refresh, attestation, current-time requests and elicitations requiring content remain explicitly answerable; the driver invents no input or credentials. Policies do not alter the server's approval mode. Normal resolution, disconnect and shutdown remove pending items; normal shutdown sends an explicit error for unanswered requests. A hard process kill may leave stale files: `respond` reports a disconnected owner instead of claiming a reply was delivered.

## Status, waiting and failures

`status` refreshes from the app-server, reporting current turn status, the current turn's last completed agent-message line (or null), received event time, pending requests, structured error/failure details and observed rate limits. Resume clears the previous turn's message. Rate-limit notifications are recorded in thread state, including a per-quota map; server-supplied reset timestamps are reported as Unix seconds. Sparse unavailable account metadata does not erase previously known metadata for the same quota.

`wait <name|threadId> [--timeout seconds]` reconnects and observes the current turn even without a logger. It pins the turn from its first snapshot, returns immediately for an ended turn, prints one final status JSON and exits:

| Exit | Meaning |
| --- | --- |
| 0 | Completed |
| 1 | Other turn failure, command, validation, transport or protocol error |
| 75 | Capacity: `serverOverloaded` or `flexUnavailable` |
| 76 | Usage limit: `usageLimitExceeded`, `rateLimitExceeded` or `sessionBudgetExceeded` |
| 130 | Interrupted |
| 124 | Timeout; returned JSON includes `timedOut: true` |

For the same turn, wait preserves the status and error from an observed `turn/completed` notification across later snapshots and reconnects. It also uses an attached logger's saved failure, rechecking saved state before accepting a terminal snapshot. This prevents a snapshot reporting interrupted without an error from erasing a recorded capacity or usage failure. A saved failure from an older turn cannot settle a wait for a newer one; saved interrupted snapshots do not override failed server results.

Classification uses only `codexErrorInfo`, never error prose. Other structured variants, including generic upstream connection failures with HTTP statuses, remain other failures. Attached start/resume use the same terminal codes. Usage limits are **never** automatically retried. `--retry-capacity <n>` on start/resume opts into at most n capacity continuations on the same thread, with delays of 1, 2, 4… seconds capped at 30 seconds, and a short “Continue from where you stopped.” input. Each retry is a new turn, logged with its IDs; wait still observes one pinned turn and may report that failed turn while the detached owner retries. A retry is skipped if the thread advances during backoff. Inspect status before acting on a retried thread; independent raw callers must coordinate turn mutations because the server has no atomic expected-id precondition for turn/start. Transport errors do not authorize continuation retries or replaying the original input.

Timeout accepts positive fractional seconds and covers connections/RPCs. It leaves the turn running. Without a timeout there is no overall deadline; transport recovery is bounded to 15 attempts. Wait is read-only with respect to the thread state file. Status/wait cannot recreate notification history missed while no logger was attached.

## Orchestrator pattern

```sh
codex-drive start --port 4800 --cwd /path/to/project --model gpt-6.1-sol --effort low \
  --name task --detach --request-policy manual "Do the bounded work"
codex-drive events task --follow > /tmp/task-events.jsonl &
codex-drive status task
codex-drive pending task
# Read the request's method/params, then answer with that method's response JSON:
codex-drive respond REQUEST_ID '{"decision":"accept"}'
codex-drive steer task "Report after the current check"
codex-drive wait task --timeout 300
codex-drive fork task --name alternative
codex-drive resume alternative --detach "Try the alternate approach"
```

Own the event follower's PID if you start it. Approval responses and steering may be issued concurrently with wait. Decide whether to resume, spend more after a usage limit, or report failure from the exit code and final JSON. `adopt` extends this pattern to existing histories; `call` reaches additional server/account/control APIs without another wrapper.

## Server ownership and persistence

The WebSocket endpoint is always `ws://127.0.0.1:<port>`; start/serve default to 4700. `serve` starts a standalone app-server and returns its actual listener PID, or reuses an existing listener. `serve --stop --port PORT` targets only that port's verified recorded listener/child and refuses replacement listeners. Startup is serialized within the driver home. Processes are never selected by name. The driver does not alter the shared Codex daemon or configuration. Set `CODEX_HOME` before serve to select the server's histories and authentication.

New servers run from the absolute driver state home, so deleting the caller's worktree does not break later configuration loading, resume or adoption. Keep that state home available for the server's lifetime. `serve` and `status` inspect existing listeners too, including older servers without saved cwd metadata. If a listener's working directory has disappeared, they warn on stderr with its port, PID and path; JSON output remains unchanged. They leave the server running. Restart it from a stable directory when its sessions can be safely resumed.

State defaults to `~/.codex-drive`, with private atomic thread files and one attached writer per thread. `CODEX_DRIVE_HOME` relocates it. Logs and pending envelopes contain prompts, agent/command output and request content; keep their location private. A logger rejoins through `thread/resume` after disconnect, refreshes history and marks the gap. Lost `turn/start` replies are recovered by inspecting the known thread rather than resubmitting input. Unknown outcomes fail clearly. Reconnects cannot guarantee lossless event replay; inspect status if a driver fails, since the server turn may continue.

## Verification and limits

```sh
npm test
npm run protocol
npm run proof
node scripts/orchestrator-proof.mjs
node scripts/full-client-proof.mjs
node scripts/server-cwd-proof.mjs
```

Tests exercise the public CLI against an isolated fake app-server, generated-schema validation, pending-response routing and state persistence. Failure fixtures are checked against the generated notification schemas. Native proofs are billable, use `gpt-6.1-sol` at low effort, choose other free ports and isolated homes under `/tmp/codex-drive-proof/`, and stop only resources they started. Temporary authentication copies are removed. The original proofs cover steer, interrupt, resume, detach, timeout and recovery; the full-client proof adds exec adoption, independent forks, an actual approval answered externally, unwrapped calls and event follow. The server-cwd proof deletes the launching directory, checks native resume/adoption and verifies warnings for a legacy listener with a deleted cwd. [PROOF.md](PROOF.md) records inspected results.

Dedicated UX for every protocol method, an interactive terminal prompt UI, realtime audio rendering and external exec/TUI process takeover are deliberately omitted: JSON call/respond and app-server history adoption provide the control surface. There is no live capacity/usage-limit hit requirement; conformant fake failures prove those branches. Aggregate status fails if a saved server is unavailable. Tail/events currently scan the log; large-log optimization awaits measurement. Hard-kill cleanup and lossless replay across disconnects are not guaranteed.
