import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, until } from '../test-support/app-server.mjs';
import { recordCompletion, readCompletions, outboxDir } from '../src/outbox.mjs';

const lines = text => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const files = home => { try { return readdirSync(outboxDir(home)).sort(); } catch { return []; } };
const turn = (turnId, overrides = {}) => ({ name: 'demo', threadId: 'thread-1', turnId, cwd: '/tmp', status: 'completed', error: null, ...overrides });
async function closedPort() {
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address(); await new Promise(resolve => server.close(resolve)); return port;
}

test('result prints the full multi-line final message of the latest settled turn and of a named turn', async t => {
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
  const settled = await f.command(['result', 'thread-1']);
  assert.equal(settled.code, 0, settled.stderr); assert.match(settled.stdout, /^demo completed turn-2\n/);
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
  assert.equal(latest.code, 1, latest.stderr); assert.equal(latest.stdout, 'demo interrupted turn-8\n');
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
  f.complete('completed', 'DONE');
  assert.equal((await waiter.result).code, 0);
  assert.deepEqual(readCompletions(f.home).map(e => [e.turnId, e.status]), [['turn-1', 'completed']]);
  f.turns.push({ id: 'turn-2', status: 'failed', items: [], error: { message: 'x', codexErrorInfo: 'serverOverloaded', additionalDetails: null } });
  assert.equal((await f.command(['result', 'demo'])).code, 1);
  const repaired = readCompletions(f.home).find(e => e.turnId === 'turn-2');
  assert.equal(repaired.status, 'failed'); assert.equal(repaired.failure, 'capacity'); assert.equal(repaired.exitCode, 75);
  assert.equal((await f.command(['result', 'demo', '--turn', 'turn-2'])).code, 1);
  assert.equal(readCompletions(f.home).length, 2, 'a second read records nothing new');
});

test('recording is idempotent per thread and turn', async t => {
  const f = await fixture(t);
  const first = recordCompletion(f.home, turn('turn-a'), { finishedAt: Date.parse('2026-11-16T10:00:00.000Z') });
  const second = recordCompletion(f.home, turn('turn-a', { status: 'failed' }), { finishedAt: Date.parse('2026-11-16T11:00:00.000Z') });
  assert.equal(second, first);
  assert.deepEqual(files(f.home), ['2026-11-16T10:00:00.000Z-thread-1-turn-a.json']);
  assert.equal(recordCompletion(f.home, turn('turn-b', { status: 'running' })), null);
  assert.equal(recordCompletion(f.home, turn('turn-b', { status: 'idle' })), null);
  // Two recorders that raced past the check: readers keep one entry per turn.
  writeFileSync(join(outboxDir(f.home), '2026-11-16T12:00:00.000Z-thread-1-turn-a.json'), JSON.stringify({ turnId: 'turn-a', status: 'failed' }));
  assert.deepEqual(readCompletions(f.home).map(e => e.status), ['completed']);
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
  assert.ok(files(f.home).includes('thread-1-turn-ancient.acked'));
  for (let i = 0; i < 8; i++) recordCompletion(f.home, turn(`turn-${i}`), { finishedAt: Date.now() - (8 - i) * 2000, maxEntries: 5 });
  assert.deepEqual(readCompletions(f.home).map(e => e.turnId), ['turn-3', 'turn-4', 'turn-5', 'turn-6', 'turn-7']);
  assert.ok(!files(f.home).some(name => name.includes('turn-ancient')), 'entry older than 14 days and its marker pruned');
  recordCompletion(f.home, turn('turn-x'), { maxAge: '1s', finishedAt: Date.now() });
  assert.deepEqual(readCompletions(f.home).map(e => e.turnId), ['turn-x']);
});

test('concurrent writers never corrupt or duplicate the outbox', async t => {
  const f = await fixture(t);
  const writer = new URL('../src/outbox.mjs', import.meta.url).href;
  const script = `import { recordCompletion } from ${JSON.stringify(writer)};
    const [home, id, shared] = process.argv.slice(1);
    for (let i = 0; i < 40; i++) recordCompletion(home, { name: 'w', threadId: 't' + (shared ? 'shared' : id), turnId: 'turn' + i, cwd: '/', status: 'completed', error: null });`;
  const run = shared => Promise.all(Array.from({ length: 6 }, (_, id) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, f.home, String(id), shared], { stdio: ['ignore', 'ignore', 'inherit'] });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`writer exited ${code}`)));
  })));
  await run('');
  assert.equal(readCompletions(f.home).length, 240);
  await run('1');
  const shared = readCompletions(f.home).filter(e => e.threadId === 'tshared');
  assert.equal(shared.length, 40);
  assert.ok(!files(f.home).some(name => name.endsWith('.tmp')), 'no temp files left behind');
});

test('help documents result exit codes and the inbox', async t => {
  const f = await fixture(t);
  const help = await f.command(['--help']);
  assert.match(help.stdout, /result <name\|threadId> \[--turn <id>\] \[--json\]/);
  assert.match(help.stdout, /inbox \[--follow\] \[--since <time>\|--unread\] \[--ack\]/);
  assert.match(help.stdout, /Result exits: completed 0, failed or interrupted 1, unknown name or turn 2, not finished 3/);
});
