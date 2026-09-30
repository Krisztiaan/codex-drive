// Billable native acceptance proof; every resource belongs to this temporary run.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, copyFileSync, chmodSync, unlinkSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

mkdirSync('/tmp/codex-drive-proof', { recursive: true });
const run = mkdtempSync('/tmp/codex-drive-proof/full-client-');
const codexHome = join(run, 'codex-home'); mkdirSync(codexHome, { mode: 0o700 });
const auth = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json');
if (existsSync(auth)) { copyFileSync(auth, join(codexHome, 'auth.json')); chmodSync(join(codexHome, 'auth.json'), 0o600); }
const env = { ...process.env, CODEX_HOME: codexHome, CODEX_DRIVE_HOME: join(run, 'state') };
const cli = resolve('src/cli.mjs'), children = new Set();
const evidence = { run, date: new Date().toISOString(), node: process.version, model: 'gpt-6.1-sol', effort: 'low', steps: [] };
function launch(args, executable = process.execPath, prefix = [cli]) {
  const child = spawn(executable, [...prefix, ...args], { env, cwd: run, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child); let stdout = '', stderr = '';
  child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
  const result = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => { children.delete(child); resolve({ code, signal, stdout, stderr }); }); });
  return { child, result, stdout: () => stdout };
}
async function command(args, expected = 0) {
  const result = await launch(args).result;
  if (result.code !== expected) evidence.commandFailure = { command: args[0], ...result };
  assert.equal(result.code, expected, `${args.join(' ')}: ${result.stderr}`);
  const output = JSON.parse(result.stdout); if (args[0] !== 'pending' || output.length) evidence.steps.push({ command: args[0], exitCode: result.code, output }); return output;
}
async function until(check, label, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(150); }
  throw new Error(`Timed out: ${label}; artifacts ${run}`);
}
function records(path) { return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []; }
function tick(path, id, n) { return records(path).some(e => e.method === 'item/completed' && e.params.turnId === id && e.params.item.type === 'agentMessage' && new RegExp(`^tick ${n}\\s*$`, 'im').test(e.params.item.text)); }
const cwd = join(run, 'work'); mkdirSync(cwd);
writeFileSync(join(cwd, 'AGENTS.md'), '# Native proof\n\nWork only in this directory. Never touch shared Codex configuration or daemons. Never select or kill processes by name; no pkill, killall or pgrep. Announce ticks as agent messages. If steered during sleep, wait for that command before obeying steering.\n');
const loop = 'Repeat 8 times: run `sleep 3; date`, then write `tick N`. When done, say FINISHED.';
let port, ownedServer;
try {
  const probe = createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r)); port = probe.address().port;
  await new Promise(r => probe.close(r)); assert.notEqual(port, 4700);
  ownedServer = await command(['serve', '--port', String(port)]); assert.ok(ownedServer.pid); evidence.server = ownedServer;
  const raw = await command(['call', 'configRequirements/read', 'null', '--port', String(port)]);
  assert.ok(Object.hasOwn(raw, 'requirements')); evidence.genericUnwrapped = 'configRequirements/read';
  const exec = launch(['exec', '--json', '--skip-git-repo-check', '--cd', cwd, '--model', evidence.model, '-c', 'model_reasoning_effort="low"', '--sandbox', 'read-only', 'Reply exactly EXEC-SEED-OK. Do not run commands.'], 'codex', []);
  const execResult = await exec.result; assert.equal(execResult.code, 0, execResult.stderr);
  writeFileSync(join(run, 'exec.jsonl'), execResult.stdout);
  const execEvents = execResult.stdout.trim().split('\n').map(JSON.parse);
  const seedId = execEvents.find(e => e.type === 'thread.started')?.thread_id; assert.ok(seedId);
  evidence.execSeed = { threadId: seedId, exitCode: 0 };
  const listed = await command(['list', '--port', String(port), '--param', 'limit=100', '--param', 'sourceKinds=["exec"]']); assert.ok(listed.data.some(t => t.id === seedId));
  assert.equal((await command(['read', seedId, '--port', String(port)])).thread.id, seedId);
  const adoptedLog = join(run, 'adopted.jsonl');
  assert.equal((await command(['adopt', seedId, '--port', String(port), '--name', 'imported', '--log', adoptedLog])).threadId, seedId);
  const adopted = await command(['resume', 'imported', '--model', evidence.model, '--effort', evidence.effort, '--sandbox', 'danger-full-access', '--approval', 'never', '--detach', loop]);
  await until(() => tick(adoptedLog, adopted.turnId, 1), 'adopted tick 1');
  await command(['steer', 'imported', 'Stop the loop, wait for any current command, say ADOPT-STEERED-OK, and finish.']);
  const adoptedFinal = await command(['wait', 'imported', '--timeout', '90']); assert.equal(adoptedFinal.lastAgentMessage, 'ADOPT-STEERED-OK');
  console.log('Exec history adopted, resumed, steered mid-turn and waited successfully.');
  const branchLog = join(run, 'fork.jsonl');
  const branch = await command(['fork', 'imported', '--name', 'branch', '--log', branchLog]); assert.notEqual(branch.threadId, seedId);
  const original = await command(['resume', 'imported', '--effort', evidence.effort, '--detach', loop]);
  const forkTurn = await command(['resume', 'branch', '--effort', evidence.effort, '--detach', 'Run `sleep 2; date`, then say BRANCH-B-OK and finish.']);
  assert.notEqual(original.turnId, forkTurn.turnId);
  assert.equal((await command(['wait', 'branch', '--timeout', '90'])).lastAgentMessage, 'BRANCH-B-OK');
  assert.equal((await command(['status', 'imported'])).status, 'running');
  await command(['steer', 'imported', 'Stop the loop, wait for any current command, say BRANCH-A-OK, and finish.']);
  assert.equal((await command(['wait', 'imported', '--timeout', '90'])).lastAgentMessage, 'BRANCH-A-OK');
  assert.equal((await command(['status', 'branch'])).lastAgentMessage, 'BRANCH-B-OK');
  console.log('Fork and original continued independently.');
  const approvalLog = join(run, 'approval.jsonl');
  const approval = await command(['start', '--port', String(port), '--cwd', cwd, '--model', evidence.model, '--effort', evidence.effort,
    '--sandbox', 'read-only', '--approval', 'untrusted', '--request-policy', 'manual', '--name', 'approval', '--log', approvalLog, '--detach',
    'Run the shell command `printf APPROVED > approval.txt` in the working directory. Request user approval when needed. Do not use a patch or a fallback. After it succeeds, reply exactly APPROVAL-OK.']);
  const follower = launch(['events', 'approval', '--follow']);
  const requests = await until(async () => { const list = await command(['pending', 'approval']); return list.length ? list : null; }, 'approval pending');
  const request = requests.find(r => r.method === 'item/commandExecution/requestApproval' || r.method === 'item/fileChange/requestApproval'); assert.ok(request);
  assert.equal(existsSync(join(cwd, 'approval.txt')), false);
  const status = await command(['status', 'approval']); assert.ok(status.pendingRequests.some(r => r.requestId === request.requestId));
  await command(['respond', request.requestId, '{"decision":"accept"}']);
  const final = await command(['wait', 'approval', '--timeout', '90']); assert.equal(final.lastAgentMessage, 'APPROVAL-OK');
  assert.equal(readFileSync(join(cwd, 'approval.txt'), 'utf8'), 'APPROVED');
  await until(() => follower.stdout().includes('turn/completed'), 'followed completion');
  follower.child.kill('SIGTERM'); const followed = await follower.result; writeFileSync(join(run, 'follow.jsonl'), followed.stdout);
  assert.ok(followed.stdout.includes(request.method));
  assert.deepEqual(await command(['pending', 'approval']), []);
  evidence.approval = { threadId: approval.threadId, turnId: approval.turnId, method: request.method, requestId: request.requestId, fileWrittenAfterResponse: true };
  const eventSnapshot = await launch(['events', 'approval']).result; assert.equal(eventSnapshot.code, 0); assert.ok(eventSnapshot.stdout.includes(request.method));
  assert.ok([adoptedLog, branchLog, approvalLog].flatMap(records).every(e => !e.params?.item?.command || !/\b(pkill|killall|pgrep)\b/.test(e.params.item.command)));
  evidence.passed = true; console.log('Approval surfaced, externally answered and logged; events follow passed.');
} catch (error) {
  evidence.failure = error.stack; throw error;
} finally {
  for (const child of children) child.kill('SIGTERM');
  const dir = join(env.CODEX_DRIVE_HOME, 'threads');
  if (existsSync(dir)) for (const file of readdirSync(dir).filter(f => f.endsWith('.json'))) {
    const state = JSON.parse(readFileSync(join(dir, file))), lock = join(dir, file) + '.lock';
    if (state.driverPid && existsSync(lock) && Number(readFileSync(lock, 'utf8')) === state.driverPid) {
      try { process.kill(state.driverPid, 'SIGTERM'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
    }
  }
  try {
    if (ownedServer) {
      try { evidence.cleanup = await command(['serve', '--stop', '--port', String(port)]); }
      catch (error) {
        evidence.cleanupWarning = error.message;
        try { process.kill(ownedServer.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
        evidence.cleanup = await command(['serve', '--stop', '--port', String(port)]);
      }
    }
  }
  finally {
    if (existsSync(join(codexHome, 'auth.json'))) unlinkSync(join(codexHome, 'auth.json'));
    writeFileSync(join(run, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
    console.log(`Evidence: ${join(run, 'evidence.json')}`);
  }
}
