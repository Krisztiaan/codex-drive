import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, until } from '../test-support/app-server.mjs';
import { appendCompletion, readCompletions, outboxDir } from '../src/outbox.mjs';

const lines = text => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const outbox = home => { const path = join(outboxDir(home), 'outbox.jsonl'); return existsSync(path) ? lines(readFileSync(path, 'utf8')) : []; };
function entry(turnId, overrides = {}) {
  return { name: 'demo', threadId: 'thread-1', turnId, cwd: '/tmp', status: 'completed', failure: null, exitCode: 0, finishedAt: new Date().toISOString(), message: `MESSAGE ${turnId}`, ...overrides };
}
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
  assert.equal(json.status, 'completed'); assert.equal(json.message, 'Line one\nLine two\n\nLine four');
  const byId = await f.command(['result', 'thread-1']);
  assert.equal(byId.code, 0, byId.stderr); assert.match(byId.stdout, /^demo completed turn-2\n/);
});

test('result exits 1 for a failed turn and still prints its partial message', async t => {
  const f = await fixture(t);
  f.turns[0].status = 'failed'; f.turns[0].error = { message: 'Backend failed', codexErrorInfo: 'usageLimitExceeded', additionalDetails: null };
  f.turns[0].items = [{ type: 'agentMessage', id: 'm-1', text: 'PARTIAL\nwork so far' }];
  const result = await f.command(['result', 'demo']);
  assert.equal(result.code, 1, result.stderr);
  assert.equal(result.stdout, 'demo failed turn-1 usageLimit\nPARTIAL\nwork so far\n');
  const json = JSON.parse((await f.command(['result', 'demo', '--json'])).stdout);
  assert.equal(json.status, 'failed'); assert.equal(json.failure.class, 'usageLimit'); assert.equal(json.message, 'PARTIAL\nwork so far');
});

test('result exits 2 for an unknown name or turn and 3 while the turn is unfinished', async t => {
  const f = await fixture(t);
  const unknown = await f.command(['result', 'nobody']);
  assert.equal(unknown.code, 2); assert.match(unknown.stderr, /Unknown thread: nobody/);
  const unknownTurn = await f.command(['result', 'demo', '--turn', 'turn-99']);
  assert.equal(unknownTurn.code, 2); assert.match(unknownTurn.stderr, /turn-99/);
  f.turns[0].status = 'inProgress'; f.turns[0].items = [];
  const running = await f.command(['result', 'demo']);
  assert.equal(running.code, 3, running.stderr);
  assert.equal(running.stdout, 'demo running turn-1\n');
});

test('result reads a log-only session when its server is gone', async t => {
  const f = await fixture(t);
  f.seed({ port: await closedPort() });
  const events = [
    { method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-7', status: 'inProgress', items: [], error: null } } },
    { method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-7', item: { type: 'agentMessage', id: 'a', text: 'Draft' } } },
    { method: 'item/completed', params: { threadId: 'other', turnId: 'turn-7', item: { type: 'agentMessage', id: 'b', text: 'NOT MINE' } } },
    { method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-7', item: { type: 'agentMessage', id: 'c', text: 'Final\nanswer' } } },
    { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-7', status: 'completed', items: [], error: null } } },
    { method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-8', status: 'inProgress', items: [], error: null } } },
  ];
  writeFileSync(f.state.logPath, events.map(e => JSON.stringify(e)).join('\n') + '\n');
  const unfinished = await f.command(['result', 'demo']);
  assert.equal(unfinished.code, 3, unfinished.stderr); assert.equal(unfinished.stdout, 'demo running turn-8\n');
  const named = await f.command(['result', 'demo', '--turn', 'turn-7', '--json']);
  assert.equal(named.code, 0, named.stderr);
  const json = JSON.parse(named.stdout);
  assert.equal(json.message, 'Final\nanswer'); assert.equal(json.source, 'log'); assert.equal(json.status, 'completed');
});

test('a detached logger writes the outbox on completion with no client waiting', async t => {
  const f = await fixture(t);
  const started = await f.command(['start', '--port', String(f.port), '--cwd', f.home, '--name', 'bg', '--detach', 'Go']);
  assert.equal(started.code, 0, started.stderr);
  const ids = JSON.parse(started.stdout);
  const long = 'DONE\n' + 'x'.repeat(400);
  f.complete('completed', long);
  const [done] = await until(() => outbox(f.home).length && outbox(f.home), 'outbox entry');
  assert.deepEqual(Object.keys(done).sort(), ['cwd', 'exitCode', 'failure', 'finishedAt', 'message', 'name', 'status', 'threadId', 'turnId']);
  assert.equal(done.name, 'bg'); assert.equal(done.threadId, ids.threadId); assert.equal(done.turnId, ids.turnId);
  assert.equal(done.status, 'completed'); assert.equal(done.exitCode, 0); assert.equal(done.failure, null);
  assert.ok(!Number.isNaN(Date.parse(done.finishedAt)));
  assert.equal(done.message, long.slice(0, 300));
  const full = await f.command(['result', 'bg']);
  assert.equal(full.code, 0, full.stderr); assert.equal(full.stdout, `bg completed ${ids.turnId}\n${long}\n`);

  const resumed = await f.command(['resume', 'bg', '--detach', 'Again']);
  assert.equal(resumed.code, 0, resumed.stderr);
  const turn = f.turns.at(-1);
  f.complete('failed', 'Stopped early', turn, { message: 'limit', codexErrorInfo: 'usageLimitExceeded', additionalDetails: null });
  const failed = await until(() => outbox(f.home).find(e => e.turnId === turn.id), 'failed outbox entry');
  assert.equal(failed.status, 'failed'); assert.equal(failed.failure, 'usageLimit'); assert.equal(failed.exitCode, 76); assert.equal(failed.message, 'Stopped early');
  assert.equal(failed.error, undefined, 'error prose is not copied to the outbox');
  assert.equal(outbox(f.home).length, 2);
});

test('adopting an already finished turn does not announce it again', async t => {
  const f = await fixture(t);
  const adopted = await f.command(['adopt', 'demo']);
  assert.equal(adopted.code, 0, adopted.stderr);
  assert.deepEqual(outbox(f.home), []);
});

test('inbox lists entries, filters --unread and --since, and --ack marks them read', async t => {
  const f = await fixture(t);
  appendCompletion(f.home, entry('turn-old', { finishedAt: new Date(Date.now() - 3 * 3600000).toISOString() }));
  appendCompletion(f.home, entry('turn-a'));
  const all = await f.command(['inbox']);
  assert.equal(all.code, 0, all.stderr); assert.deepEqual(lines(all.stdout).map(e => e.turnId), ['turn-old', 'turn-a']);
  assert.deepEqual(lines((await f.command(['inbox', '--since', '1h'])).stdout).map(e => e.turnId), ['turn-a']);
  assert.deepEqual(lines((await f.command(['inbox', '--unread'])).stdout).map(e => e.turnId), ['turn-old', 'turn-a']);
  const acked = await f.command(['inbox', '--unread', '--ack']);
  assert.equal(acked.code, 0, acked.stderr); assert.equal(lines(acked.stdout).length, 2);
  assert.equal((await f.command(['inbox', '--unread'])).stdout, '');
  appendCompletion(f.home, entry('turn-b'));
  assert.deepEqual(lines((await f.command(['inbox', '--unread'])).stdout).map(e => e.turnId), ['turn-b']);
  assert.equal(lines((await f.command(['inbox'])).stdout).length, 3);
  assert.equal((await f.command(['inbox', '--unread', '--since', '1h'])).code, 1);
});

test('inbox --follow prints one line per new completion, across rotation', async t => {
  const f = await fixture(t);
  appendCompletion(f.home, entry('turn-backlog'));
  const follower = f.launch(['inbox', '--follow', '--unread']);
  await until(() => follower.stdout().includes('turn-backlog'), 'backlog line');
  appendCompletion(f.home, entry('turn-new'));
  await until(() => follower.stdout().includes('turn-new'), 'followed line');
  for (let i = 0; i < 6; i++) appendCompletion(f.home, entry(`turn-r${i}`, { message: 'y'.repeat(200) }), { limit: 1500 });
  await until(() => follower.stdout().includes('turn-r5'), 'line after rotation');
  assert.ok(existsSync(join(outboxDir(f.home), 'outbox.1.jsonl')), 'outbox rotated');
  const seen = lines(follower.stdout()).map(e => e.turnId);
  assert.deepEqual(seen, ['turn-backlog', 'turn-new', 'turn-r0', 'turn-r1', 'turn-r2', 'turn-r3', 'turn-r4', 'turn-r5']);
  follower.child.kill('SIGTERM');
});

test('the outbox rotates at its size limit and keeps one previous generation', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 20; i++) appendCompletion(f.home, entry(`turn-${i}`), { limit: 1000 });
  assert.deepEqual(readdirSync(outboxDir(f.home)).filter(name => name.endsWith('.jsonl')).sort(), ['outbox.1.jsonl', 'outbox.jsonl']);
  const kept = readCompletions(f.home).map(e => e.turnId);
  assert.equal(kept.at(-1), 'turn-19');
  assert.ok(kept.length < 20 && kept.length > 1);
  assert.deepEqual(kept, [...kept].sort((a, b) => Number(a.slice(5)) - Number(b.slice(5))));
});

test('concurrent writers never corrupt the outbox', async t => {
  const f = await fixture(t);
  const writer = new URL('../src/outbox.mjs', import.meta.url).href;
  const script = `import { appendCompletion } from ${JSON.stringify(writer)};
    const [home, id, limit] = process.argv.slice(1);
    for (let i = 0; i < 40; i++) appendCompletion(home, { name: 'w' + id, threadId: 't' + id, turnId: id + '-' + i, cwd: '/', status: 'completed', failure: null, exitCode: 0, finishedAt: new Date().toISOString(), message: 'z'.repeat(250) }, { limit: Number(limit) });`;
  const run = limit => Promise.all(Array.from({ length: 6 }, (_, id) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, f.home, String(id), String(limit)], { stdio: ['ignore', 'ignore', 'inherit'] });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`writer exited ${code}`)));
  })));
  await run(1e9);
  const entries = readCompletions(f.home);
  assert.equal(entries.length, 240);
  assert.equal(new Set(entries.map(e => e.turnId)).size, 240);
  await run(20000);
  for (const name of readdirSync(outboxDir(f.home)).filter(name => name.endsWith('.jsonl'))) lines(readFileSync(join(outboxDir(f.home), name), 'utf8'));
});

test('help documents result exit codes and the inbox', async t => {
  const f = await fixture(t);
  const help = await f.command(['--help']);
  assert.match(help.stdout, /result <name\|threadId> \[--turn <id>\] \[--json\]/);
  assert.match(help.stdout, /inbox \[--follow\] \[--since <time>\|--unread\] \[--ack\]/);
  assert.match(help.stdout, /Result exits: completed 0, failed or interrupted 1, unknown name or turn 2, not finished 3/);
});
