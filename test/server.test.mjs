import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { until } from '../test-support/app-server.mjs';

// The Codex executable is an external boundary. Keep the real subprocess,
// listener, cwd deletion and CLI; replace only the protocol peer.
async function setup(t) {
  mkdirSync('/tmp/codex-drive-proof', { recursive: true });
  const run = mkdtempSync('/tmp/codex-drive-proof/server-unit-');
  const home = join(run, 'state'), caller = join(run, 'worktree'), bin = join(run, 'bin');
  for (const dir of [home, caller, bin]) mkdirSync(dir);
  const peer = pathToFileURL(resolve('test-support/app-server.mjs')).href;
  writeFileSync(join(bin, 'codex'), `#!${process.execPath}
import { fixture } from ${JSON.stringify(peer)};
const cleanups = [];
const port = Number(new URL(process.argv[process.argv.indexOf('--listen') + 1]).port);
const f = await fixture({ after(fn) { cleanups.push(fn); } }, { historyFile: process.cwd() + '/history.json', port, diagnostics: () => ({ cwd: process.cwd() }) });
process.once('SIGTERM', async () => { for (const history of f.threads.values()) for (const turn of history) if (turn.status === 'inProgress') turn.status = 'interrupted'; f.persist(); for (const cleanup of cleanups) await cleanup(); });
`, { mode: 0o700 });
  const env = { ...process.env, CODEX_DRIVE_HOME: home, PATH: bin + ':' + process.env.PATH };
  const probe = createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port; await new Promise(r => probe.close(r)); assert.notEqual(port, 4700);
  let serverStarted = false;
  async function command(args, cwd = run, driveHome = home) {
    const child = spawn(process.execPath, [resolve('src/cli.mjs'), ...args], { cwd, env: { ...env, CODEX_DRIVE_HOME: driveHome }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
    const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve({ code, stdout, stderr })); });
    if (args[0] === 'serve' && !args.includes('--stop') && result.code === 0 && JSON.parse(stdout).pid) serverStarted = true;
    return result;
  }
  t.after(async () => { if (serverStarted) await command(['serve', '--stop', '--port', String(port)]); rmSync(run, { recursive: true, force: true }); });
  return { run, home, caller, bin, env, port, command };
}

test('serve survives deletion of its launching directory by using the stable state home', async t => {
  const f = await setup(t);
  const started = await f.command(['serve', '--port', String(f.port)], f.caller);
  assert.equal(started.code, 0, started.stderr);
  assert.ok(JSON.parse(started.stdout).pid, 'test must own a newly started server');
  const before = await f.command(['call', 'server/diagnostics', '--port', String(f.port)]);
  assert.equal(before.code, 0, before.stderr);
  assert.equal(JSON.parse(before.stdout).cwd, realpathSync(f.home));
  rmSync(f.caller, { recursive: true });
  const after = await f.command(['call', 'thread/resume', '{"threadId":"thread-1"}', '--port', String(f.port)]);
  assert.equal(after.code, 0, after.stderr);
  const adopted = await f.command(['adopt', 'thread-1', '--port', String(f.port)]);
  assert.equal(adopted.code, 0, adopted.stderr);
  const reused = await f.command(['serve', '--port', String(f.port)]);
  assert.equal(reused.code, 0); assert.equal(reused.stderr, ''); assert.equal(JSON.parse(reused.stdout).alreadyListening, true);
});

test('serve and status warn about a legacy listener whose cwd was deleted without replacing it', async t => {
  const f = await setup(t);
  const child = spawn(join(f.bin, 'codex'), ['app-server', '--listen', `ws://127.0.0.1:${f.port}`], { cwd: f.caller, env: f.env, stdio: 'ignore' });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await new Promise(r => child.once('exit', r)); } });
  await until(async () => (await f.command(['call', 'server/diagnostics', '--port', String(f.port)])).code === 0, 'legacy listener');
  const adopted = await f.command(['adopt', 'thread-1', '--name', 'legacy', '--port', String(f.port)]);
  assert.equal(adopted.code, 0, adopted.stderr);
  rmSync(f.caller, { recursive: true });
  const reused = await f.command(['serve', '--port', String(f.port)]);
  assert.equal(reused.code, 0, reused.stderr);
  assert.equal(JSON.parse(reused.stdout).alreadyListening, true);
  assert.match(reused.stderr, /WARNING:.*working directory.*no longer exists/);
  assert.ok(reused.stderr.includes(String(child.pid)) && reused.stderr.includes(String(f.port)));
  const status = await f.command(['status', 'legacy']);
  assert.equal(status.code, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).status, 'completed');
  assert.match(status.stderr, /WARNING:.*working directory.*no longer exists/);
  assert.match(status.stderr, /configuration.*resume.*adopt/i);
  const empty = await f.command(['status', '--json', '--port', String(f.port)], f.run, join(f.run, 'empty-state'));
  assert.equal(empty.code, 0, empty.stderr); assert.deepEqual(JSON.parse(empty.stdout), []);
  assert.match(empty.stderr, /working directory.*no longer exists/);
  mkdirSync(f.caller); // Recreating the pathname does not restore the process's old cwd.
  const recreated = await f.command(['status', 'legacy']);
  assert.equal(recreated.code, 0, recreated.stderr);
  assert.match(recreated.stderr, /working directory.*no longer exists/);
});

test('owned server restarts idle, refuses active stop, and force lists affected sessions', async t => {
  const f = await setup(t);
  const started = await f.command(['serve', '--port', String(f.port)]); assert.equal(started.code, 0, started.stderr);
  const oldPid = JSON.parse(started.stdout).pid;
  const restarted = await f.command(['serve', '--restart', '--port', String(f.port)]);
  assert.equal(restarted.code, 0, restarted.stderr); assert.notEqual(JSON.parse(restarted.stdout).pid, oldPid);
  const run = await f.command(['start', '--name', 'active', '--detach', '--port', String(f.port), 'Work']);
  assert.equal(run.code, 0, run.stderr);
  const stopped = await f.command(['serve', '--stop', '--port', String(f.port)]);
  assert.equal(stopped.code, 1); assert.match(stopped.stderr, /active.*Refusing shutdown/);
  const forced = await f.command(['serve', '--stop', '--force', '--port', String(f.port)]);
  assert.equal(forced.code, 0, forced.stderr); assert.match(forced.stderr, /forcing shutdown.*active/);
  // Detached logger is ours; it reconnects until stopped explicitly by its recorded PID.
  const { readFileSync } = await import('node:fs');
  const saved = JSON.parse(readFileSync(join(f.home, 'threads/active.json'), 'utf8'));
  try { process.kill(saved.driverPid, 'SIGTERM'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
});

test('wait reconnects through an owned server restart and resume keeps the saved thread ID', async t => {
  const f = await setup(t);
  assert.equal((await f.command(['serve', '--port', String(f.port)])).code, 0);
  const started = await f.command(['start', '--name', 'recover', '--detach', '--port', String(f.port), 'Work']);
  assert.equal(started.code, 0, started.stderr); const ids = JSON.parse(started.stdout);
  const waiting = f.command(['wait', 'recover', '--timeout', '15']);
  const restarted = await f.command(['serve', '--restart', '--force', '--port', String(f.port)]);
  assert.equal(restarted.code, 0, restarted.stderr);
  const waited = await waiting; assert.equal(waited.code, 130, waited.stdout + waited.stderr);
  assert.equal(JSON.parse(waited.stdout).turnId, ids.turnId);
  // Give the original logger a chance to persist its recovered completion and release ownership.
  const { existsSync } = await import('node:fs');
  await until(() => !existsSync(join(f.home, 'threads/recover.json.lock')), 'recovered logger');
  const resumed = await f.command(['resume', 'recover', '--detach', 'Continue']);
  assert.equal(resumed.code, 0, resumed.stderr); assert.equal(JSON.parse(resumed.stdout).threadId, ids.threadId);
  assert.notEqual(JSON.parse(resumed.stdout).turnId, ids.turnId);
  assert.equal((await f.command(['interrupt', 'recover'])).code, 0);
  await until(() => !existsSync(join(f.home, 'threads/recover.json.lock')));
});
