# Live acceptance proof

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
