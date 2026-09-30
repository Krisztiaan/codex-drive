import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store, atomicWrite, checkKey, applyEvent } from '../src/state.mjs';

function fixture(t) {
  const root = '/tmp/codex-drive-proof';
  mkdirSync(root, { recursive: true });
  const home = mkdtempSync(join(root, 'unit-state-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return { home, store: new Store(home) };
}

function thread(overrides = {}) {
  return { threadId: 'thread-1', turnId: 'turn-1', name: 'demo', status: 'running',
    cwd: '/tmp/codex-drive-proof', model: 'gpt-6.1-sol', log: '/tmp/codex-drive-proof/events.jsonl', ...overrides };
}

test('unsafe state keys cannot traverse or select absolute paths', t => {
  const { store } = fixture(t);
  for (const key of ['../escape', '/absolute', '.', '..', 'nested/name', 'space name', '', 'a\\b']) {
    assert.throws(() => checkKey(key), /Invalid thread name or id/);
    assert.throws(() => store.read(key), /Invalid thread name or id/);
    assert.throws(() => store.create(thread({ name: key })), /Invalid thread name or id/);
  }
});

test('state persists all fields and can be found by its name or thread id', t => {
  const { store } = fixture(t);
  const state = thread();
  store.create(state);
  assert.deepEqual(store.read('demo'), state);
  assert.deepEqual(store.read('thread-1'), state);
  assert.deepEqual(store.all(), [state]);
  assert.throws(() => store.read('missing'), /Unknown thread: missing/);
  assert.equal(statSync(store.path('demo')).mode & 0o777, 0o600);
});

test('unnamed threads use their thread id as the state key', t => {
  const { store } = fixture(t);
  const state = thread({ name: undefined });
  store.create(state);
  assert.equal(store.read('thread-1').threadId, 'thread-1');
  assert.deepEqual(readdirSync(store.dir), ['thread-1.json']);
});

test('duplicate names are rejected without overwriting existing state', t => {
  const { store } = fixture(t);
  const initial = thread();
  store.create(initial);
  assert.throws(() => store.create(thread({ threadId: 'thread-2' })), { code: 'EEXIST' });
  assert.deepEqual(store.read('demo'), initial);
});

test('save atomically replaces state and leaves no temporary files', t => {
  const { store } = fixture(t);
  const state = thread();
  store.create(state);
  state.status = 'completed';
  state.lastAgentMessage = 'FINISHED';
  store.save(state);
  assert.deepEqual(store.read('demo'), state);
  assert.deepEqual(readdirSync(store.dir), ['demo.json']);
  assert.equal(statSync(store.path('demo')).mode & 0o777, 0o600);
  assert.ok(readFileSync(store.path('demo'), 'utf8').endsWith('\n'));
});

test('failed atomic writes preserve the previous data and clean temporary files', t => {
  const { home } = fixture(t);
  const path = join(home, 'snapshot.json');
  atomicWrite(path, { saved: true });
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => atomicWrite(path, cyclic), /circular/i);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { saved: true });
  assert.deepEqual(readdirSync(home).sort(), ['snapshot.json', 'threads']);
  const directory = join(home, 'directory');
  mkdirSync(directory);
  assert.throws(() => atomicWrite(directory, { saved: false }));
  assert.ok(statSync(directory).isDirectory());
  assert.ok(readdirSync(home).every(name => !name.endsWith('.tmp')));
});

test('turn events update the current turn and terminal status', () => {
  const state = thread({ status: 'completed' });
  assert.equal(applyEvent(state, { method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-2' } } }, 'start-time'), true);
  assert.equal(state.turnId, 'turn-2');
  assert.equal(state.status, 'running');
  assert.equal(state.lastEventTime, 'start-time');
  applyEvent(state, { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'failed' } } }, 'old-time');
  assert.equal(state.status, 'running');
  for (const status of ['completed', 'interrupted', 'failed']) {
    const error = status === 'failed' ? { message: 'Failed' } : null;
    applyEvent(state, { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-2', status, error } } }, status);
    assert.equal(state.status, status);
    assert.deepEqual(state.error, error);
    assert.equal(state.lastEventTime, status);
  }
});

test('retryable errors do not finish a running turn', () => {
  const state = thread();
  applyEvent(state, { method: 'error', params: { threadId: 'thread-1', turnId: 'turn-1', willRetry: true, error: { message: 'Retrying' } } }, 'retry-time');
  assert.equal(state.status, 'running');
  assert.equal(state.lastEventTime, 'retry-time');
});

test('unrelated thread and global events cannot mutate thread state', () => {
  const state = thread();
  const original = structuredClone(state);
  assert.equal(applyEvent(state, { method: 'turn/completed', params: { threadId: 'other', turn: { id: 'turn-1', status: 'failed' } } }), false);
  assert.equal(applyEvent(state, { method: 'warning', params: { message: 'Global warning' } }), false);
  assert.deepEqual(state, original);
});

test('completed agent messages expose the last nonempty line', () => {
  const state = thread();
  applyEvent(state, { method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', text: 'Working\n\nSTEERED-OK\n' } } });
  assert.equal(state.lastAgentMessage, 'STEERED-OK');
  applyEvent(state, { method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'commandExecution', command: 'date' } } });
  assert.equal(state.lastAgentMessage, 'STEERED-OK');
});

test('a live owner prevents a second lock until release', t => {
  const { store } = fixture(t);
  const release = store.lock('demo');
  assert.throws(() => store.lock('demo'), /Another driver owns demo/);
  release();
  const releaseAgain = store.lock('demo');
  releaseAgain();
  assert.deepEqual(readdirSync(store.dir), []);
});

test('a dead owner lock is recovered', t => {
  const { store } = fixture(t);
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  assert.equal(child.status, 0);
  const pid = Number(child.stdout);
  assert.ok(Number.isInteger(pid) && pid > 0);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  writeFileSync(store.path('demo') + '.lock', String(pid));
  const release = store.lock('demo');
  assert.equal(readFileSync(store.path('demo') + '.lock', 'utf8'), String(process.pid));
  release();
});

test('thread names cannot shadow a canonical thread ID', t => {
  const { store } = fixture(t);
  store.create(thread({ name: 'first', threadId: 'id-first' }));
  assert.throws(() => store.create(thread({ name: 'id-first', threadId: 'id-second' })), /collid/i);
  assert.equal(store.read('id-first').name, 'first');
});

test('a concurrently created state is either absent or complete for readers', async t => {
  const { store, home } = fixture(t);
  const { spawn } = await import('node:child_process');
  const { pathToFileURL } = await import('node:url');
  const { resolve } = await import('node:path');
  const { setTimeout: delay } = await import('node:timers/promises');
  const source = `import { Store } from ${JSON.stringify(pathToFileURL(resolve('src/state.mjs')).href)}; new Store(${JSON.stringify(home)}).create({name:'demo',threadId:'id-created',payload:'x'.repeat(32*1024*1024)});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: 'ignore' });
  let done = false;
  const exited = new Promise(resolve => child.once('exit', code => { done = true; resolve(code); }));
  try {
    while (!done) {
      try { assert.equal(store.read('demo').payload.length, 32 * 1024 * 1024); }
      catch (error) { if (!error.message.startsWith('Unknown thread:')) throw error; }
      await delay(1);
    }
    assert.equal(await exited, 0);
    assert.equal(store.read('demo').payload.length, 32 * 1024 * 1024);
  } finally { if (!done) child.kill('SIGTERM'); await exited; }
});
