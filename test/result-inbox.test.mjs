import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, utimesSync, mkdirSync, mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { fixture, until } from '../test-support/app-server.mjs';
import { recordCompletion, readCompletions, outboxDir, follow } from '../src/outbox.mjs';
import { underDir } from '../src/views.mjs';

const lines = text => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const files = home => { try { return readdirSync(outboxDir(home)).sort(); } catch { return []; } };
const turn = (turnId, overrides = {}) => ({ name: 'demo', threadId: 'thread-1', turnId, cwd: '/tmp', status: 'completed', error: null, ...overrides });
async function closedPort() {
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address(); await new Promise(resolve => server.close(resolve)); return port;
}

test('result prints the full multi-line final message of the latest turn and of a named turn', async t => {
  const f = await fixture(t);
  f.turns[0].items = [{ type: 'agentMessage', id: 'm-1', text: 'Earlier note' }, { type: 'agentMessage', id: 'm-2', text: 'Line one\nLine two\n\nLine four' }];
  f.turns.push({ id: 'turn-2', status: 'completed', items: [{ type: 'agentMessage', id: 'm-3', text: 'SECOND\nturn' }], error: null });
  const latest = await f.command(['result', 'demo']);
  assert.equal(latest.code, 0, latest.stderr);
  assert.equal(latest.stdout, 'demo completed turn-2\nSECOND\nturn\n');
  const named = await f.command(['result', 'demo', '--turn', 'turn-1', '--json']);
  assert.equal(named.code, 0, named.stderr);
  const json = JSON.parse(named.stdout);
  assert.equal(json.name, 'demo'); assert.equal(json.threadId, 'thread-1'); assert.equal(json.turnId, 'turn-1');
  assert.equal(json.status, 'completed'); assert.equal(json.message, 'Line one\nLine two\n\nLine four'); assert.equal(json.source, 'server');
  f.turns.push({ id: 'turn-3', status: 'inProgress', items: [], error: null });
  // A newer running turn is the latest turn: not finished, never an older settled turn.
  const latestRunning = await f.command(['result', 'thread-1']);
  assert.equal(latestRunning.code, 3, latestRunning.stderr); assert.equal(latestRunning.stdout, 'demo running turn-3\n');
  const running = await f.command(['result', 'demo', '--turn', 'turn-3']);
  assert.equal(running.code, 3); assert.equal(running.stdout, 'demo running turn-3\n');
});

test('result exits 1 for a failed turn, prints its partial message and keeps a saved failure', async t => {
  const f = await fixture(t);
  f.turns[0].status = 'failed'; f.turns[0].error = { message: 'Backend failed', codexErrorInfo: 'usageLimitExceeded', additionalDetails: null };
  f.turns[0].items = [{ type: 'agentMessage', id: 'm-1', text: 'PARTIAL\nwork so far' }];
  const result = await f.command(['result', 'demo']);
  assert.equal(result.code, 1, result.stderr);
  assert.equal(result.stdout, 'demo failed turn-1 usageLimit\nPARTIAL\nwork so far\n');
  const json = JSON.parse((await f.command(['result', 'demo', '--json'])).stdout);
  assert.equal(json.status, 'failed'); assert.equal(json.failure.class, 'usageLimit'); assert.equal(json.message, 'PARTIAL\nwork so far');
  // A history snapshot that lost the error does not erase the logger's saved failure.
  f.turns[0].status = 'interrupted'; f.turns[0].error = null;
  f.seed({ status: 'failed', error: { message: 'limit', codexErrorInfo: 'serverOverloaded', additionalDetails: null } });
  assert.match((await f.command(['result', 'demo'])).stdout, /^demo failed turn-1 capacity\n/);
});

test('result exits 2 for an unknown name or turn and 3 while nothing has settled', async t => {
  const f = await fixture(t);
  const unknown = await f.command(['result', 'nobody']);
  assert.equal(unknown.code, 2); assert.match(unknown.stderr, /Unknown thread: nobody/);
  const unknownTurn = await f.command(['result', 'demo', '--turn', 'turn-99']);
  assert.equal(unknownTurn.code, 2); assert.match(unknownTurn.stderr, /turn-99/);
  f.turns[0].status = 'inProgress'; f.turns[0].items = [];
  const running = await f.command(['result', 'demo']);
  assert.equal(running.code, 3, running.stderr);
  assert.equal(running.stdout, 'demo running turn-1\n');
  const wrongPort = await f.command(['result', 'demo', '--port', String(await closedPort())]);
  assert.equal(wrongPort.code, 1); assert.match(wrongPort.stderr, /Port differs/);
});

test('result reads a log-only session when its server is gone, including recovered completions', async t => {
  const f = await fixture(t);
  f.seed({ port: await closedPort(), status: 'running', turnId: 'turn-9' });
  const events = [
    { method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-7', status: 'inProgress', items: [], error: null } } },
    { method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-7', item: { type: 'agentMessage', id: 'a', text: 'Draft' } } },
    { method: 'item/completed', params: { threadId: 'other', turnId: 'turn-7', item: { type: 'agentMessage', id: 'b', text: 'NOT MINE' } } },
    { method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-7', item: { type: 'agentMessage', id: 'c', text: 'Final\nanswer' } } },
    { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-7', status: 'completed', items: [], error: null } } },
    { method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-8', status: 'inProgress', items: [], error: null } } },
    { method: 'driver/reconnected', params: { threadId: 'thread-1', turnId: 'turn-8', status: 'interrupted' } },
    { method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-9', status: 'inProgress', items: [], error: null } } },
  ];
  writeFileSync(f.state.logPath, events.map(e => JSON.stringify(e)).join('\n') + '\n');
  const latest = await f.command(['result', 'demo']);
  assert.equal(latest.code, 3, latest.stderr); assert.equal(latest.stdout, 'demo running turn-9\n');
  const interrupted = await f.command(['result', 'demo', '--turn', 'turn-8']);
  assert.equal(interrupted.code, 1, interrupted.stderr); assert.equal(interrupted.stdout, 'demo interrupted turn-8\n');
  const named = await f.command(['result', 'demo', '--turn', 'turn-7', '--json']);
  assert.equal(named.code, 0, named.stderr);
  const json = JSON.parse(named.stdout);
  assert.equal(json.message, 'Final\nanswer'); assert.equal(json.source, 'log'); assert.equal(json.status, 'completed');
  const unfinished = await f.command(['result', 'demo', '--turn', 'turn-9']);
  assert.equal(unfinished.code, 3, unfinished.stderr); assert.equal(unfinished.stdout, 'demo running turn-9\n');
});

test('a detached logger records the completion with no client waiting, without message text', async t => {
  const f = await fixture(t);
  const started = await f.command(['start', '--port', String(f.port), '--cwd', f.home, '--name', 'bg', '--detach', 'Go']);
  assert.equal(started.code, 0, started.stderr);
  const ids = JSON.parse(started.stdout);
  f.complete('completed', 'SECRET-TOKEN in the final answer');
  const [done] = await until(() => readCompletions(f.home).length && readCompletions(f.home), 'outbox entry');
  assert.deepEqual(Object.keys(done).sort(), ['cwd', 'exitCode', 'failure', 'finishedAt', 'name', 'status', 'threadId', 'turnId']);
  assert.equal(done.name, 'bg'); assert.equal(done.threadId, ids.threadId); assert.equal(done.turnId, ids.turnId);
  assert.equal(done.status, 'completed'); assert.equal(done.exitCode, 0); assert.equal(done.failure, null);
  assert.ok(!Number.isNaN(Date.parse(done.finishedAt)));
  assert.ok(!files(f.home).some(name => readFileSync(join(outboxDir(f.home), name), 'utf8').includes('SECRET')));
  const full = await f.command(['result', 'bg']);
  assert.equal(full.code, 0, full.stderr); assert.equal(full.stdout, `bg completed ${ids.turnId}\nSECRET-TOKEN in the final answer\n`);

  assert.equal((await f.command(['resume', 'bg', '--detach', 'Again'])).code, 0);
  const last = f.turns.at(-1);
  f.complete('failed', 'Stopped early', last, { message: 'limit', codexErrorInfo: 'usageLimitExceeded', additionalDetails: null });
  const failed = await until(() => readCompletions(f.home).find(e => e.turnId === last.id), 'failed outbox entry');
  assert.equal(failed.status, 'failed'); assert.equal(failed.failure, 'usageLimit'); assert.equal(failed.exitCode, 76);
  assert.equal(readCompletions(f.home).length, 2);
});

test('adopting an already finished turn does not announce it', async t => {
  const f = await fixture(t);
  const adopted = await f.command(['adopt', 'demo']);
  assert.equal(adopted.code, 0, adopted.stderr);
  assert.deepEqual(files(f.home), []);
});

test('wait and result repair the entry of a logger that died', async t => {
  const f = await fixture(t);
  f.turns[0].status = 'inProgress'; f.turns[0].items = []; f.seed({ status: 'running' });
  const waiter = f.launch(['wait', 'demo']);
  await until(() => f.hasRead(), 'wait snapshot');
  const done = Math.floor(Date.now() / 1000) - 100;
  f.turns[0].completedAt = done;
  f.complete('completed', 'DONE');
  assert.equal((await waiter.result).code, 0);
  assert.deepEqual(readCompletions(f.home).map(e => [e.turnId, e.status, e.finishedAt]), [['turn-1', 'completed', new Date(done * 1000).toISOString()]]);
  f.turns.push({ id: 'turn-2', status: 'failed', items: [], completedAt: done + 5, error: { message: 'x', codexErrorInfo: 'serverOverloaded', additionalDetails: null } });
  assert.equal((await f.command(['result', 'demo'])).code, 1);
  const repaired = readCompletions(f.home).find(e => e.turnId === 'turn-2');
  assert.equal(repaired.status, 'failed'); assert.equal(repaired.failure, 'capacity'); assert.equal(repaired.exitCode, 75);
  assert.equal(repaired.finishedAt, new Date((done + 5) * 1000).toISOString(), 'the server completion time, not the observation time');
  assert.equal((await f.command(['result', 'demo', '--turn', 'turn-2'])).code, 1);
  assert.equal(readCompletions(f.home).length, 2, 'a second read records nothing new');
});

test('recording is idempotent per thread and turn', async t => {
  const f = await fixture(t);
  const first = recordCompletion(f.home, turn('turn-a'), { finishedAt: Date.parse('2026-11-16T10:00:00.000Z') });
  const second = recordCompletion(f.home, turn('turn-a', { status: 'failed' }), { finishedAt: Date.parse('2026-11-16T11:00:00.000Z') });
  assert.equal(second, first);
  assert.deepEqual(files(f.home), ['thread-1@turn-a.json']);
  const [kept] = readCompletions(f.home);
  assert.equal(kept.status, 'completed'); assert.equal(kept.finishedAt, '2026-11-16T10:00:00.000Z');
  assert.equal(recordCompletion(f.home, turn('turn-b', { status: 'running' })), null);
  assert.equal(recordCompletion(f.home, turn('turn-b', { status: 'idle' })), null);
  assert.deepEqual(files(f.home), ['thread-1@turn-a.json']);
});

test('inbox orders by finish time and pruning counts distinct turns', async t => {
  const f = await fixture(t);
  const base = Date.now() - 60000;
  recordCompletion(f.home, turn('turn-z'), { finishedAt: base, maxEntries: 3 });
  recordCompletion(f.home, turn('turn-a'), { finishedAt: base + 1000, maxEntries: 3 });
  recordCompletion(f.home, turn('turn-a'), { finishedAt: base + 1500, maxEntries: 3 });
  recordCompletion(f.home, turn('turn-m'), { finishedAt: base + 2000, maxEntries: 3 });
  assert.deepEqual(lines((await f.command(['inbox'])).stdout).map(e => e.turnId), ['turn-z', 'turn-a', 'turn-m']);
  recordCompletion(f.home, turn('turn-b'), { finishedAt: base + 3000, maxEntries: 3 });
  assert.deepEqual(readCompletions(f.home).map(e => e.turnId), ['turn-a', 'turn-m', 'turn-b']);
  assert.deepEqual(files(f.home), ['thread-1@turn-a.json', 'thread-1@turn-b.json', 'thread-1@turn-m.json']);
  // A repaired turn already past the retention age is not published.
  assert.equal(recordCompletion(f.home, turn('turn-old'), { finishedAt: Date.now() - 20 * 86400000 }), null);
});

test('follow prints a completion published between its baseline scan and its watch', async t => {
  const f = await fixture(t);
  recordCompletion(f.home, turn('turn-before'));
  const printed = [], stop = new AbortController();
  const running = follow(f.home, {}, entry => printed.push(entry.turnId), { signal: stop.signal, afterBaseline: () => recordCompletion(f.home, turn('turn-during')) });
  await until(() => printed.includes('turn-during'), 'startup-gap completion');
  recordCompletion(f.home, turn('turn-after'));
  await until(() => printed.includes('turn-after'), 'watched completion');
  stop.abort(); await running;
  assert.deepEqual(printed, ['turn-during', 'turn-after']);
});

test('a crash between the temp write and the rename leaves no visible entry and is cleaned up', async t => {
  const f = await fixture(t);
  recordCompletion(f.home, turn('turn-a'));
  const crashed = join(outboxDir(f.home), '.crashed-writer.tmp');
  writeFileSync(crashed, '{"name":"half');
  const listed = await f.command(['inbox']);
  assert.equal(listed.code, 0, listed.stderr); assert.equal(listed.stderr, '');
  assert.deepEqual(lines(listed.stdout).map(e => e.turnId), ['turn-a']);
  utimesSync(crashed, new Date(Date.now() - 2 * 3600000), new Date(Date.now() - 2 * 3600000));
  recordCompletion(f.home, turn('turn-b'));
  assert.ok(!files(f.home).includes('.crashed-writer.tmp'), 'stale temp pruned at the next write');
  assert.deepEqual(readCompletions(f.home).map(e => e.turnId), ['turn-a', 'turn-b']);
});

test('inbox lists entries by name, filters --unread and --since, and --ack marks them read', async t => {
  const f = await fixture(t);
  recordCompletion(f.home, turn('turn-old'), { finishedAt: Date.now() - 3 * 3600000 });
  recordCompletion(f.home, turn('turn-a'));
  const all = await f.command(['inbox']);
  assert.equal(all.code, 0, all.stderr); assert.deepEqual(lines(all.stdout).map(e => e.turnId), ['turn-old', 'turn-a']);
  assert.deepEqual(lines((await f.command(['inbox', '--since', '1h'])).stdout).map(e => e.turnId), ['turn-a']);
  assert.deepEqual(lines((await f.command(['inbox', '--unread'])).stdout).map(e => e.turnId), ['turn-old', 'turn-a']);
  const acked = await f.command(['inbox', '--unread', '--ack']);
  assert.equal(acked.code, 0, acked.stderr); assert.equal(lines(acked.stdout).length, 2);
  assert.equal((await f.command(['inbox', '--unread'])).stdout, '');
  recordCompletion(f.home, turn('turn-b'));
  assert.deepEqual(lines((await f.command(['inbox', '--unread'])).stdout).map(e => e.turnId), ['turn-b']);
  assert.equal(lines((await f.command(['inbox'])).stdout).length, 3);
  assert.equal((await f.command(['inbox', '--unread', '--since', '1h'])).code, 1);
});

test('inbox --follow prints each new completion once across many entries', async t => {
  const f = await fixture(t);
  recordCompletion(f.home, turn('turn-backlog'));
  const follower = f.launch(['inbox', '--follow', '--unread', '--ack']);
  await until(() => follower.stdout().includes('turn-backlog'), 'backlog line');
  const expected = ['turn-backlog'];
  for (let i = 0; i < 60; i++) { recordCompletion(f.home, turn(`turn-n${i}`)); expected.push(`turn-n${i}`); }
  recordCompletion(f.home, turn('turn-n5')); // A duplicate recording prints nothing new.
  await until(() => lines(follower.stdout()).length >= expected.length, 'all followed lines');
  await new Promise(resolve => setTimeout(resolve, 200));
  const seen = lines(follower.stdout()).map(e => e.turnId);
  assert.equal(seen.length, expected.length); assert.deepEqual(new Set(seen), new Set(expected));
  follower.child.kill('SIGTERM');
  assert.equal((await f.command(['inbox', '--unread'])).stdout, '', 'the follower acknowledged what it printed');
});

test('recording prunes entries past the declared age and count, with their acknowledgements', async t => {
  const f = await fixture(t);
  recordCompletion(f.home, turn('turn-ancient'), { finishedAt: Date.now() - 20 * 86400000, maxAge: '30d' });
  assert.equal((await f.command(['inbox', '--ack'])).code, 0);
  assert.ok(files(f.home).includes('thread-1@turn-ancient.acked'));
  for (let i = 0; i < 8; i++) recordCompletion(f.home, turn(`turn-${i}`), { finishedAt: Date.now() - (8 - i) * 2000, maxEntries: 5 });
  assert.deepEqual(readCompletions(f.home).map(e => e.turnId), ['turn-3', 'turn-4', 'turn-5', 'turn-6', 'turn-7']);
  assert.ok(!files(f.home).some(name => name.includes('turn-ancient')), 'entry older than 14 days and its marker pruned');
  recordCompletion(f.home, turn('turn-x'), { maxAge: '1s', finishedAt: Date.now() });
  assert.deepEqual(readCompletions(f.home).map(e => e.turnId), ['turn-x']);
});

test('concurrent writers never corrupt or duplicate the outbox', async t => {
  const f = await fixture(t);
  const writer = new URL('../src/outbox.mjs', import.meta.url).href;
  // Every writer spins until the same instant, then publishes, so recorders really race.
  const script = `import { recordCompletion } from ${JSON.stringify(writer)};
    const [home, id, shared, at] = process.argv.slice(1);
    while (Date.now() < Number(at)) {}
    for (let i = 0; i < 40; i++) recordCompletion(home, { name: 'w' + id, threadId: 't' + (shared ? 'shared' : id), turnId: 'turn' + i, cwd: '/', status: 'completed', error: null });`;
  const run = shared => { const at = Date.now() + 400; return Promise.all(Array.from({ length: 8 }, (_, id) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, f.home, String(id), shared, String(at)], { stdio: ['ignore', 'ignore', 'inherit'] });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`writer exited ${code}`)));
  }))); };
  await run('');
  assert.equal(files(f.home).length, 320);
  await run('1');
  const physical = files(f.home).filter(name => name.startsWith('tshared@'));
  assert.equal(physical.length, 40, 'one physical file per turn');
  assert.deepEqual(physical, Array.from({ length: 40 }, (_, i) => `tshared@turn${i}.json`).sort());
  for (const name of physical) JSON.parse(readFileSync(join(outboxDir(f.home), name), 'utf8'));
  assert.ok(!files(f.home).some(name => name.endsWith('.tmp')), 'no temp files left behind');
});

test('help documents result exit codes and the inbox', async t => {
  const f = await fixture(t);
  const help = await f.command(['--help']);
  assert.match(help.stdout, /result <name\|threadId> \[--turn <id>\] \[--json\]/);
  assert.match(help.stdout, /inbox \[<threadId@turnId>\.\.\.\] \[--follow\] \[--since <time>\|--unread\] \[--ack\] \[--cwd prefix\]/);
  assert.match(help.stdout, /Result exits: completed 0, failed or interrupted 1, unknown name or turn 2, not finished 3/);
});

test('result falls back to the log only for a missing thread and reports other RPC errors', async t => {
  let error = null;
  const f = await fixture(t, { turnsListError: () => error });
  const events = [
    { receivedAt: '2026-11-10T08:00:00.000Z', method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-5', status: 'inProgress', items: [], error: null } } },
    { receivedAt: '2026-11-10T08:00:01.000Z', method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-5', item: { type: 'agentMessage', id: 'a', text: 'FROM LOG' } } },
    { receivedAt: '2026-11-10T08:00:02.000Z', method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-5', status: 'completed', items: [], error: null } } },
  ];
  writeFileSync(f.state.logPath, events.map(e => JSON.stringify(e)).join('\n') + '\n');
  error = { code: -32603, message: 'internal error' };
  const internal = await f.command(['result', 'demo']);
  assert.equal(internal.code, 1); assert.match(internal.stderr, /internal error/); assert.equal(internal.stdout, '');
  error = { code: -32600, message: 'thread not found: thread-1' };
  const missing = await f.command(['result', 'demo', '--json']);
  assert.equal(missing.code, 0, missing.stderr);
  const json = JSON.parse(missing.stdout);
  assert.equal(json.source, 'log'); assert.equal(json.message, 'FROM LOG');
  assert.equal(readCompletions(f.home).find(e => e.turnId === 'turn-5').finishedAt, '2026-11-10T08:00:02.000Z', 'the journal completion time');
});

test('a completion recovered after a disconnect keeps its full message for a log-only result', async t => {
  const f = await fixture(t);
  assert.equal((await f.command(['resume', 'demo', '--detach', 'Go'])).code, 0);
  const current = f.turns.at(-1);
  f.disconnect();
  f.complete('completed', 'RECOVERED\nfull answer', current);
  await until(() => JSON.parse(readFileSync(join(f.home, 'threads/demo.json'), 'utf8')).status === 'completed', 'recovered completion');
  await until(() => readCompletions(f.home).some(e => e.turnId === current.id), 'logger outbox entry');
  const saved = JSON.parse(readFileSync(join(f.home, 'threads/demo.json'), 'utf8'));
  writeFileSync(join(f.home, 'threads/demo.json'), JSON.stringify({ ...saved, port: await closedPort() })); // The server is gone.
  const result = await f.command(['result', 'demo', '--json']);
  assert.equal(result.code, 0, result.stderr);
  const json = JSON.parse(result.stdout);
  assert.equal(json.source, 'log'); assert.equal(json.turnId, current.id); assert.equal(json.message, 'RECOVERED\nfull answer');
});

test('a failed outbox write never changes the logger exit code', async t => {
  const f = await fixture(t);
  writeFileSync(join(f.home, 'outbox'), 'not a directory');
  const logger = f.launch(['resume', 'demo', 'Go']);
  await until(() => f.turns.length === 2 && f.turns[1].status === 'inProgress', 'turn started');
  await delay(100);
  f.complete('completed', 'DONE');
  const result = await logger.result;
  assert.equal(result.code, 0, result.stderr);
  assert.match(readFileSync(f.state.logPath, 'utf8'), /Outbox entry not recorded/);
});

test('completion file names keep thread and turn pairs distinct even when ids contain hyphens', async () => {
  const { mkdtempSync, readdirSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { recordCompletion } = await import('../src/outbox.mjs');
  const home = mkdtempSync(join(tmpdir(), 'cd-outbox-pair-'));
  try {
    recordCompletion(home, { threadId: 'a-b', turnId: 'c', status: 'completed' });
    recordCompletion(home, { threadId: 'a', turnId: 'b-c', status: 'completed' });
    const files = readdirSync(join(home, 'outbox')).filter(n => n.endsWith('.json'));
    assert.equal(files.length, 2, files.join(','));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('inbox --cwd keeps entries from that directory and below, for listing, acknowledging and following', async t => {
  const f = await fixture(t);
  recordCompletion(f.home, turn('turn-here', { cwd: '/work/project' }));
  recordCompletion(f.home, turn('turn-below', { cwd: '/work/project/.worktrees/lane' }));
  recordCompletion(f.home, turn('turn-sibling', { cwd: '/work/project-other' }));
  const listed = await f.command(['inbox', '--cwd', '/work/project', '--unread', '--ack']);
  assert.equal(listed.code, 0, listed.stderr);
  assert.deepEqual(lines(listed.stdout).map(e => e.turnId).sort(), ['turn-below', 'turn-here']);
  assert.deepEqual(lines((await f.command(['inbox', '--unread'])).stdout).map(e => e.turnId), ['turn-sibling'], 'only the printed entries were acknowledged');
  const follower = f.launch(['inbox', '--follow', '--cwd', '/work/project/']);
  await delay(200);
  recordCompletion(f.home, turn('turn-later-sibling', { cwd: '/work/project-other' }));
  recordCompletion(f.home, turn('turn-later', { cwd: '/work/project' }));
  await until(() => follower.stdout().includes('turn-later'), 'followed project entry');
  await delay(100);
  follower.child.kill('SIGTERM');
  assert.deepEqual(lines(follower.stdout()).map(e => e.turnId), ['turn-later']);
});

test('--cwd compares directories with symlinks resolved on both sides, including removed paths, at segment boundaries', t => {
  mkdirSync('/tmp/codex-drive-proof', { recursive: true });
  const root = mkdtempSync('/tmp/codex-drive-proof/cwd-'); // /tmp is itself a symlink on macOS
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'proj/lane'), { recursive: true }); mkdirSync(join(root, 'proj2'));
  symlinkSync(join(root, 'proj'), join(root, 'link'));
  const viaLink = underDir(join(root, 'link')), viaReal = underDir(join(root, 'proj'));
  assert.ok(viaLink(join(root, 'proj/lane')), 'symlinked prefix, real recorded path');
  assert.ok(viaReal(join(root, 'link/lane')), 'real prefix, symlinked recorded path');
  assert.ok(viaReal(join(root, 'link')), 'the directory itself');
  assert.ok(viaReal(join(root, 'link/removed/deeper')), 'a removed worktree under a symlinked spelling');
  assert.ok(underDir(join(root, 'link/removed'))(join(root, 'proj/removed/x')), 'a removed prefix');
  assert.ok(!viaReal(join(root, 'proj2')) && !viaLink(join(root, 'proj2/x')), 'a sibling sharing the prefix spelling');
  assert.ok(!viaReal(null) && !viaReal(root), 'no cwd, or the parent');
});

test('inbox entry keys narrow a listing so --ack acknowledges exactly the delivered entries', async t => {
  const f = await fixture(t);
  for (const id of ['turn-a', 'turn-b', 'turn-c']) recordCompletion(f.home, turn(id));
  const acked = await f.command(['inbox', '--ack', 'thread-1@turn-b', 'thread-1@turn-missing']);
  assert.equal(acked.code, 0, acked.stderr);
  assert.deepEqual(lines(acked.stdout).map(e => e.turnId), ['turn-b']);
  assert.deepEqual(lines((await f.command(['inbox', '--unread'])).stdout).map(e => e.turnId), ['turn-a', 'turn-c']);
  const following = await f.command(['inbox', '--follow', 'thread-1@turn-a']);
  assert.notEqual(following.code, 0); assert.match(following.stderr, /takes no entry keys/);
});
