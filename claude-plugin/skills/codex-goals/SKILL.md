---
name: codex-goals
description: Drive multi-model workers and reviewers through codex-drive using role-based routing. Use when dispatching or consulting Codex workers on a plan, design, review or goal, running leveled review rounds, steering/resuming/stopping sessions, handling usage limits, or comparing models.
---

# Codex goals

You orchestrate: you write the brief, dispatch by role, verify the result and report. One **goal** is one bounded
piece of work described by one committed **brief**. A worker's report is a claim; check the commits, the checks and
the load-bearing code before you call anything done.

**The repository's `AGENTS.md` wins** over every default here: roles, models, worktree and brief locations, checks,
and what needs the owner.

## Role-based routing

Never hardcode vendor model names in briefs or review prompts. Dispatch by **role** so `roles.json`
(`~/.codex-drive/roles.json` or `.codex-drive/roles.json`) stays the single authority as models change.
Run `codex-drive roles` to inspect the active mapping.

| Role | Purpose | Default style | Dispatch |
|---|---|---|---|
| `architect` | Plan, architecture, direction notes, high-stakes review (read-only) | goal-driven | `codex-drive start --role architect` |
| `reviewer` | Fast, high-recall read-only code review lenses | goal-driven | `codex-drive review` or `--role reviewer` |
| `design-reviewer` | Pre-implementation design & direction review (read-only) | goal-driven | `codex-drive review --kind design` |
| `implementer` | Complex, logic-heavy implementation (state, concurrency, persistence) | goal-driven | `codex-drive start --role implementer` |
| `mechanical` | Bounded renames, codemods, bulk updates | prescriptive | `codex-drive start --role mechanical` |
| `mapper` | Read-only codebase mapping, ownership and dependency tracing | goal-driven | `codex-drive start --role mapper` |
| `tester` | Adversarial failing-test prover for blocking review findings | goal-driven | `codex-drive start --role tester` |
| `generalist` | Cross-cutting review & UI/UX implementation | goal-driven | Claude Agent tool / `review` |
| `slice` | Well-defined slice fully checked by tests or lint | prescriptive | Configured slice CLI |

Always report the model and effort that actually ran, not the one you intended.

## The loop

1. **Direction (for medium/large changes, recurring bug areas, or production defects).** Write a one-page direction
   note before design or code: root cause, owning authority, general rule, what it deletes, what it adds. Review it
   with `codex-drive review --kind design`.
2. **Brief.** One committed brief per goal on the worker's branch. Read [briefs.md](briefs.md) before writing one.
3. **Dispatch.**
   ```sh
   codex-drive serve                                   # once per machine session; reuses a running server
   codex-drive rate-limits                             # before a large dispatch
   codex-drive start --role implementer --name <project>-<slug> --cwd <abs-worktree> --detach \
     "Read <brief path> fully and execute it. It is the authoritative brief. Stop where it says stop."
   ```
   `--role` sets model, effort and sandbox from `roles.json` (explicit `--model`/`--effort`/`--sandbox` override).
   `start --detach` prints `{threadId,turnId}`; record the thread ID in the goal record. Prefix names per project.
4. **Receive completion.**
   - **Preferred (with the Claude Code plugin):** do not hold a `wait` open. The plugin's background monitor streams
     each completion into the session automatically; `SessionStart` catches completions after a restart or crash.
   - **Manual / batch fallback:** run `codex-drive wait <name> --timeout <seconds>` (or `wait a b c --any`) with
     `run_in_background: true`. Never `sleep`, poll a log, or write a `pgrep` loop. Keep `wait`'s exit code (never
     pipe it): `0` completed, `1` failed, `75` capacity, `76` usage limit, `124` timeout, `130` interrupted.
5. **Read the result** with `codex-drive result <name> --turn <id>` (exits `0` completed, `1` failed/interrupted,
   `2` unknown, `3` still running). Never tail logs for results. Then verify: commits since the brief, the brief's
   `## Outcome`, and the project's checks.
6. **Leveled review.** Run `codex-drive review --worktree <dir> --base <rev> --head <rev> --brief <path> --name <prefix> --kind handoff`
   (reads `Level:` from the brief, or pass `--level 0|1|2|3`). Send all accepted findings to the implementer in one
   fix round, then re-review with `--kind rereview --previous <run-dir>`. Repeat until clean; cap at 3 rounds before
   changing the plan or escalating to the owner.
7. **Fix findings on the same thread**, never a new session:
   `codex-drive steer <name> "<correction>"` while running, or
   `codex-drive resume <name> --detach "<findings and what to fix>"` after it settles.
8. **Check lanes & report.** Run `codex-drive lanes` to spot stalled worktrees. Report to the owner at each goal
   boundary, outcome first, stating which of **committed, integrated, tested, deployed** applies.

## Standing rules

- **Capacity is not a stop.** Exit `75` means retry with backoff inside the goal's budget (`--retry-capacity 5` on
  `start`/`resume`). Report it only when the budget runs out.
- **A usage limit pauses everything.** On exit `76` dispatch nothing more on that account; see [operations.md](operations.md).
- **No `git stash` across worktrees.** Commit WIP on your branch instead (`codex-drive hook stash-guard` enforces this).
- **Headless.** Never steal focus or open windows during tests or prototypes.
- **Shell & edits.** Quote globs in zsh (`'*.md'`, `--name 'goal-*'`); use structured edit tools instead of `sed -i`
  or heredoc scripts.

## References

- [briefs.md](briefs.md): writing briefs and review prompts per autonomy tier.
- [operations.md](operations.md): non-zero exits, stalls, usage limits, account switches and session adoption.
- [parallel.md](parallel.md): parallel worktrees, pilot-before-fan-out and lane health.
- [model-trials.md](model-trials.md): blind A/B comparisons across models or effort levels.
