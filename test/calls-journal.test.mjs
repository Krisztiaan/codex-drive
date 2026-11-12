import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync, mkdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixture, until } from '../test-support/app-server.mjs';
import { journalScenario } from '../test-support/journal-scenarios.mjs';

for (const scenario of ['wait', 'attached logger', 'short calls', 'status', 'serve health']) {
  test(`${scenario} creates no implicit call journals and preserves its output`, async t => {
    const result = await journalScenario(t, scenario);
    assert.deepEqual(result.calls, { files: 0, bytes: 0, methods: {} });
    if (scenario === 'attached logger') assert.equal(result.log.methods['turn/diff/updated'].records, 8);
  });
}

test('wait opts out of cumulative diffs and diffs do not trigger lifecycle flushes', async t => {
  const f = await fixture(t);
  assert.equal((await f.command(['wait', 'demo'])).code, 0);
  assert.ok(f.received[0].params.capabilities.optOutNotificationMethods.includes('turn/diff/updated'));
  const { lifecycleEvent } = await import(pathToFileURL(join(process.env.CODEX_DRIVE_TEST_SOURCE ?? resolve('src'), 'client.mjs')).href);
  assert.equal(lifecycleEvent({ method: 'turn/diff/updated' }), false);
  assert.equal(lifecycleEvent({ method: 'turn/completed' }), true);
  const { journal } = await import('../src/client.mjs');
  const path = join(f.home, 'buffered.jsonl'), log = journal(path, { buffered: true });
  log({ method: 'turn/diff/updated', params: { diff: 'fixture' } });
  assert.equal(existsSync(path), false);
  log({ method: 'turn/completed', params: {} });
  assert.equal(readFileSync(path, 'utf8').trim().split('\n').length, 2);
  log.flush();
});

test('one-shot server requests still surface and receive policy responses without a journal', async t => {
  const f = await fixture(t, { initializeEvents: [{ id: 'approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'cmd' } }] });
  const result = await f.command(['call', 'model/list', '{}', '--port', String(f.port)]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /driver\/requestPending/);
  await until(() => f.replies.length);
  assert.deepEqual(f.replies[0], { id: 'approval', result: { decision: 'accept' } });
  assert.equal(existsSync(join(f.home, 'calls')), false);
});

test('calls pruning skips file links, nested directories, and unrelated state', async t => {
  const f = await fixture(t), dir = join(f.home, 'calls'); mkdirSync(dir);
  const outside = join(f.home, 'events.jsonl'); writeFileSync(outside, 'keep\n'); utimesSync(outside, 0, 0);
  symlinkSync(outside, join(dir, 'linked.jsonl'));
  symlinkSync(join(f.home, 'missing'), join(dir, 'dangling.jsonl'));
  mkdirSync(join(dir, 'nested.jsonl')); writeFileSync(join(dir, 'nested.jsonl', 'old.jsonl'), 'keep');
  writeFileSync(join(dir, 'old.jsonl'), '{}\n'); utimesSync(join(dir, 'old.jsonl'), 0, 0);
  writeFileSync(join(dir, 'old.txt'), 'keep'); utimesSync(join(dir, 'old.txt'), 0, 0);
  const dry = await f.command(['prune', '--calls', '--older-than', '1']);
  assert.equal(dry.code, 0, dry.stderr);
  assert.deepEqual(JSON.parse(dry.stdout).calls, ['old.jsonl']);
  assert.equal(existsSync(join(dir, 'old.jsonl')), true);
  const result = await f.command(['prune', '--calls', '--older-than', '1', '--apply']);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).calls, ['old.jsonl']);
  assert.equal(existsSync(join(dir, 'old.jsonl')), false);
  assert.equal(readFileSync(outside, 'utf8'), 'keep\n');
  assert.equal(readFileSync(join(dir, 'nested.jsonl', 'old.jsonl'), 'utf8'), 'keep');
  assert.equal(readFileSync(join(dir, 'old.txt'), 'utf8'), 'keep');
  assert.equal(existsSync(join(f.home, 'threads/demo.json')), true);
});

test('calls pruning refuses a symlinked calls directory for dry-run and apply', async t => {
  const f = await fixture(t), target = join(f.home, 'logs'); mkdirSync(target);
  const path = join(target, 'old.jsonl'); writeFileSync(path, 'keep'); utimesSync(path, 0, 0);
  symlinkSync(target, join(f.home, 'calls'));
  for (const flags of [[], ['--apply']]) {
    const result = await f.command(['prune', '--calls', '--older-than', '1', ...flags]);
    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stderr, /calls.*directory|directory.*calls/i);
    assert.equal(readFileSync(path, 'utf8'), 'keep');
  }
  // Replace calls/ after entering it. Pruning must neither traverse the new
  // link nor remove files from the original directory after it has moved.
  const dir = join(f.home, 'calls'), moved = join(f.home, 'moved-calls');
  fs.unlinkSync(dir); mkdirSync(dir);
  writeFileSync(join(dir, 'old.jsonl'), 'original'); utimesSync(join(dir, 'old.jsonl'), 0, 0);
  const { pruneCalls } = await import('../src/views.mjs');
  const readdir = fs.readdirSync, cwd = process.cwd();
  const mock = t.mock.method(fs, 'readdirSync', function (directory, ...args) {
    const files = readdir(directory, ...args);
    if (directory === '.') { fs.renameSync(dir, moved); symlinkSync(target, dir); }
    return files;
  });
  syncBuiltinESMExports();
  try { assert.throws(() => pruneCalls({ home: f.home }, '1', true), /calls directory changed/); }
  finally { mock.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(process.cwd(), cwd);
  assert.equal(readFileSync(path, 'utf8'), 'keep');
  assert.equal(readFileSync(join(moved, 'old.jsonl'), 'utf8'), 'original');
});
