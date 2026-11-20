# codex-drive plugin for Claude Code

Displays Codex workers in Claude Code. The automatic views select the active session's workers within the
project directory and its worktrees. The manual overview includes workers from every session in that directory scope.

| Part | What it does |
| --- | --- |
| `SessionStart` hook (`hooks/hooks.json`) | On startup, resume, clear and compact, shows the session's running workers and unread completions in at most 12 lines. |
| Monitor `codex-completions` (`monitors/monitors.json`) | Follows `codex-drive inbox --follow --unread --cwd <project> --owner <session-id>`. Each completion includes a `codex-drive result <name> --turn <turnId>` command for that specific turn. |
| `/codex-workers` (`skills/codex-workers/SKILL.md`) | Shows workers from every owner, including unowned workers. It lists running workers, unread completions and recently read completions with their owners. With a worker name, it reports the latest turn's status, owner and full message when available. Also available as `/codex-drive:codex-workers`. |

Codex-drive captures `CLAUDE_CODE_SESSION_ID` from the Bash environment on `start`, `resume` and adoption of an
unowned running turn. The same ID reaches subagents and scripts they run. The hook reads `session_id` from its
input, and the monitor starts with `CLAUDE_CODE_SESSION_ID`. Claude Code keeps an existing monitor process on an
interactive `/resume` or `/clear`, so the hooks pause and retarget it through a process-local owner file under
`CODEX_DRIVE_HOME/claude-monitors/`. Compaction keeps the owner. Automatic output requires a session ID.

Use `--quiet` on a launch that collects its own completion with `wait` or another script. Quiet and unowned
completions appear in manual views.

**No message text appears on its own.** The hook, the monitor and the `/codex-workers` overview show metadata
only: name, status, failure class, finish time and the command that reads that turn. A worker's running message and final message never reach a
session unless a person asks: `/codex-workers <name>` (the skill cannot be invoked by Claude itself) or
`codex-drive result <name>`.

**An entry is marked read only after its line is written.** The hook, the monitor and `/codex-workers` print
first, then acknowledge exactly the entries they printed in the current session's read state. An
entry left out by the 12-line limit, an entry whose result could not be read, and anything not printed because of
a timeout stay unread.

**Session start never waits long.** The hook has a 5-second budget. Status and repairs stop one second before the
end, and no new call starts after its time. A call past its time gets SIGTERM, then SIGKILL half a second later,
and the hook waits until it has exited. A slow or stalled server costs one line, `codex-drive status did not
finish within 4 s`, and unread completions are still listed.

Before listing completions, the hook and `/codex-workers` repair missing outbox entries for settled turns in their
respective status views. They use `codex-drive result <name> --turn <id> --json`. A later run can finish repairs
left over at the deadline.

## Requirements

- `codex-drive` on `PATH` with `status --owner` and `inbox --owner`, or set `CODEX_DRIVE_BIN`.
- Node.js 24 or later, the same as codex-drive.
- An interactive Claude Code session for the monitor. Plugin monitors do not start with `-p`.

## Install locally

Try it for one session without installing anything:

```sh
claude --plugin-dir /path/to/codex-drive/claude-plugin
```

Install it from the marketplace at the repository root (`.claude-plugin/marketplace.json`), at user scope:

```sh
claude plugin validate /path/to/codex-drive
claude plugin marketplace add /path/to/codex-drive
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
| `CODEX_DRIVE_BIN` | `codex-drive` | The executable the hook, the monitor and `/codex-workers` call. |
| `CODEX_WORKERS_CWD` | the project directory | The directory scope for all three. Use `/` to remove the directory restriction. Paths are compared with symlinks resolved on both sides. |
| `CODEX_WORKERS_SINCE` | `24h` | Only sessions with an event in this window are inspected. This bounds the hook's time, because `status` makes one server call per session. |
| `CODEX_WORKERS_DEADLINE_MS` | `5000` | The `SessionStart` budget in milliseconds. `/codex-workers` has 30 seconds. |
| `CODEX_DRIVE_HOME` | `~/.codex-drive` | codex-drive's own setting. It applies to all three parts. |

## Behaviour to know

- **Read state follows the session.** A completion can appear twice if a session's hook and monitor list it
  before either acknowledges it. The plugin acknowledges after writing to stdout. If the session closes at that
  point, use `codex-drive inbox --cwd <project>` to recover any retained entry. `/codex-workers` shows up to 50
  unread completions and eight read completions from the last 24 hours.
- **Wake-up.** The documentation says only that what a monitor prints "reaches Claude as notifications". In a
  test on Claude Code 2.1.325, a monitor line started a turn in an idle interactive session with no user message.
  See [Verification](#verification).
- **Existing workers.** Older records without an owner remain visible in the manual views.
- **Codex accounts.** Worker commands use the current Codex login and each worker's saved server.
  Use `codex-drive account` after switching logins to see which servers belong to each account.
  Completion entries remain in the inbox if the original account or server is unavailable.

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
- Session identity in Bash and hooks is documented under [Claude Code environment variables](https://code.claude.com/docs/en/env-vars#claude-code-session-id).
- Validation and installation: <https://code.claude.com/docs/en/plugins/cli-reference> (`claude plugin validate`,
  `marketplace add`, `install`, `disable`), <https://code.claude.com/docs/en/plugins/create> (`--plugin-dir`) and
  <https://code.claude.com/docs/en/plugins/marketplace-reference>.

## Verification

- `claude plugin validate claude-plugin --strict` and `claude plugin validate . --strict` (the marketplace) pass on
  Claude Code 2.1.325. One directory-submission note remains: there is no icon. The validator checks `plugin.json`,
  `hooks/hooks.json` and the skill frontmatter. It does not read `monitors/monitors.json`: a probe with an unknown key and with a non-array still passed. The monitor entry
  therefore follows the documented example field for field, and `test/claude-plugin.test.mjs` runs its command.
- `test/claude-plugin.test.mjs` runs the committed hook and monitor commands through `/bin/sh`, with the path
  variables substituted, against the fixture app-server. It covers these cases:
  - the quiet case and a missing binary
  - metadata only, checked with a message and running text that carry a token
  - the project scope
  - acknowledgement after printing, with overflow left unread
  - the dead-logger repair
  - the deadline, with a stalled server and with a binary that ignores SIGTERM (it is reaped)
  - separate owners and read state, resume, compaction, inherited script ownership and quiet waits
  - `/codex-workers`, with and without a name, including an unreadable result that stays unread
  - the monitor's one line per completion, and its stop without acknowledgement when its output is gone

  Symlinked and removed paths are tested in `test/result-inbox.test.mjs`.
- Headless `claude -p --plugin-dir claude-plugin --setting-sources project` runs, with an isolated
  `CODEX_DRIVE_HOME` and no install, confirmed three things. The plugin loads as `codex-drive@inline` with the
  skill `codex-drive:codex-workers`. The `SessionStart` output reached the model's context. `/codex-workers`
  injected its report under the `allowed-tools` pattern `Bash(node *codex-workers.mjs* show *)`. The narrower
  pattern `Bash(node *codex-workers.mjs show *)` was refused, because the quoted path ends in `"`.
  `/codex-workers <name>` passed the name through `$ARGUMENTS` under the same pattern.
- An interactive session in a pseudo-terminal (no window), with the same flags and an isolated home, showed
  `1 monitor` in the footer. A completion recorded while the session was idle arrived as a monitor event. Claude
  then answered it unprompted, and the entry was acknowledged. This run used the first version of the monitor,
  which printed raw JSON. The current version prints one formatted line and is covered by the tests above.
- A headless pseudo-terminal probe on Claude Code 2.1.328 used a local fixture API and isolated settings.
  The Bash subprocess, a script launched from a subagent's Bash tool, the hooks and the monitor agreed on the
  session ID. The ID survived `/compact`, CLI `--resume` and `--continue`. An in-process `/resume` switched the
  hook ID while leaving the monitor process running. With the updated plugin loaded via `--plugin-dir`,
  completions reached the conversation active before and after the switch. The previous owner's subsequent
  completion, an unowned completion and a quiet completion stayed in the manual inbox.
