# Model trials

Compare models, roles or effort levels by running the same real slice once per arm, each in its own worktree
(see [parallel.md](parallel.md)).

- **Use a real slice** whose dependencies are merged; the winning branch becomes the work.
- **One arm per model/effort**, each briefed in the style its autonomy tier needs (see [briefs.md](briefs.md)),
  with identical scope and done criteria. Start all arms together so host/provider contention is shared.
- **Decide scoring before launch:**
  1. hidden acceptance tests written from the spec by a separate agent and never shown to the arms;
  2. the project's checks on each branch;
  3. a blind review of anonymized branches against one rubric (`codex-drive review`);
  4. cost and process: tokens and wall time (`thread/tokenUsage/updated` and `turn/completed` `durationMs` in
     `codex-drive events <name>`), fix rounds needed, edits outside owned paths, and Outcome accuracy.
- **Promote winners cleanly:** update `~/.codex-drive/roles.json` (or `.codex-drive/roles.json`) so every skill and
  review command adopts the winning model with a single edit.
- Report the comparison with a recommendation and what it does not show.
