# codex-drive plugin for Claude Code

Makes Codex workers started with `codex-drive start --detach` visible in Claude Code sessions. It keeps no state
of its own: every fact comes from `codex-drive status`, `inbox` and `result`, scoped to the session's project
directory and everything below it (worktrees included).

| Part | What it does |
| --- | --- |
| `SessionStart` hook (`hooks/hooks.json`) | On startup, resume, clear and compact, prints at most 12 lines: the project's running workers and the completions no session has seen yet, each with the first line of its final message. It acknowledges what it prints. Silent when nothing runs and nothing is unread. |
| Monitor `codex-completions` (`monitors/monitors.json`) | Runs `codex-drive inbox --follow --unread --ack --cwd <project>` for the whole session. Each completion prints one JSON line (`name`, `status`, `failure`, `exitCode`, `finishedAt`), which reaches Claude as a notification. Read the full text with `codex-drive result <name>`. |
| `/codex-workers` (`skills/codex-workers/SKILL.md`) | Running workers, then the full final message of each unread completion (acknowledged once shown), then the completions already seen in the last 24 hours with their first lines. Also available as `/codex-drive:codex-workers`. |

Before it lists completions, the hook and `/codex-workers` call `codex-drive result <name> --turn <id> --json` for
each settled turn that `status` reports but the outbox never recorded. That is how the entry of a logger that died
is repaired. Each unread completion gets one `result` call, which supplies its first line.

## Requirements

- `codex-drive` on `PATH`, including `inbox --cwd` (this branch or later). Without it the hook prints
  `inbox failed: Unknown option: --cwd` and the monitor exits.
- Node.js 24 or later, the same as codex-drive.
- An interactive Claude Code session for the monitor. Plugin monitors do not start with `-p`.

## Install locally

Try it for one session without installing anything:

```sh
claude --plugin-dir /Users/krisztiaan/dev/codex-drive/claude-plugin
```

Install it from the local marketplace at the repository root (`.claude-plugin/marketplace.json`), at user scope:

```sh
claude plugin validate /Users/krisztiaan/dev/codex-drive
claude plugin marketplace add /Users/krisztiaan/dev/codex-drive
claude plugin install codex-drive@codex-drive
```

Add `--scope project` to the last two commands to enable it for one project only. Edits to a local-path marketplace
take effect at the next session start or after `/reload-plugins`.

## Disable or remove

```sh
claude plugin disable codex-drive@codex-drive      # keep it installed, stop loading it
claude plugin enable codex-drive@codex-drive
claude plugin uninstall codex-drive@codex-drive
claude plugin marketplace remove codex-drive
```

`/plugin` in a session does the same from its **Installed** tab. A monitor that is already running keeps running
after you disable the plugin, until the session ends.

## Settings

Set these in the environment Claude Code starts with:

| Variable | Default | Effect |
| --- | --- | --- |
| `CODEX_DRIVE_BIN` | `codex-drive` | The executable the hook and `/codex-workers` call. The monitor always calls `codex-drive` on `PATH`. |
| `CODEX_WORKERS_CWD` | the project directory | The directory scope for the hook and `/codex-workers`. Use `/` for every worker in the driver home. |
| `CODEX_WORKERS_SINCE` | `24h` | Only sessions with an event in this window are inspected. This bounds the hook's time, because `status` makes one server call per session. |
| `CODEX_DRIVE_HOME` | `~/.codex-drive` | codex-drive's own setting. It applies to all three parts. |

## Behaviour to know

- **Acknowledgement.** The monitor and the hook acknowledge what they print. A completion is therefore shown once:
  as a notification in a session whose monitor was running, or at the next session start. With two sessions open
  in the same project, the first follower to scan the outbox usually acknowledges an entry before the second
  sees it. Both may print it if they scan at the same moment. `codex-drive inbox --cwd <project>` lists everything
  recorded, read or not.
- **Wake-up.** The documentation says only that what a monitor prints "reaches Claude as notifications". In a
  test on Claude Code 2.1.325, a monitor line started a turn in an idle interactive session with no user message.
  See [Verification](#verification).
- **Paths are compared as written.** Claude Code reports the project directory with symlinks resolved, for
  example `/private/tmp/...` on macOS. A worker started with `--cwd /tmp/...` is recorded under `/tmp` and falls
  outside that scope. Start workers with the resolved path, or set `CODEX_WORKERS_CWD`.
- **First run.** Sessions that settled before codex-drive had an outbox have no entry. On the first run, the hook
  repairs those from the last 24 hours and lists them once as unread.

## Documentation used

The formats follow the Claude Code documentation as read on 2026-11-16:

- Monitors: <https://code.claude.com/docs/en/plugins/components#monitors>. Their default location is
  `monitors/monitors.json`, and each entry has `name`, `command` and `description`. A monitor "runs in the
  background for the whole session", and "What it prints reaches Claude as notifications". The command runs "in
  the session's current working directory" and not with `-p`. Path variables, including `${CLAUDE_PROJECT_DIR}`,
  are substituted in monitor commands. The field table is in the [manifest
  reference](https://code.claude.com/docs/en/plugins/manifest-reference#monitors).
- Hooks: <https://code.claude.com/docs/en/plugins/components#hooks> and
  <https://code.claude.com/docs/en/hooks>. Hooks live under a top-level `hooks` key. The `SessionStart` matchers
  are `startup`, `resume`, `clear`, `compact` and `fork`. Plain stdout from a `SessionStart` hook that exits 0 is
  added as context, and output over 10,000 characters is replaced by a file path.
- Skills: <https://code.claude.com/docs/en/skills>. The `` !`command` `` placeholder is replaced by the command's
  output before Claude sees the skill. `allowed-tools` pre-approves it, and a command that fails aborts the
  invocation, so `show` always exits 0. A plugin skill with a frontmatter `name` is also invocable bare, as
  `/codex-workers`, unless another command has that name. The docs prefer skills to `commands/` for new plugins.
- Validation and installation: <https://code.claude.com/docs/en/plugins/cli-reference> (`claude plugin validate`,
  `marketplace add`, `install`, `disable`), <https://code.claude.com/docs/en/plugins/create> (`--plugin-dir`) and
  <https://code.claude.com/docs/en/plugins/marketplace-reference>.

## Verification

- `claude plugin validate claude-plugin --strict` and `claude plugin validate . --strict` (the marketplace) pass on
  Claude Code 2.1.325. One directory-submission note remains: there is no icon. The validator checks `plugin.json`, `hooks/hooks.json` and the skill frontmatter. It does not
  read `monitors/monitors.json`: a probe with an unknown key and with a non-array still passed. The monitor entry
  therefore follows the documented example field for field, and `test/claude-plugin.test.mjs` runs its command.
- `test/claude-plugin.test.mjs` runs the committed hook and monitor commands through `/bin/sh`, with the path
  variables substituted, against the fixture app-server. It covers the quiet case, a missing binary, the
  project scope, acknowledgement, the dead-logger repair, the 12-line budget, `/codex-workers` and the monitor's
  one line per completion.
- Headless `claude -p --plugin-dir claude-plugin --setting-sources project` runs, with an isolated
  `CODEX_DRIVE_HOME` and no install, confirmed three things. The plugin loads as `codex-drive@inline` with the
  skill `codex-drive:codex-workers`. The `SessionStart` output reached the model's context. `/codex-workers`
  injected its report under the `allowed-tools` pattern `Bash(node *codex-workers.mjs* show *)`. The narrower
  pattern `Bash(node *codex-workers.mjs show *)` was refused, because the quoted path ends in `"`.
- An interactive session in a pseudo-terminal (no window), with the same flags and an isolated home, showed
  `1 monitor` in the footer. A completion recorded while the session was idle arrived as `Monitor event: {...}`.
  Claude then answered it unprompted, and the entry was acknowledged.
