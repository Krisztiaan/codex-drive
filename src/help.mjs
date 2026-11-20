import { DEFAULT_PERMISSIONS } from './defaults.mjs';
import { levelTable } from './review.mjs';

export const HELP_TOPICS = Object.freeze({
  turns: `Turns, sessions & roles:
  codex-drive start ["<prompt>"] [--cwd <dir>] [--role <role>] [--model <m>] [--effort <e>] [--name <n>] [--detach] [--quiet]
  codex-drive resume <name|id> ["<prompt>"] [--role <role>] [--detach] [--quiet]
  codex-drive adopt|attach <threadId> [--name <n>] [--detach] [--quiet]
  codex-drive fork <name|id> [--name <new-name>]
  codex-drive steer <name|id> [--turn <turnId>] "<text>"
  codex-drive interrupt <name|id> [--turn <turnId>]
  codex-drive wait <name|id> [...] [--all | --any] [--timeout <seconds>]

Defaults: --sandbox ${DEFAULT_PERMISSIONS.sandbox}, --approval ${DEFAULT_PERMISSIONS.approval}, --request-policy ${DEFAULT_PERMISSIONS.requestPolicy}.
Overrides: --sandbox read-only|workspace-write|danger-full-access, --approval untrusted|on-failure|on-request|never,
  --add-dir <dir> (requires workspace-write), --request-policy manual|approve|decline, --retry-capacity <n>.
Raw params: --thread-params <json>|@file|-, --turn-params <json>|@file|-, --param [thread.|turn.]key=<json>.
Wait exits: 0 completed, 1 error/failed, 75 capacity, 76 usage limit, 124 timeout, 130 interrupted.
Multi-wait defaults to --all; --any returns on first settled turn without interrupting peers.`,

  inbox: `Results & completion inbox:
  codex-drive result <name|threadId> [--turn <id>] [--json]
  codex-drive inbox [<threadId@turnId>...] [--follow] [--since <time>|--unread] [--ack] [--cwd prefix] [--owner <session-id>]

result prints "<name> <status> <turnId> [failure]" then the full final agent message of the latest turn or --turn.
While the turn is still running it prints only the header and exits 3 (never substitutes an older turn).
Result exits: completed 0, failed or interrupted 1, unknown name or turn 2, not finished 3.

inbox prints one JSON line per settled turn (metadata only, no message text) from $CODEX_DRIVE_HOME/outbox/.
  --unread         skip acknowledged entries for the current reader/owner
  --since 24h|ISO  filter by finish time
  --ack            mark printed entries (or explicit <threadId@turnId> keys) read
  --cwd <dir>      restrict to workers in or below <dir> (symlinks resolved)
  --owner <id>     select one Claude Code session's automatic notifications (excludes --quiet/unowned)
  --follow         watch outbox and stream new completions once`,

  roles: `Role-based routing (fluid model ecosystem):
  codex-drive roles [--json] [--cwd <dir>]
  codex-drive start --role <role> ...
  codex-drive resume <name> --role <role> ...

Layers (deepest wins):
  1. Built-in defaults (templates/roles.json)
  2. ~/.codex-drive/roles.json (or $CODEX_DRIVE_HOME/roles.json)
  3. <cwd>/.codex-drive/roles.json

Each role sets { provider, model, effort, sandbox, style, description }.
Explicit --model, --effort, or --sandbox flags always override the role default.
Run \`codex-drive setup --roles\` to scaffold ~/.codex-drive/roles.json.`,

  review: `Leveled independent multi-model review:
  codex-drive review --worktree <dir> --base <rev> --head <rev> --brief <path> --name <prefix> \\
    --kind handoff|rereview|design [--level 0..3] [--record] [--previous <run-dir>] \\
    [--effort <e>] [--timeout <s>] [--codex-only] [--dry-run] [--json]

${levelTable()}

Override built-in prompts per repo at <repo>/.codex-drive/review/{REVIEW-PROMPT.md,lenses/*.md}.
Exits: 0 merge, 1 fix first, 2 usage, 3 incomplete, 4 void (worktree mutated), 5 insufficient reading,
  75 capacity/usage limit, 124 timeout, 130 interrupted.`,

  lanes: `Worktree lane watchdog:
  codex-drive lanes [--dir <path>] [--cwd <dir>] [--minutes 60] [--json]

Inspects git worktrees under .worktrees/ (or --dir) and classifies each as:
  active   process running in lane, or commit/file change within --minutes
  idle     no running process and no uncommitted files
  STALLED  uncommitted work with no running process or change within --minutes

Exits: 0 healthy, 1 one or more lanes STALLED, 2 usage error.`,

  hooks: `PreToolUse guardrail hooks (Claude Code & Codex CLI):
  codex-drive hook <wait-guard|stash-guard|all> [--agent claude|codex]

Reads hook JSON from stdin and emits a PreToolUse deny JSON payload when a Bash command violates a rule:
  wait-guard   refuses leading \`sleep N\`, \`until\` loops, \`pgrep -f\`/\`pkill -f\` self-match loops, unbounded polling
  stash-guard  refuses mutating \`git stash\` across shared worktrees (allows \`git stash list\` and \`show\`)
  all          runs both guards

Wired automatically in claude-plugin/hooks/hooks.json; Codex snippet in codex-pack/hooks.json.`,

  protocol: `Schema-validated pass-through RPC & event inspection:
  codex-drive methods
  codex-drive call <method> [<params-json>|@file|-] [--param key=<json>] [--request-policy manual|approve|decline]
  codex-drive events <name|id> [--follow]
  codex-drive tail <name|id> [-n 20]
  codex-drive pending [<name|id>]
  codex-drive respond <requestId> <result-json>|@file|- [--error]
  codex-drive list | read <id> | archive <id> | unarchive <id> | rollback <id> | compact <id> | name <id> <name>
  codex-drive models | account [--json] | rate-limits [--json]

Regenerate protocol/schema.json after upgrading Codex: npm run protocol.`,

  server: `Server ownership, accounts & cleanup:
  codex-drive serve [--port <port>] [--stop | --prune | --restart] [--force] [--timeout seconds]
  codex-drive status [<name|id>] [--json] [--active] [--cwd prefix] [--since 24h] [--name glob] [--owner <id>]
  codex-drive account [--json]
  codex-drive rate-limits [--json]
  codex-drive prune [--calls] [--older-than 30d] [--apply]

Server commands default to the active login in $CODEX_HOME/auth.json; saved threads bind to their recorded server/account.
To target another account explicitly, pass both --port <port> and --allow-other-account.
Prune defaults to dry-run; --apply removes confirmed terminal local sessions (never deletes server history).`,

  setup: `Non-destructive local setup & scaffolding:
  codex-drive setup [--roles] [--codex] [--claude] [--templates <dir>] [--home <dir>] [--codex-home <dir>] [--force] [--dry-run] [--json]

  --roles            write starter ~/.codex-drive/roles.json
  --codex            install bounded-handoff skill & agent TOML presets into ~/.codex/
  --claude           print Claude Code plugin marketplace/install commands
  --templates <dir>  copy AGENTS.md, CLAUDE.md, BRIEF.md, roles.json into <dir>
  --force            overwrite existing files (default: skip existing)`,
});

export const COMPACT_USAGE = `codex-drive — multi-model Codex worker driver, review ensemble & guardrail suite

Workers:
  start ["<prompt>"] [--cwd <dir>] [--role <r>] [--model <m>] [--effort <e>] [--name <n>] [--detach] [--quiet]
  resume <name|id> ["<prompt>"] [--role <r>] [--detach] [--quiet]
  adopt|attach <threadId> [--name <n>] [--detach] [--quiet]   |   fork <name|id> [--name <new>]
  steer <name|id> "<text>"   |   interrupt <name|id>   |   wait <name|id> [...] [--all|--any] [--timeout <s>]

Results & Inbox:
  status [<name|id>] [--json] [--active] [--cwd <dir>] [--since 24h] [--name <glob>] [--owner <id>]
  result <name|threadId> [--turn <id>] [--json]
  inbox [<threadId@turnId>...] [--follow] [--since <time>|--unread] [--ack] [--cwd prefix] [--owner <session-id>]

Workflow & Guardrails:
  roles [--json] [--cwd <dir>]
  review --worktree <dir> --base <rev> --head <rev> --brief <path> --name <p> --kind handoff|rereview|design [--level 0..3]
  lanes [--dir <path>] [--minutes 60] [--json]
  hook <wait-guard|stash-guard|all> [--agent claude|codex]
  setup [--roles] [--codex] [--claude] [--templates <dir>] [--dry-run]

Server & Protocol:
  serve [--port <p>] [--stop|--prune|--restart]   |   account [--json]   |   rate-limits [--json]
  methods   |   call <method> [json|@file|-]   |   events|tail <name>   |   pending|respond   |   prune
  list | read | archive | unarchive | rollback | compact | name | models

Key defaults & exits:
  Defaults: --sandbox ${DEFAULT_PERMISSIONS.sandbox}, --approval ${DEFAULT_PERMISSIONS.approval}, --request-policy ${DEFAULT_PERMISSIONS.requestPolicy} (override: --request-policy manual|decline).
  Wait exits: 0 completed, 1 error, 75 capacity, 76 usage limit, 124 timeout, 130 interrupted.
  Result exits: completed 0, failed or interrupted 1, unknown name or turn 2, not finished 3.

Expand any topic: codex-drive help <${Object.keys(HELP_TOPICS).join('|')}>`;

export function formatHelp(topic) {
  if (!topic) return COMPACT_USAGE;
  const key = topic.toLowerCase();
  if (HELP_TOPICS[key]) return HELP_TOPICS[key];
  const alias = {
    start: 'turns', resume: 'turns', adopt: 'turns', attach: 'turns', fork: 'turns', steer: 'turns', interrupt: 'turns', wait: 'turns',
    result: 'inbox', status: 'server', account: 'server', 'rate-limits': 'server', prune: 'server', serve: 'server',
    call: 'protocol', methods: 'protocol', events: 'protocol', tail: 'protocol', pending: 'protocol', respond: 'protocol',
    hook: 'hooks',
  }[key];
  if (alias) return HELP_TOPICS[alias];
  throw new Error(`Unknown help topic "${topic}". Available: ${Object.keys(HELP_TOPICS).join(', ')}`);
}
