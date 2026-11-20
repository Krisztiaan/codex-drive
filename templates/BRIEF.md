# <Goal title: what changes for the user or operator>

**Status:** active goal, YYYY-MM-DD.
**Worktree:** `.worktrees/<slug>`, branch `<type>/<slug>`, base `<commit>`.
**Level:** `<0, 1, 2 or 3 — read by codex-drive review>`

## Goal

<The problem as the user sees it, and the observable outcome. One or two short paragraphs.>

## Decided

<Quote applicable owner rulings verbatim, with dates, including in resumes. Workers apply these without stopping.>

## Scope

- <Each deliverable, with its owning module and contract.>

## Out of scope

- <Each adjacent excluded item and its tracking issue, so reviewers do not grade against it.>

## Owners and files

<Owning modules, tests, and shared files with named owners (when running in parallel).>

## Direction and design

<Required for medium/large changes, recurring bug areas, or security/persistence/schema changes:
one-sentence invariant, general rule, what is deleted and added, mechanical git-grep caller inventory,
and acceptance tests including refusals and recovery.>

## Recovery and race matrix

<If stateful/concurrent: name concrete artifacts, writers, crashes, replays, and expected recovery.>

## Done

- Tests at stable boundaries (including denied side effects, recovery, and idempotency/replay).
- For bug fixes, demonstrate the regression test fails with the fix reverted.
- Run touched-area checks (never full suites unless explicitly asked).
- Commit work on the assigned branch; never `git stash`; never poll with `sleep` or `pgrep`.
- Append `## Outcome` below and commit before hand-off.
- Run `codex-drive review` at the declared `Level:` until clean (3-round convergence cap).

## Outcome

<Written by the worker: what changed by scope item, checks actually run, deviations, and open items.
Each fix round appends `### Review fix round N`.>
