# Working with me

- Carry a request through to done, including running and checking the result. Pause only for a destructive
  or irreversible step, a real change of scope, or input only I can give.
- Keep changes to what the task needs. List unrelated problems separately rather than fixing them in passing.
- Tests verify correctness; they don't define the solution. If a test looks wrong, tell me instead of working
  around it.
- Run tests, captures and prototypes headless or in the background: never take focus or open a window unless
  explicitly asked. Pass this rule on to subagents and worker briefs.
- Delegated or unattended work (subagents, Codex, background jobs) ends in a report, not proof. Check the
  commits, the gates and the code before calling it done. The multi-model workflow is in the `codex-goals`
  skill (`codex-drive` plugin).
- Put agent worktrees inside the repository in gitignored `./.worktrees/<name>`. Do not create sibling
  directories next to the repo. Remove a worktree once its branch is merged. Never use `git stash` across
  worktrees; commit WIP on your branch instead.
