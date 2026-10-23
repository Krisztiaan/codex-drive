import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, until } from '../test-support/app-server.mjs';

for (const command of ['start', 'resume', 'adopt', 'attach', 'fork']) {
  test(`${command} without saved settings sends full-access defaults`, async t => {
    const f = await fixture(t);
    const composed = ['start', 'resume'].includes(command);
    const result = await f.command([command, ...(command === 'start' ? [] : ['external']), '--port', String(f.port), '--name', 'defaults', ...(composed ? ['--detach', 'Go'] : [])]);
    assert.equal(result.code, 0, result.stderr);
    const method = command === 'start' ? 'thread/start' : command === 'fork' ? 'thread/fork' : 'thread/resume';
    const params = f.received.find(m => m.method === method).params;
    assert.equal(params.sandbox, 'danger-full-access');
    assert.equal(params.approvalPolicy, 'never');
    const state = JSON.parse((await f.command(['status', 'defaults'])).stdout);
    assert.equal(state.sandbox, 'danger-full-access');
    assert.equal(state.approval, 'never');
    assert.equal(state.requestPolicy, 'approve');
    if (composed) {
      assert.equal(f.received.find(m => m.method === 'turn/start').params.approvalPolicy, 'never');
      f.request('item/commandExecution/requestApproval', { threadId: state.threadId, turnId: state.turnId, itemId: 'cmd' });
      await until(() => f.replies.length, 'automatic approval');
      assert.deepEqual(f.replies.at(-1), { id: 'server-1', result: { decision: 'accept' } });
      assert.equal((await f.command(['interrupt', 'defaults'])).code, 0);
      assert.equal((await f.command(['wait', 'defaults'])).code, 130);
    }
  });

  test(`${command} explicit stricter flags override defaults`, async t => {
    const f = await fixture(t);
    const composed = ['start', 'resume'].includes(command);
    const result = await f.command([command, ...(command === 'start' ? [] : ['external']), '--port', String(f.port), '--name', 'strict', '--sandbox', 'read-only', '--approval', 'on-request', '--request-policy', 'decline', ...(composed ? ['--detach', 'Go'] : [])]);
    assert.equal(result.code, 0, result.stderr);
    const method = command === 'start' ? 'thread/start' : command === 'fork' ? 'thread/fork' : 'thread/resume';
    const params = f.received.find(m => m.method === method).params;
    assert.equal(params.sandbox, 'read-only');
    assert.equal(params.approvalPolicy, 'on-request');
    const state = JSON.parse((await f.command(['status', 'strict'])).stdout);
    assert.equal(state.sandbox, 'read-only');
    assert.equal(state.approval, 'on-request');
    assert.equal(state.requestPolicy, 'decline');
    if (composed) {
      assert.equal(f.received.find(m => m.method === 'turn/start').params.approvalPolicy, 'on-request');
      f.request('item/commandExecution/requestApproval', { threadId: state.threadId, turnId: state.turnId, itemId: 'cmd' });
      await until(() => f.replies.length, 'automatic decline');
      assert.deepEqual(f.replies.at(-1), { id: 'server-1', result: { decision: 'decline' } });
      assert.equal((await f.command(['interrupt', 'strict'])).code, 0);
      assert.equal((await f.command(['wait', 'strict'])).code, 130);
    }
  });
}

test('resume preserves saved stricter settings and manual request handling', async t => {
  const f = await fixture(t);
  f.seed({ sandbox: 'read-only', approval: 'on-request', requestPolicy: 'manual' });
  const result = await f.command(['resume', 'demo', '--detach', 'Go']);
  assert.equal(result.code, 0, result.stderr);
  const params = f.received.find(m => m.method === 'thread/resume').params;
  assert.equal(Object.hasOwn(params, 'sandbox'), false);
  assert.equal(Object.hasOwn(params, 'approvalPolicy'), false);
  const state = JSON.parse((await f.command(['status', 'demo'])).stdout);
  assert.equal(state.sandbox, 'read-only');
  assert.equal(state.approval, 'on-request');
  assert.equal(state.requestPolicy, 'manual');
  f.request('item/commandExecution/requestApproval', { threadId: state.threadId, turnId: state.turnId, itemId: 'cmd' });
  const pending = await until(async () => JSON.parse((await f.command(['pending', 'demo'])).stdout)[0], 'manual approval');
  assert.equal(f.replies.length, 0);
  assert.equal((await f.command(['respond', pending.requestId, '{"decision":"decline"}'])).code, 0);
  assert.equal((await f.command(['interrupt', 'demo'])).code, 0);
  assert.equal((await f.command(['wait', 'demo'])).code, 130);
});

test('explicit stricter flags override saved full-access settings on resume and fork', async t => {
  const f = await fixture(t);
  f.seed({ sandbox: 'danger-full-access', approval: 'never', requestPolicy: 'approve' });
  for (const command of ['resume', 'fork']) {
    const result = await f.command([command, 'demo', ...(command === 'fork' ? ['--name', 'strict-fork'] : []), '--sandbox', 'workspace-write', '--approval', 'on-request', '--request-policy', 'manual']);
    assert.equal(result.code, 0, result.stderr);
    const params = f.received.findLast(m => m.method === `thread/${command}`).params;
    assert.equal(params.sandbox, 'workspace-write');
    assert.equal(params.approvalPolicy, 'on-request');
    const state = JSON.parse((await f.command(['status', command === 'fork' ? 'strict-fork' : 'demo'])).stdout);
    assert.equal(state.sandbox, 'workspace-write');
    assert.equal(state.approval, 'on-request');
    assert.equal(state.requestPolicy, 'manual');
    f.seed({ sandbox: 'danger-full-access', approval: 'never', requestPolicy: 'approve' });
  }
});

test('fork inherits saved settings without replacing server permission profiles', async t => {
  const f = await fixture(t);
  f.seed({ sandbox: 'read-only', approval: 'on-request', requestPolicy: 'manual', activePermissionProfile: 'restricted' });
  const result = await f.command(['fork', 'demo', '--name', 'inherited']);
  assert.equal(result.code, 0, result.stderr);
  const params = f.received.find(m => m.method === 'thread/fork').params;
  assert.equal(Object.hasOwn(params, 'sandbox'), false);
  assert.equal(Object.hasOwn(params, 'approvalPolicy'), false);
  const state = JSON.parse((await f.command(['status', 'inherited'])).stdout);
  assert.equal(state.sandbox, 'read-only');
  assert.equal(state.approval, 'on-request');
  assert.equal(state.requestPolicy, 'manual');
  assert.equal(state.activePermissionProfile, 'restricted');
});

test('explicit permission profiles override the default sandbox', async t => {
  const f = await fixture(t);
  for (const command of ['start', 'adopt', 'fork']) {
    const result = await f.command([command, ...(command === 'start' ? [] : ['external']), '--port', String(f.port), '--name', `profile-${command}`, '--thread-params', '{"permissions":"restricted"}', ...(command === 'start' ? ['--detach', 'Go'] : [])]);
    assert.equal(result.code, 0, result.stderr);
    const method = command === 'start' ? 'thread/start' : command === 'fork' ? 'thread/fork' : 'thread/resume';
    const params = f.received.findLast(m => m.method === method).params;
    assert.equal(params.permissions, 'restricted');
    assert.equal(Object.hasOwn(params, 'sandbox'), false);
    if (command === 'start') {
      assert.equal((await f.command(['interrupt', `profile-${command}`])).code, 0);
    }
  }
});
