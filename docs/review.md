# Leveled independent review (`codex-drive review`)

Runs a read-only multi-model review ensemble over a git diff and brief, combining a zero-model mechanical pre-pass with narrow specialized lenses.

## Usage

```sh
codex-drive review --worktree .worktrees/feat --base main --head HEAD \
  --brief docs/goals/feat.md --name proj-feat --kind handoff --level 2

codex-drive review --worktree .worktrees/feat --base main --head HEAD \
  --brief docs/goals/feat.md --name proj-feat --kind rereview --previous <run-dir>

codex-drive review --worktree .worktrees/feat --base main --head HEAD \
  --brief docs/goals/feat.md --name proj-feat --kind design
```

## Levels

Declared via `--level` or a `Level: <0-3>` line in the brief:

| Level | Scope | Reviewers |
|---|---|---|
| `0` | Docs, mechanical moves, generated files | Gate only (`--record` adds `record` lens) |
| `1` | Presentation: templates, copy, styles, wiring | `generalist` |
| `2` | Behaviour: workers, timers, flows, APIs | `generalist` + `state` + `tests` |
| `3` | Security, custody, permissions, persistence, schema | `generalist` + all 5 lenses (`state`, `invariants`, `inventory`, `tests`, `record`) |
| `design` | Pre-implementation design/direction notes (`--kind design`) | `design-reviewer` + `generalist` |

Models and effort resolve from `roles.json` (`generalist`, `reviewer`, `design-reviewer`). Pass `--codex-only` to route `generalist` through the `architect` Codex role instead of Claude Code.

## How it works

1. **Mechanical pre-pass (no model):** writes `change.diff` and `mechanical.md` (changed symbols + `git grep` references) into `$XDG_STATE_HOME/codex-drive/reviews/<run>/`.
2. **Parallel read-only reviewers:** each reviewer outputs ranked `**P1**`/`**P2**`/`**P3**` findings, a `READ LEDGER` of opened file ranges, and a strict two-line trailer (`FINDINGS P1=.. P2=.. P3=..` / `VERDICT: merge|fix first`).
3. **Rule-based verdict:** merges overlapping findings within 5 lines, checks that the worktree did not mutate mid-run, and verifies every changed file appears in the read ledgers.
4. **Custom repo prompts:** place `REVIEW-PROMPT.md` and/or `lenses/*.md` under `<repo>/.codex-drive/review/` to override the built-in [review-prompts/](../review-prompts/).

## Exit codes

`0` merge · `1` fix first · `2` usage error · `3` incomplete reviewer output · `4` void (worktree changed during review) · `5` insufficient reading · `75` capacity/usage limit · `124` timeout · `130` interrupted.
