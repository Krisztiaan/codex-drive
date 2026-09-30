import test from 'node:test';
import assert from 'node:assert/strict';
import { methods, validateCall } from '../src/protocol.mjs';

test('generic calls validate generated stable and experimental request parameters', () => {
  assert.ok(methods().includes('fs/readFile'));
  assert.ok(methods().includes('thread/goal/set'));
  assert.doesNotThrow(() => validateCall('fs/readFile', { path: '/tmp/example' }));
  assert.doesNotThrow(() => validateCall('thread/goal/set', { threadId: 't', objective: 'finish', tokenBudget: 10 }));
  assert.throws(() => validateCall('not/aMethod', {}), /Unknown client method/);
  assert.throws(() => validateCall('fs/readFile', { path: 42 }), /fs\/readFile.*path/s);
  assert.throws(() => validateCall('fs/readFile', { path: '/tmp/example', typo: true }), /typo/);
});

test('generic calls preserve arbitrary explicit maps while validating nested inputs', () => {
  assert.doesNotThrow(() => validateCall('thread/start', {
    cwd: '/tmp/proof', config: { 'model_reasoning_effort': 'high', custom: { arbitrary: true } },
    mockExperimentalField: 'generated experimental field',
  }));
  assert.throws(() => validateCall('turn/start', { threadId: 't', input: [{ type: 'text', text: 42 }] }), /text/);
  assert.throws(() => validateCall('turn/start', { threadId: 't', input: [{ type: 'text', text: 'go', typo: true }] }), /typo/);
  assert.throws(() => validateCall('model/list', { limit: -1 }), /must be >= 0/);
  assert.throws(() => validateCall('model/list', { includeHidden: 'yes' }), /boolean/);
});

test('server request answers follow generated response types', async () => {
  const { validateResponse, serverMethods } = await import('../src/protocol.mjs');
  assert.ok(serverMethods().includes('currentTime/read'));
  assert.doesNotThrow(() => validateResponse('item/commandExecution/requestApproval', { decision: 'accept' }));
  assert.doesNotThrow(() => validateResponse('item/permissions/requestApproval', { permissions: {}, scope: 'turn' }));
  assert.doesNotThrow(() => validateResponse('item/tool/requestUserInput', { answers: { q: { answers: ['yes'] } } }));
  assert.doesNotThrow(() => validateResponse('currentTime/read', { currentTimeAt: 1_790_000_000 }));
  assert.throws(() => validateResponse('currentTime/read', { currentTimeAt: 'tomorrow' }), /integer/);
  assert.throws(() => validateResponse('item/commandExecution/requestApproval', { decision: 'approved' }), /response/);
  assert.throws(() => validateResponse('item/tool/call', { success: true }), /contentItems/);
  assert.throws(() => validateResponse('unknown/request', {}), /Unknown server request method/);
});
