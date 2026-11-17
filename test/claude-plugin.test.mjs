import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
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
const unread = async f => lines((await f.command(['inbox', '--unread'])).stdout).map(e => e.turnId);
const entry = (turnId, overrides = {}) => ({ name: 'demo', threadId: 'thread-1', turnId, status: 'completed', error: null, ...overrides });
const SECRET = 'sk-live-0123456789SECRET';

function shell(f, command, env = {}) {
  // `codex-drive` on PATH is this checkout's CLI, as an installed one would be.
  const bin = join(f.home, 'bin'); mkdirSync(bin, { recursive: true });
  try { symlinkSync(resolve('src/cli.mjs'), join(bin, 'codex-drive')); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const started = Date.now();
  const child = spawn('/bin/sh', ['-c', command], { cwd: f.home, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CODEX_DRIVE_HOME: f.home, CODEX_HOME: join(f.home, 'codex'), CLAUDE_PROJECT_DIR: f.home,
      CODEX_DRIVE_BIN: '', CODEX_WORKERS_CWD: '', CODEX_WORKERS_SINCE: '', CODEX_WORKERS_DEADLINE_MS: '', ...env } });
  let stdout = '', stderr = '';
  child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
  const result = new Promise(done => child.once('close', code => done({ code, stdout, stderr, ms: Date.now() - started })));
  return { child, result, stdout: () => stdout, stop() { try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; } } };
}
const hook = (f, env) => shell(f, substitute(hookCommand, f.home), env).result;
const view = (f, args, env) => shell(f, `node "${plugin}/scripts/codex-workers.mjs" show "${f.home}" ${args}`, env).result;
const running = (f, overrides = {}) => { f.turns.push({ id: 'turn-2', status: 'inProgress', items: [], error: null }); f.seed({ status: 'running', turnId: 'turn-2', lastEventTime: new Date().toISOString(), ...overrides }); };
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };

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

test('the SessionStart hook lists running workers and unread completions as metadata only, then acknowledges them', async t => {
  const f = await fixture(t);
  f.turns[0].items = [{ type: 'agentMessage', id: 'm-1', text: `Token ${SECRET}\nmore` }];
  running(f, { lastAgentMessage: `Running with ${SECRET}` });
  recordCompletion(f.home, entry('turn-1', { cwd: join(f.home, '.worktrees/lane') }), { finishedAt: Date.parse('2026-11-16T10:00:00Z') });
  recordCompletion(f.home, entry('turn-x', { name: 'elsewhere', threadId: 'thread-9', cwd: '/elsewhere' }));
  const first = await hook(f);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(first.stdout, [
    `codex-drive: 1 running under ${f.home}: demo`,
    'codex-drive: 1 finished:',
    '  demo completed at 2026-11-16T10:00:00.000Z; read it with codex-drive result demo --turn turn-1',
  ].join('\n') + '\n');
  assert.ok(!first.stdout.includes('SECRET'));
  // The worker has since started turn-2; the printed command still reads the completion it names.
  const hint = first.stdout.split('\n')[2].split('; read it with codex-drive ')[1].split(' ');
  const read = await f.command(hint);
  assert.equal(read.code, 0, read.stderr); assert.match(read.stdout, /^demo completed turn-1\n/);
  assert.deepEqual(await unread(f), ['turn-x'], 'acknowledged only what it showed');
  assert.equal((await hook(f)).stdout, `codex-drive: 1 running under ${f.home}: demo\n`);
});

test('the SessionStart hook repairs the outbox entry of a settled turn whose logger died', async t => {
  const f = await fixture(t);
  f.seed({ status: 'running', lastEventTime: new Date().toISOString() }); // Saved as running; the server finished turn-1.
  assert.equal(readCompletions(f.home).length, 0);
  const output = await hook(f);
  assert.equal(output.code, 0, output.stderr);
  assert.match(output.stdout, /^codex-drive: 1 finished:\n {2}demo completed at \S+; read it with codex-drive result demo --turn turn-1\n$/);
  assert.deepEqual(readCompletions(f.home).map(e => [e.turnId, e.status]), [['turn-1', 'completed']]);
  assert.deepEqual(await unread(f), []);
});

test('the SessionStart hook keeps to twelve lines and leaves what it did not show unread', async t => {
  const f = await fixture(t);
  running(f);
  const base = Date.now() - 60000;
  for (let i = 0; i < 15; i++) recordCompletion(f.home, entry(`turn-old-${String(i).padStart(2, '0')}`, { cwd: f.home }), { finishedAt: base + i * 1000 });
  const output = await hook(f);
  assert.equal(output.code, 0, output.stderr);
  const printed = output.stdout.trimEnd().split('\n');
  assert.equal(printed.length, 12);
  assert.match(printed[1], /^codex-drive: 15 finished/);
  assert.match(printed[2], /^ {2}demo completed at /);
  assert.equal(printed.at(-1), '  6 more stay unread: /codex-workers');
  assert.deepEqual(await unread(f), Array.from({ length: 6 }, (_, i) => `turn-old-0${i}`), 'the oldest six stay unread');
});

test('the SessionStart hook ends by its deadline when codex-drive ignores SIGTERM, and reaps it', async t => {
  const f = await fixture(t);
  const stuck = join(f.home, 'stuck-codex-drive'), pids = join(f.home, 'pids');
  writeFileSync(stuck, `#!/usr/bin/env node\nrequire('fs').appendFileSync(${JSON.stringify(pids)}, process.pid + '\\n');\nprocess.on('SIGTERM', () => {});\nsetInterval(() => {}, 1000);\n`);
  chmodSync(stuck, 0o755);
  const output = await hook(f, { CODEX_DRIVE_BIN: stuck, CODEX_WORKERS_DEADLINE_MS: '1500' });
  assert.equal(output.code, 0, output.stderr);
  assert.ok(output.ms < 4000, `took ${output.ms} ms`);
  assert.match(output.stdout, /^codex-drive: codex-drive status did not finish within 0\.5 s; run codex-drive status/m);
  const started = readFileSync(pids, 'utf8').trim().split('\n').map(Number);
  assert.ok(started.length >= 1);
  for (const pid of started) assert.equal(alive(pid), false, `pid ${pid} was reaped`);
});

test('a stalled server does not stall session start, and unread completions are still delivered', async t => {
  const f = await fixture(t);
  f.seed({ status: 'running', lastEventTime: new Date().toISOString() });
  f.pause('thread/turns/list');
  recordCompletion(f.home, entry('turn-1', { cwd: f.home }));
  const output = await hook(f, { CODEX_WORKERS_DEADLINE_MS: '2500' });
  assert.equal(output.code, 0, output.stderr);
  assert.ok(output.ms < 5000, `took ${output.ms} ms`);
  assert.match(output.stdout, /codex-drive status did not finish within 1\.5 s/);
  assert.match(output.stdout, /\n {2}demo completed at \S+; read it with codex-drive result demo --turn turn-1\n$/);
  assert.deepEqual(await unread(f), []);
});

test('two sessions starting at once deliver every completion, each at most once per session', async t => {
  const f = await fixture(t);
  const ids = Array.from({ length: 6 }, (_, i) => `turn-c${i}`);
  for (const id of ids) recordCompletion(f.home, entry(id, { cwd: f.home }));
  const [a, b] = await Promise.all([hook(f), hook(f)]);
  const shown = output => output.stdout.split('\n').filter(line => line.startsWith('  demo')).length;
  assert.ok(shown(a) + shown(b) >= ids.length, 'every entry reached a session');
  for (const output of [a, b]) assert.ok(shown(output) <= ids.length, 'no session printed an entry twice');
  assert.deepEqual(await unread(f), []);
});

test('/codex-workers lists metadata only and acknowledges it; /codex-workers <name> alone shows the message', async t => {
  const f = await fixture(t);
  f.turns[0].items = [{ type: 'agentMessage', id: 'm-1', text: `First line ${SECRET}\nSecond line` }];
  running(f, { lastAgentMessage: `Running with ${SECRET}` });
  recordCompletion(f.home, entry('turn-1', { cwd: f.home }));
  const overview = await view(f, '');
  assert.equal(overview.code, 0, overview.stderr);
  assert.match(overview.stdout, new RegExp(`^## Running under ${f.home} \\(1\\)\\n- demo \\(gpt-6.1-sol, last event \\d+s ago\\)\\n`));
  assert.match(overview.stdout, /## Unread completions \(1\)\n- demo completed at \S+; read it with codex-drive result demo --turn turn-1\n/);
  assert.ok(!overview.stdout.includes('SECRET'), 'no message or running text in the overview');
  assert.deepEqual(await unread(f), []);
  assert.match((await view(f, '')).stdout, /## Already read, last 24h \(1\)\n- demo completed at \S+; read it with codex-drive result demo --turn turn-1\n/);
  f.turns.pop(); // turn-2 settles away; the latest settled turn is turn-1
  const one = await view(f, 'demo');
  assert.equal(one.code, 0, one.stderr);
  assert.equal(one.stdout, `## demo completed turn-1\nFirst line ${SECRET}\nSecond line\n`);
});

test('/codex-workers refuses a bad name, and a result it cannot read leaves the entry unread', async t => {
  const f = await fixture(t);
  recordCompletion(f.home, entry('turn-1', { cwd: f.home }));
  const bad = await view(f, "'a;b'");
  assert.equal(bad.code, 0); assert.match(bad.stdout, /^Not a codex-drive worker name: a;b/);
  const unknown = await view(f, 'nobody');
  assert.equal(unknown.code, 0); assert.match(unknown.stdout, /^codex-drive result nobody failed: codex-drive: Unknown thread: nobody/);
  assert.deepEqual(await unread(f), ['turn-1']);
  const missing = await view(f, '', { CODEX_DRIVE_BIN: join(f.home, 'no-such-codex-drive') });
  assert.equal(missing.code, 0); assert.match(missing.stdout, /codex-drive was not found/);
});

test('the monitor prints one metadata line per completion of this project and acknowledges it after printing', async t => {
  const f = await fixture(t);
  f.turns[0].items = [{ type: 'agentMessage', id: 'm-1', text: SECRET }];
  const follower = shell(f, substitute(monitor.command, f.home));
  t.after(() => follower.stop());
  await delay(400);
  recordCompletion(f.home, entry('turn-other', { name: 'other', threadId: 'thread-9', cwd: '/elsewhere' }));
  recordCompletion(f.home, entry('turn-1', { cwd: join(f.home, '.worktrees/lane'), status: 'failed', error: { message: 'limit', codexErrorInfo: 'usageLimitExceeded', additionalDetails: null } }), { finishedAt: Date.parse('2026-11-16T11:00:00Z') });
  await until(() => follower.stdout().includes('demo'), 'monitor line');
  await until(async () => (await unread(f)).length === 1, 'acknowledged');
  assert.equal(follower.stdout(), 'codex-drive: demo failed (usageLimit) at 2026-11-16T11:00:00.000Z; read it with codex-drive result demo --turn turn-1\n');
  assert.deepEqual(await unread(f), ['turn-other']);
});

test('the monitor stops without acknowledging when its output is gone', async t => {
  const f = await fixture(t);
  const bin = join(f.home, 'bin'); mkdirSync(bin, { recursive: true });
  symlinkSync(resolve('src/cli.mjs'), join(bin, 'codex-drive'));
  const child = spawn(process.execPath, [join(plugin, 'scripts/codex-workers.mjs'), 'follow', f.home], { stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CODEX_DRIVE_HOME: f.home, CODEX_DRIVE_BIN: '' } });
  t.after(() => child.kill('SIGKILL'));
  await delay(400);
  child.stdout.destroy(); // The session went away.
  recordCompletion(f.home, entry('turn-1', { cwd: f.home }));
  await new Promise(done => child.once('exit', done));
  await delay(100);
  assert.deepEqual(await unread(f), ['turn-1']);
  assert.ok(!readdirSync(join(f.home, 'outbox')).some(name => name.endsWith('.acked')));
  await until(() => spawnSync('pgrep', ['-f', `inbox --follow --unread --cwd ${f.home}`]).status === 1, 'follower stopped');
});

test('the codex-workers skill never substitutes user arguments into its pre-run shell command', async () => {
  const { readFileSync } = await import('node:fs');
  const skill = readFileSync(new URL('../claude-plugin/skills/codex-workers/SKILL.md', import.meta.url), 'utf8');
  const commands = [...skill.matchAll(/!`([^`]*)`/g)].map(m => m[1]);
  assert.ok(commands.length > 0, 'the skill pre-runs an overview command');
  for (const command of commands) assert.doesNotMatch(command, /\$ARGUMENTS|\$\d/, command);
});
