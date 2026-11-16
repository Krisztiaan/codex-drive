#!/usr/bin/env node
// Claude Code views of codex-drive: the SessionStart summary and the /codex-workers report.
// Stateless: every fact comes from `codex-drive status`, `inbox` and `result`; nothing is stored here.
// Usage: codex-workers.mjs session-start|show [projectDir]
import { spawn } from 'node:child_process';

// Parameters, each adjustable from the environment of the Claude Code session.
const BIN = process.env.CODEX_DRIVE_BIN || 'codex-drive';     // CODEX_DRIVE_BIN: the codex-drive executable
const WINDOW = process.env.CODEX_WORKERS_SINCE || '24h';      // CODEX_WORKERS_SINCE: sessions with events this recent are inspected
const SCOPE = process.env.CODEX_WORKERS_CWD;                   // CODEX_WORKERS_CWD: directory scope; default the project, '/' for all
const MAX_LINES = 12;          // SessionStart summary budget
const HEADLINE_CHARS = 120;    // One-line summary of a final message
const RESULT_CHARS = 4000;     // Full message in /codex-workers; the rest stays one `codex-drive result` away
const RECENT = 8;              // Already acknowledged completions listed by /codex-workers
const CALL_TIMEOUT_MS = 20000; // Per codex-drive call
const PARALLEL = 4;            // codex-drive result calls at once
const SETTLED = new Set(['completed', 'failed', 'interrupted']);

const clean = text => String(text ?? '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ' ');
const cut = (text, max) => text.length > max ? text.slice(0, max - 1) + '…' : text;
const label = item => clean(item.name ?? item.threadId);
const turnKey = item => `${item.threadId}@${item.turnId}`;
const jsonLines = text => text.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
function headline(message) {
  const first = clean(message).split(/\r?\n/).map(line => line.replace(/^[\s>#*-]+/, '').trim()).find(Boolean);
  return first ? cut(first, HEADLINE_CHARS) : '';
}

function run(args) {
  return new Promise(resolve => {
    let stdout = '', stderr = '';
    const child = spawn(BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    // Spawn's own timeout option keeps its timer after a failed spawn; this one never holds the process open.
    const timer = setTimeout(() => child.kill('SIGTERM'), CALL_TIMEOUT_MS); timer.unref();
    child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
    child.once('error', error => { clearTimeout(timer); resolve({ code: null, stdout, stderr, missing: error.code === 'ENOENT', error }); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}
const firstLine = text => clean(text).split('\n').map(line => line.trim()).find(Boolean) ?? '';
async function sessions(scope) {
  const status = await run(['status', '--json', '--cwd', scope, '--since', WINDOW]);
  if (status.missing) return { missing: true };
  try { return { list: JSON.parse(status.stdout) }; }
  catch { return { failed: firstLine(status.stderr) || `exit ${status.code}` }; }
}
async function each(items, work) {
  const queue = [...items], out = [];
  await Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => { while (queue.length) { const item = queue.shift(); out.push([item, await work(item)]); } }));
  return new Map(out);
}
// One `result --json` per turn. It also records a settled turn missing from the outbox (a logger that died).
async function result(item) {
  const call = await run(['result', item.name ?? item.threadId, '--turn', item.turnId, '--json']);
  try { return JSON.parse(call.stdout); } catch { return null; }
}
// Inbox entries; an inbox that fails (an older codex-drive without --cwd, say) stops the view rather than
// reading as empty, which would make every settled session look unrecorded.
async function inbox(args) {
  const call = await run(['inbox', ...args]);
  if (call.code !== 0) throw new Error(`inbox failed: ${firstLine(call.stderr) || `exit ${call.code}`}`);
  return jsonLines(call.stdout);
}
const outcome = item => `${item.status}${item.failure ? ` (${typeof item.failure === 'string' ? item.failure : item.failure.class})` : ''}`;

// Settled turns that codex-drive status reports but the outbox never recorded are repaired with `result`.
async function repairMissing(scope, list) {
  const known = new Set((await inbox(['--cwd', scope])).map(turnKey));
  const missing = list.filter(s => !s.refreshError && SETTLED.has(s.status) && s.turnId && !known.has(turnKey(s)));
  return new Map([...await each(missing, result)].map(([s, r]) => [turnKey(s), r]));
}
async function withResults(entries, known) {
  const fetched = await each(entries.filter(entry => !known.has(turnKey(entry))), result);
  return entries.map(entry => ({ entry, result: known.get(turnKey(entry)) ?? fetched.get(entry) }));
}
function runningLines(scope, list) {
  const running = list.filter(s => !s.refreshError && s.status === 'running');
  const unreachable = list.filter(s => s.refreshError && s.status === 'running');
  const lines = [];
  if (running.length) {
    const names = running.map(label);
    let shown = names.join(', ');
    if (shown.length > 160) { let n = names.length; while (n > 1 && names.slice(0, n).join(', ').length > 150) n--; shown = `${names.slice(0, n).join(', ')} (+${names.length - n} more)`; }
    lines.push(`codex-drive: ${running.length} running under ${scope}: ${shown}`);
    const waiting = running.filter(s => s.pendingRequests?.length).map(label);
    if (waiting.length) lines.push(`codex-drive: waiting for an answer: ${waiting.join(', ')} (codex-drive pending <name>)`);
  }
  if (unreachable.length) lines.push(`codex-drive: ${unreachable.length} recorded as running but their server did not answer: ${cut(unreachable.map(label).join(', '), 120)}`);
  return lines;
}

async function sessionStart(scope) {
  const found = await sessions(scope);
  if (found.missing) return [];
  if (found.failed) return [`codex-drive: status failed: ${cut(found.failed, 160)}`];
  const repaired = await repairMissing(scope, found.list);
  const unread = await inbox(['--cwd', scope, '--unread', '--ack']);
  const lines = runningLines(scope, found.list);
  if (!unread.length) return lines;
  lines.push(`codex-drive: ${unread.length} finished while no session followed (full text: codex-drive result <name>):`);
  const room = Math.max(2, MAX_LINES - lines.length), shown = unread.length > room ? unread.slice(-(room - 1)) : unread;
  for (const { entry, result: r } of await withResults(shown, repaired)) {
    const summary = headline(r?.message);
    lines.push(`  ${label(entry)} ${outcome(entry)}${summary ? ` - ${summary}` : ''}`);
  }
  if (shown.length < unread.length) lines.push(`  ${unread.length - shown.length} earlier: codex-drive inbox --cwd ${scope}`);
  return lines;
}

async function show(scope) {
  const found = await sessions(scope);
  if (found.missing) return [`codex-drive was not found; install it on PATH or set CODEX_DRIVE_BIN.`];
  if (found.failed) return [`codex-drive status failed: ${found.failed}`];
  const repaired = await repairMissing(scope, found.list);
  const unread = await inbox(['--cwd', scope, '--unread', '--ack']);
  const unreadKeys = new Set(unread.map(turnKey));
  const recent = (await inbox(['--cwd', scope, '--since', WINDOW])).filter(e => !unreadKeys.has(turnKey(e))).slice(-RECENT);
  const running = found.list.filter(s => s.status === 'running');
  const out = [`## Running under ${scope} (${running.length})`];
  for (const s of running) {
    const age = s.lastEventTime ? `${Math.max(0, Math.round((Date.now() - Date.parse(s.lastEventTime)) / 1000))}s` : '-';
    const state = s.refreshError ? 'server did not answer' : s.pendingRequests?.length ? `waiting for ${s.pendingRequests.length} answer(s)` : `last event ${age} ago`;
    out.push(`- ${label(s)} (${clean(s.model ?? '-')}, ${state}): ${cut(clean(s.lastAgentMessage ?? ''), HEADLINE_CHARS)}`);
  }
  out.push('', `## Unread results (${unread.length})`);
  for (const { entry, result: r } of await withResults(unread, repaired)) {
    out.push('', `### ${label(entry)} ${outcome(entry)} ${entry.turnId} (${entry.finishedAt})`);
    const message = r?.message == null ? '(no final message)' : clean(r.message);
    out.push(cut(message, RESULT_CHARS) + (message.length > RESULT_CHARS ? `\n(truncated; full text: codex-drive result ${label(entry)} --turn ${entry.turnId})` : ''));
  }
  if (recent.length) {
    out.push('', `## Already read, last ${WINDOW} (${recent.length})`);
    for (const { entry, result: r } of await withResults(recent, new Map())) {
      const summary = headline(r?.message);
      out.push(`- ${label(entry)} ${outcome(entry)} ${entry.finishedAt}${summary ? ` - ${summary}` : ''}`);
    }
  }
  return out;
}

const [mode, dir] = process.argv.slice(2);
const scope = SCOPE || dir || process.env.CLAUDE_PROJECT_DIR || process.cwd();
const views = { 'session-start': sessionStart, show };
if (!views[mode]) { console.error('Usage: codex-workers.mjs session-start|show [projectDir]'); process.exit(2); }
// A view never fails its caller: a SessionStart hook or a skill's injected command that exits non-zero would
// block or abort, so errors become one line of output instead.
try { const lines = await views[mode](scope); if (lines.length) console.log(lines.join('\n')); }
catch (error) { console.log(`codex-drive: ${mode} failed: ${cut(firstLine(error.message), 160)}`); }
