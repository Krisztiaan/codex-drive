// Billable native orchestration proof. Never connects to port 4700 or shared driver state.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, copyFileSync, chmodSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

mkdirSync('/tmp/codex-drive-proof', { recursive: true });
const run = mkdtempSync('/tmp/codex-drive-proof/orchestrator-');
const codexHome = join(run, 'codex-home'); mkdirSync(codexHome);
const auth = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json');
if (existsSync(auth)) { copyFileSync(auth, join(codexHome, 'auth.json')); chmodSync(join(codexHome, 'auth.json'), 0o600); }
const env = { ...process.env, CODEX_HOME: codexHome, CODEX_DRIVE_HOME: join(run, 'state') };
const cli = resolve('src/cli.mjs'), children = new Set();
const evidence = { run, date: new Date().toISOString(), node: process.version, model: 'gpt-6.1-sol', effort: 'low', steps: [] };
function launch(args) {
  const child = spawn(process.execPath, [cli, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child); let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const result = new Promise((resolve, reject) => {
    child.once('error', reject); child.once('exit', (code, signal) => { children.delete(child); resolve({ code, signal, stdout, stderr }); });
  });
  return { child, result, stdout: () => stdout };
}
async function command(args, expected = 0) {
  const result = await launch(args).result;
  assert.equal(result.code, expected, `${args[0]}: ${result.stderr}`);
  if (args.includes('--detach') && ['start', 'resume'].includes(args[0])) assert.match(result.stderr, /WARNING: danger-full-access/);
  const output = JSON.parse(result.stdout);
  evidence.steps.push({ command: args[0], exitCode: result.code, ...(result.stderr.includes('WARNING:') ? { warningPrinted: true } : {}), output });
  return output;
}
async function until(check, label, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const found = await check(); if (found) return found; await delay(100); }
  throw new Error(`Timed out: ${label}. Artifacts: ${run}`);
}
const cwd = join(run, 'work'); mkdirSync(cwd);
writeFileSync(join(cwd, 'AGENTS.md'), '# Proof boundaries\n\nWork only in this directory. Never touch shared Codex configuration or daemons. Never kill or select processes by name (no pkill, killall, or pgrep). If steered during sleep, wait for that command to finish before obeying steering. Announce ticks as agent messages.\n');
const log = join(run, 'detached.jsonl');
function events() { return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []; }
function hasTick(turnId, n) { return events().some(e => e.method === 'item/completed' && e.params.turnId === turnId && e.params.item.type === 'agentMessage' && new RegExp(`^tick ${n}\\s*$`, 'im').test(e.params.item.text)); }
const prompt = 'Repeat 8 times: run `sleep 5; date`, then write `tick N`. When done, say FINISHED.';
let ownedServer, port;
try {
  const probe = createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r)); port = probe.address().port;
  await new Promise(r => probe.close(r)); assert.notEqual(port, 4700);
  const server = await command(['serve', '--port', String(port)]); assert.ok(server.pid); ownedServer = server;
  evidence.server = server;
  const started = await command(['start', '--port', String(port), '--cwd', cwd, '--model', evidence.model, '--effort', evidence.effort,
    '--sandbox', 'danger-full-access', '--approval', 'never', '--name', 'detached', '--log', log, '--detach', prompt]);
  assert.equal((await command(['status', started.threadId])).status, 'running');
  const timed = await command(['wait', 'detached', '--timeout', '0.2'], 124); assert.equal(timed.timedOut, true);
  const waiting = launch(['wait', 'detached', '--timeout', '90']);
  await until(() => hasTick(started.turnId, 2), 'detached tick 2');
  const steerTime = Date.now();
  await command(['steer', 'detached', 'Stop the loop now, wait for any current sleep, write DETACHED-STEERED-OK, and finish.']);
  const result = await waiting.result; assert.equal(result.code, 0, result.stderr);
  const final = JSON.parse(result.stdout); assert.equal(final.lastAgentMessage, 'DETACHED-STEERED-OK');
  assert.ok(Date.parse(final.lastEventTime) >= steerTime);
  evidence.steps.push({ command: 'wait (concurrent with steer)', exitCode: result.code, output: final });
  assert.equal((await command(['wait', 'detached', '--timeout', '5'])).status, 'completed');
  console.log('Detached steering, timeout, and completed wait passed.');
  const resumed = await command(['resume', 'detached', '--detach', prompt]);
  assert.equal(resumed.threadId, started.threadId); assert.notEqual(resumed.turnId, started.turnId);
  const current = await command(['status', 'detached']); assert.notEqual(current.lastAgentMessage, final.lastAgentMessage);
  await until(() => hasTick(resumed.turnId, 1), 'resumed detached tick 1');
  await command(['interrupt', resumed.threadId]);
  assert.equal((await command(['wait', 'detached', '--timeout', '10'], 130)).status, 'interrupted');
  console.log('Detached resume, current-message status, interrupt, and interrupted wait passed.');
  // Prove observation without any logger process, using a finished thread and a new attached turn.
  const attached = launch(['resume', 'detached', prompt]);
  const ids = await until(() => attached.stdout().trim() && JSON.parse(attached.stdout().trim()), 'attached IDs');
  attached.child.kill('SIGTERM'); await attached.result;
  evidence.detachedObserver = { threadId: ids.threadId, turnId: ids.turnId, attachedLoggerStopped: true };
  const observer = launch(['wait', 'detached', '--timeout', '90']);
  await command(['steer', 'detached', 'Stop the loop now, wait for any current sleep, write NO-LOGGER-OK, and finish.']);
  const observed = await observer.result; assert.equal(observed.code, 0, observed.stderr);
  assert.equal(JSON.parse(observed.stdout).lastAgentMessage, 'NO-LOGGER-OK');
  evidence.steps.push({ command: 'wait without logger', exitCode: observed.code, output: JSON.parse(observed.stdout) });
  assert.ok(events().every(e => !e.params?.item?.command || !/\b(pkill|killall|pgrep)\b/.test(e.params.item.command)));
  evidence.passed = true;
  console.log('Wait without an attached logger passed.');
} finally {
  for (const child of children) child.kill('SIGTERM');
  // Only PID resources recorded in this proof's own temporary directory may be cleaned up.
  const stateFile = join(env.CODEX_DRIVE_HOME, 'threads', 'detached.json');
  if (existsSync(stateFile)) {
    const state = JSON.parse(readFileSync(stateFile, 'utf8'));
    const lockFile = stateFile + '.lock';
    if (state.driverPid && existsSync(lockFile) && Number(readFileSync(lockFile, 'utf8')) === state.driverPid) {
      try { process.kill(state.driverPid, 'SIGTERM'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
    }
  }
  try { if (ownedServer) evidence.cleanup = await command(['serve', '--stop', '--port', String(port)]); }
  finally {
    if (existsSync(join(codexHome, 'auth.json'))) unlinkSync(join(codexHome, 'auth.json'));
    writeFileSync(join(run, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
    console.log(`Evidence: ${join(run, 'evidence.json')}`);
  }
}
