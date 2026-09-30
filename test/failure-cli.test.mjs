import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv from 'ajv';
import { fixture, until } from '../test-support/app-server.mjs';

const schema = JSON.parse(readFileSync(new URL('../protocol/schema.json', import.meta.url)));
const ajv = new Ajv({ strict: false, validateFormats: false });
const validators = new Map();
function notification(type, params) {
  if (!validators.has(type)) validators.set(type, ajv.compile({ $ref: `#/definitions/v2/${type}`, definitions: schema.definitions }));
  const check = validators.get(type); assert.equal(check(params), true, JSON.stringify(check.errors));
  return params;
}
function error(info, message = 'Do not classify this prose') { return { message, codexErrorInfo: info, additionalDetails: null }; }

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
