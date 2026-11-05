import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, until } from '../test-support/app-server.mjs';
import { filterStates, duration } from '../src/views.mjs';

function identity(f, id = 'current') {
  mkdirSync(join(f.home, 'codex'), { recursive: true });
  writeFileSync(join(f.home, 'codex', 'auth.json'), JSON.stringify({ tokens: { account_id: id, id_token: 'x.' + Buffer.from(JSON.stringify({ email: 'current@example.test' })).toString('base64url') + '.SECRET' } }));
}
const account = { account: { type: 'chatgpt', email: 'old@example.test', planType: 'pro' }, requiresOpenaiAuth: true };
const usage = { accountId: 'old', ordinaryUsageAllowed: false, rateLimits: { primary: { usedPercent: 95, resetsAt: 1800000000 } } };

test('account summaries, raw escape hatch, stale identity and near-limit detached warnings', async t => {
  const f = await fixture(t, { account, usage }); identity(f);
  const summary = await f.command(['account', '--port', String(f.port)]);
  assert.equal(summary.code, 0, summary.stderr);
  assert.match(summary.stdout, /old@example.test.*pro/); assert.match(summary.stdout, /95% used; resets/); assert.match(summary.stdout, /Ordinary usage allowed: no/);
  assert.match(summary.stderr, /server account differs/); assert.doesNotMatch(summary.stdout + summary.stderr, /SECRET/);
  const raw = await f.command(['rate-limits', '--json', '--port', String(f.port)]);
  assert.deepEqual(JSON.parse(raw.stdout), usage);
  const started = await f.command(['resume', 'demo', '--detach', 'Continue']);
  assert.equal(started.code, 0, started.stderr); assert.match(started.stderr, /server account differs/); assert.match(started.stderr, /at or near its limit/);
  f.complete(); assert.equal((await f.command(['wait', 'demo'])).code, 0);
  const healthy = await f.command(['serve', '--port', String(f.port)]);
  assert.equal(JSON.parse(healthy.stdout).identityCheck, 'mismatch');
  assert.match(healthy.stderr, /server account differs/);
});

test('status defaults to compact table; JSON, filters, unavailable servers and single-name compatibility', async t => {
  const f = await fixture(t);
  f.seed({ lastEventTime: new Date().toISOString() });
  const plain = await f.command(['status']); assert.equal(plain.code, 0, plain.stderr);
  assert.match(plain.stdout, /NAME.*STATUS.*MODEL.*CWD.*EVENT AGE.*LAST MESSAGE.*USAGE LEFT/); assert.match(plain.stdout, /demo.*completed/);
  const json = await f.command(['status', '--json', '--cwd', f.home, '--name', 'd?m*', '--since', '1h']);
  assert.equal(JSON.parse(json.stdout).length, 1);
  assert.deepEqual(JSON.parse((await f.command(['status', '--active', '--json'])).stdout), []);
  assert.equal(JSON.parse((await f.command(['status', 'demo'])).stdout).threadId, f.state.threadId);
  f.seed({ port: 1 });
  const unavailable = await f.command(['status', '--json']);
  assert.equal(unavailable.code, 0, unavailable.stderr); assert.match(JSON.parse(unavailable.stdout)[0].refreshError, /Cannot connect/);
  assert.equal((await f.command(['status', '--since', 'bogus'])).code, 1);
});

test('filters use path boundaries and literal regex characters', () => {
  assert.equal(filterStates([{ cwd: '/project-two', name: 'a.b', lastEventTime: new Date().toISOString() }], { cwd: '/project' }).length, 0);
  assert.equal(filterStates([{ name: 'axb' }], { name: 'a.b' }).length, 0);
  assert.equal(filterStates([{ cwd: '/project' }], { cwd: '/' }).length, 1);
  assert.equal(duration('1.5h'), 5400000); assert.throws(() => duration('0d'));
});

test('multi wait all combines failures with usage precedence, any cancels only observers', async t => {
  const f = await fixture(t);
  f.threads.set('second-id', [{ id: 'second-turn', status: 'failed', items: [], error: { message: 'limit', codexErrorInfo: 'usageLimitExceeded' } }]);
  writeFileSync(join(f.home, 'threads', 'second.json'), JSON.stringify({ ...f.state, name: 'second', threadId: 'second-id' }));
  f.turns[0].status = 'interrupted';
  const all = await f.command(['wait', 'demo', 'second', '--all']);
  assert.equal(all.code, 76, all.stderr); assert.equal(all.stdout.trim().split('\n').length, 2);
  const bothEnded = await f.command(['wait', 'demo', 'second', '--any']);
  assert.equal(bothEnded.stdout.trim().split('\n').length, 1);
  f.turns[0].status = 'inProgress';
  const any = await f.command(['wait', 'demo', 'second', '--any', '--timeout', '3']);
  assert.equal(any.code, 76, any.stderr); assert.equal(any.stdout.trim().split('\n').length, 1); assert.equal(f.turns[0].status, 'inProgress');
  assert.ok(!f.received.some(m => m.method === 'turn/interrupt'));
});

test('steers persist alongside a concurrent attached state writer', async t => {
  const f = await fixture(t);
  const run = f.launch(['resume', 'demo', 'Work']); await until(() => run.stdout().trim());
  const steer = await f.command(['steer', 'demo', 'Finish now']); assert.equal(steer.code, 0, steer.stderr);
  assert.equal((await run.result).code, 0);
  const state = JSON.parse((await f.command(['status', 'demo'])).stdout);
  assert.equal(state.steers[0].text, 'Finish now'); assert.equal(state.steers[0].turnId, 'turn-2'); assert.ok(Date.parse(state.steers[0].time));
});

test('prune defaults to dry run, skips active writers, preserves external logs and server histories', async t => {
  const f = await fixture(t); f.seed({ lastEventTime: '2020-01-01T00:00:00Z' });
  writeFileSync(f.state.logPath, 'external');
  const dry = await f.command(['prune']); assert.equal(JSON.parse(dry.stdout).dryRun, true); assert.equal(JSON.parse(dry.stdout).sessions.length, 1);
  assert.ok(existsSync(join(f.home, 'threads/demo.json')));
  f.turns[0].status = 'inProgress';
  assert.equal(JSON.parse((await f.command(['prune', '--apply'])).stdout).sessions.length, 0);
  f.turns[0].status = 'completed';
  const applied = await f.command(['prune', '--apply']); assert.equal(applied.code, 0, applied.stderr);
  assert.ok(!existsSync(join(f.home, 'threads/demo.json'))); assert.ok(existsSync(f.state.logPath)); assert.equal(f.threads.size, 1);
});

test('stop refuses server-loaded active sessions even with stale local status', async t => {
  const f = await fixture(t); f.turns[0].status = 'inProgress';
  const stopped = await f.command(['serve', '--stop', '--port', String(f.port)]);
  assert.equal(stopped.code, 1); assert.match(stopped.stderr, /Active sessions.*demo.*Refusing shutdown/);
  const restart = await f.command(['serve', '--restart', '--timeout', '0.1', '--port', String(f.port)]);
  assert.equal(restart.code, 1); assert.match(restart.stderr, /Refusing shutdown/);
  assert.equal((await f.command(['status', 'demo'])).code, 0);
});

test('shutdown inspection includes active threads without local state', async t => {
  const f = await fixture(t);
  f.threads.set('untracked', [{ id: 'external-turn', status: 'inProgress', items: [], error: null }]);
  const stopped = await f.command(['serve', '--stop', '--port', String(f.port)]);
  assert.equal(stopped.code, 1); assert.match(stopped.stderr, /untracked.*Refusing shutdown/);
});

test('a failed TCP probe cannot bypass active-turn shutdown inspection', async t => {
  const f = await fixture(t); f.turns[0].status = 'inProgress';
  const net = (await import('node:net')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const { EventEmitter } = await import('node:events');
  const { serve } = await import('../src/server.mjs');
  const previousHome = process.env.CODEX_DRIVE_HOME, originalConnect = net.createConnection, originalKill = process.kill;
  let signalled = false;
  process.env.CODEX_DRIVE_HOME = f.home;
  net.createConnection = () => Object.assign(new EventEmitter(), { destroy() {}, setTimeout(ms, fn) { queueMicrotask(fn); return this; } });
  syncBuiltinESMExports();
  // The fixture listener belongs to this test process: catch an unsafe signal.
  process.kill = (pid, signal) => { if (signal === 'SIGTERM') { signalled = true; throw new Error('Unchecked shutdown signal'); } return originalKill(pid, signal); };
  try {
    await assert.rejects(serve(f.port, true), /Active sessions.*demo.*Refusing shutdown/);
    assert.equal(signalled, false);
  } finally {
    net.createConnection = originalConnect; process.kill = originalKill; syncBuiltinESMExports();
    if (previousHome === undefined) delete process.env.CODEX_DRIVE_HOME; else process.env.CODEX_DRIVE_HOME = previousHome;
  }
});
