import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, until } from '../test-support/app-server.mjs';

test('internal resumes exclude history while explicit overrides and raw calls win', async t => {
  const f = await fixture(t);
  for (const args of [['wait', 'demo'], ['adopt', 'thread-1'], ['resume', 'demo', '--thread-params', '{"excludeTurns":false}'], ['call', 'thread/resume', '{"threadId":"thread-1"}', '--port', String(f.port)]]) {
    const before = f.received.length;
    const result = await f.command(args);
    assert.equal(result.code, 0, result.stderr);
    const params = f.received.slice(before).find(m => m.method === 'thread/resume').params;
    assert.equal(params.excludeTurns, args[0] === 'call' ? undefined : args.includes('--thread-params') ? false : true);
  }
});

test('snapshots page older targets without hydration and fetch commentary only for that target', async t => {
  const f = await fixture(t);
  const { snapshot } = await import('../src/turns.mjs');
  const { Rpc } = await import('../src/rpc.mjs');
  f.turns[0].status = 'failed';
  f.turns[0].error = { message: 'failure' };
  f.turns[0].items[0].phase = 'commentary';
  f.turns.push({ id: 'newer', status: 'inProgress', items: [], error: null });
  const rpc = new Rpc(f.port); await rpc.connect();
  try {
    const state = { threadId: 'thread-1' };
    await snapshot(rpc, state, undefined, 'turn-1');
    await snapshot(rpc, state, undefined, 'turn-1');
    assert.equal(state.lastAgentMessage, 'PREVIOUS');
    assert.equal(state.error.message, 'failure');
    assert.ok(f.received.filter(m => m.method === 'thread/turns/list').every(m => m.params.itemsView === 'notLoaded' && m.params.limit === 1));
    const items = f.received.filter(m => m.method === 'thread/items/list');
    assert.equal(items.length, 1); assert.equal(items[0].params.turnId, 'turn-1');
  } finally { rpc.close(); }
});

test('quiet wait backs off while events complete promptly without another poll', async t => {
  const f = await fixture(t);
  f.turns[0].status = 'inProgress'; f.turns[0].items = [];
  f.seed({ status: 'running', lastAgentMessage: null });
  const waiter = f.launch(['wait', 'demo', '--timeout', '8']);
  await until(f.hasRead);
  const { setTimeout: delay } = await import('node:timers/promises');
  await delay(3300);
  const reads = f.received.filter(m => m.method === 'thread/turns/list');
  assert.ok(reads.length <= 3, String(reads.length));
  const before = reads.length, start = Date.now();
  f.complete('completed', 'EVENT');
  const result = await waiter.result;
  assert.equal(result.code, 0, result.stderr);
  assert.ok(Date.now() - start < 500);
  assert.equal(f.received.filter(m => m.method === 'thread/turns/list').length, before);
  assert.equal(JSON.parse(result.stdout).lastAgentMessage, 'EVENT');
});

test('completion between resume and first snapshot is retained', async t => {
  let f;
  f = await fixture(t, { turnsList: async (params, result) => {
    f.complete('completed', 'RACED');
    return result;
  } });
  f.turns[0].status = 'inProgress'; f.turns[0].items = [];
  f.seed({ status: 'running', lastAgentMessage: null });
  const result = await f.command(['wait', 'demo', '--timeout', '2']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).lastAgentMessage, 'RACED');
});

test('only wait observers opt out of unused streaming notifications', async t => {
  const f = await fixture(t);
  await f.command(['wait', 'demo']);
  const { WAIT_NOTIFICATION_OPT_OUTS } = await import('../src/client.mjs');
  assert.deepEqual(f.received.find(m => m.method === 'initialize').params.capabilities.optOutNotificationMethods, WAIT_NOTIFICATION_OPT_OUTS);
  const before = f.received.length;
  await f.command(['adopt', 'demo']);
  assert.equal(f.received.slice(before).find(m => m.method === 'initialize').params.capabilities.optOutNotificationMethods, undefined);
});

test('calls pruning is explicit, age-filtered and dry-run by default', async t => {
  const f = await fixture(t);
  const { mkdirSync, writeFileSync, utimesSync, existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const dir = join(f.home, 'calls'); mkdirSync(dir);
  const old = join(dir, 'old.jsonl'), fresh = join(dir, 'fresh.jsonl');
  writeFileSync(old, '{}\n'); writeFileSync(fresh, '{}\n');
  utimesSync(old, new Date(0), new Date(0));
  const dry = await f.command(['prune', '--calls', '--older-than', '2']);
  assert.deepEqual(JSON.parse(dry.stdout).calls, ['old.jsonl']);
  assert.ok(existsSync(old));
  const applied = await f.command(['prune', '--calls', '--older-than', '2', '--apply']);
  assert.equal(applied.code, 0, applied.stderr);
  assert.equal(existsSync(old), false); assert.ok(existsSync(fresh));
});

test('logger buffers noisy journal writes and flushes lifecycle records', async t => {
  const f = await fixture(t);
  const { journal } = await import('../src/client.mjs');
  const { readFileSync, existsSync } = await import('node:fs');
  const log = journal(f.state.logPath, { buffered: true });
  log({ method: 'item/agentMessage/delta', params: { delta: 'hé' } });
  assert.equal(existsSync(f.state.logPath), false);
  log({ method: 'turn/completed', params: {} });
  assert.equal(readFileSync(f.state.logPath, 'utf8').trim().split('\n').length, 2);
  log.flush();
});

test('serve inspection uses metadata and treats approval waiting as active', async t => {
  const f = await fixture(t);
  f.turns[0].status = 'inProgress';
  const { activeTurns } = await import('../src/server.mjs');
  const previous = process.env.CODEX_DRIVE_HOME; process.env.CODEX_DRIVE_HOME = f.home;
  try {
    assert.deepEqual(await activeTurns(f.port), ['demo']);
    assert.ok(f.received.filter(m => m.method === 'thread/read').every(m => m.params.includeTurns === false));
    f.turns[0].status = 'completed';
    assert.deepEqual(await activeTurns(f.port), []);
  } finally { if (previous === undefined) delete process.env.CODEX_DRIVE_HOME; else process.env.CODEX_DRIVE_HOME = previous; }
});

