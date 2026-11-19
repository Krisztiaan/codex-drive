import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixture, until } from '../test-support/app-server.mjs';

const sourceModule = name => import(pathToFileURL(join(process.env.CODEX_DRIVE_TEST_SOURCE ?? resolve('src'), name)).href);

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
  const { snapshot } = await sourceModule('turns.mjs');
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
  const f = await fixture(t, { threadFlags: ['waitingOnApproval'] });
  f.turns[0].status = 'inProgress';
  const { activeTurns } = await sourceModule('server.mjs');
  const previous = process.env.CODEX_DRIVE_HOME; process.env.CODEX_DRIVE_HOME = f.home;
  try {
    assert.deepEqual(await activeTurns(f.port), ['demo']);
    assert.ok(f.received.filter(m => m.method === 'thread/read').every(m => m.params.includeTurns === false));
    f.turns[0].status = 'completed';
    assert.deepEqual(await activeTurns(f.port), []);
  } finally { if (previous === undefined) delete process.env.CODEX_DRIVE_HOME; else process.env.CODEX_DRIVE_HOME = previous; }
});

test('--any reports one observer error and still waits for a real completion', async t => {
  const f = await fixture(t);
  const { writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  writeFileSync(join(f.home, 'threads/broken.json'), JSON.stringify({ ...f.state, name: 'broken', threadId: 'bad-thread' }));
  // An empty history produces a protocol error rather than a settled turn.
  f.threads.set('bad-thread', []);
  f.turns[0].status = 'inProgress'; f.turns[0].items = [];
  f.seed({ status: 'running', lastAgentMessage: null });
  const waiter = f.launch(['wait', 'broken', 'demo', '--any', '--timeout', '3']);
  await until(() => waiter.stdout().includes('error'));
  f.complete('completed', 'SURVIVOR');
  const result = await waiter.result;
  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.stdout.includes('SURVIVOR'));
});

test('--any all-error exits nonzero', async t => {
  const f = await fixture(t);
  const { writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  writeFileSync(join(f.home, 'threads/broken.json'), JSON.stringify({ ...f.state, name: 'broken', threadId: 'bad-thread' }));
  f.threads.set('bad-thread', []); f.turns.length = 0;
  assert.equal((await f.command(['wait', 'broken', 'demo', '--any'])).code, 1);
});

test('open-socket RPC timeout is retried by wait without replaying mutations', async t => {
  let reads = 0;
  const f = await fixture(t, { turnsList: (params, result) => ++reads === 1 ? new Promise(() => {}) : result });
  const { waitForTurn } = await sourceModule('turns.mjs');
  const { Store } = await import('../src/state.mjs');
  const actual = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => actual(fn, ms === 30000 ? 20 : ms, ...args));
  const previous = process.env.CODEX_DRIVE_HOME; process.env.CODEX_DRIVE_HOME = f.home;
  f.useLogin();
  try {
    assert.equal(await waitForTurn(new Store(f.home), {}, 'demo', () => {}), 0);
    assert.equal(reads, 2);
    assert.equal(f.received.filter(m => m.method === 'thread/resume').length, 2);
    assert.equal(f.received.filter(m => m.method === 'turn/start').length, 0);
  } finally { if (previous === undefined) delete process.env.CODEX_DRIVE_HOME; else process.env.CODEX_DRIVE_HOME = previous; }
});

test('continuous notifications cannot postpone reconciliation snapshots', async t => {
  const f = await fixture(t);
  f.turns[0].status = 'inProgress'; f.turns[0].items = [];
  f.seed({ status: 'running', lastAgentMessage: null });
  const task = f.launch(['wait', 'demo', '--timeout', '8']);
  await until(f.hasRead);
  const timer = setInterval(() => f.emit('warning', { threadId: 'thread-1' }), 20);
  try {
    await until(() => f.received.filter(m => m.method === 'thread/turns/list').length >= 3);
    f.complete('completed', 'TRAFFIC');
    assert.equal((await task.result).code, 0);
  } finally { clearInterval(timer); }
});

test('warm resume rate-limit replay survives history exclusion', async t => {
  const rateLimits = { limitId: 'codex', primary: { usedPercent: 45, resetsAt: 1234, windowDurationMins: 60 } };
  const f = await fixture(t, { resumeEvents: [{ method: 'account/rateLimits/updated', params: { rateLimits } }] });
  const result = await f.command(['wait', 'demo']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).rateLimits.primary.usedPercent, 45);
  assert.equal(f.received.find(m => m.method === 'thread/resume').params.excludeTurns, true);
});

test('unknown loaded thread status blocks server inspection', async t => {
  const f = await fixture(t, { threadStatus: 'notLoaded' });
  const { activeTurns } = await sourceModule('server.mjs');
  const previous = process.env.CODEX_DRIVE_HOME; process.env.CODEX_DRIVE_HOME = f.home;
  try { await assert.rejects(activeTurns(f.port), /Unknown or unreadable/); }
  finally { if (previous === undefined) delete process.env.CODEX_DRIVE_HOME; else process.env.CODEX_DRIVE_HOME = previous; }
});

test('logger recovery retains an explicit resume history override', async t => {
  const f = await fixture(t);
  f.turns[0].status = 'inProgress'; f.turns[0].items = [];
  f.seed({ status: 'running', lastAgentMessage: null });
  const task = f.launch(['resume', 'demo', '--thread-params', '{"excludeTurns":false}']);
  await until(() => task.stdout().trim());
  f.disconnect();
  await until(() => f.received.filter(m => m.method === 'thread/resume').length >= 2);
  f.complete('completed', 'RECOVERY');
  const result = await task.result;
  assert.equal(result.code, 0, result.stderr);
  assert.ok(f.received.filter(m => m.method === 'thread/resume').every(m => m.params.excludeTurns === false));
});

test('noisy logger events coalesce state writes and flush at completion', async t => {
  const f = await fixture(t);
  f.turns[0].status = 'inProgress'; f.turns[0].items = [];
  f.seed({ status: 'running', lastAgentMessage: null });
  const { Store } = await import('../src/state.mjs');
  const { runAttached } = await sourceModule('turns.mjs');
  const store = new Store(f.home), save = store.save.bind(store);
  let saves = 0, ready;
  store.save = state => { saves++; return save(state); };
  const attached = new Promise(resolve => { ready = resolve; });
  f.useLogin();
  const task = runAttached(store, 'adopt', {}, 'demo', undefined, { ready });
  await attached;
  const before = saves;
  for (let n = 0; n < 100; n++) f.emit('item/agentMessage/delta', { threadId: 'thread-1', turnId: 'turn-1', delta: 'x' });
  const { setTimeout: delay } = await import('node:timers/promises');
  await delay(100);
  assert.ok(saves <= before + 1, String(saves - before));
  f.complete('completed', 'FLUSHED');
  await task;
  assert.equal(store.read('demo').lastAgentMessage, 'FLUSHED');
});
