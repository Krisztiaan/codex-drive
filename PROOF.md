# Live acceptance proof

The latest verification is the [2026-09-30 orchestration follow-up](#2026-09-30-orchestration-follow-up) below. The first section preserves the original 2026-09-29 evidence.

Run date: 2026-09-29T19:47:07.404Z. Runtime: Node v26.8.2, codex-cli 0.159.0, requested model `gpt-6.1-sol`, effort `low`. The server returned the requested model; no model-reroute notification was logged. All goal work ran in fresh subdirectories of `/tmp/codex-drive-proof/run-r9zC52` with explicit `danger-full-access` and approval `never`.

The exact prompt for both loops was:

> Repeat 8 times: run `sleep 15; date`, then write `tick N`. When done, say FINISHED.

Commands:

```sh
npm test
node scripts/proof.mjs
```

The integration script runs `serve`, attached `start`, `steer` after tick 2, `status`, `resume`, a separate `start` and `interrupt` after tick 2, then `serve --stop`. It supplies a fresh ephemeral loopback port, isolated state/Codex homes, and private authentication copied only for the run. The copy is removed after server shutdown. Local `AGENTS.md` instructions preserve the brief boundaries while keeping the exact user prompt. Assertions reject process-name matching commands. No shared daemon or Codex configuration is modified.

| Check | Observed result |
| --- | --- |
| Steering | Agent emitted ticks 1 and 2, then `STEERED-OK`; completed. 3 of the requested 8 sleep commands started, so it stopped early. |
| Interrupt | Agent emitted ticks 1 and 2; server reported `interrupted`; attached CLI exited 130. 2 of 8 sleep commands started. |
| Resume | Same thread, different turn; agent wrote `RESUMED-OK`; completed. |
| Connection recovery | Accepted `turn/start` response deliberately dropped; known thread rejoined without replay. A second disconnect after tick 1 rejoined the same running turn. |
| Concurrent serve | Two invocations produced one server owner; the other reused the listener or failed clearly on its startup lock. |
| Finished-thread steering | Failed nonzero with `No turn is running`. |
| ID lookup | Status by thread ID resolved the named thread. |
| Process selection | Observed commands contain no `pkill`, `killall`, or `pgrep`; only the requested loop commands ran. |
| Unit tests | 21 passed, 0 failed (`npm test`): argument parsing, state persistence, event reduction, locks. |
| Cleanup | Native listener PID 52700 on port 53341 stopped; `serve --stop` verified the port no longer listened. |

Thread and turn IDs:

- Steering thread: `01a0eeb4-e715-7843-8d69-b0c445bc752e`; turn: `01a0eeb4-e91c-7a21-b6cf-639f742a3cea`.
- Resume turn on the same thread: `01a0eeb5-e594-7a02-af4e-6e0fe4677f44`.
- Interrupt thread: `01a0eeb5-f798-7020-95ba-e4d051cdac5a`; turn: `01a0eeb5-f80b-79e1-8d17-e492bd1256ad`.

Inspected steering log sequence (local receipt timestamps):

```text
2026-09-29T19:47:08.712Z driver/startUncertain
2026-09-29T19:47:09.227Z driver/startRecovered 01a0eeb4-e91c-7a21-b6cf-639f742a3cea
2026-09-29T19:47:33.550Z agent: tick 1
2026-09-29T19:47:33.647Z driver/disconnected
2026-09-29T19:47:34.425Z driver/reconnected 01a0eeb4-e91c-7a21-b6cf-639f742a3cea
2026-09-29T19:47:52.558Z agent: tick 2
2026-09-29T19:48:10.701Z agent: STEERED-OK
2026-09-29T19:48:11.086Z turn/completed: completed (01a0eeb4-e91c-7a21-b6cf-639f742a3cea)
2026-09-29T19:48:17.132Z agent: RESUMED-OK
2026-09-29T19:48:17.159Z turn/completed: completed (01a0eeb5-e594-7a02-af4e-6e0fe4677f44)
```

[Steering/resume event extract](evidence/steer.jsonl), [interrupt event extract](evidence/interrupt.jsonl), and [run summary](evidence/summary.json) retain the raw server event fields and receipt times needed to inspect these conclusions. Sleep-command counts use unique command item IDs for the exact `sleep 15; date` invocation; those IDs are recorded in the summary. The complete original JSONL logs remain in the run directory above. The extracts include command starts/completions and agent messages; they contain no authentication material.

A command already in progress after tick 2 may finish before steering is handled; the agent emitted no tick 3 in this run. Connection gaps are recorded explicitly; missed notifications are not claimed to have been replayed. These results prove this CLI/protocol combination on the tested runtime, not guaranteed model compliance for arbitrary prompts.

## 2026-09-30 orchestration follow-up

Implementation baseline: `b7c126e`, followed by this commit's changes. Node v26.8.2 and codex-cli 0.159.0. All checks used temporary state and isolated Codex homes under `/tmp/codex-drive-proof/`. No client connected to the live server on port 4700, and no shared driver state file was read or changed. `gate-speed` was excluded entirely.

Each functional change began with a failing behavior test, then implementation and a passing check:

| Regression | Observed red result | Passing behavior |
| --- | --- | --- |
| Resume message | `PREVIOUS` returned instead of `null` | Only the current turn's message or null; legacy state still readable. |
| Wait | Returned while the backend turn still ran | Rejoins without a logger, prints final JSON, returns 0/1/130 for completed/failed/interrupted. |
| Timeout | `--timeout` rejected; exited 1 | Exits 124 with `timedOut: true`, cancels outstanding RPCs, leaves the turn running. |
| Reconnected wait | Timed out or followed a newer turn | Pins the original turn across disconnects and paginated history containing 25 newer turns. |
| Detach | `--detach` rejected | Detached start/resume return ready IDs, while status, wait, steer and interrupt continue to work. |
| Detached warning | Invoking stderr was empty | Full-access warning appears on stderr; child diagnostics remain JSONL. |
| Alias collision | Creating a name matching another thread ID succeeded | Rejects shadowing; canonical IDs take precedence for existing files. |
| Fast lost start reply | Logger still ran after recovered completion | Recovered terminal snapshot cannot be rewound by older buffered events. |
| Concurrent initial state | Reader saw `Unexpected end of JSON input` | Readers see absent or complete state; duplicate protection remains. |
| Partial log append | Tail failed on an unterminated final row | Ignores only unfinished trailing data; complete corrupt rows still fail. |
| Port override | Status silently succeeded on another saved port | Mismatches fail before connecting. |
| Wait event time | Returned cached `OLD` time | Returned JSON includes receipt time of observed selected-thread events, without state writes. |
| Help/PATH | Help failed; installer was absent | Help works from another directory; installation is repeatable and refuses foreign occupants. |

Final checks: `npm test` **36 passed, 0 failed**; `git diff --check` passed. CLI tests use a controllable WebSocket app-server boundary and real subprocesses/files. The state-creation race uses concurrent writer/reader processes. These tests are separate from native model acceptance.

```sh
npm test
node scripts/proof.mjs
node scripts/orchestrator-proof.mjs
node scripts/install.mjs
# From /tmp/codex-drive-proof/:
command -v codex-drive
codex-drive --help
```

The original exact `sleep 15; date` proof passed on port **64977**: steering after tick 2 produced `STEERED-OK` and completed after 3 unique loop-command items; interrupt after tick 2 reported interrupted after 2 unique loop-command items; resume produced `RESUMED-OK`. It also recovered an accepted start with a dropped reply and a disconnect after tick 1. Full logs: `/tmp/codex-drive-proof/run-gKj0DY`. [Summary](evidence/2026-09-30-summary.json), [steering/resume extract](evidence/2026-09-30-steer.jsonl), [interrupt extract](evidence/2026-09-30-interrupt.jsonl). Counts use unique IDs for the exact loop command, recorded in the summary.

The final orchestrator proof passed on port **59980**. Detached start returned before the loop completed; status showed running with a null current message; a 0.2-second wait exited 124 without interruption. Steering after tick 2 produced `DETACHED-STEERED-OK`, and a concurrent wait exited 0 with fresh event time. Detached resume reused the thread, changed the turn, and initially reported a null message. Interrupt produced status interrupted and wait exit 130. A further turn continued after its attached logger was explicitly stopped; a separate wait then rejoined and returned `NO-LOGGER-OK`, exit 0. Detached full-access stderr warnings were checked. Full logs: `/tmp/codex-drive-proof/orchestrator-aa2fnG`. [Command/status summary](evidence/orchestrator-summary.json), [detached event extract](evidence/orchestrator.jsonl).

The first orchestrator run also passed at `/tmp/codex-drive-proof/orchestrator-0LE2hs` (port 61856); the final rerun above adds the warning and event-time assertions. Both isolated servers and the original-proof server were stopped by their recorded native PIDs, and temporary authentication copies were removed. No process-name selection was used.

PATH installation resolves `/Users/krisztiaan/.local/bin/codex-drive` to `/Users/krisztiaan/dev/codex-drive/src/cli.mjs`. The actual installed command printed usage and exited 0 from another directory, without requiring a server. Unit installation checks additionally preserve existing regular files, directories, foreign links and broken links.

Deliberately unchanged: aggregate status fails if any saved server is unreachable; tail scans the whole log; connection gaps do not promise lossless replay; approvals remain noninteractive. The concurrent, unrelated `GOAL-2.md` is left unmodified and uncommitted.
