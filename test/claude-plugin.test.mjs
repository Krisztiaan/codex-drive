import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture, until } from '../test-support/app-server.mjs';
import { recordCompletion, readCompletions } from '../src/outbox.mjs';

// The Claude Code plugin runs its hook and monitor commands through a shell with the plugin's path variables
// substituted; these tests run the committed commands the same way against the fixture app-server.
const plugin = resolve('claude-plugin');
const hookCommand = JSON.parse(readFileSync(join(plugin, 'hooks/hooks.json'), 'utf8')).hooks.SessionStart[0].hooks[0].command;
const endCommand = JSON.parse(readFileSync(join(plugin, 'hooks/hooks.json'), 'utf8')).hooks.SessionEnd[0].hooks[0].command;
const [monitor] = JSON.parse(readFileSync(join(plugin, 'monitors/monitors.json'), 'utf8'));
const substitute = (command, project) => command.replaceAll('${CLAUDE_PLUGIN_ROOT}', plugin).replaceAll('${CLAUDE_PROJECT_DIR}', project);
const lines = text => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const OWNER = 'claude-session-a', OTHER = 'claude-session-b';
const ownerEnv = owner => ({ CLAUDE_CODE_SESSION_ID: owner });
const unread = async (f, owner = OWNER) => lines((await f.command(['inbox', '--unread'], { env: ownerEnv(owner) })).stdout).map(e => e.turnId);
const notification = (turnId, owner = OWNER, quiet = false) => ({ turnNotifications: { [turnId]: { owner, quiet } } });
const entry = (turnId, overrides = {}, owner = OWNER, quiet = false) => ({ name: 'demo', threadId: 'thread-1', turnId, status: 'completed', error: null, ...notification(turnId, owner, quiet), ...overrides });
const SECRET = 'sk-live-0123456789SECRET';

function shell(f, command, env = {}, stdin) {
  // `codex-drive` on PATH is this checkout's CLI, as an installed one would be.
  const bin = join(f.home, 'bin'); mkdirSync(bin, { recursive: true });
  try { symlinkSync(resolve('src/cli.mjs'), join(bin, 'codex-drive')); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const started = Date.now();
  const child = spawn('/bin/sh', ['-c', command], { cwd: f.home, detached: true, stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CODEX_DRIVE_HOME: f.home, CODEX_HOME: join(f.home, 'codex'), CLAUDE_PROJECT_DIR: f.home,
      CODEX_DRIVE_BIN: '', CODEX_WORKERS_CWD: '', CODEX_WORKERS_SINCE: '', CODEX_WORKERS_DEADLINE_MS: '10000', ...ownerEnv(OWNER), ...env } });
  if (stdin !== undefined) child.stdin.end(stdin);
  let stdout = '', stderr = '';
  child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
  const result = new Promise(done => child.once('close', code => done({ code, stdout, stderr, ms: Date.now() - started })));
  return { child, result, stdout: () => stdout, stop() { try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; } } };
}
const hook = (f, env, session_id = OWNER, source = 'startup') => shell(f, substitute(hookCommand, f.home), env, JSON.stringify({ session_id, source })).result;
const end = (f, session_id) => shell(f, substitute(endCommand, f.home), {}, JSON.stringify({ session_id, reason: 'resume' })).result;
const view = (f, args, env) => shell(f, `node "${plugin}/scripts/codex-workers.mjs" show "${f.home}" ${args}`, env).result;
const running = (f, overrides = {}) => { f.turns.push({ id: 'turn-2', status: 'inProgress', items: [], error: null }); f.seed({ status: 'running', turnId: 'turn-2', lastEventTime: new Date().toISOString(), ...notification('turn-2'), ...overrides }); };
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };

test('the SessionStart hook is quiet with nothing running and nothing unread, and when codex-drive is missing', async t => {
  const f = await fixture(t);
  f.seed({ lastEventTime: new Date().toISOString() });
  recordCompletion(f.home, entry('turn-1', { cwd: f.home }));
  assert.equal((await f.command(['inbox', '--ack'], { env: ownerEnv(OWNER) })).code, 0);
  const quiet = await hook(f);
  assert.equal(quiet.code, 0, quiet.stderr); assert.equal(quiet.stdout, '');
  const missing = await hook(f, { CODEX_DRIVE_BIN: join(f.home, 'no-such-codex-drive') });
  assert.equal(missing.code, 0, missing.stderr); assert.equal(missing.stdout, '');
});

test('the SessionStart hook lists running workers and unread completions as metadata only, then acknowledges them', async t => {
  const f = await fixture(t);
  f.turns[0].items = [{ type: 'agentMessage', id: 'm-1', text: `Token ${SECRET}\nmore` }];
  running(f, { lastAgentMessage: `Running with ${SECRET}` });
  const finishedAt = Date.now() - 60_000;
  recordCompletion(f.home, entry('turn-1', { cwd: join(f.home, '.worktrees/lane') }), { finishedAt });
  recordCompletion(f.home, entry('turn-x', { name: 'elsewhere', threadId: 'thread-9', cwd: '/elsewhere' }));
  const first = await hook(f);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(first.stdout, [
    `codex-drive: 1 running under ${f.home}: demo`,
    'codex-drive: 1 finished:',
    `  demo completed at ${new Date(finishedAt).toISOString()}; read it with codex-drive result demo --turn turn-1`,
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
  f.seed({ status: 'running', lastEventTime: new Date().toISOString(), ...notification('turn-1') }); // Saved as running; the server finished turn-1.
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
  f.seed({ status: 'running', lastEventTime: new Date().toISOString(), ...notification('turn-1') });
  f.pause('thread/turns/list');
  recordCompletion(f.home, entry('turn-1', { cwd: f.home }));
  const output = await hook(f, { CODEX_WORKERS_DEADLINE_MS: '2500' });
  assert.equal(output.code, 0, output.stderr);
  assert.ok(output.ms < 5000, `took ${output.ms} ms`);
  assert.match(output.stdout, /codex-drive status did not finish within 1\.5 s/);
  assert.match(output.stdout, /\n {2}demo completed at \S+; read it with codex-drive result demo --turn turn-1\n$/);
  // Delivery is required within this budget. Acknowledgement is best effort after output.
});

test('SessionStart uses hook identity across resume and compaction, and acknowledges only that session', async t => {
  const f = await fixture(t);
  recordCompletion(f.home, entry('turn-a', { cwd: f.home }));
  recordCompletion(f.home, entry('turn-b', { cwd: f.home }, OTHER));
  recordCompletion(f.home, entry('turn-old', { cwd: f.home }, null));
  recordCompletion(f.home, entry('turn-quiet', { cwd: f.home }, OWNER, true));
  assert.equal((await hook(f, {}, null)).stdout, '');
  const a = await hook(f, ownerEnv(OTHER), OWNER, 'resume');
  assert.match(a.stdout, /1 finished:[\s\S]*--turn turn-a/);
  assert.doesNotMatch(a.stdout, /turn-b|turn-old|turn-quiet/);
  assert.equal((await hook(f, {}, OWNER, 'compact')).stdout, '');
  assert.deepEqual((await unread(f, OTHER)).sort(), ['turn-a', 'turn-b', 'turn-old', 'turn-quiet']);
  const manual = await view(f, '');
  assert.match(manual.stdout, /owner: claude-session-b.*--turn turn-b/);
  assert.match(manual.stdout, /owner: unowned.*--turn turn-old/);
  assert.match(manual.stdout, /--turn turn-quiet/);
  assert.match((await hook(f, {}, OTHER)).stdout, /1 finished:[\s\S]*--turn turn-b/);
  assert.equal((await hook(f, {}, OTHER, 'resume')).stdout, '');
});

test('/codex-workers lists metadata only and acknowledges it; /codex-workers <name> alone shows the message', async t => {
  const f = await fixture(t);
  f.turns[0].items = [{ type: 'agentMessage', id: 'm-1', text: `First line ${SECRET}\nSecond line` }];
  running(f, { lastAgentMessage: `Running with ${SECRET}` });
  recordCompletion(f.home, entry('turn-1', { cwd: f.home }));
  const overview = await view(f, '');
  assert.equal(overview.code, 0, overview.stderr);
  assert.match(overview.stdout, /^## Running under .* \(1\)\n- demo \(gpt-6.1-sol, last event \d+s ago\) \(owner: claude-session-a\)\n/);
  assert.match(overview.stdout, /## Unread completions \(1\)\n- demo completed at \S+ \(owner: claude-session-a\); read it with codex-drive result demo --turn turn-1\n/);
  assert.ok(!overview.stdout.includes('SECRET'), 'no message or running text in the overview');
  assert.deepEqual(await unread(f), []);
  assert.match((await view(f, '')).stdout, /## Already read, last 24h \(1\)\n- demo completed at \S+ \(owner: claude-session-a\); read it with codex-drive result demo --turn turn-1\n/);
  f.turns.pop(); // turn-2 settles away; the latest settled turn is turn-1
  const one = await view(f, 'demo');
  assert.equal(one.code, 0, one.stderr);
  assert.equal(one.stdout, `## demo completed turn-1 (owner: unowned)\nFirst line ${SECRET}\nSecond line\n`);
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

test('the monitor follows the active owner and project, including after an in-process resume', async t => {
  const f = await fixture(t);
  f.turns[0].items = [{ type: 'agentMessage', id: 'm-1', text: SECRET }];
  const follower = shell(f, substitute(monitor.command, f.home));
  t.after(() => follower.stop());
  await until(() => {
    try { return readdirSync(join(f.home, 'claude-monitors')).some(name => name.endsWith('.owner')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; return false; }
  }, 'monitor started');
  recordCompletion(f.home, entry('turn-other', { name: 'other', threadId: 'thread-9', cwd: '/elsewhere' }));
  recordCompletion(f.home, entry('turn-b', { cwd: f.home }, OTHER));
  recordCompletion(f.home, entry('turn-old', { cwd: f.home }, null));
  const finishedAt = Date.now() - 60_000;
  recordCompletion(f.home, entry('turn-1', { cwd: join(f.home, '.worktrees/lane'), status: 'failed', error: { message: 'limit', codexErrorInfo: 'usageLimitExceeded', additionalDetails: null } }), { finishedAt });
  await until(() => follower.stdout().includes('demo'), 'monitor line');
  await until(async () => (await unread(f)).length === 3, 'acknowledged');
  assert.equal(follower.stdout(), `codex-drive: demo failed (usageLimit) at ${new Date(finishedAt).toISOString()}; read it with codex-drive result demo --turn turn-1\n`);
  assert.equal((await end(f, OWNER)).code, 0);
  recordCompletion(f.home, entry('turn-stale', { cwd: f.home }));
  const resumed = await hook(f, {}, OTHER, 'resume');
  assert.equal(resumed.code, 0, resumed.stderr);
  recordCompletion(f.home, entry('turn-new', { cwd: f.home }, OTHER));
  await until(() => follower.stdout().includes('--turn turn-new'), 'resumed owner monitor line');
  await until(async () => !(await unread(f, OTHER)).includes('turn-new'), 'resumed owner acknowledged');
  assert.match(resumed.stdout + follower.stdout(), /turn-b/);
  assert.doesNotMatch(follower.stdout(), /turn-stale|turn-old|turn-other/);
  assert.ok((await unread(f)).includes('turn-new'));
});

test('a worker started by a child script inherits the session and --quiet lets its wait deliver the result', async t => {
  const f = await fixture(t);
  const follower = shell(f, substitute(monitor.command, f.home));
  t.after(() => follower.stop());
  const started = await shell(f, `sh -c 'codex-drive start --port ${f.port} --name scripted --detach --quiet Work'`).result;
  assert.equal(started.code, 0, started.stderr);
  const { turnId } = JSON.parse(started.stdout);
  const waiting = shell(f, 'codex-drive wait scripted');
  t.after(() => waiting.stop());
  await until(() => f.hasRead(), 'wait observer snapshot');
  f.complete('completed', 'Done');
  const waited = await waiting.result;
  assert.equal(waited.code, 0, waited.stderr);
  assert.equal(JSON.parse(waited.stdout).owner, OWNER);
  assert.deepEqual(readCompletions(f.home).map(e => [e.turnId, e.owner, e.quiet]), [[turnId, OWNER, true]]);
  assert.equal((await hook(f)).stdout, '');

  await until(() => !existsSync(join(f.home, 'threads/scripted.json.lock')), 'detached logger released the writer lock');
  const resumed = await f.command(['resume', 'scripted', '--detach', 'Continue'], { env: ownerEnv(OWNER) });
  assert.equal(resumed.code, 0, resumed.stderr);
  const next = JSON.parse(resumed.stdout).turnId;
  f.complete('completed', 'Next');
  await until(() => follower.stdout().includes(`--turn ${next}\n`), 'ordinary resumed turn delivered');
  assert.doesNotMatch(follower.stdout(), new RegExp(`--turn ${turnId}\\n`));
});

test('the monitor stops without acknowledging when its output is gone', async t => {
  const f = await fixture(t);
  const bin = join(f.home, 'bin'); mkdirSync(bin, { recursive: true });
  symlinkSync(resolve('src/cli.mjs'), join(bin, 'codex-drive'));
  const child = spawn(process.execPath, [join(plugin, 'scripts/codex-workers.mjs'), 'follow', f.home], { stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CODEX_DRIVE_HOME: f.home, CODEX_DRIVE_BIN: '', ...ownerEnv(OWNER) } });
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
