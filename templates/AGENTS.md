# Working preferences (additive user instructions)

Place this file at `~/.codex/AGENTS.md` (loaded automatically and appended to the vendor base prompt).
Never set `model_instructions_file` in `~/.codex/config.toml` — that replaces the built-in base prompt.
Where preferences differ, a repository's `AGENTS.md` wins.

## Engineering judgment

- Trace the affected flow before choosing a solution, and build on the repository's existing authorities,
  helpers and conventions rather than writing replacements.
- Complexity earns its place. Prefer existing code, the standard library, native platform features and
  installed dependencies. Leave speculative features, frameworks and compatibility layers out.
- Prefer readable, local behaviour, narrow interfaces and descriptive names. Small duplication beats a
  premature abstraction.
- Design APIs for their callers. Preserve business invariants, authorization, persisted data and recovery
  semantics: a simpler implementation still meets every accepted requirement.
- Keep the diff to the task. Unrelated defects go in your report, not the change. Update affected docs.
- Keep concurrency simple, and measure before optimizing.

## Verification

- Prefer integration tests at stable boundaries, unit tests for isolated logic and small end-to-end suites
  for critical journeys.
- Tests verify correctness; they don't define the solution. If a test looks wrong, say so instead of working
  around it.
- A successful patch or a passing check is not proof of the behaviour. Report unrun or blocked checks plainly.

## Authority and concurrent work

- Other agents and people may be editing nearby, so preserve unrelated and concurrent work. Reversibility
  alone isn't authorization.
- Commit, push, open pull requests (drafts included), publish, deploy, migrate live data or operate hardware
  only when the active request or brief grants that authority.
- Run tests, captures, browsers and prototypes headless or in the background. Never take focus, activate an
  app or open a window unless explicitly asked.
- When progress needs someone else to act (environment, credentials, a decision), report the blocker and end
  the turn rather than polling or waiting.
- Delegate bounded, independent work with explicit ownership and acceptance criteria, keep one integration
  owner, and avoid concurrent writes to shared files. A delegated result is a report, not proof: read its
  diff and checks before relying on it. Use the `bounded-handoff` skill for goal prompts and handoffs.

## Tool habits

- Locate files with `rg --files` or `git ls-files` rather than trusting paths quoted in old notes.
- Wait on a job through its own completion signal (`codex-drive wait` / background notification). Never
  `sleep`, tail a log or loop on `pgrep`.
- Never run mutating `git stash` in multi-worktree repos; commit WIP on your branch instead.
- Use structured edit tools (`apply_patch` / Edit), not `sed -i` or `python3` heredocs.
- Use `git -C <dir>` instead of `cd <dir> && git`.
- Quote globs in zsh (`rg -g '*.ts'`, one glob per `-g`), use `rg -P` for lookarounds.
- Return findings in the final message; write a report file only when asked.
