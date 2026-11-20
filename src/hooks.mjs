import { readFileSync } from 'node:fs';

const LEADING_SLEEP = /^\s*(?:#[^\n]*\n\s*)*sleep\s+\d/;
const UNTIL_LOOP = /(?:^|[;&|(){}\n'"`]|\b(?:then|do|else)\s)\s*until\s[\s\S]*?(?:;|\n)\s*do\b/;
const LOOP = /\b(until|while)\b[^\n]*?\bdo\b/;
const SELF_MATCH = /\bp(?:grep|kill)\b[^|;&\n]*\s-[A-Za-z]*f/;
const PROCESS_LOOKUP = /\bp(?:grep|idof)\b/;
const SLEEP = /\bsleep\s+\d/;
const DEADLINE = /(?:^|[\s;&|(])timeout\s+\d|\bSECONDS\b|deadline|DEADLINE|\battempts?\b|\btries\b|\bdate\s+\+%s\b|\bEPOCHSECONDS\b|\$\(\(\s*\w+\s*\+\s*1\s*\)\)|\(\(\s*\w+\s*\+\+\s*\)\)|\(\(\s*\+\+\s*\w+\s*\)\)/;

const WAIT_ALTERNATIVE = 'Instead: run the job with run_in_background: true and act on its completion notification; '
  + 'use `codex-drive wait <name> --timeout <seconds>` or `codex-drive inbox --follow --unread --ack` for Codex workers; '
  + 'or use a bounded deadline (`timeout` / `SECONDS`). Do not retry with a shorter sleep or another loop.';

export function waitGuardReason(command) {
  if (typeof command !== 'string' || !command.trim()) return null;
  if (LEADING_SLEEP.test(command)) {
    return `Refused: a command that starts with \`sleep N\` waits blind and then polls. ${WAIT_ALTERNATIVE}`;
  }
  if (UNTIL_LOOP.test(command)) {
    return `Refused: an \`until\` loop polls for a condition. ${WAIT_ALTERNATIVE}`;
  }
  const loop = LOOP.test(command);
  if (loop && (SELF_MATCH.test(command) || (PROCESS_LOOKUP.test(command) && SLEEP.test(command)))) {
    return 'Refused: polling `pgrep`/`pidof` in a loop; `pgrep -f`/`pkill -f` also match the loop\'s own command line, so the wait never ends. '
      + `Capture the PID once (\`pgrep -f '[n]ame'\`) or wait on the job's own completion signal. ${WAIT_ALTERNATIVE}`;
  }
  if (loop && SLEEP.test(command) && !DEADLINE.test(command)) {
    return `Refused: this polling loop sleeps with no deadline. ${WAIT_ALTERNATIVE}`;
  }
  return null;
}

const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);
const STASH_READS = new Set(['list', 'show']);
export const STASH_REFUSAL = 'git stash is refused: refs/stash is one stack shared by every worktree of the repository, '
  + 'so another lane can pop, drop or apply your work. Commit work in progress on your own branch instead (`git commit -m "WIP ..."`), and amend or squash it later.';

function splitShellSegments(command) {
  const segments = [];
  let current = [];
  let word = '';
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  const pushWord = () => { if (word) { current.push(word); word = ''; } };
  const pushSegment = () => { pushWord(); if (current.length) { segments.push(current); current = []; } };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (escaped) { word += ch; escaped = false; continue; }
    if (ch === '\\' && !inSingle) { escaped = true; continue; }
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (!inSingle && !inDouble) {
      if (ch === ';' || ch === '\n' || ch === '|' || ch === '&') {
        pushSegment();
        continue;
      }
      if (/\s/.test(ch)) { pushWord(); continue; }
    }
    word += ch;
  }
  pushSegment();
  return segments;
}

export function stashGuardReason(command) {
  if (typeof command !== 'string' || !/\bstash\b/.test(command)) return null;
  for (const words of splitShellSegments(command)) {
    let at = 0;
    while (at < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at]) || ['command', 'exec', 'env', 'nice', 'nohup'].includes(words[at]))) at++;
    if (words[at] !== 'git' && !words[at]?.endsWith('/git')) continue;
    let next = at + 1;
    while (next < words.length && words[next].startsWith('-')) next += GIT_VALUE_OPTIONS.has(words[next]) ? 2 : 1;
    if (words[next] === 'stash' && !STASH_READS.has(words[next + 1])) return STASH_REFUSAL;
  }
  return null;
}

export function extractCommand(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const input = payload.tool_input ?? payload.input ?? null;
  if (input && typeof input === 'object' && typeof input.command === 'string') return input.command;
  if (typeof payload.command === 'string') return payload.command;
  return null;
}

export function formatPreToolUseDeny(reason, agent = 'claude') {
  if (agent === 'codex') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    };
  }
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

export function evaluateHook(kind, payload, agent = 'claude') {
  const command = extractCommand(payload);
  if (!command) return null;
  let reason = null;
  if (kind === 'wait-guard') reason = waitGuardReason(command);
  else if (kind === 'stash-guard') reason = stashGuardReason(command);
  else if (kind === 'all') reason = waitGuardReason(command) ?? stashGuardReason(command);
  else throw new Error(`Unknown hook "${kind}". Choose wait-guard, stash-guard, or all.`);
  return reason ? formatPreToolUseDeny(reason, agent) : null;
}

export function runHookFromStdin(kind, agent = 'claude', stdinText) {
  const raw = stdinText ?? readFileSync(0, 'utf8');
  let payload;
  try { payload = JSON.parse(raw); } catch { return null; }
  return evaluateHook(kind, payload, agent);
}
