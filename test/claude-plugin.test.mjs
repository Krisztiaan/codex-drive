import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture, until } from '../test-support/app-server.mjs';
import { recordCompletion, readCompletions } from '../src/outbox.mjs';

// The Claude Code plugin runs its hook and monitor commands through a shell with the plugin's path variables
// substituted; these tests run the committed commands the same way against the fixture app-server.
const plugin = resolve('claude-plugin');
const hookCommand = JSON.parse(readFileSync(join(plugin, 'hooks/hooks.json'), 'utf8')).hooks.SessionStart[0].hooks[0].command;
const [monitor] = JSON.parse(readFileSync(join(plugin, 'monitors/monitors.json'), 'utf8'));
const substitute = (command, project) => command.replaceAll('${CLAUDE_PLUGIN_ROOT}', plugin).replaceAll('${CLAUDE_PROJECT_DIR}', project);
const lines = text => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const entry = (turnId, overrides = {}) => ({ name: 'demo', threadId: 'thread-1', turnId, status: 'completed', error: null, ...overrides });

function shell(f, command, env = {}) {
  // `codex-drive` on PATH is this checkout's CLI, as the monitor command expects an installed one.
  const bin = join(f.home, 'bin'); mkdirSync(bin, { recursive: true });
  try { symlinkSync(resolve('src/cli.mjs'), join(bin, 'codex-drive')); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const child = spawn('/bin/sh', ['-c', command], { cwd: f.home, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CODEX_DRIVE_HOME: f.home, CODEX_HOME: join(f.home, 'codex'), CLAUDE_PROJECT_DIR: f.home, CODEX_DRIVE_BIN: '', CODEX_WORKERS_CWD: '', CODEX_WORKERS_SINCE: '', ...env } });
  let stdout = '', stderr = '';
  child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
  const result = new Promise(done => child.once('close', code => done({ code, stdout, stderr })));
  return { child, result, stdout: () => stdout, stop() { try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; } } };
}
const hook = (f, env) => shell(f, substitute(hookCommand, f.home), env).result;
const view = (f, mode, env) => shell(f, `node "${plugin}/scripts/codex-workers.mjs" ${mode} "${f.home}"`, env).result;
const running = f => { f.turns.push({ id: 'turn-2', status: 'inProgress', items: [], error: null }); f.seed({ status: 'running', turnId: 'turn-2', lastEventTime: new Date().toISOString() }); };

test('the SessionStart hook is quiet with nothing running and nothing unread, and when codex-drive is missing', async t => {
  const f = await fixture(t);
  f.seed({ lastEventTime: new Date().toISOString() });
  recordCompletion(f.home, entry('turn-1', { cwd: f.home }));
  assert.equal((await f.command(['inbox', '--ack'])).code, 0);
  const quiet = await hook(f);
  assert.equal(quiet.code, 0, quiet.stderr); assert.equal(quiet.stdout, '');
  const missing = await hook(f, { CODEX_DRIVE_BIN: join(f.home, 'no-such-codex-drive') });
  assert.equal(missing.code, 0, missing.stderr); assert.equal(missing.stdout, '');
});

test('the SessionStart hook lists running workers and unread completions of this project once, with a headline', async t => {
  const f = await fixture(t);
  f.turns[0].items = [{ type: 'agentMessage', id: 'm-1', text: '## Committed `abc123`\nDetails follow' }];
  running(f);
  recordCompletion(f.home, entry('turn-1', { cwd: join(f.home, '.worktrees/lane') }));
  recordCompletion(f.home, entry('turn-x', { name: 'elsewhere', threadId: 'thread-9', cwd: '/elsewhere' }));
  const first = await hook(f);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(first.stdout, [
    `codex-drive: 1 running under ${f.home}: demo`,
    'codex-drive: 1 finished while no session followed (full text: codex-drive result <name>):',
    '  demo completed - Committed `abc123`',
  ].join('\n') + '\n');
  assert.deepEqual(lines((await f.command(['inbox', '--unread'])).stdout).map(e => e.turnId), ['turn-x'], 'acknowledged only what it showed');
  const again = await hook(f);
  assert.equal(again.stdout, `codex-drive: 1 running under ${f.home}: demo\n`);
});

test('the SessionStart hook repairs the outbox entry of a settled turn whose logger died', async t => {
  const f = await fixture(t);
  f.seed({ status: 'running', lastEventTime: new Date().toISOString() }); // Saved as running; the server finished turn-1.
  assert.equal(readCompletions(f.home).length, 0);
  const output = await hook(f);
  assert.equal(output.code, 0, output.stderr);
  assert.equal(output.stdout, 'codex-drive: 1 finished while no session followed (full text: codex-drive result <name>):\n  demo completed - PREVIOUS\n');
  assert.deepEqual(readCompletions(f.home).map(e => [e.turnId, e.status]), [['turn-1', 'completed']]);
  assert.equal((await f.command(['inbox', '--unread'])).stdout, '');
});

test('the SessionStart hook keeps to twelve lines and points at the rest', async t => {
  const f = await fixture(t);
  running(f);
  const base = Date.now() - 60000;
  for (let i = 0; i < 15; i++) recordCompletion(f.home, entry(`turn-old-${i}`, { cwd: f.home }), { finishedAt: base + i * 1000 });
  const output = await hook(f);
  assert.equal(output.code, 0, output.stderr);
  const printed = output.stdout.trimEnd().split('\n');
  assert.equal(printed.length, 12);
  assert.match(printed[1], /^codex-drive: 15 finished/);
  assert.equal(printed[2], '  demo completed', 'an unknown turn has no headline');
  assert.equal(printed.at(-1), `  6 earlier: codex-drive inbox --cwd ${f.home}`);
  assert.equal((await f.command(['inbox', '--unread'])).stdout, '', 'every listed or counted entry is acknowledged');
});

test('/codex-workers shows running workers and full unread results, then lists them as read', async t => {
  const f = await fixture(t);
  f.turns[0].items = [{ type: 'agentMessage', id: 'm-1', text: 'First line\nSecond line' }];
  running(f);
  recordCompletion(f.home, entry('turn-1', { cwd: f.home }));
  const shown = await view(f, 'show');
  assert.equal(shown.code, 0, shown.stderr);
  assert.match(shown.stdout, new RegExp(`^## Running under ${f.home} \\(1\\)\\n- demo \\(gpt-6.1-sol, last event \\d+s ago\\): PREVIOUS\\n`));
  assert.match(shown.stdout, /## Unread results \(1\)\n\n### demo completed turn-1 \(.+\)\nFirst line\nSecond line\n/);
  const later = await view(f, 'show');
  assert.match(later.stdout, /## Unread results \(0\)\n/);
  assert.match(later.stdout, /## Already read, last 24h \(1\)\n- demo completed \S+ - First line\n$/);
  const missing = await view(f, 'show', { CODEX_DRIVE_BIN: join(f.home, 'no-such-codex-drive') });
  assert.equal(missing.code, 0); assert.match(missing.stdout, /codex-drive was not found/);
});

test('the monitor command prints one line per completion of this project and acknowledges it', async t => {
  const f = await fixture(t);
  const follower = shell(f, substitute(monitor.command, f.home));
  t.after(() => follower.stop());
  await delay(300);
  recordCompletion(f.home, entry('turn-other', { name: 'other', threadId: 'thread-9', cwd: '/elsewhere' }));
  recordCompletion(f.home, entry('turn-1', { cwd: join(f.home, '.worktrees/lane') }));
  await until(() => follower.stdout().includes('turn-1'), 'monitor line');
  await delay(150);
  const printed = lines(follower.stdout());
  assert.deepEqual(printed.map(e => [e.name, e.turnId, e.status]), [['demo', 'turn-1', 'completed']]);
  assert.deepEqual(lines((await f.command(['inbox', '--unread'])).stdout).map(e => e.turnId), ['turn-other']);
});
