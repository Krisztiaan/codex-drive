# codex-drive plugin for Claude Code

Makes Codex workers started with `codex-drive start --detach` visible in Claude Code sessions. It keeps no state
of its own: every fact comes from `codex-drive status`, `inbox` and `result`, scoped to the session's project
directory and everything below it (worktrees included).

| Part | What it does |
| --- | --- |
| `SessionStart` hook (`hooks/hooks.json`) | On startup, resume, clear and compact, prints at most 12 lines: the names of the project's running workers, then the completions no session has seen yet. Silent when nothing runs and nothing is unread. |
| Monitor `codex-completions` (`monitors/monitors.json`) | Follows `codex-drive inbox --follow --unread --cwd <project>` for the whole session. Each completion prints one line, which reaches Claude as a notification: `codex-drive: <name> <status> (<failure>) at <finishedAt>; read it with codex-drive result <name>`. |
| `/codex-workers` (`skills/codex-workers/SKILL.md`) | With no argument: the running workers (name, model, last event age), the unread completions, and the completions already seen in the last 24 hours. With a worker name, `/codex-workers <name>`: that worker's latest final message in full. Also available as `/codex-drive:codex-workers`. |

**No message text appears on its own.** The hook, the monitor and the `/codex-workers` overview show metadata
only: name, status, failure class and finish time. A worker's running message and final message never reach a
session unless a person asks: `/codex-workers <name>` (the skill cannot be invoked by Claude itself) or
`codex-drive result <name>`.

**An entry is marked read only after its line is written.** The hook, the monitor and `/codex-workers` print
first, then acknowledge exactly the entries they printed with `codex-drive inbox --ack <threadId>@<turnId>...`. An
entry left out by the 12-line limit, an entry whose result could not be read, and anything not printed because of
a timeout stay unread.

**Session start never waits long.** The hook has a 5-second budget. Status and repairs stop one second before the
end, and no new call starts after its time. A call past its time gets SIGTERM, then SIGKILL half a second later,
and the hook waits until it has exited. A slow or stalled server costs one line, `codex-drive status did not
finish within 4 s`, and unread completions are still listed.

Before it lists completions, the hook and `/codex-workers` call `codex-drive result <name> --turn <id> --json` for
each settled turn that `status` reports but the outbox never recorded. That is how the entry of a logger that died
is repaired. Repairs left over at the deadline are done by a later run.

## Requirements

- `codex-drive` on `PATH` with `inbox --cwd` and `inbox --ack <key>` (this branch or later). An older one fails
  with `Unknown option: --cwd`. The hook reports this in one line, and the monitor reports it once and stops.
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
| `CODEX_DRIVE_BIN` | `codex-drive` | The executable the hook, the monitor and `/codex-workers` call. |
| `CODEX_WORKERS_CWD` | the project directory | The directory scope for all three. Use `/` for every worker in the driver home. Paths are compared with symlinks resolved on both sides. |
| `CODEX_WORKERS_SINCE` | `24h` | Only sessions with an event in this window are inspected. This bounds the hook's time, because `status` makes one server call per session. |
| `CODEX_WORKERS_DEADLINE_MS` | `5000` | The `SessionStart` budget in milliseconds. `/codex-workers` has 30 seconds. |
| `CODEX_DRIVE_HOME` | `~/.codex-drive` | codex-drive's own setting. It applies to all three parts. |

## Behaviour to know

- **Read state is shared.** One acknowledgement marker per completion is shared by every session and the
  monitor, and delivery is at least once. A completion normally appears once: as a notification in a session whose
  monitor is running, or at the next session start. It can appear twice when two readers list it before either has
  acknowledged it. This happens when two sessions of one project read at the same moment, or when a session's hook
  and monitor both start while it is unread. Each reader prints an entry at most once. Nothing is lost:
  `codex-drive inbox --cwd <project>` lists everything recorded, read or not.
- **Wake-up.** The documentation says only that what a monitor prints "reaches Claude as notifications". In a
  test on Claude Code 2.1.325, a monitor line started a turn in an idle interactive session with no user message.
  See [Verification](#verification).
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
  - two sessions starting at once
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
