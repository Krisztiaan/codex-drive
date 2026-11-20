# Pass-through protocol, events & server requests

`codex-drive` validates every request and server-request response against the checked-in JSON Schema generated from `codex app-server` ([protocol/schema.json](../protocol/schema.json), version in [protocol/README.md](../protocol/README.md)).

## Regenerate schema after upgrading Codex

```sh
npm run protocol
```

New client methods and parameters become available immediately without runtime changes.

## Pass-through calls & aliases

```sh
codex-drive methods
codex-drive call configRequirements/read null
codex-drive call model/list '{"limit":10,"includeHidden":true}'
codex-drive call thread/read @read-params.json
printf '%s\n' '{"threadId":"UUID"}' | codex-drive call thread/read -
```

| Alias | Protocol method |
|---|---|
| `list` / `read <id>` | `thread/list` / `thread/read` |
| `archive <id>` / `unarchive <id>` | `thread/archive` / `thread/unarchive` |
| `rollback <id>` | `thread/revert` (`--param beforeTurnId='"TURN"'`) |
| `compact <id>` / `name <id> <title>` | `thread/compact/start` / `thread/name/set` |
| `models` / `rate-limits` | `model/list` / `account/rateLimits/read` |

Omitted parameters default to `{}` (or `null` for null-only methods). Protocol errors print the raw error object to stderr and exit `1`. Transport failures never replay mutations.

## Events & server requests

```sh
codex-drive events <name> [--follow]     # raw JSONL server envelopes
codex-drive tail <name> -n 20            # readable agent/command/lifecycle lines
codex-drive pending [<name>]             # open server-to-client requests
codex-drive respond <requestId> '{"decision":"accept"}'
codex-drive respond <requestId> '{"code":-32601,"message":"Unsupported"}' --error
```

- `--request-policy approve` (default) answers supported approval requests automatically; `manual` leaves all requests for `respond`; `decline` declines approvals/elicitations.
- User questions, dynamic tools, token refreshes, and content elicitations remain manual — `codex-drive` never invents credentials or user input.
- Wait observers opt out of noisy streaming deltas (`WAIT_NOTIFICATION_OPT_OUTS`) and create no raw call journals.
