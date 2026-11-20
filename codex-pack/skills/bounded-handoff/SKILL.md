---
name: bounded-handoff
description: "For the parent or integrating agent only: design or revise a long-running goal prompt, prepare a campaign handoff, or split authorized work across subagents. Not for a worker carrying out an assignment it was given."
---

# Bounded handoff

Use the existing tracker and current repository authority; this is not a new planning system. Respect any prohibition on delegation or interaction with other threads.

For goal-prompt design or revision, read [Goal design](references/goal-design.md) and use only that workflow. For handoffs or authorized delegation, use the sections below. Do not load the goal reference for routine implementation.

## Assignment

Supply only what the worker needs:
- Outcome and acceptance criteria.
- Current decisions, explicit exclusions and relevant authority paths.
- Owned files or domain; shared files requiring integration-owner approval.
- Dependencies and agreed validation lane/build owner.
- Return format: findings or changed files, checks and evidence, unresolved blocker.

Delegate only when independent useful work remains for the parent and coordination will plausibly pay off. The integrator owns shared interfaces, integration and final acceptance. Do not fan out merely to fill slots.

## Routing

Honor explicit user choices and repository presets. Select roles by the assignment: mapping (`code_mapper`), bounded mechanical implementation (`mechanical_worker`), or independent risk review (`risk_reviewer`). Use the active role definitions or `roles.json` (`codex-drive roles`) for model and effort rather than duplicating model names here; raise effort for a concrete reasoning need, not task duration alone.

Use named roles only if the active tool schema supports them. Otherwise read the selected preset under `~/.codex/agents/` and pass its model, effort and bounded instructions through supported spawn fields. If overrides are unavailable, report the limitation instead of claiming the preset applied. Parent runtime overrides can supersede role permissions; a role name is not an isolation guarantee.

Keep an agent for a coherent domain; start fresh when its assignment materially changes or completed-work history dominates. Do not fork an entire campaign transcript by default. Do not interrupt or replace running agents merely to apply updated presets.

## Integration and handoff

Communicate completion, blockers and interface changes. Avoid repeated status requests. Keep detailed logs outside the parent context and link evidence at its source.

Separate execution handoffs from human review briefs. The worker needs ownership, constraints and acceptance criteria; the integrator needs changes, evidence and blockers; the human reviewer needs purpose, consequential decisions and verification limits. Carry forward detail that affects the next decision and link the rest. These distinctions do not add approval gates or authorize external actions.

Review the combined diff, including mechanical-worker output. Schedule shared builds through one owner; use worktrees only from an authorized, understood checkpoint, preserving dirty work. Never silently transfer another worker's files or kill its processes.

At handoff, record current state, next action and evidence in the existing authorized tracker or handoff location; distinguish implemented, verified, blocked and deliberately deferred. Updating an external issue requires authorization covering that write. Do not create a second task ledger.

For model or prompt comparisons, hold task, source snapshot, tools, effort and acceptance criteria constant where possible. Judge correctness and rework before elapsed time or usage. Use isolated authorized work; do not benchmark against a live dirty campaign or claim gains from prompt size alone.
