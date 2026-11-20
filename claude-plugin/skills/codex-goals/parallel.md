# Parallel goals

Run goals in parallel only when each slice is bounded and its dependencies are already merged.

- **One worktree per goal**, inside `.worktrees/<name>` (gitignored) — never sibling directories next to the repo,
  never two writers in one tree. Dispatch with `--cwd <worktree>` and state the worktree path and branch at the top
  of the brief. Reviewers read the same worktree read-only.
- **Pilot before fan-out.** One worker proves the pattern and records the recipe in its `## Outcome`; only then
  dispatch the remaining lanes in parallel, linking the pilot's Outcome.
- **No shared files without a named owner.** Commit shared seams (types, stubs, registries) on the base branch before
  splitting. When sharing is unavoidable, name the files, keep edits local, and plan one integration step.
- **No `git stash`.** `refs/stash` is shared across all worktrees. Commit WIP on your branch instead.
- **Isolate runtime state** per worktree: test database names, ports, temp directories.
- **Check the budget first:** `codex-drive rate-limits` before fanning out.
- **Watch lane health:** run `codex-drive lanes` periodically; it exits `1` if any worktree has uncommitted work with
  no running process or recent file change.
- **Wait on multiple lanes cleanly:** with the Claude plugin, completions arrive automatically via the monitor;
  otherwise run `codex-drive wait a b c --any` in the background and re-issue for remaining lanes as each settles.

## Merging

Review each branch as it finishes (3-round convergence cap: if round 3 still finds new P1/P2s in code added by round
2, stop and simplify the plan). Never merge into a tree where another worker is running. Run merge checks on the
merged result, then remove the worktree and branch. Resolve conflicts in generated files by regenerating, not by hand.
