# codex-drive

A Node 24+ command-line client for the installed Codex app-server. An orchestrator or person can make any generated protocol request, own a turn's event stream, answer server requests, adopt sessions and fork them. Named commands compose the same validated RPC core; they do not implement a separate Codex runtime.

Requires `codex` on PATH, authenticated access for model turns, and `lsof`/`ps` for server ownership (tested on macOS). Runtime validation uses Ajv and the checked-in generated JSON Schema.

## Install and regenerate

```sh
npm ci
node scripts/install.mjs
codex-drive --help
npm run protocol
```

The installer symlinks `~/.local/bin/codex-drive` to this checkout's executable `src/cli.mjs`. It is repeatable and refuses to replace files, directories or foreign symlinks, including broken links. Ensure `~/.local/bin` is on PATH. No build step is required. Moving the checkout requires updating the link manually. Direct invocation and `npm link` also work.

`npm run protocol` runs `codex app-server generate-json-schema --experimental` and replaces [protocol/schema.json](protocol/schema.json) with the complete canonical bundle. It contains client requests, notifications, server requests, response types and error types. The current installed version produces **179 client methods and 11 server request methods**; [protocol/README.md](protocol/README.md) records its version. Regenerate after upgrading Codex. New client methods and parameters become available without changing runtime code. The generation step checks that every server request has a generated response schema. The former partial TypeScript reference tree has been removed.

## Pass-through commands

```sh
codex-drive methods
codex-drive call configRequirements/read null --port 4800
codex-drive call model/list '{"limit":10,"includeHidden":true}' --port 4800
codex-drive call thread/read @read-params.json --port 4800
printf '%s\n' '{"threadId":"UUID"}' | codex-drive call thread/read - --port 4800
```

`methods` lists all generated client request names. `call <method> [params-json|@file|-]` validates the exact JSON type and fields, sends the request, prints the result JSON and exits. Omitted parameters default to `{}`, or `null` for a null-only parameter type. `--param key=<json>` adds or replaces a top-level parameter. Unknown methods, misspelled struct fields and invalid values fail clearly; explicit maps such as `config`, output schemas and metadata remain open. Semantic restrictions described by the protocol but not encoded in JSON Schema remain server checks. Protocol errors print the full original error object, including `data`, to stderr and exit 1. Transport failures never replay a mutation. `call initialize` uses the supplied initialization parameters for its single handshake.

Connections enable the experimental API because it is included in the generated schema. Attached loggers retain raw server envelopes in the thread's log (`--log` or a private default under `logs/`), including cumulative diffs and streaming deltas. Other connections, including generic calls, wait, status and serve health checks, create no raw journals in `CODEX_DRIVE_HOME/calls/`. Wait observers opt out of unused streaming deltas and cumulative `turn/diff/updated` notifications. The named `WAIT_NOTIFICATION_OPT_OUTS` constant lists the seven excluded methods; completed items, turn completions, status, token-usage and rate-limit notifications remain enabled. Generic calls are short-lived: if a method starts asynchronous work, use `adopt --detach` to keep an owner for its subsequent events and server requests. A server request received during the call is surfaced while the call is pending; its broker record and response routing work independently of raw journaling. Normal connection closure explicitly rejects any outstanding request.

Small aliases forward **every** parameter of their mapped request via `--param`. Most return the raw result; account commands have readable summaries and a `--json` escape hatch:

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

`resume <name|threadId> "text"` composes `thread/resume` and a new `turn/start`, rejecting an already-running turn. Without text or raw input it attaches to the existing turn. Internal resumes default to `excludeTurns:true`; explicit `--thread-params` or `--param excludeTurns=false` overrides still win, and raw `call thread/resume` remains unchanged. Saved per-thread sandbox, approval and request-policy settings remain in effect unless explicitly overridden. A thread ID without local state is adopted during resume and uses the same defaults as start. `adopt` (also spelled `attach`) loads an existing thread using `thread/resume`, persists local state, refreshes its current turn and logs it until it ends. Adopted threads support status, wait, steer, interrupt and resume like native threads. Exec and TUI histories must be in the app-server's `CODEX_HOME`; this loads persisted history into that runtime, and does not take over a turn running in a separate exec/TUI process. Finish that external turn before continuing it through this server.

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

Every server-to-client request is announced on stderr (or detached diagnostic log), persisted while pending, exposed by `pending [name|threadId]`, and included in `status.pendingRequests`. Attached owners also retain the original envelope in the thread log. A local UUID identifies the request; the envelope also includes its original protocol ID, method, parameters, thread and owning connection. `respond` routes through that owner's private Unix socket and validates the result against the generated response schema before sending it. Invalid responses leave the item pending. `--error` sends a full JSON-RPC error instead, including for a future method whose response schema is not yet available. Requests without a thread association appear in unfiltered `pending`.

The default `--request-policy approve` automatically answers command/file/permission approvals that still arrive. Use `--request-policy manual` to answer requests yourself, or `--request-policy decline` to decline approvals and MCP elicitations. Policies validate their responses and leave a request manual if its shape is unsupported. User questions, dynamic tools, token refresh, attestation, current-time requests and elicitations requiring content remain explicitly answerable; the driver invents no input or credentials. Policies do not alter the server's approval mode. Normal resolution, disconnect and shutdown remove pending items; normal shutdown sends an explicit error for unanswered requests. A hard process kill may leave stale files: `respond` reports a disconnected owner instead of claiming a reply was delivered.

## Status, waiting and failures

`status` without a name prints a compact table (name, status, model, cwd tail, event age, last message and quota remaining). Use `--json` for the previous JSON array. Filters combine: `--active`, `--cwd /project` (path prefix with directory boundaries), `--since 24h`, and `--name 'goal-*'` (shell-quoted glob with `*`/`?`). Durations accept positive s/m/h/d/w values. Unreachable servers produce an unavailable row with `refreshError` in JSON, allowing other sessions to remain visible. Active filtering uses refreshed status. Usage percentages are observed quota headroom, not permission to dispatch.

`status <name|threadId>` keeps its JSON object output and adds `steers`, with accepted steering text, turn ID and timestamp. Steering is stored in a separate per-thread journal under `CODEX_DRIVE_HOME/steers/` to avoid racing the attached state writer.

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

`wait a b c` observes goals concurrently and prints one final status JSON line per completion. `--all` is the default; `--any` returns after the first settled turn and closes the remaining observers, leaving turns running. Errors produce a JSON line naming the affected goal. `--any` uses the winning settled turn's exit code. With no winner, or with `--all`, the combined exit is 76 if any observed result hit a usage limit, otherwise the largest exit code (including 124 timeout and 130 interruption). `--timeout` bounds each observer from invocation; single-name output and exit codes stay unchanged.

For the same turn, wait preserves the status and error from an observed `turn/completed` notification across later snapshots and reconnects. It also uses an attached logger's saved failure, rechecking saved state before accepting a terminal snapshot. This prevents a snapshot reporting interrupted without an error from erasing a recorded capacity or usage failure. A saved failure from an older turn cannot settle a wait for a newer one; saved interrupted snapshots do not override failed server results.

Classification uses only `codexErrorInfo`, never error prose. Other structured variants, including generic upstream connection failures with HTTP statuses, remain other failures. Attached start/resume use the same terminal codes. Usage limits are **never** automatically retried. `--retry-capacity <n>` on start/resume opts into at most n capacity continuations on the same thread, with delays of 1, 2, 4… seconds capped at 30 seconds, and a short “Continue from where you stopped.” input. Each retry is a new turn, logged with its IDs; wait still observes one pinned turn and may report that failed turn while the detached owner retries. A retry is skipped if the thread advances during backoff. Inspect status before acting on a retried thread; independent raw callers must coordinate turn mutations because the server has no atomic expected-id precondition for turn/start. Transport errors do not authorize continuation retries or replaying the original input.

Timeout accepts positive fractional seconds and covers connections/RPCs. It leaves the turn running. Without a timeout there is no overall deadline; transport recovery is bounded to 15 attempts. Wait is read-only with respect to the thread state file. Status/wait cannot recreate notification history missed while no logger was attached.

## Results and the completion inbox

`result <name|threadId> [--turn <id>] [--json]` prints a header line, `name status turnId` plus the failure class for a failed turn, then the complete final agent message of the latest settled turn, or of `--turn`. A newer running turn does not hide the last settled one; the header names the turn. It reads the app-server (`thread/turns/list`, then `thread/items/list` for that turn only). It reads the session's own log only when the server is unreachable or answers that it does not know the thread (`thread not found` or `no rollout found for thread id`); every other server error is reported. Log replay includes the logger's reconnect and recovery records, which carry the status, error, full final message and completion time found by the recovery snapshot. `--json` reports `source: "server"` or `"log"`. As in `wait`, a failure the logger saved for the same turn wins over a history snapshot that lost its error. A failed or interrupted turn still prints the message that exists.

| Exit | Meaning |
| --- | --- |
| 0 | Completed |
| 1 | Failed or interrupted (the message that exists is printed), or a command error |
| 2 | Unknown name, thread ID or turn |
| 3 | Not finished: the requested turn is still running, or no turn has settled yet |

Each settled turn gets one entry in the completion outbox, `CODEX_DRIVE_HOME/outbox/` (default `~/.codex-drive/outbox/`): a small JSON file named `<threadId>-<turnId>.json` with `name`, `threadId`, `turnId`, `cwd`, `status` (`completed`, `failed`, `interrupted`), `failure` (`capacity`, `usageLimit`, `other` or null), `exitCode` (the `wait` contract) and `finishedAt`. It holds no message text, errors or prompts; read content with `result`. `finishedAt` is the server's completion time when known (from the turn, the recovery snapshot or the journal), otherwise the time of recording.

The logger (attached or `--detach`) records each turn it saw running when it settles, so entries appear with no `wait` running. `wait` and `result` record the terminal turn they observe too, which repairs the entry of a logger that died; until one of them runs, a follower does not learn of a turn whose logger died. Recording is idempotent: each entry is written to a temporary file and published with a hard link, which never replaces an existing entry, so racing recorders leave exactly one file and a crash never leaves a partial entry. A failed recording is reported to the session log (or stderr for `wait` and `result`) through a sink that never throws, so it cannot change a command's exit code.

Each recording prunes entries older than 14 days or beyond the newest 2,000 turns by `finishedAt`, with their acknowledgement markers; a repair for a turn already past the age is skipped. Temporary files and orphan markers are removed once they are an hour old. Both limits are adjustable: `CODEX_DRIVE_OUTBOX_MAX_AGE` (a duration such as `30d`) and `CODEX_DRIVE_OUTBOX_MAX_ENTRIES`.

`inbox` prints the entries ordered by `finishedAt`, one JSON line each. `--since 24h` (or an ISO time) limits by `finishedAt`; `--unread` skips acknowledged entries; `--cwd prefix` keeps entries whose worker ran in that directory or below it, as `status --cwd` does; `--ack` acknowledges what it prints by creating an empty `<threadId>-<turnId>.acked` marker beside it. `--follow` takes a baseline scan, starts watching the outbox directory (no polling), then rescans, so nothing published during startup is lost; every later change triggers a rescan, and each entry prints once. Combined with `--unread` or `--since` it prints the matching baseline too. Two followers can both print an entry before either acknowledges it.

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

## Integrating with Claude Code

Start workers detached, follow the outbox from a background task or monitor, and read each result when its line arrives. Nothing depends on a `wait` staying alive, and a new session picks up what finished meanwhile with `inbox --unread`.

```sh
codex-drive start --cwd /path/to/project --name project-task --detach "Do the bounded work"
codex-drive inbox --follow --unread --ack     # background task or monitor: one line per completion
codex-drive result project-task               # on each line: full final message; exit 0/1/2/3
```

In a new or resumed session, run `codex-drive inbox --unread --ack` once to see completions that arrived while no follower ran, then `codex-drive status --active` for the workers still running.

## Server ownership and persistence

The WebSocket endpoint is always `ws://127.0.0.1:<port>`; start/serve default to 4700. `serve` starts a standalone app-server and returns its actual listener PID, or reuses an existing listener. `serve --stop --port PORT` refuses while any server-loaded thread has active status, including approval-waiting threads, listing local names or thread IDs (including threads without local state). Inspection uses metadata-only `thread/read includeTurns:false`; unreadable or unknown status also refuses shutdown. `serve --restart --port PORT` waits up to 30 seconds for idle, then stops and starts on the same port; `--timeout seconds` changes the idle-wait budget. `--force` on stop/restart explicitly permits interruption and lists affected sessions on stderr. Start/resume dispatch and restart share a driver-home/port lock; independent raw clients and other driver homes must coordinate their mutations. `serve --stop --port PORT` targets only that port's verified recorded listener/child and refuses replacement listeners. Startup is serialized within the driver home. Processes are never selected by name. The driver does not alter the shared Codex daemon or configuration. Set `CODEX_HOME` before serve to select the server's histories and authentication.

`serve` checks an existing server’s account against auth identity metadata on disk before reporting health. Start/resume also check before dispatch and warn for mismatches and usage at 90% or more, or when the backend disallows ordinary usage. Warnings do not block dispatch. Detached invocations display these warnings to their caller too. `account` and `rate-limits` print the account, plan, used percentages, reset times in local time and backend ordinary-usage permission (unknown when unavailable). Use `--json` for their original raw results, or `call account/read` / `call account/rateLimits/read`. Percentages and reset times never establish permission to retry.

The checked-in schema exposes `account/read` (without an account ID), usage `accountId` when available, and `account/updated` with auth mode and plan only. It offers login/logout, but no reload-current-auth operation. The driver never logs in, logs out or refreshes tokens for detection. It compares account IDs from usage and auth metadata, falling back to email; unavailable identities are reported as `identityCheck: "unavailable"` by serve. New server metadata records its `CODEX_HOME`; legacy listeners use the caller’s `CODEX_HOME`, so run health checks with the same environment used to launch them. Identity comparisons cannot distinguish accounts when both ID and email are unavailable. Recover with an explicit idle restart, or start a second server on another port with the current auth.

New servers run from the absolute driver state home, so deleting the caller's worktree does not break later configuration loading, resume or adoption. Keep that state home available for the server's lifetime. `serve` and `status` inspect existing listeners too, including older servers without saved cwd metadata. If a listener's working directory has disappeared, they warn on stderr with its port, PID and path; JSON output remains unchanged. They leave the server running. Restart it from a stable directory when its sessions can be safely resumed.

State defaults to `~/.codex-drive`, with private atomic thread files and one attached writer per thread. `CODEX_DRIVE_HOME` relocates it. Logs and pending envelopes contain prompts, agent/command output and request content; keep their location private. A logger rejoins through `thread/resume` after disconnect, immediately reconciles turn metadata and marks the gap. Lost `turn/start` replies are recovered by inspecting the known thread rather than resubmitting input. Unknown outcomes fail clearly. Reconnects cannot guarantee lossless event replay; inspect status if a driver fails, since the server turn may continue.

Wait installs event listeners before resume and uses turn completions as its primary signal. It reconciles immediately after connect/reconnect, then after 1, 2, 4, 8 and at most 10 seconds; continuous notifications cannot postpone that deadline. Reconciliation pages turn metadata with `itemsView:'notLoaded'`, including older pinned targets. The last agent message comes from completed-item events; if missing at settlement, the observer searches only that target turn's items once, newest first. Turn `summary` can omit commentary-phase messages, so it is insufficient as the only source for failed/interrupted turns. Disconnects and request timeouts reconnect with 500–750 ms jitter and the logger's 15-retry budget, without replaying mutations. With `--any`, an observer error is printed without cancelling peers; a settled peer determines the exit code, while all-error remains nonzero.

Attached logger state and raw journal writes flush on turn start/completion, completed agent messages, status/rate-limit updates, errors/warnings and driver diagnostics; other events, including diff updates, flush at most once per second, with a final flush on exit. `lastEventTime` on disk may therefore be up to one second stale. `events --follow` reads appended bytes from its saved offset, preserving partial UTF-8 and JSON records.

`prune [--older-than 30d]` lists old terminal local sessions as JSON and defaults to dry-run. `--apply` takes each session’s writer lock, confirms its current turn is terminal through the saved server, and removes its local state and steer journal. A session that advanced to a different turn after selection is retained. It removes logs only under the driver home’s `logs/` directory when unshared; explicitly supplied external logs are retained. Active writers, running turns and sessions with unknown event age are excluded. Unreachable servers fail clearly without removing that session. Server histories are never archived or deleted. `prune --calls [--older-than 30d]` selects legacy call journals by modification time (a bare number means days), defaults to dry-run, and removes only selected regular `.jsonl` files directly inside the configured state home's `calls/` with `--apply`. It refuses a symlinked `calls/` directory and skips file symlinks and nested directories. Use it when no owners need those journals. New connections create no call journals; existing files are retained until explicitly pruned. Nothing is pruned automatically; server diagnostic logs remain retained.

Local names remain unique within a driver home; collisions fail before starting a turn. Use project-prefixed names (`project-task`) or separate `CODEX_DRIVE_HOME` values for projects; `--cwd` helps select a project’s sessions.

## Verification and limits

```sh
npm test
npm run protocol
npm run proof
node scripts/orchestrator-proof.mjs
node scripts/full-client-proof.mjs
node scripts/server-cwd-proof.mjs
node scripts/account-proof.mjs  # no credentials or model turns
```

`npm test` limits file concurrency to two so subprocess startup does not compete across the entire suite; individual orchestration tests still run concurrent clients. Tests exercise the public CLI against an isolated fake app-server, generated-schema validation, pending-response routing and state persistence. Failure fixtures are checked against the generated notification schemas. The account proof runs an isolated unauthenticated server, checks summaries/health/restart/stop, and uses no model turns. The other native proofs are billable, use `gpt-6.1-sol` at low effort, choose other free ports and isolated homes under `/tmp/codex-drive-proof/`, and stop only resources they started. Temporary authentication copies are removed. The original proofs cover steer, interrupt, resume, detach, timeout and recovery; the full-client proof adds exec adoption, independent forks, an actual approval answered externally, unwrapped calls and event follow. The server-cwd proof deletes the launching directory, checks native resume/adoption and verifies warnings for a legacy listener with a deleted cwd. [PROOF.md](PROOF.md) records inspected results.

Dedicated UX for every protocol method, an interactive terminal prompt UI, realtime audio rendering and external exec/TUI process takeover are deliberately omitted: JSON call/respond and app-server history adoption provide the control surface. There is no live capacity/usage-limit hit requirement; conformant fake failures prove those branches. Tail/events currently scan the log; large-log optimization awaits measurement. Hard-kill cleanup and lossless replay across disconnects are not guaranteed.

Offline efficiency comparison: `node test-support/request-mix.mjs main --regressions` runs five expected-failing regressions against a temporary copy of main, then prints the seven-thread wait request mix before/after. It uses fixture servers and temporary homes only.

Offline journal comparison: `node test-support/journal-mix.mjs 079ce7c --regressions` runs eight expected-failing journal/pruning regressions and an attached-log preservation check against an exported baseline, then prints bytes, files and method counts for wait, logger, short-call, status and serve-health scenarios before/after. All writes and pruning use temporary homes. `node test-support/analyze-calls.mjs /path/to/calls` performs a read-only census of existing journals, emitting aggregate method sizes, timestamp buckets and the six largest files without event payloads. Historical journals lack connection-kind metadata, so attribution to CLI commands requires source tracing or labeled fixture runs.
