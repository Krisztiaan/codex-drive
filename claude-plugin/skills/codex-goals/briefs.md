# Writing a brief

The brief is the only context a worker is certain to have, and resumes point back to it. Write one per goal, commit
it on the worker's branch, and send corrections to the same session (`steer` or `resume`) rather than writing a
second brief.

## Contents

- **Scope** in one line and a **stop line**: what comes next and must not be started.
- **Level:** declare `Level: 0|1|2|3` so `codex-drive review` selects the right reviewer set automatically.
- **Decided:** quote applicable owner rulings verbatim with dates (and repeat them on resumes) so workers do not
  stop to re-ask settled questions.
- **Out of scope:** name adjacent items and their tracking issues so reviewers do not grade the branch against them.
- **Reading order:** direction note, design note, and prior Outcomes this goal builds on, each with why to read it.
- **Standing rules by reference:** link `AGENTS.md` and the repo's worker guide instead of retyping them.
- **Deliverables:** contracts other goals depend on (signatures, shapes, names).
- **Ownership** (when running in parallel): worktree path and branch first, then owned paths, shared files with a
  named owner, and read-only paths. See [parallel.md](parallel.md).
- **Inventory before design:** when a change must cover every caller/writer/reader, start from a mechanical
  `git grep` inventory, not from memory.
- **Done means:** checkable and exhaustive, naming the touched-area checks (never full suites in a worker lane) and
  what review will insist on (tests that fail without the fix, invariants, refusals, recovery).
- **Allowed stops:** the few reasons to stop early. Capacity/busy pools retry within budget. Anything that cannot be
  done cleanly stops at the last good commit with file and line.
- **Output: one channel.** The final message plus `## Outcome` appended to the brief and committed. Never also ask
  for a separate `report.md`. Read-only reviewers return the final message only.

Every implementation brief also states: commit after each deliverable once its checks pass; never `git stash`; never
sleep or poll without a deadline; report out-of-scope findings in `## Outcome` instead of fixing them; flag a test
that looks wrong instead of working around it.

## Style by autonomy tier

Tie brief style to the role's autonomy tier (`codex-drive roles`), not to a specific vendor model name:

- **`goal-driven` roles (`architect`, `reviewer`, `design-reviewer`, `implementer`, `generalist`, `mapper`):**
  give goal, context, boundaries, invariants and done criteria; leave the *how* to the worker. Stacked prohibitions
  and step-by-step recipes over-constrain them.
- **`prescriptive` roles (`mechanical`, `slice`):**
  give numbered steps, exact files, named edge cases, explicit judgment criteria and the exact test or lint command
  that decides pass or fail. Fix rounds state the exact change to make, not just the symptom. Keep each session to
  one focused slice.
- Always request tests explicitly when you want new or updated tests written and run.

## Review prompt

Prefer `codex-drive review`, which generates a mechanical `git grep` pre-pass, enforces a `READ LEDGER`, and parses
structured `FINDINGS` / `VERDICT:` trailers. When writing a manual review prompt, give the brief path, base commit,
diff range, prior findings and dispositions, and out-of-scope items. Never include your own conclusion; a reviewer
handed a verdict returns it.
