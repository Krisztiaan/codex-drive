import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, until } from '../test-support/app-server.mjs';

test('resume status never inherits the previous turn message', async t => {
  const f = await fixture(t);
  const resumed = f.launch(['resume', 'demo', 'Continue']);
  await until(() => resumed.stdout().trim(), 'resume ids');
  const status = await f.command(['status', 'demo']);
  assert.equal(status.code, 0, status.stderr);
  const current = JSON.parse(status.stdout);
  assert.equal(current.status, 'running');
  assert.equal(current.lastAgentMessage, null);
  f.complete('completed', 'CURRENT');
  assert.equal((await resumed.result).code, 0);
  assert.equal(JSON.parse((await f.command(['status', 'demo'])).stdout).lastAgentMessage, 'CURRENT');
});

test('wait rejoins a running turn without an attached logger and returns its final JSON', async t => {
  const f = await fixture(t);
  f.turns[0].status = 'inProgress'; f.turns[0].items = []; f.seed({ status: 'running', lastEventTime: 'OLD' });
  const waiter = f.launch(['wait', 'demo']);
  let ended = false; waiter.result.then(() => { ended = true; });
  await until(f.hasRead, 'initial running snapshot');
  assert.equal(ended, false, 'wait returned while the turn was still running');
  f.complete('completed', 'WAIT-OK');
  const result = await waiter.result;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).lastAgentMessage, 'WAIT-OK');
  assert.notEqual(JSON.parse(result.stdout).lastEventTime, 'OLD');
  assert.equal(JSON.parse(result.stdout).status, 'completed');
});

test('wait timeout has distinct code and JSON without interrupting the running turn', async t => {
  const f = await fixture(t);
  f.turns[0].status = 'inProgress'; f.turns[0].items = []; f.seed({ status: 'running' });
  const result = await f.command(['wait', 'demo', '--timeout', '0.15']);
  assert.equal(result.code, 124, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'running');
  assert.equal(JSON.parse(result.stdout).timedOut, true);
  assert.equal(f.turns[0].status, 'inProgress');
});

test('wait reconnects after a connection drop and remains bound to its original turn', async t => {
  const f = await fixture(t);
  f.turns[0].status = 'inProgress'; f.turns[0].items = []; f.seed({ status: 'running' });
  const waiter = f.launch(['wait', 'demo', '--timeout', '3']);
  const { setTimeout: delay } = await import('node:timers/promises');
  await until(f.hasRead, 'initial turn snapshot'); f.disconnect(); await delay(200);
  f.complete('completed', 'ORIGINAL', f.turns[0]);
  for (let n = 2; n <= 26; n++) f.turns.push({ id: `turn-${n}`, status: n === 26 ? 'inProgress' : 'completed', items: [], error: null });
  const result = await waiter.result;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).turnId, 'turn-1');
  assert.equal(JSON.parse(result.stdout).lastAgentMessage, 'ORIGINAL');
});

test('detached start and resume return IDs while status, wait, steer and interrupt remain usable', async t => {
  const f = await fixture(t);
  const { join } = await import('node:path');
  const { readFileSync } = await import('node:fs');
  const started = await f.command(['start', '--port', String(f.port), '--cwd', f.home, '--model', 'gpt-6.1-sol', '--effort', 'low', '--name', 'background', '--log', join(f.home, 'background.jsonl'), '--detach', 'Continue']);
  assert.equal(started.code, 0, started.stderr);
  assert.match(started.stderr, /WARNING: danger-full-access/);
  const ids = JSON.parse(started.stdout);
  assert.ok(ids.threadId && ids.turnId);
  assert.equal(JSON.parse((await f.command(['status', 'background'])).stdout).status, 'running');
  assert.equal((await f.command(['wait', 'background', '--timeout', '0.1'])).code, 124);
  assert.equal((await f.command(['steer', 'background', 'Stop'])).code, 0);
  const waited = await f.command(['wait', 'background']);
  assert.equal(waited.code, 0, waited.stderr);
  assert.equal(JSON.parse(waited.stdout).lastAgentMessage, 'STEERED');
  await until(() => !JSON.parse(readFileSync(join(f.home, 'threads/background.json'), 'utf8')).status.startsWith('running'), 'detached completion persisted');
  const resumed = await f.command(['resume', 'background', '--detach', 'Continue again']);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.notEqual(JSON.parse(resumed.stdout).turnId, ids.turnId);
  assert.equal(JSON.parse((await f.command(['status', 'background'])).stdout).lastAgentMessage, null);
  assert.equal((await f.command(['interrupt', 'background'])).code, 0);
  assert.equal((await f.command(['wait', 'background'])).code, 130);
  const log = readFileSync(join(f.home, 'background.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(log.some(e => e.method === 'turn/completed'));
});

test('a fast turn completed during a lost start reply does not leave its logger hanging', async t => {
  const f = await fixture(t); f.loseNextStartReply();
  const resumed = f.launch(['resume', 'demo', 'Continue']);
  const { setTimeout: delay } = await import('node:timers/promises');
  const result = await Promise.race([resumed.result, delay(10000, { code: 'still-running' }, { ref: false })]);
  assert.equal(result.code, 0, result.stderr ?? 'Logger is still running after recovered completion');
  assert.equal(JSON.parse((await f.command(['status', 'demo'])).stdout).lastAgentMessage, 'RECOVERED');
});

test('tail tolerates an unfinished final append but rejects corrupt complete records', async t => {
  const f = await fixture(t);
  const { writeFileSync } = await import('node:fs');
  const complete = JSON.stringify({ method: 'item/completed', params: { item: { type: 'agentMessage', text: 'VISIBLE' } } });
  writeFileSync(f.state.logPath, complete + '\n{"method":"item/');
  const result = await f.command(['tail', 'demo']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'VISIBLE');
  writeFileSync(f.state.logPath, complete + '\n{broken}\n');
  assert.notEqual((await f.command(['tail', 'demo'])).code, 0);
});

test('help succeeds from another directory without requiring a server or state lookup', async t => {
  const f = await fixture(t);
  const result = await f.command(['--help'], { cwd: f.home });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /wait.*--timeout/);
  assert.match(result.stdout, /--detach/);
  assert.match(result.stdout, /Defaults: --sandbox danger-full-access, --approval never, --request-policy approve/);
  assert.match(result.stdout, /--request-policy manual\|decline/);
});

test('wait immediately reports already-ended turns with completed, failed and interrupted exit codes', async t => {
  const f = await fixture(t);
  for (const [status, expected] of [['completed', 0], ['failed', 1], ['interrupted', 130]]) {
    f.turns[0].status = status; f.seed({ status: 'running' });
    const result = await f.command(['wait', 'thread-1', '--timeout', '2']);
    assert.equal(result.code, expected, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, status);
  }
});

test('wait timeout cancels an outstanding server RPC rather than waiting for its RPC timeout', async t => {
  const f = await fixture(t); f.pause('thread/turns/list');
  const started = Date.now();
  const result = await f.command(['wait', 'demo', '--timeout', '0.2']);
  assert.equal(result.code, 124, result.stderr);
  assert.ok(Date.now() - started < 10000, 'wait exceeded its timeout by the full RPC timeout');
});

test('status refuses an explicit port that differs from the saved thread server', async t => {
  const f = await fixture(t), other = await fixture(t);
  const result = await f.command(['status', 'demo', '--port', String(other.port)]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Port differs from thread server/);
});

test('wait follows the resumed turn across a steer and returns only when that turn settles', async t => {
  const { setTimeout: delay } = await import('node:timers/promises');
  const { readdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const f = await fixture(t, { steerCompletes: false });
  const resumed = await f.command(['resume', 'demo', '--detach', 'Go']);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).turnId, 'turn-2');
  const reads = () => f.received.filter(m => m.method === 'thread/turns/list').length, before = reads();
  const waiters = [['wait', 'demo', '--timeout', '30'], ['wait', 'demo', 'thread-1', '--any', '--timeout', '30'], ['wait', 'demo', 'thread-1', '--all', '--timeout', '30']]
    .map(args => { const run = f.launch(args); run.ended = false; run.result.then(() => { run.ended = true; }); return run; });
  await until(() => reads() >= before + 5, 'every observer snapshot');
  const steer = await f.command(['steer', 'demo', 'Use build-4']);
  assert.equal(steer.code, 0, steer.stderr); assert.deepEqual(JSON.parse(steer.stdout), { turnId: 'turn-2' });
  await delay(1500); // Past each observer's next snapshot.
  for (const run of waiters) assert.equal(run.ended, false, 'wait returned while the steered turn was still running');
  const status = JSON.parse((await f.command(['status', 'demo'])).stdout);
  assert.equal(status.status, 'running'); assert.equal(status.turnId, 'turn-2');
  f.complete('completed', 'DONE', f.turns.at(-1));
  for (const run of waiters) {
    const result = await run.result;
    assert.equal(result.code, 0, result.stderr);
    for (const line of result.stdout.trim().split('\n').map(JSON.parse)) { assert.equal(line.turnId, 'turn-2'); assert.equal(line.status, 'completed'); assert.equal(line.lastAgentMessage, 'DONE'); }
  }
  await until(() => readdirSync(join(f.home, 'outbox')).includes('thread-1@turn-2.json'), 'outbox entry');
  assert.deepEqual(readdirSync(join(f.home, 'outbox')).filter(name => name.startsWith('thread-1@')), ['thread-1@turn-2.json']);
});
