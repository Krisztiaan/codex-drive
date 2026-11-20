---
name: bounded-handoff
description: "For the parent or integrating agent only: design or revise a long-running goal prompt, prepare a campaign handoff, or split authorized work across subagents. Not for a worker carrying out an assignment it was given."
---

# Bounded handoff

Use the repository's existing tracker and authority; do not create a second task ledger. Respect any prohibition on delegation or cross-thread writes.

## Expand only when needed

- **Designing or revising a long-running goal prompt:** read [references/goal-design.md](references/goal-design.md) and use only that workflow. Do not load it for routine delegation.
- **Active role-to-model mapping:** run `codex-drive roles` (or inspect `~/.codex/agents/*.toml`).

## Assignment (minimum needed context)

Supply only:
- Outcome, acceptance criteria, current rulings (`Decided`) and explicit exclusions (`Out of scope`).
- Owned files/domain; shared files requiring integration-owner approval.
- Agreed validation lane/build owner and return format (changed files, checks run, blockers).

Delegate only when independent work remains for the parent and coordination pays off. One integrator owns shared interfaces and final acceptance.

## Routing

Honor user choices and repo presets. Choose roles by capability (`code_mapper`, `mechanical_worker`, `risk_reviewer`) rather than duplicating model names here; raise effort for concrete reasoning need, not duration. Keep an agent for a coherent domain; start fresh when the assignment shifts or old history dominates. Never claim a preset applied if overrides were unavailable.

## Integration & handoff

- Keep verbose logs out of parent context; link evidence at source.
- Separate worker briefs (ownership, constraints, done), integrator handoffs (diff, evidence, blockers), and human summaries (purpose, consequential decisions, verification limits).
- Review the combined diff before relying on it; schedule shared builds through one owner; never `git stash` across worktrees or kill another lane's processes.
- Record state cleanly at handoff: distinguish **implemented, verified, blocked, deferred**.
- For model/prompt trials, hold task, snapshot, tools, effort and acceptance constant; judge correctness and rework before elapsed time or usage.
