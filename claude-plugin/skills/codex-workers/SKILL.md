---
name: codex-workers
description: Show this project's running codex-drive workers and their unread Codex results.
disable-model-invocation: true
allowed-tools: Bash(node *codex-workers.mjs* show *)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-workers.mjs" show "${CLAUDE_PROJECT_DIR}"`

Report this to the user: the running workers, then each unread result's outcome and its main points. Run no
other command for this report. A longer result is one `codex-drive result <name>` away.
