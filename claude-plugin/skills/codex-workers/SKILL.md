---
name: codex-workers
description: Show this project's running codex-drive workers and unread completions, or one worker's final message in full.
argument-hint: "[worker name]"
disable-model-invocation: true
allowed-tools: Bash(node *codex-workers.mjs* show *)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-workers.mjs" show "${CLAUDE_PROJECT_DIR}" $ARGUMENTS`

Report this to the user as it stands. Run no other command for this report.
