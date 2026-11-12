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

## Outcome

Completed on `goal/calls-journal`. Implicit call journaling is removed; new connections add **zero bytes and zero files** to
`calls/`. Attached thread logs retain their full raw stream. Legacy calls remain available for the orchestrator's reviewed
cleanup. No real journal was deleted, moved or rewritten; no live app-server was contacted or signalled. Stop here with commits
only: do not merge, push or begin another goal.

### Read-only verification

Source: `node test-support/analyze-calls.mjs /Users/krisztiaan/.codex-drive/calls`, run against the real directory on 2026-11-12
before the implementation. It enumerated regular `.jsonl` files, measured their sizes, and parsed their records without emitting
payloads. This is a live directory census, not an atomic snapshot: files created after enumeration are excluded and existing
files may change during reading. There were **146,584 files, 8,244,072,054 bytes (8.244 decimal GB), median 396 bytes**.
The parser counted 5,721,621 valid records / 8,243,644,451 record bytes and 186 malformed lines. Method-byte totals below include
the `receivedAt` envelope and newline, excluding malformed lines; they are not protocol wire bytes. The 427,603-byte difference
from enumerated file sizes is not assigned to methods. Malformed historical records were left untouched.

| Method | All-file records | All-file bytes | Six-largest records | Six-largest bytes |
| --- | ---: | ---: | ---: | ---: |
| `turn/diff/updated` | 65,521 | 3,100,276,322 | 8,933 | 1,342,487,650 |
| `item/completed` | 508,389 | 2,588,173,487 | 42,398 | 215,577,274 |
| `item/started` | 508,335 | 620,406,321 | 42,407 | 51,345,279 |
| `item/agentMessage/delta` | 2,987,706 | 884,274,854 | 249,561 | 73,853,633 |
| `item/commandExecution/outputDelta` | 210,229 | 418,683,924 | 11,397 | 25,761,338 |
| `thread/tokenUsage/updated` | 240,628 | 136,398,090 | 19,448 | 11,036,917 |

The brief's six-file diff count and size are correct. Those six total **1,757,544,081 bytes**, so their diff share is
`1,342,487,650 / 1,757,544,081 = 76.38%`, rather than exactly 80%. The whole-directory diff share is only
`3,100,276,322 / 8,244,072,054 = 37.61%`; completed items and deltas are substantial outside the largest-file sample.
The largest file is 888,583,956 bytes, with 1,287 diff updates consuming 866,218,790 bytes, confirming that claim. Five of the six
span 3.98–4.00 hours between first and last received records; the 172,492,417-byte file spans **5.97 hours**. These spans measure
observed events, not socket lifetimes. The six sizes are 888,583,956; 199,221,747; 192,092,040; 172,713,584; 172,492,417;
132,440,337 bytes.

**145,418 files / 51,820,222 bytes** contain only the four ambient methods named in the brief. Another 347 files containing
diff updates account for 7,462,094,723 bytes; the remaining 819 files account for 730,157,109 bytes. These are event signatures,
not connection kinds. Historical calls contain neither originating CLI commands nor observer/logger role markers, and no
production reader maps them back to those roles. Exact historical bytes split by wait/call/status/serve cannot be recovered
from this evidence. The labeled fixture below supplies that attribution without guessing from payloads.

First-record UTC hour buckets demonstrate the file churn: 1,272–1,280 files/hour throughout 2026-11-09 00:00–06:59;
2,349 during 2026-11-12 20:00–20:59; and 5,424 during 2026-11-12 02:00–02:59. These are directory-wide observations, not an
identified orchestration session or a measured post-merge rate. Source tracing explains the multiplication:

- A wait uses one `connection()` per thread and another on each reconnect. At `079ce7c`, its six delta opt-outs leave
  `turn/diff/updated` enabled, and the journal's `turn/*` predicate accepts every cumulative diff (also moderation metadata).
  Completed agent messages can still be large even after excluding diffs.
- Ordinary calls, aliases, steer/interrupt, status and serve inspection/health use `connection()` with its former default
  per-UUID journal. They record every notification received before closure, even during initialization. Generic
  `call thread/resume` can receive a large replay; short calls typically receive only ambient records. A new connection with
  no events creates the old `calls/` directory but no actual file until its first append.
- Status opens one connection per saved thread, even when the server and usage lookup are shared. Serve opens one per health
  check or active-thread inspection pass; repeated restart inspection can therefore create repeated files.
- The attached logger itself uses `new Rpc()` and the explicit thread log, **not** `connection()` and `calls/`. Detached
  start/resume add a separate parent health connection; that preflight previously could create an ambient calls file.

For a concrete cadence model, invoking seven-thread wait and seven-thread status once per minute formerly allowed
`(7 + 7) * 60 = 840` new files/hour, plus raw calls, preflights and reconnects, if every connection received an event.
This is a source-derived illustration, not a measured "typical session" rate. The historical data cannot identify such a
session precisely. With this change all of those implicit call-journal contributions are zero.

### Decision and implementation

- Removed the default raw journal from `connection()`. Repository search found no production reader of `calls/` except the
  explicit pruning path. Errors still reach the CLI, and `RequestBroker` still persists pending envelopes, announces requests,
  routes replies, handles policies and rejects outstanding requests on close. Existing request/recovery tests remain green.
  There is no new env switch, rotating file or opt-in journal mode to maintain: attached `--log` collection already exists.
- Added `turn/diff/updated` to the wait-only notification opt-out constant. `applyEvent`, completion capture and final-message
  recovery do not consume diff contents. Generic initialization overrides and attached logger subscriptions are unchanged.
  Tightened `lifecycleEvent` to actual turn start/completion rather than every `turn/*` notification, so diffs no longer force
  immediate logger appends or state saves. They remain in the raw attached log and flush with other buffered traffic within
  one second or at graceful exit. No tail/events/status consumer reads call journals or depends on diff-triggered state saves.
- Kept explicit age-based `prune --calls` for legacy cleanup, with its 30-day default, bare-days support and dry-run default.
  It now refuses a linked/non-directory `calls/`, skips file links (including dangling links), directories and non-JSONL files,
  and only removes eligible regular entries immediately beneath the configured home's canonical `calls/`. A synchronous helper
  pins that directory as cwd and verifies its identity before each entry; relative unlink cannot traverse a replacement parent
  symlink. Cwd is restored on success/error. The directory-replacement regression verifies refusal and preservation of both
  the original files and the linked target. All pruning tests used temporary homes.
- Chose no automatic deletion: eliminating the writer bounds new journal growth at zero without scanning 146k existing files
  on every invocation. A shared daily/per-process journal would still duplicate unnecessary data, require rotation and retain
  sensitive event payloads. The old backlog is intentionally left for orchestrator review.
- Updated README's connection, opt-out, buffering, legacy prune and offline measurement descriptions. Fixture support now
  emits initialization traffic and encodes 64-bit WebSocket frame lengths so the tests can exercise cumulative diffs over 64 KB.
  Replaced one regression's incidental calls-file synchronization with direct observation of delivered RPC completions; its
  reconnect and capacity-error assertions remain intact.

### Before/after fixture measurement

Source: `node test-support/journal-mix.mjs 079ce7c --regressions`. It exports baseline source into a temporary directory and
uses ephemeral fixture ports and temporary homes for both versions. No checkout, process, real log or protocol file is modified.
Baseline `079ce7c` already includes the efficiency merge. Each streaming scenario emits eight growing diffs of
`n * 16,384` characters (`n=1..8`), eight 1-KB text deltas, started/completed command items, token updates and a final completed
agent message/turn. Initialization emits the four ambient notifications. All scenarios exit successfully with their expected
outputs. Attached-log volume is captured before the subsequent read-only `events`, `tail` and status checks.

| Scenario | Before calls bytes / files | After calls bytes / files | Explicit thread log before → after |
| --- | ---: | ---: | --- |
| One wait, streaming traffic | 591,425 / 1 | 0 / 0 | none → none |
| One attached logger, same traffic | 0 / 0 | 0 / 0 | 613,452 bytes / 1 file → identical |
| 20 short `call model/list` commands | 8,800 / 20 | 0 / 0 | none → none |
| Five single-thread status checks | 2,200 / 5 | 0 / 0 | none → none |
| Five existing-server serve-health checks | 2,200 / 5 | 0 / 0 | none → none |

The baseline wait writes eight diff records / 590,880 bytes plus a rate-limit event and final message/completion.
The explicit logger retains **every method count and byte count** across versions, including eight diffs / 590,880 bytes,
eight deltas / 9,304 bytes, eight started items, nine completed items, eight token updates and the final turn completion.
`events` exposes all eight diffs/deltas, `tail` includes the final message, and status reports that same message. These are
fixture storage measurements, not production CPU, throughput, wire-byte, memory or latency-distribution results.

### Validation and limits

- Full `npm test`: **153 passed, 0 failed**, Node 26.13.0, required file concurrency 2. Focused calls/efficiency run: 25 passed.
- Baseline proof: the new calls-journal suite reports **8 expected failures / 1 pass** against exported `079ce7c`; the pass is
  attached-log preservation, which intentionally already worked. Failures cover wait/call/status/serve growth, diff opt-out,
  one-shot request handling without a journal and safe legacy pruning. The current suite passes those cases.
- `npm ci` installed local worktree dependencies; tests had initially resolved the parent checkout's dependencies. The first
  exported-source comparison consequently could not resolve Ajv and was discarded; the completed comparison above ran with
  the worktree installation. npm reported one moderate dependency vulnerability; dependency upgrades are outside this goal.
- `git diff --check` passed. No protocol regeneration or live proof was run; `npm run proof` starts a live, billable app-server
  and is outside the fixture-only boundary.
- Existing calls consume their original disk space until the orchestrator explicitly prunes them. Long-running processes
  already loaded from the main checkout keep their old behavior; this worktree was neither merged nor deployed. Explicit thread
  logs remain intentionally unbounded and can still contain large diffs/items. No server-side storage, connection-sharing,
  historical corruption, unrelated pruning or dependency issue was changed.
