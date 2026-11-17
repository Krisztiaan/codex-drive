#!/usr/bin/env node
// Claude Code views of codex-drive: the SessionStart summary, the completion monitor and /codex-workers.
// Stateless: every fact comes from `codex-drive status`, `inbox` and `result`; nothing is stored here.
// Automatic output (session start, monitor, the /codex-workers overview) carries metadata only; message text
// appears only when a person asks for one worker with `/codex-workers <name>`.
// An entry is acknowledged only after its line has been written, so a failure or timeout leaves it unread.
// Usage: codex-workers.mjs session-start|follow [projectDir]
//        codex-workers.mjs show [projectDir] [name]
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// Parameters, each adjustable from the environment of the Claude Code session where noted.
const BIN = process.env.CODEX_DRIVE_BIN || 'codex-drive';     // CODEX_DRIVE_BIN: the codex-drive executable
const WINDOW = process.env.CODEX_WORKERS_SINCE || '24h';      // CODEX_WORKERS_SINCE: sessions with events this recent are inspected
const SCOPE = process.env.CODEX_WORKERS_CWD;                   // CODEX_WORKERS_CWD: directory scope; default the project, '/' for all
const positive = (value, fallback) => Number.isFinite(+value) && +value > 0 ? +value : fallback;
const SESSION_DEADLINE_MS = positive(process.env.CODEX_WORKERS_DEADLINE_MS, 5000); // CODEX_WORKERS_DEADLINE_MS: SessionStart budget
const SHOW_DEADLINE_MS = 30000; // /codex-workers budget, under the skill's 2-minute command limit
const RESERVE_MS = 1000;        // Of each budget, kept for listing and acknowledging after status and repairs
const CALL_TIMEOUT_MS = 20000;  // One codex-drive call, within the budget
const GRACE_MS = 500;           // Between SIGTERM and SIGKILL for a call past its time
const PARALLEL = 4;             // Repair calls at once
const MAX_LINES = 12;           // SessionStart summary
const MAX_LISTED = 50;          // Unread completions listed by /codex-workers; the rest stay unread
const RESULT_CHARS = 4000;      // Message shown by /codex-workers <name>; the rest is one `codex-drive result` away
const RECENT = 8;               // Acknowledged completions listed by /codex-workers
const SETTLED = new Set(['completed', 'failed', 'interrupted']);
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/; // codex-drive's own name alphabet

const clean = text => String(text ?? '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ' ');
const cut = (text, max) => text.length > max ? text.slice(0, max - 1) + '…' : text;
const label = item => clean(item.name ?? item.threadId);
const turnKey = item => `${item.threadId}@${item.turnId}`;
const firstLine = text => clean(text).split('\n').map(line => line.trim()).find(Boolean) ?? '';
const jsonLines = text => text.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
const seconds = ms => `${Math.round(ms / 100) / 10} s`;
const failureClass = failure => failure ? ` (${typeof failure === 'string' ? failure : failure.class})` : '';
// Metadata only: name, status, failure class, finish time and the command that reads exactly this turn (a newer
// turn of the same worker must not answer it); never message text.
const completion = entry => `${label(entry)} ${clean(entry.status)}${clean(failureClass(entry.failure))} at ${clean(entry.finishedAt)}; read it with codex-drive result ${label(entry)} --turn ${clean(entry.turnId)}`;
const emit = text => new Promise((resolve, reject) => process.stdout.write(text + '\n', error => error ? reject(error) : resolve()));

// One codex-drive call that ends by `until` (absolute ms): SIGTERM to its process group at the time, SIGKILL after
// GRACE_MS, and the promise settles once the child has exited. A call that cannot start before `until` never starts.
function run(args, until) {
  return new Promise(resolve => {
    const budget = Math.min(CALL_TIMEOUT_MS, until - Date.now());
    if (budget <= 0) { resolve({ code: null, stdout: '', stderr: '', timedOut: true }); return; }
    let stdout = '', stderr = '', timedOut = false, settled = false, killer;
    const child = spawn(BIN, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const signal = name => { try { process.kill(-child.pid, name); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
    const finish = value => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(killer); resolve(value); };
    const timer = setTimeout(() => { timedOut = true; signal('SIGTERM'); killer = setTimeout(() => signal('SIGKILL'), GRACE_MS); }, budget);
    child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
    child.once('error', error => finish({ code: null, stdout, stderr, missing: error.code === 'ENOENT', error }));
    // A killed call settles on exit: a descendant may still hold its pipes open.
    child.once('exit', code => { if (timedOut) { child.stdout.destroy(); child.stderr.destroy(); finish({ code, stdout, stderr, timedOut }); } });
    child.once('close', code => finish({ code, stdout, stderr, timedOut }));
  });
}
const why = (call, ms) => call.timedOut ? `did not finish within ${seconds(ms)}` : `failed: ${cut(firstLine(call.stderr) || `exit ${call.code}`, 160)}`;
async function sessions(scope, until, budget) {
  const call = await run(['status', '--json', '--cwd', scope, '--since', WINDOW], until);
  if (call.missing) return { missing: true };
  if (call.code === 0) try { return { list: JSON.parse(call.stdout) }; } catch {}
  return { failed: `codex-drive status ${why(call, budget)}` };
}
async function inbox(args, until, budget) {
  const call = await run(['inbox', ...args], until);
  if (call.code !== 0) throw new Error(`codex-drive inbox ${why(call, budget)}`);
  return jsonLines(call.stdout);
}
// Called only after the entries' lines were written.
async function acknowledge(entries, until) {
  if (entries.length) await run(['inbox', '--ack', ...entries.map(turnKey)], until);
}
// Settled turns that status reports but the outbox never recorded (a logger that died) are recorded by
// `codex-drive result`. Work stops being scheduled at `until`; what is left is repaired by a later run.
async function repairMissing(scope, list, until, budget) {
  const known = new Set((await inbox(['--cwd', scope], until, budget)).map(turnKey));
  const queue = list.filter(s => !s.refreshError && SETTLED.has(s.status) && s.turnId && !known.has(turnKey(s)));
  await Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
    while (queue.length && Date.now() < until) { const s = queue.shift(); await run(['result', s.name ?? s.threadId, '--turn', s.turnId, '--json'], until); }
  }));
}
function runningLines(scope, list) {
  const running = list.filter(s => !s.refreshError && s.status === 'running');
  const unreachable = list.filter(s => s.refreshError && s.status === 'running');
  const lines = [];
  if (running.length) {
    const names = running.map(label);
    let n = names.length;
    while (n > 1 && names.slice(0, n).join(', ').length > 150) n--;
    lines.push(`codex-drive: ${running.length} running under ${scope}: ${names.slice(0, n).join(', ')}${n < names.length ? ` (+${names.length - n} more)` : ''}`);
    const waiting = running.filter(s => s.pendingRequests?.length).map(label);
    if (waiting.length) lines.push(`codex-drive: waiting for an answer: ${cut(waiting.join(', '), 120)} (codex-drive pending <name>)`);
  }
  if (unreachable.length) lines.push(`codex-drive: ${unreachable.length} recorded as running but their server did not answer: ${cut(unreachable.map(label).join(', '), 120)}`);
  return lines;
}
// Status and repairs end RESERVE_MS before the deadline; listing and acknowledgement use the rest.
async function overview(scope, budget) {
  const deadline = Date.now() + budget, early = deadline - RESERVE_MS, lines = [];
  const found = await sessions(scope, early, budget - RESERVE_MS);
  if (found.missing) return { missing: true };
  if (found.list) {
    try { await repairMissing(scope, found.list, early, budget - RESERVE_MS); } catch (error) { lines.push(`codex-drive: ${error.message}`); }
  } else lines.push(`codex-drive: ${found.failed}; run codex-drive status --cwd ${scope}`);
  let unread = [];
  try { unread = await inbox(['--cwd', scope, '--unread'], deadline, budget); } catch (error) { lines.push(`codex-drive: ${error.message}`); }
  return { deadline, lines, list: found.list ?? [], unread };
}

async function sessionStart(scope) {
  const view = await overview(scope, SESSION_DEADLINE_MS);
  if (view.missing) return;
  const { deadline, unread } = view, lines = [...runningLines(scope, view.list), ...view.lines];
  let shown = [];
  if (unread.length) {
    lines.push(`codex-drive: ${unread.length} finished:`);
    const room = Math.max(2, MAX_LINES - lines.length);
    shown = unread.length > room ? unread.slice(-(room - 1)) : unread;
    for (const entry of shown) lines.push(`  ${completion(entry)}`);
    if (shown.length < unread.length) lines.push(`  ${unread.length - shown.length} more stay unread: /codex-workers`);
  }
  if (!lines.length) return;
  await emit(lines.join('\n'));
  await acknowledge(shown, deadline);
}

async function show(scope, name) {
  if (name) return showOne(name);
  const view = await overview(scope, SHOW_DEADLINE_MS);
  if (view.missing) { await emit('codex-drive was not found; install it on PATH or set CODEX_DRIVE_BIN.'); return; }
  const { deadline, list, unread } = view;
  const shown = unread.slice(-MAX_LISTED), unreadKeys = new Set(unread.map(turnKey));
  let recent = [];
  try { recent = (await inbox(['--cwd', scope, '--since', WINDOW], deadline, SHOW_DEADLINE_MS)).filter(e => !unreadKeys.has(turnKey(e))).slice(-RECENT); } catch {}
  const running = list.filter(s => s.status === 'running');
  const out = [...view.lines, `## Running under ${scope} (${running.length})`];
  for (const s of running) {
    const age = s.lastEventTime ? `last event ${Math.max(0, Math.round((Date.now() - Date.parse(s.lastEventTime)) / 1000))}s ago` : 'no event yet';
    out.push(`- ${label(s)} (${clean(s.model ?? '-')}, ${s.refreshError ? 'server did not answer' : s.pendingRequests?.length ? `waiting for ${s.pendingRequests.length} answer(s)` : age})`);
  }
  out.push('', `## Unread completions (${unread.length})`);
  for (const entry of shown) out.push(`- ${completion(entry)}`);
  if (shown.length < unread.length) out.push(`- ${unread.length - shown.length} earlier ones stay unread`);
  if (recent.length) { out.push('', `## Already read, last ${WINDOW} (${recent.length})`); for (const entry of recent) out.push(`- ${completion(entry)}`); }
  out.push('', "/codex-workers <name> shows a worker's latest turn in full.");
  await emit(out.join('\n'));
  await acknowledge(shown, deadline);
}
// The latest turn of one worker, in full: the only view that shows message text.
async function showOne(name) {
  if (!NAME.test(name)) { await emit(`Not a codex-drive worker name: ${cut(clean(name), 80)}`); return; }
  const deadline = Date.now() + SHOW_DEADLINE_MS;
  const call = await run(['result', name, '--json'], deadline);
  let result = null;
  try { result = JSON.parse(call.stdout); } catch {}
  if (call.missing) { await emit('codex-drive was not found; install it on PATH or set CODEX_DRIVE_BIN.'); return; }
  if (!result || call.timedOut) { await emit(`codex-drive result ${name} ${why(call, SHOW_DEADLINE_MS)}`); return; }
  const message = result.message == null ? '(no final message)' : clean(result.message);
  const header = `## ${label(result)} ${clean(result.status)}${clean(failureClass(result.failure))} ${clean(result.turnId ?? '-')}`;
  await emit(`${header}\n${cut(message, RESULT_CHARS)}${message.length > RESULT_CHARS ? `\n(truncated; full text: codex-drive result ${name})` : ''}`);
  if (result.turnId && SETTLED.has(result.status)) await acknowledge([result], deadline);
}

// The plugin monitor: one metadata line per new completion, acknowledged after it is written.
async function follow(scope) {
  const child = spawn(BIN, ['inbox', '--follow', '--unread', '--cwd', scope], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '', queue = Promise.resolve();
  const stop = code => { child.kill('SIGTERM'); process.exit(code); };
  for (const name of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.once(name, () => stop(0));
  process.stdout.on('error', () => stop(1)); // The session went away: stop the follower, acknowledge nothing more.
  child.stderr.on('data', d => { stderr += d; });
  createInterface({ input: child.stdout }).on('line', line => {
    queue = queue.then(async () => {
      const [entry] = jsonLines(line);
      if (!entry) return;
      await emit(`codex-drive: ${completion(entry)}`);
      await acknowledge([entry], Date.now() + CALL_TIMEOUT_MS);
    }).catch(() => stop(1)); // stdout gone: stop without acknowledging
  });
  const code = await new Promise(resolve => { child.once('error', error => resolve(error.code === 'ENOENT' ? 0 : 1)); child.once('close', resolve); });
  await queue;
  if (code) await emit(`codex-drive: completion monitor stopped: ${cut(firstLine(stderr) || `exit ${code}`, 160)}`).catch(() => {});
  process.exitCode = code ?? 1;
}

const [mode, dir, name] = process.argv.slice(2);
const scope = SCOPE || dir || process.env.CLAUDE_PROJECT_DIR || process.cwd();
const views = { 'session-start': () => sessionStart(scope), show: () => show(scope, name), follow: () => follow(scope) };
if (!views[mode]) { console.error('Usage: codex-workers.mjs session-start|follow [projectDir] | show [projectDir] [name]'); process.exit(2); }
// A view never fails its caller: a SessionStart hook or a skill's injected command that exits non-zero would
// block or abort, so errors become one line of output instead.
try { await views[mode](); }
catch (error) { await emit(`codex-drive: ${mode} failed: ${cut(firstLine(error.message), 160)}`).catch(() => {}); }
