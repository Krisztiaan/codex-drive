import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { RequestBroker, pendingRequests, respond } from '../src/requests.mjs';

function transport() {
  const rpc = new EventEmitter(); rpc.port = 49123; rpc.sent = [];
  rpc.send = message => rpc.sent.push(message);
  return rpc;
}
function home(t) {
  mkdirSync('/tmp/codex-drive-proof', { recursive: true });
  const dir = mkdtempSync('/tmp/codex-drive-proof/req-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const approval = { id: 18, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-a', turnId: 'turn-a', itemId: 'item-a', command: 'echo hello' } };

test('manual requests are listed and an external response reaches the original connection and id', async t => {
  const dir = home(t), rpc = transport(), logs = [];
  const broker = new RequestBroker({ home: dir, log: event => logs.push(event) });
  await broker.start(); t.after(() => broker.close());
  broker.handle(rpc, approval);
  const pending = pendingRequests(dir, 'thread-a');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].method, approval.method);
  assert.deepEqual(pending[0].params, approval.params);
  assert.equal(rpc.sent.length, 0);
  const reply = await respond(dir, pending[0].requestId, { decision: 'accept' });
  assert.equal(reply.responded, true);
  assert.deepEqual(rpc.sent, [{ id: 18, result: { decision: 'accept' } }]);
  assert.deepEqual(pendingRequests(dir), []);
  assert.ok(logs.some(e => e.method === 'driver/requestPending'));
  assert.ok(logs.some(e => e.method === 'driver/requestResponded'));
});

test('invalid responses stay pending and future requests can be answered with an explicit protocol error', async t => {
  const dir = home(t), rpc = transport(), broker = new RequestBroker({ home: dir });
  await broker.start(); t.after(() => broker.close());
  broker.handle(rpc, approval);
  const id = broker.pending()[0].requestId;
  await assert.rejects(respond(dir, id, { decision: 'invented' }), /decision|schema|valid/i);
  assert.equal(broker.pending().length, 1);
  assert.equal(rpc.sent.length, 0);
  broker.handle(rpc, { id: 'future', method: 'future/request', params: { threadId: 'thread-a', arbitrary: true } });
  const unknown = broker.pending().find(p => p.method === 'future/request');
  await respond(dir, unknown.requestId, undefined, { error: { code: -32601, message: 'Unsupported client operation', data: { method: 'future/request' } } });
  assert.deepEqual(rpc.sent[0], { id: 'future', error: { code: -32601, message: 'Unsupported client operation', data: { method: 'future/request' } } });
  assert.equal(broker.pending().length, 1);
});

test('server resolution removes only its connection request and disconnect cancels only that connection', async t => {
  const dir = home(t), logs = [], a = transport(), b = transport(), broker = new RequestBroker({ home: dir, log: e => logs.push(e) });
  await broker.start(); t.after(() => broker.close());
  broker.handle(a, approval); broker.handle(b, approval);
  const [first, second] = broker.pending();
  assert.notEqual(first.requestId, second.requestId);
  broker.handle(a, { method: 'serverRequest/resolved', params: { threadId: 'thread-a', requestId: 18 } });
  assert.deepEqual(broker.pending().map(p => p.requestId), [second.requestId]);
  await assert.rejects(respond(dir, first.requestId, { decision: 'accept' }), /no longer pending/);
  b.emit('disconnect');
  assert.deepEqual(pendingRequests(dir), []);
  assert.ok(logs.some(e => e.method === 'driver/requestCanceled' && e.params.reason.includes('disconnected')));
  const c = transport(); broker.handle(c, approval);
  await respond(dir, broker.pending()[0].requestId, { decision: 'decline' });
  assert.deepEqual(c.sent, [{ id: 18, result: { decision: 'decline' } }]);
});

test('explicit approval policy answers approvals but leaves tools and input manual', async t => {
  const dir = home(t), rpc = transport(), broker = new RequestBroker({ home: dir, policy: 'approve' });
  await broker.start(); t.after(() => broker.close());
  broker.handle(rpc, approval);
  broker.handle(rpc, { id: 19, method: 'item/fileChange/requestApproval', params: { threadId: 'thread-a' } });
  broker.handle(rpc, { id: 20, method: 'item/permissions/requestApproval', params: { threadId: 'thread-a', permissions: { network: { enabled: true } } } });
  assert.deepEqual(rpc.sent, [
    { id: 18, result: { decision: 'accept' } },
    { id: 19, result: { decision: 'accept' } },
    { id: 20, result: { permissions: { network: { enabled: true } }, scope: 'turn' } }
  ]);
  for (const [i, method] of ['item/tool/call', 'account/chatgptAuthTokens/refresh', 'attestation/generate', 'item/tool/requestUserInput', 'mcpServer/elicitation/request'].entries()) {
    broker.handle(rpc, { id: 30 + i, method, params: { threadId: 'thread-a' } });
  }
  assert.equal(rpc.sent.length, 3);
  assert.equal(broker.pending().length, 5);
});

test('decline policy replies follow the schema and unsupported policy shapes remain answerable manually', async t => {
  const dir = home(t), rpc = transport(), broker = new RequestBroker({ home: dir, policy: 'decline' });
  await broker.start(); t.after(() => broker.close());
  broker.handle(rpc, { id: 1, method: 'execCommandApproval', params: {} });
  broker.handle(rpc, { id: 2, method: 'item/permissions/requestApproval', params: {} });
  broker.handle(rpc, { id: 3, method: 'mcpServer/elicitation/request', params: {} });
  assert.deepEqual(rpc.sent, [
    { id: 1, result: { decision: { denied: { rejection: 'Declined by client policy' } } } },
    { id: 2, result: { permissions: {}, scope: 'turn' } },
    { id: 3, result: { action: 'decline', content: null, _meta: null } }
  ]);
  const approving = new RequestBroker({ home: dir, policy: 'approve' });
  await approving.start(); t.after(() => approving.close());
  approving.handle(rpc, { id: 4, method: 'item/permissions/requestApproval', params: { permissions: { network: 'new-shape' } } });
  assert.equal(approving.pending().length, 1);
  await respond(dir, approving.pending()[0].requestId, { permissions: {}, scope: 'turn' });
  assert.deepEqual(rpc.sent.at(-1), { id: 4, result: { permissions: {}, scope: 'turn' } });
});

test('repeated server request delivery does not permit duplicate replies and closing removes owner artifacts', async t => {
  const dir = home(t), rpc = transport(), logs = [], broker = new RequestBroker({ home: dir, log: e => logs.push(e) });
  await broker.start(); t.after(() => broker.close());
  broker.handle(rpc, approval); broker.handle(rpc, approval);
  assert.equal(pendingRequests(dir).length, 1);
  const pending = broker.pending()[0];
  await broker.close();
  assert.equal(existsSync(pending.socket), false);
  assert.deepEqual(pendingRequests(dir), []);
  await assert.rejects(respond(dir, pending.requestId, { decision: 'accept' }), /no longer pending/);
  assert.ok(logs.some(e => e.method === 'driver/requestCanceled' && e.params.reason.includes('closed')));
});

test('closing answers each pending live request with a protocol error before removing it', async t => {
  const dir = home(t), rpc = transport(), broker = new RequestBroker({ home: dir });
  await broker.start(); t.after(() => broker.close());
  broker.handle(rpc, approval);
  broker.handle(rpc, { id: 'auth-1', method: 'account/chatgptAuthTokens/refresh', params: {} });
  const sentWhilePending = [];
  rpc.send = message => {
    sentWhilePending.push(pendingRequests(dir).some(p => p.serverRequestId === message.id));
    rpc.sent.push(message);
  };
  await broker.close();
  assert.deepEqual(rpc.sent, [
    { id: 18, error: { code: -32000, message: 'Client request owner closed before responding' } },
    { id: 'auth-1', error: { code: -32000, message: 'Client request owner closed before responding' } }
  ]);
  assert.deepEqual(sentWhilePending, [true, true]);
  assert.deepEqual(pendingRequests(dir), []);
});

test('closing is idempotent and racing server requests receive errors without becoming pending', async t => {
  const dir = home(t), rpc = transport(), logs = [], broker = new RequestBroker({ home: dir, log: event => logs.push(event) });
  await broker.start(); t.after(() => broker.close());
  broker.handle(rpc, approval);
  const closing = broker.close();
  assert.equal(broker.close(), closing);
  broker.handle(rpc, { id: 'racing', method: 'future/request', params: { threadId: 'thread-a' } });
  assert.ok(!pendingRequests(dir).some(p => p.serverRequestId === 'racing'));
  await closing;
  assert.deepEqual(rpc.sent.find(message => message.id === 'racing'), {
    id: 'racing', error: { code: -32000, message: 'Client request owner closed before responding' }
  });
  assert.ok(logs.some(event => event.method === 'driver/requestCanceled' && event.params.serverRequestId === 'racing'));
  assert.equal(pendingRequests(dir).length, 0);
});
