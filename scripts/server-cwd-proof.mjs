// Native cwd-lifetime proof; no shared state and no connection to port 4700.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, copyFileSync, chmodSync, unlinkSync, rmSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { listening } from '../src/server.mjs';

mkdirSync('/tmp/codex-drive-proof', { recursive: true });
const run = mkdtempSync('/tmp/codex-drive-proof/server-cwd-'), cli = resolve('src/cli.mjs');
const home = join(run, 'state'), codexHome = join(run, 'codex-home'), work = join(run, 'work'), caller = join(run, 'caller');
for (const dir of [home, codexHome, work, caller]) mkdirSync(dir, { mode: 0o700 });
const auth = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json');
if (existsSync(auth)) { copyFileSync(auth, join(codexHome, 'auth.json')); chmodSync(join(codexHome, 'auth.json'), 0o600); }
const env = { ...process.env, CODEX_HOME: codexHome, CODEX_DRIVE_HOME: home };
const evidence = { run, date: new Date().toISOString(), node: process.version, steps: [], servers: [] };
const children = new Set();
async function command(args, { cwd = run, driveHome = home, expected = 0 } = {}) {
  const child = spawn(process.execPath, [cli, ...args], { cwd, env: { ...env, CODEX_DRIVE_HOME: driveHome }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child); let stdout = '', stderr = '';
  child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }); children.delete(child);
  evidence.steps.push({ command: args[0], code, stderr });
  assert.equal(code, expected, `${args[0]}: ${stderr}`);
  return { output: code === 0 ? JSON.parse(stdout) : null, stderr };
}
async function freePort() {
  const probe = createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r)); const port = probe.address().port;
  await new Promise(r => probe.close(r)); assert.notEqual(port, 4700); return port;
}
function cwdOf(pid) { return execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' }).split('\n').find(s => s.startsWith('n'))?.slice(1); }
function descendedFrom(pid, ancestor) {
  while (pid > 1) {
    if (pid === ancestor) return true;
    pid = Number(execFileSync('ps', ['-p', String(pid), '-o', 'ppid='], { encoding: 'utf8' }).trim());
  }
  return false;
}
try {
  const port = await freePort();
  const { output: server } = await command(['serve', '--port', String(port)], { cwd: caller });
  assert.ok(server.pid, 'proof must own a newly started server'); evidence.servers.push(server);
  evidence.launchCwd = cwdOf(server.pid); assert.equal(evidence.launchCwd, realpathSync(home));
  const { output: seed } = await command(['start', '--port', String(port), '--cwd', work, '--model', 'gpt-6.1-sol', '--effort', 'low', '--sandbox', 'read-only', '--approval', 'never', '--name', 'seed', 'Reply exactly SEED-OK. Do not run commands.']);
  rmSync(caller, { recursive: true });
  const { output: resumed } = await command(['call', 'thread/resume', JSON.stringify({ threadId: seed.threadId }), '--port', String(port)]);
  assert.equal(resumed.thread.id, seed.threadId);
  const adoptedHome = join(run, 'adopt-state');
  const { output: adopted } = await command(['adopt', seed.threadId, '--port', String(port), '--name', 'adopted'], { driveHome: adoptedHome });
  assert.equal(adopted.threadId, seed.threadId);
  await command(['resume', 'adopted', '--effort', 'low', 'Reply exactly RESUME-OK. Do not run commands.'], { driveHome: adoptedHome });
  const { output: status, stderr: statusWarning } = await command(['status', 'adopted'], { driveHome: adoptedHome });
  assert.equal(status.status, 'completed'); assert.equal(status.lastAgentMessage, 'RESUME-OK'); assert.equal(statusWarning, '');
  const reuse = await command(['serve', '--port', String(port)]); assert.equal(reuse.output.alreadyListening, true); assert.equal(reuse.stderr, '');
  evidence.stable = { threadId: seed.threadId, callerDeleted: true, rawResume: true, adopt: true, resumedTurnId: status.turnId, finalMessage: status.lastAgentMessage };
  console.log('Native resume, adopt and a new turn passed after deleting the launching directory.');
  await command(['serve', '--stop', '--port', String(port)]);
  const badCaller = join(run, 'legacy-caller'); mkdirSync(badCaller); const legacyPort = await freePort();
  const launcher = spawn('codex', ['app-server', '--listen', `ws://127.0.0.1:${legacyPort}`], { cwd: badCaller, env, stdio: 'ignore' }); children.add(launcher);
  for (let n = 0; n < 100 && !await listening(legacyPort); n++) await delay(100);
  assert.equal(await listening(legacyPort), true);
  const pid = Number(execFileSync('lsof', ['-nP', `-iTCP:${legacyPort}`, '-sTCP:LISTEN', '-Fp'], { encoding: 'utf8' }).split('\n').find(s => s.startsWith('p')).slice(1));
  assert.ok(descendedFrom(pid, launcher.pid), 'legacy listener must belong to this proof');
  evidence.servers.push({ pid, port: legacyPort });
  const legacyHome = join(run, 'legacy-state');
  await command(['adopt', seed.threadId, '--port', String(legacyPort), '--name', 'legacy'], { driveHome: legacyHome });
  rmSync(badCaller, { recursive: true });
  const warnedServe = await command(['serve', '--port', String(legacyPort)]);
  assert.equal(warnedServe.output.alreadyListening, true); assert.match(warnedServe.stderr, /working directory no longer exists/);
  const warnedStatus = await command(['status', 'legacy'], { driveHome: legacyHome });
  assert.match(warnedStatus.stderr, /working directory no longer exists/);
  evidence.legacy = { pid, port: legacyPort, warningOnServe: warnedServe.stderr, warningOnStatus: warnedStatus.stderr };
  console.log('Native serve/status warnings passed for a deleted legacy cwd without replacing the server.');
  evidence.passed = true;
} catch (error) { evidence.failure = error.stack; throw error; }
finally {
  evidence.cleanup = [];
  try {
    for (const server of evidence.servers) {
      const result = await command(['serve', '--stop', '--port', String(server.port)]);
      assert.equal(await listening(server.port), false); evidence.cleanup.push(result.output);
    }
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    if (existsSync(join(codexHome, 'auth.json'))) unlinkSync(join(codexHome, 'auth.json'));
    evidence.authRemoved = !existsSync(join(codexHome, 'auth.json'));
    writeFileSync(join(run, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
    console.log(`Evidence: ${join(run, 'evidence.json')}`);
  }
}
