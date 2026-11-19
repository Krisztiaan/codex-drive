---
name: codex-workers
description: Show this project's codex-drive workers, owners and completions, or one worker's final message in full.
argument-hint: "[worker name]"
disable-model-invocation: true
allowed-tools: Bash(node *codex-workers.mjs* show *), Bash(codex-drive result:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-workers.mjs" show "${CLAUDE_PROJECT_DIR}"`

Report this overview to the user as it stands.

If the user named a worker ($ARGUMENTS), check that the name matches `^[A-Za-z0-9][A-Za-z0-9_.-]*$`; if it does,
run `codex-drive result <name> --json` with the Bash tool and report the status, owner and full message. Never paste the argument into a shell
command unvalidated. (Arguments are not substituted into the command above, so pasted shell syntax cannot run.)
