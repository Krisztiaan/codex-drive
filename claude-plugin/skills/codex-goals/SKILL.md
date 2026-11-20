---
name: codex-goals
description: Drive multi-model workers and reviewers through codex-drive using role-based routing. Use when dispatching or consulting Codex workers on a plan, design, review or goal, running leveled review rounds, steering/resuming/stopping sessions, handling usage limits, or comparing models.
---

# Codex goals

Orchestrate bounded goals: write one committed brief, dispatch by role, verify commits/checks/code, report outcome first. A worker's report is a claim, not proof. **The repository's `AGENTS.md` wins** over every default here.

## Roles (`codex-drive roles`)

Dispatch by **role** so `roles.json` (`~/.codex-drive/roles.json` or `.codex-drive/roles.json`) stays the single authority as models evolve. Never hardcode vendor model names in briefs or review prompts.

| Role | Use for | Style | Dispatch |
|---|---|---|---|
| `architect` | Plan, direction, high-stakes review (read-only) | goal-driven | `codex-drive start --role architect` |
| `reviewer` | Narrow read-only review lenses | goal-driven | `codex-drive review` / `--role reviewer` |
| `design-reviewer` | Pre-implementation design review (read-only) | goal-driven | `codex-drive review --kind design` |
| `implementer` | Logic-heavy code (state, concurrency, persistence) | goal-driven | `codex-drive start --role implementer` |
| `mechanical` | Bounded renames, codemods, bulk edits | prescriptive | `codex-drive start --role mechanical` |
| `mapper` | Read-only codebase/ownership mapping | goal-driven | `codex-drive start --role mapper` |
| `tester` | Adversarial failing-test prover | goal-driven | `codex-drive start --role tester` |
| `generalist` | Cross-cutting review & UI/UX | goal-driven | Claude Agent / `review` |
| `slice` | Well-defined slice fully checked by tests/lint | prescriptive | Configured slice CLI |

Report the model and effort that actually ran, not the one intended.

## Loop

1. **Direction** (medium/large, recurring bug area, production defect): 1-page note → `codex-drive review --kind design`.
2. **Brief:** commit one brief on the worker's branch (`Level: 0..3`, `Decided`, `Out of scope`, `Done`).
3. **Dispatch:** `codex-drive serve` (once), `codex-drive rate-limits` (before fan-out), then:
   ```sh
   codex-drive start --role implementer --name <proj>-<slug> --cwd <worktree> --detach \
     "Read <brief> fully and execute it. Stop where it says stop."
   ```
4. **Collect:** with the plugin, completions arrive automatically via the monitor; otherwise run `codex-drive wait <name> --timeout <s>` in the background (never `sleep`, `until`, or `pgrep` loops; never pipe `wait`). Read full output with `codex-drive result <name> --turn <id>`.
5. **Review & fix:** `codex-drive review --kind handoff` → send all findings in one `steer` (running) or `resume --detach` (settled) on the **same thread** → `--kind rereview --previous <run-dir>`. Cap at 3 rounds before changing the plan.
6. **Health & report:** check `codex-drive lanes`; report outcome first and state **committed / integrated / tested / deployed**.

## Standing rules

- Exit `75` (capacity) → retry with `--retry-capacity 5`; exit `76` (usage limit) → pause account immediately, never retry.
- Never `git stash` across worktrees (commit WIP instead); run all tests/prototypes headless; quote zsh globs.

## Expand only when needed

| Need | Read |
|---|---|
| Writing/fixing a brief or review prompt | [briefs.md](briefs.md) |
| Non-zero exit, stall, usage limit, account switch, `adopt` | [operations.md](operations.md) |
| Running parallel worktrees / pilot-before-fan-out | [parallel.md](parallel.md) |
| Blind A/B model or effort comparison | [model-trials.md](model-trials.md) |
| Exact CLI flags for any subcommand | `codex-drive help <turns\|inbox\|review\|roles\|lanes\|hooks\|server>` |
