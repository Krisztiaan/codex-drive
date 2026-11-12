import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv from 'ajv';
import { fixture, until } from '../test-support/app-server.mjs';
import { Rpc } from '../src/rpc.mjs';
import { Store } from '../src/state.mjs';
import { waitForTurn } from '../src/turns.mjs';

const schema = JSON.parse(readFileSync(new URL('../protocol/schema.json', import.meta.url)));
const ajv = new Ajv({ strict: false, validateFormats: false });
const validators = new Map();
function notification(type, params) {
  if (!validators.has(type)) validators.set(type, ajv.compile({ $ref: `#/definitions/v2/${type}`, definitions: schema.definitions }));
  const check = validators.get(type); assert.equal(check(params), true, JSON.stringify(check.errors));
  return params;
}
function error(info, message = 'Do not classify this prose') { return { message, codexErrorInfo: info, additionalDetails: null }; }

test('wait preserves a notLoaded capacity completion against an in-flight interrupted snapshot', async t => {
  let reads = 0, pendingRead, release;
  const f = await fixture(t, { turnsList: (params, result) => {
    if (++reads === 1) return result;
    pendingRead = result;
    return new Promise(resolve => { release = resolve; });
  } });
  const turn = f.turns[0]; turn.status = 'inProgress'; turn.items = [];
  f.seed({ status: 'running', lastAgentMessage: null });
  const waiter = f.launch(['wait', 'demo', '--timeout', '3']);
  await until(() => release, 'in-flight turn snapshot');
  const failure = error('serverOverloaded', 'Selected model is at capacity. Please try a different model.');
  turn.itemsView = 'notLoaded';
  f.emit('error', notification('ErrorNotification', { threadId: f.state.threadId, turnId: turn.id, error: failure, willRetry: false }));
  notification('TurnCompletedNotification', { threadId: f.state.threadId, turn: { ...turn, status: 'failed', error: failure } });
  f.complete('failed', null, turn, failure);
  pendingRead.data[0].status = 'interrupted'; pendingRead.data[0].error = null;
  release(pendingRead);
  const result = await waiter.result;
  assert.equal(result.code, 75, result.stdout + result.stderr);
  const current = JSON.parse(result.stdout);
  assert.equal(current.status, 'failed'); assert.equal(current.failure.class, 'capacity');
  assert.deepEqual(current.error, failure);
});

test('an in-flight snapshot cannot erase the completed turn agent message', async t => {
  let reads = 0, release;
  const f = await fixture(t, { turnsList: (params, result) => {
    if (++reads === 1) return result;
    return new Promise(resolve => { release = () => resolve(result); });
  } });
  f.turns[0].status = 'inProgress'; f.turns[0].items = []; f.seed({ status: 'running' });
  const waiter = f.launch(['wait', 'demo', '--timeout', '3']);
  await until(() => release, 'in-flight turn snapshot');
  f.complete('completed', 'WAIT-OK'); release();
  const result = await waiter.result;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).lastAgentMessage, 'WAIT-OK');
});

test('an attached wait returns capacity exit 75 when the turn fails at model capacity', async t => {
  const f = await fixture(t);
  const turn = f.turns[0]; turn.status = 'inProgress'; turn.items = [];
  f.seed({ status: 'running', lastAgentMessage: null });
  const waiter = f.launch(['wait', 'demo', '--timeout', '3']);
  await until(f.hasRead, 'wait attached to running turn');
  const failure = error('serverOverloaded', 'Selected model is at capacity');
  f.emit('error', notification('ErrorNotification', { threadId: f.state.threadId, turnId: turn.id, error: failure, willRetry: false }));
  notification('TurnCompletedNotification', { threadId: f.state.threadId, turn: { ...turn, status: 'failed', error: failure } });
  f.complete('failed', null, turn, failure);
  const result = await waiter.result;
  const current = JSON.parse(result.stdout);
  assert.equal(current.status, 'failed');
  assert.equal(current.failure.class, 'capacity');
  assert.equal(result.code, 75, result.stderr);
});

for (const mode of ['attached', 'already ended']) {
  for (const [info, classification, code] of [
    ['serverOverloaded', 'capacity', 75], ['flexUnavailable', 'capacity', 75],
    ['usageLimitExceeded', 'usageLimit', 76], ['rateLimitExceeded', 'usageLimit', 76], ['sessionBudgetExceeded', 'usageLimit', 76],
    ['other', 'other', 1], [null, 'other', 1],
    [{ httpConnectionFailed: { httpStatusCode: 503 } }, 'other', 1],
    [{ responseStreamConnectionFailed: { httpStatusCode: 429 } }, 'other', 1],
  ]) {
    test(`wait ${mode}: ${JSON.stringify(info)} survives a conflicting snapshot and exits ${code}`, async t => {
      const f = await fixture(t, { turnsList: (params, result) => ({ ...result, data: result.data.map(turn =>
        turn.status === 'failed' ? { ...turn, status: 'interrupted', error: null } : turn) }) }), turn = f.turns[0];
      turn.status = 'inProgress'; turn.items = []; f.seed({ status: 'running', lastAgentMessage: null });
      const failure = error(info, 'Selected model is at capacity; usage limit exceeded');
      const completed = notification('TurnCompletedNotification', { threadId: f.state.threadId, turn: { ...turn, status: 'failed', error: failure } });
      let waiter;
      if (mode === 'attached') {
        waiter = f.launch(['wait', 'demo', '--timeout', '3']);
        await until(f.hasRead, 'wait running snapshot');
        f.emit('error', notification('ErrorNotification', { threadId: f.state.threadId, turnId: turn.id, error: failure, willRetry: false }));
      }
      f.complete(completed.turn.status, null, turn, completed.turn.error);
      if (mode === 'already ended') f.seed({ status: 'failed', error: failure });
      const result = mode === 'attached' ? await waiter.result : await f.command(['wait', 'demo', '--timeout', '3']);
      const current = JSON.parse(result.stdout);
      assert.equal(current.status, 'failed'); assert.equal(current.failure.class, classification);
      assert.deepEqual(current.error, failure); assert.equal(current.turnId, turn.id);
      assert.equal(result.code, code, result.stderr);
      assert.equal(f.received.some(m => ['turn/start', 'turn/interrupt'].includes(m.method)), false);
    });
  }
  for (const [status, code] of [['completed', 0], ['interrupted', 130]]) {
    test(`wait ${mode}: ${status} exits ${code}`, async t => {
      const f = await fixture(t), turn = f.turns[0];
      turn.status = 'inProgress'; turn.items = []; f.seed({ status: 'running' });
      let waiter;
      if (mode === 'attached') { waiter = f.launch(['wait', 'demo', '--timeout', '3']); await until(f.hasRead, 'wait running snapshot'); }
      f.complete(status, null, turn);
      const result = mode === 'attached' ? await waiter.result : await f.command(['wait', 'demo', '--timeout', '3']);
      const current = JSON.parse(result.stdout);
      assert.equal(current.status, status); assert.equal(current.failure, null); assert.equal(result.code, code, result.stderr);
    });
  }
}

test('wait retains a completion across reconnect when the resumed snapshot loses the failure', async t => {
  let reads = 0, release;
  const f = await fixture(t, { turnsList: (params, result) => {
    if (++reads === 2) return new Promise(resolve => { release = () => resolve(result); });
    if (reads > 2) result.data[0] = { ...result.data[0], status: 'interrupted', error: null };
    return result;
  } });
  const turn = f.turns[0]; turn.status = 'inProgress'; turn.items = []; turn.itemsView = 'notLoaded';
  f.seed({ status: 'running' });
  // Observe actual event delivery instead of using the removed call journal as
  // a synchronization side channel while a snapshot is still in flight.
  let observed = false, result;
  const emit = Rpc.prototype.emit;
  t.mock.method(Rpc.prototype, 'emit', function (name, ...args) {
    const value = emit.call(this, name, ...args);
    if (name === 'event' && args[0]?.method === 'turn/completed') observed = true;
    return value;
  });
  const previous = process.env.CODEX_DRIVE_HOME; process.env.CODEX_DRIVE_HOME = f.home;
  const controller = new AbortController();
  const waiter = waitForTurn(new Store(f.home), { timeout: '3' }, 'demo', value => { result = value; }, controller.signal);
  waiter.catch(() => {});
  try {
    await until(() => release, 'in-flight snapshot before disconnect');
    const failure = error('serverOverloaded'); f.complete('failed', null, turn, failure);
    await until(() => observed, 'wait received completion');
    f.disconnect(); release();
    assert.equal(await waiter, 75);
    assert.equal(result.failure.class, 'capacity');
    assert.ok(f.received.filter(m => m.method === 'thread/resume').length >= 2, 'wait must reconnect');
  } finally {
    controller.abort(new Error('Test finished')); await waiter.catch(() => {});
    if (previous === undefined) delete process.env.CODEX_DRIVE_HOME; else process.env.CODEX_DRIVE_HOME = previous;
  }
});

test('late wait uses a detached logger completion when the server snapshot loses its failure', async t => {
  const f = await fixture(t, { turnsList: (params, result) => ({ ...result, data: result.data.map(turn =>
    turn.status === 'failed' ? { ...turn, status: 'interrupted', error: null } : turn) }) });
  assert.equal((await f.command(['resume', 'demo', '--detach', 'Continue'])).code, 0);
  f.complete('failed', null, f.turns.at(-1), error('serverOverloaded'));
  const path = join(f.home, 'threads/demo.json');
  await until(() => JSON.parse(readFileSync(path, 'utf8')).status === 'failed', 'detached logger persisted completion');
  const before = readFileSync(path, 'utf8');
  const result = await f.command(['wait', 'demo', '--timeout', '3']);
  assert.equal(result.code, 75, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).failure.class, 'capacity');
  assert.equal(readFileSync(path, 'utf8'), before, 'wait must leave persisted state unchanged');
});

test('wait rechecks saved completion if a failure notification was missed during disconnect', async t => {
  const f = await fixture(t, { turnsList: (params, result) => ({ ...result, data: result.data.map(turn =>
    turn.status === 'failed' ? { ...turn, status: 'interrupted', error: null } : turn) }) });
  f.turns[0].status = 'inProgress'; f.seed({ status: 'running' });
  const waiter = f.launch(['wait', 'demo', '--timeout', '3']);
  await until(f.hasRead, 'initial running snapshot');
  f.disconnect();
  const failure = error('serverOverloaded'); f.complete('failed', null, f.turns[0], failure);
  f.seed({ status: 'failed', error: failure });
  const result = await waiter.result;
  assert.equal(result.code, 75, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).error, failure);
  assert.ok(f.received.filter(m => m.method === 'thread/resume').length >= 2);
});

test('a saved previous failure cannot settle wait for a newer turn', async t => {
  const f = await fixture(t);
  f.seed({ status: 'failed', error: error('serverOverloaded') });
  const next = { id: 'turn-2', status: 'inProgress', items: [], error: null }; f.turns.push(next);
  const waiter = f.launch(['wait', 'demo', '--timeout', '3']);
  await until(f.hasRead, 'newer turn snapshot'); f.complete('completed', 'NEW-TURN', next);
  const result = await waiter.result;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).turnId, next.id);
});

test('a saved interrupted snapshot cannot hide a failed server result', async t => {
  const f = await fixture(t), failure = error('serverOverloaded');
  f.seed({ status: 'interrupted', error: null });
  f.complete('failed', null, f.turns[0], failure);
  const result = await f.command(['wait', 'demo', '--timeout', '3']);
  assert.equal(result.code, 75, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).error, failure);
});

test('protocol-conformant fake failures produce distinct status classes and wait exits', async t => {
  for (const [info, classification, code] of [['serverOverloaded', 'capacity', 75], ['usageLimitExceeded', 'usageLimit', 76], ['other', 'other', 1]]) {
    const f = await fixture(t);
    assert.equal((await f.command(['resume', 'demo', '--detach', 'Continue'])).code, 0);
    const turn = f.turns.at(-1), failure = error(info, 'Overloaded or usage limit? Text must not decide.');
    const limits = { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1800000000 } };
    f.emit('account/rateLimits/updated', notification('AccountRateLimitsUpdatedNotification', { rateLimits: limits }));
    f.emit('error', notification('ErrorNotification', { threadId: f.state.threadId, turnId: turn.id, error: failure, willRetry: false }));
    notification('TurnCompletedNotification', { threadId: f.state.threadId, turn: { ...turn, items: [], status: 'failed', error: failure } });
    f.complete('failed', null, turn, failure);
    const waited = await f.command(['wait', 'demo']); assert.equal(waited.code, code, waited.stderr);
    const current = JSON.parse(waited.stdout); assert.equal(current.failure.class, classification);
    assert.deepEqual(current.error, failure);
    await until(() => JSON.parse(readFileSync(join(f.home, 'threads/demo.json'))).rateLimits?.primary?.resetsAt, 'rate-limit state');
    const state = JSON.parse((await f.command(['status', 'demo'])).stdout);
    assert.equal(state.failure.class, classification);
    assert.equal(state.rateLimits.primary.resetsAt, 1800000000);
    assert.deepEqual(state.failure.resetsAt, classification === 'usageLimit' ? { primary: 1800000000 } : null);
  }
});

test('capacity retry opts into a bounded same-thread continuation with backoff', async t => {
  const f = await fixture(t);
  const run = f.launch(['resume', 'demo', '--retry-capacity', '1', 'Original task']);
  await until(() => run.stdout().trim(), 'first IDs');
  const first = JSON.parse(run.stdout().trim());
  const failedAt = Date.now(); f.complete('failed', null, f.turns.at(-1), error('serverOverloaded'));
  await until(() => f.received.filter(m => m.method === 'turn/start').length === 2, 'capacity continuation');
  assert.ok(Date.now() - failedAt >= 900, 'retry skipped documented backoff');
  const retry = f.received.filter(m => m.method === 'turn/start').at(-1);
  assert.equal(retry.params.threadId, first.threadId);
  assert.equal(retry.params.input[0].text, 'Continue from where you stopped.');
  f.complete('failed', null, f.turns.at(-1), error('flexUnavailable'));
  assert.equal((await run.result).code, 75);
  assert.equal(f.received.filter(m => m.method === 'turn/start').length, 2);
});

test('usage limits never retry even when capacity retry is enabled', async t => {
  const f = await fixture(t);
  const run = f.launch(['resume', 'demo', '--retry-capacity', '3', 'Task']);
  await until(() => run.stdout().trim(), 'first IDs');
  f.complete('failed', null, f.turns.at(-1), error('rateLimitExceeded', 'serverOverloaded; try again'));
  assert.equal((await run.result).code, 76);
  assert.equal(f.received.filter(m => m.method === 'turn/start').length, 1);
});

test('capacity continuation is skipped if another caller advances the thread during backoff', async t => {
  const f = await fixture(t), run = f.launch(['resume', 'demo', '--retry-capacity', '2', 'Original']);
  await until(() => run.stdout().trim(), 'first IDs');
  f.complete('failed', null, f.turns.at(-1), error('serverOverloaded'));
  f.turns.push({ id: 'external-turn', status: 'completed', items: [], error: null });
  f.emit('turn/started', { threadId: f.state.threadId, turn: { id: 'external-turn', status: 'inProgress', items: [], error: null } });
  const result = await run.result;
  assert.equal(result.code, 75, result.stderr);
  assert.equal(f.received.filter(m => m.method === 'turn/start').length, 1);
  assert.equal(f.turns.at(-1).id, 'external-turn');
});
