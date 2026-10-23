import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../test-support/app-server.mjs';

test('generic call reaches an unwrapped method and reports full protocol errors', async t => {
  const f = await fixture(t);
  const called = await f.command(['call', 'server/diagnostics', '{}', '--port', String(f.port)]);
  assert.equal(called.code, 0, called.stderr);
  assert.deepEqual(JSON.parse(called.stdout), { diagnostics: ['PASSTHROUGH'] });
  const failed = await f.command(['call', 'thread/read', '{"threadId":"missing"}', '--port', String(f.port)]);
  assert.equal(failed.code, 1);
  assert.deepEqual(JSON.parse(failed.stderr), { code: -32001, message: 'Not found', data: { detail: 'original' } });
});

test('generic JSON retains its type so scalar and array parameters fail validation', async t => {
  const f = await fixture(t);
  for (const invalid of ['42', '[]', '"text"']) {
    const result = await f.command(['call', 'model/list', invalid, '--port', String(f.port)]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Invalid parameters/);
  }
});

test('generic calls accept JSON files, stdin and overrides without consuming initialize twice', async t => {
  const f = await fixture(t);
  const { writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const file = join(f.home, 'params.json'); writeFileSync(file, '{"limit":3}');
  assert.equal((await f.command(['call', 'model/list', '@' + file, '--param', 'includeHidden=true', '--port', String(f.port)])).code, 0);
  assert.deepEqual(f.received.at(-1).params, { limit: 3, includeHidden: true });
  const piped = await f.command(['call', 'model/list', '-', '--port', String(f.port)], { stdin: '{"limit":7}' });
  assert.equal(piped.code, 0, piped.stderr); assert.equal(f.received.at(-1).params.limit, 7);
  const initialized = await f.command(['call', 'initialize', '{"clientInfo":{"name":"test","version":"1"},"capabilities":{"experimentalApi":true}}', '--port', String(f.port)]);
  assert.equal(initialized.code, 0, initialized.stderr);
  assert.equal(f.received.filter(m => m.method === 'initialize').at(-1).params.clientInfo.name, 'test');
  assert.equal(f.received.filter(m => m.method === 'initialize').length, 3, 'one handshake per client');
  const invalid = await f.command(['call', 'model/list', '{}', '--param', '__proto__={"includeHidden":true}', '--port', String(f.port)]);
  assert.equal(invalid.code, 1); assert.match(invalid.stderr, /__proto__/);
});

test('turn composition forwards full scoped and shared options and rejects invalid input before mutations', async t => {
  const f = await fixture(t);
  const start = await f.command(['start', '--port', String(f.port), '--detach', '--name', 'options', '--thread-params', '{"developerInstructions":"THREAD","serviceTier":"default","experimentalRawEvents":true}', '--param', 'modelProvider="openai"', '--param', 'turn.outputSchema={"type":"object","properties":{"answer":{"type":"string"}}}', '--param', 'turn.summary="detailed"', 'Do it']);
  assert.equal(start.code, 0, start.stderr);
  const thread = f.received.find(m => m.method === 'thread/start').params;
  assert.equal(thread.developerInstructions, 'THREAD'); assert.equal(thread.experimentalRawEvents, true); assert.equal(thread.modelProvider, 'openai');
  const turn = f.received.find(m => m.method === 'turn/start').params;
  assert.equal(turn.summary, 'detailed'); assert.equal(turn.outputSchema.properties.answer.type, 'string'); assert.equal(turn.input[0].text, 'Do it');
  f.complete(); await f.command(['wait', 'options']);
  const before = f.received.length;
  const bad = await f.command(['resume', 'options', '--turn-params', '{"input":[],"typo":true}']);
  assert.equal(bad.code, 1); assert.match(bad.stderr, /typo/); assert.equal(f.received.length, before);
  assert.equal((await f.command(['status', 'options', '--param', 'ignored=true'])).code, 1);
});

test('adopted external histories and forks have independent addressable turn state', async t => {
  const f = await fixture(t);
  f.threads.set('external', structuredClone(f.turns));
  const adopted = await f.command(['adopt', 'external', '--port', String(f.port), '--name', 'imported']);
  assert.equal(adopted.code, 0, adopted.stderr); assert.equal(JSON.parse(adopted.stdout).threadId, 'external');
  const forked = await f.command(['fork', 'imported', '--name', 'branch']);
  assert.equal(forked.code, 0, forked.stderr); assert.notEqual(JSON.parse(forked.stdout).threadId, 'external');
  const a = await f.command(['resume', 'imported', '--detach', 'Original']);
  const b = await f.command(['resume', 'branch', '--detach', 'Fork']);
  assert.equal(a.code, 0, a.stderr); assert.equal(b.code, 0, b.stderr);
  assert.equal((await f.command(['steer', 'imported', 'Finish'])).code, 0);
  assert.equal(JSON.parse((await f.command(['status', 'branch'])).stdout).status, 'running');
  assert.equal((await f.command(['interrupt', 'branch'])).code, 0);
  assert.equal((await f.command(['wait', 'imported'])).code, 0); assert.equal((await f.command(['wait', 'branch'])).code, 130);
});

test('manual server requests surface in logs, status and pending and accept validated external responses', async t => {
  const f = await fixture(t);
  assert.equal((await f.command(['resume', 'demo', '--detach', '--request-policy', 'manual', 'Ask approval'])).code, 0);
  f.request('item/commandExecution/requestApproval', { threadId: 'thread-1', turnId: 'turn-2', itemId: 'cmd', startedAtMs: Date.now(), reason: 'Proof', command: 'echo proof', cwd: f.home });
  const { until } = await import('../test-support/app-server.mjs');
  const pending = await until(async () => { const list = JSON.parse((await f.command(['pending', 'demo'])).stdout); return list.length && list; }, 'pending approval');
  assert.equal(pending[0].method, 'item/commandExecution/requestApproval');
  assert.equal(JSON.parse((await f.command(['status', 'demo'])).stdout).pendingRequests[0].requestId, pending[0].requestId);
  const invalid = await f.command(['respond', pending[0].requestId, '{"decision":"bogus"}']); assert.equal(invalid.code, 1);
  assert.equal((await f.command(['respond', pending[0].requestId, '{"decision":"accept"}'])).code, 0);
  await until(() => f.replies.length, 'server response'); assert.deepEqual(f.replies.at(-1), { id: 'server-1', result: { decision: 'accept' } });
  assert.deepEqual(JSON.parse((await f.command(['pending', 'demo'])).stdout), []);
  const events = (await f.command(['events', 'demo'])).stdout.trim().split('\n').map(JSON.parse);
  assert.ok(events.some(e => e.method === 'item/commandExecution/requestApproval'));
  f.request('future/request', { threadId: 'thread-1' }, 'future');
  const future = await until(async () => { const list = JSON.parse((await f.command(['pending'])).stdout); return list.find(e => e.method === 'future/request'); });
  assert.equal((await f.command(['respond', future.requestId, '{"code":-32601,"message":"Unsupported"}', '--error'])).code, 0);
  await until(() => f.replies.some(e => e.id === 'future'), 'future error');
  assert.deepEqual(f.replies.at(-1), { id: 'future', error: { code: -32601, message: 'Unsupported' } });
  f.complete(); assert.equal((await f.command(['wait', 'demo'])).code, 0);
});

test('start submits the first turn before trying to read its not-yet-materialized history', async t => {
  const f = await fixture(t); f.turns.length = 0;
  const started = await f.command(['start', '--port', String(f.port), '--detach', '--name', 'fresh', 'First message']);
  assert.equal(started.code, 0, started.stderr);
  assert.ok(JSON.parse(started.stdout).turnId);
  f.complete(); assert.equal((await f.command(['wait', 'fresh'])).code, 0);
});

test('detach forwards stdin turn JSON and raw full-access warning to its parent', async t => {
  const f = await fixture(t);
  const result = await f.command(['start', '--port', String(f.port), '--name', 'stdin', '--detach', '--thread-params', '{"sandbox":"danger-full-access","approvalPolicy":"never"}', '--turn-params', '-'], { stdin: '{"input":[{"type":"text","text":"FROM-STDIN","text_elements":[]}],"effort":"low"}' });
  assert.equal(result.code, 0, result.stderr); assert.match(result.stderr, /WARNING: danger-full-access/);
  assert.equal(f.received.find(m => m.method === 'turn/start').params.input[0].text, 'FROM-STDIN');
  f.complete(); assert.equal((await f.command(['wait', 'stdin'])).code, 0);
});

test('events follow preserves new unwrapped notifications while the attached logger runs', async t => {
  const f = await fixture(t);
  assert.equal((await f.command(['resume', 'demo', '--detach', 'Collect'])).code, 0);
  const follow = f.launch(['events', 'demo', '--follow']);
  f.emit('future/notification', { arbitrary: ['opaque', 42] });
  const { until } = await import('../test-support/app-server.mjs');
  await until(() => follow.stdout().includes('future/notification'), 'unwrapped event');
  const event = follow.stdout().trim().split('\n').map(JSON.parse).find(e => e.method === 'future/notification');
  assert.deepEqual(event.params, { arbitrary: ['opaque', 42] });
  f.complete(); await until(() => follow.stdout().includes('turn/completed'), 'completed event');
  follow.child.kill('SIGTERM'); await follow.result;
});

test('adoption rejects turn-only options and fork rejects non-object JSON without contacting the server', async t => {
  const f = await fixture(t), before = f.received.length;
  const adoption = await f.command(['adopt', 'external', '--port', String(f.port), '--param', 'turn.outputSchema={}']);
  assert.equal(adoption.code, 1); assert.match(adoption.stderr, /does not belong/);
  for (const raw of ['42', 'false', '[]']) {
    const fork = await f.command(['fork', 'demo', '--thread-params', raw]); assert.equal(fork.code, 1); assert.match(fork.stderr, /JSON object/);
  }
  assert.equal(f.received.length, before);
});

test('adoption preserves the existing approval reviewer unless explicitly overridden', async t => {
  const f = await fixture(t); f.threads.set('external', structuredClone(f.turns));
  assert.equal((await f.command(['adopt', 'external', '--port', String(f.port)])).code, 0);
  const resumed = f.received.find(m => m.method === 'thread/resume');
  assert.equal(Object.hasOwn(resumed.params, 'approvalsReviewer'), false);
});

test('an attached logger finishes its owned turn after reconnect even if the thread has advanced', async t => {
  const f = await fixture(t), run = f.launch(['resume', 'demo', 'Original']);
  const { until } = await import('../test-support/app-server.mjs');
  const { setTimeout: delay } = await import('node:timers/promises');
  await until(() => run.stdout().trim(), 'attached IDs'); const ids = JSON.parse(run.stdout().trim());
  f.disconnect(); f.complete('completed', 'OWNED', f.turns.at(-1));
  f.turns.push({ id: 'newer', status: 'inProgress', items: [], error: null });
  const result = await Promise.race([run.result, delay(2500, { code: 'still-running' }, { ref: false })]);
  assert.equal(result.code, 0, result.stderr ?? 'logger followed the newer turn');
  assert.equal(JSON.parse(run.stdout().trim()).turnId, ids.turnId);
  assert.equal(f.turns.at(-1).status, 'inProgress');
});

test('lost-start recovery retains account rate-limit notifications from its buffered stream', async t => {
  const f = await fixture(t); f.loseNextStartReply({ primary: { usedPercent: 100, resetsAt: 1800000000 } });
  const run = f.launch(['resume', 'demo', 'Recover']);
  const { until } = await import('../test-support/app-server.mjs');
  await until(() => f.received.some(e => e.method === 'turn/start'), 'start received');
  assert.equal((await run.result).code, 0);
  const status = JSON.parse((await f.command(['status', 'demo'])).stdout);
  assert.equal(status.rateLimits.primary.resetsAt, 1800000000);
});
