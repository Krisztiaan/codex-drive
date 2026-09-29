// Live, billable acceptance test. Owns only its isolated loopback server and /tmp proof directory.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, createConnection } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, copyFileSync, chmodSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

const root = '/tmp/codex-drive-proof';
mkdirSync(root, { recursive: true });
const run = mkdtempSync(join(root, 'run-'));
const home = join(run, 'codex-home'); mkdirSync(home);
// Authentication is copied privately; refreshes stay isolated. No shared configuration/daemon is changed.
const auth = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json');
if (existsSync(auth)) { copyFileSync(auth, join(home, 'auth.json')); chmodSync(join(home, 'auth.json'), 0o600); }
const env = { ...process.env, CODEX_HOME: home, CODEX_DRIVE_HOME: join(run, 'state') };
const cli = resolve('src/cli.mjs');
const children = new Set();
function launch(args) {
  const child = spawn(process.execPath, [cli, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let stdout = '', stderr = '';
  child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
  const result = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => { children.delete(child); resolve({ code, signal, stdout, stderr }); });
  });
  return { child, result, stdout: () => stdout };
}
async function command(args) {
  const r = await launch(args).result;
  assert.equal(r.code, 0, `${args[0]} failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}
function events(path) {
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
}
function messages(path, turnId) {
  return events(path).filter(e => e.method === 'item/completed' && e.params.item.type === 'agentMessage' && (!turnId || e.params.turnId === turnId));
}
function ticks(path, turnId) {
  return messages(path, turnId).flatMap(e => [...e.params.item.text.matchAll(/^tick (\d+)\s*$/gim)].map(m => +m[1]));
}
async function until(check, label, timeout = 240000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = check(); if (value) return value; await delay(200); }
  throw new Error(`Timed out waiting for ${label}; artifacts: ${run}`);
}
async function finished(processHandle, expected) {
  const r = await Promise.race([processHandle.result, delay(120000, undefined, { ref: false }).then(() => { throw new Error('Attached CLI did not exit'); })]);
  assert.equal(r.code, expected, r.stderr); return r;
}
const prompt = 'Repeat 8 times: run `sleep 15; date`, then write `tick N`. When done, say FINISHED.';
let serverPort, proxy, proxyPort, ownsServer = false, dropStartReply = true;
const connections = new Set();
const evidence = { date: new Date().toISOString(), node: process.version, run, prompt, model: 'gpt-6.1-sol', effort: 'low' };
async function start(name) {
  const cwd = join(run, name); mkdirSync(cwd);
  writeFileSync(join(cwd, 'AGENTS.md'), '# Proof boundaries\n\nWork only in this directory. Never touch shared Codex configuration or daemons. Never kill or select processes by name (no pkill, killall, or pgrep). Run only the requested sleep/date commands. If steered during sleep, wait for that command to finish, then follow the steering message without running the next iteration. Write tick messages as agent messages.\n');
  const log = join(run, `${name}.jsonl`);
  const handle = launch(['start', '--port', String(proxyPort), '--cwd', cwd, '--model', evidence.model, '--effort', evidence.effort,
    '--sandbox', 'danger-full-access', '--approval', 'never', '--name', name, '--log', log, prompt]);
  const ids = await until(() => { const line = handle.stdout().trim().split('\n')[0]; return line ? JSON.parse(line) : null; }, `${name} ids`, 30000);
  assert.ok(ids.threadId && ids.turnId);
  return { ...ids, handle, log };
}
try {
  const probe = createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r)); serverPort = probe.address().port; await new Promise(r => probe.close(r));
  const startups = await Promise.all([launch(['serve', '--port', String(serverPort)]).result, launch(['serve', '--port', String(serverPort)]).result]);
  const successes = startups.filter(r => r.code === 0).map(r => JSON.parse(r.stdout));
  const started = successes.find(r => r.pid);
  assert.ok(started, 'Proof requires a fresh owned server'); ownsServer = true;
  for (const result of startups) if (result.code !== 0) assert.match(result.stderr, /Another driver owns/);
  assert.equal(successes.filter(r => r.pid).length, 1, 'Concurrent serve spawned more than one server');
  evidence.concurrentServe = 'one owner; other invocation reused the listener or failed on the startup lock';
  evidence.server = started;
  // Transparent TCP proxy lets us prove WebSocket recovery without test hooks in the CLI.
  proxy = createServer(client => {
    const upstream = createConnection({ host: '127.0.0.1', port: serverPort });
    connections.add(client); connections.add(upstream);
    client.pipe(upstream);
    let buffered = Buffer.alloc(0);
    // Parse only server frames to drop the accepted turn/start reply deterministically.
    upstream.on('data', chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      // HTTP upgrade response precedes WebSocket frames.
      if (buffered.subarray(0, 4).toString() === 'HTTP') {
        const end = buffered.indexOf('\r\n\r\n');
        if (end < 0) return;
        client.write(buffered.subarray(0, end + 4)); buffered = buffered.subarray(end + 4);
      }
      while (buffered.length >= 2) {
        let size = buffered[1] & 127, offset = 2;
        if (size === 126) { if (buffered.length < 4) return; size = buffered.readUInt16BE(2); offset = 4; }
        else if (size === 127) { if (buffered.length < 10) return; size = Number(buffered.readBigUInt64BE(2)); offset = 10; }
        if (buffered.length < offset + size) return;
        const frame = buffered.subarray(0, offset + size); buffered = buffered.subarray(offset + size);
        let message;
        if ((frame[0] & 15) === 1) { try { message = JSON.parse(frame.subarray(offset).toString()); } catch {} }
        if (dropStartReply && message?.result?.turn?.id) {
          dropStartReply = false; client.destroy(); upstream.destroy(); return;
        }
        client.write(frame);
      }
    });
    const close = () => { connections.delete(client); connections.delete(upstream); client.destroy(); upstream.destroy(); };
    client.on('error', close); upstream.on('error', close); client.on('close', close); upstream.on('close', close);
  });
  await new Promise(r => proxy.listen(0, '127.0.0.1', r)); proxyPort = proxy.address().port;
  const steer = await start('steer');
  console.log(`Steering proof started: ${steer.threadId}`);
  assert.ok(events(steer.log).some(e => e.method === 'driver/startRecovered'), 'Lost turn/start reply was not recovered');
  await until(() => ticks(steer.log, steer.turnId).includes(1), 'tick 1');
  for (const socket of connections) socket.destroy();
  await until(() => events(steer.log).some(e => e.method === 'driver/reconnected'), 'WebSocket rejoin');
  await until(() => ticks(steer.log, steer.turnId).includes(2), 'tick 2');
  const steeringResult = await command(['steer', 'steer', 'Stop the loop now, write STEERED-OK, and finish.']);
  await finished(steer.handle, 0);
  assert.ok(!events(steer.log).some(e => e.params?.item?.type === 'commandExecution' && /\b(pkill|killall|pgrep)\b/.test(e.params.item.command)), 'Proof violated process-selection boundaries');
  const steerMessages = messages(steer.log, steer.turnId).map(e => e.params.item.text);
  assert.ok(steerMessages.some(text => text.includes('STEERED-OK')), 'Missing STEERED-OK agent output');
  const steerTicks = ticks(steer.log, steer.turnId);
  assert.ok(Math.max(...steerTicks) < 8, 'Loop did not stop early');
  const steerStatus = await command(['status', 'steer']); assert.equal(steerStatus.status, 'completed');
  const byId = await command(['status', steer.threadId]); assert.equal(byId.threadId, steer.threadId);
  const idleSteer = await launch(['steer', 'steer', 'Should fail']).result; assert.notEqual(idleSteer.code, 0); assert.match(idleSteer.stderr, /No turn is running/);
  evidence.steer = { threadId: steer.threadId, turnId: steer.turnId, ticks: steerTicks, steeringResult, status: steerStatus.status, log: steer.log, reconnect: true, lostStartReplyRecovered: true };
  console.log('Steering and reconnect passed.');
  const resume = launch(['resume', 'steer', 'Write RESUMED-OK and finish.']);
  await until(() => resume.stdout().trim(), 'resume ids', 30000);
  const resumeIds = JSON.parse(resume.stdout().trim());
  assert.equal(resumeIds.threadId, steer.threadId); assert.notEqual(resumeIds.turnId, steer.turnId);
  await finished(resume, 0);
  assert.ok(messages(steer.log, resumeIds.turnId).some(e => e.params.item.text.includes('RESUMED-OK')));
  evidence.resume = { ...resumeIds, log: steer.log, status: (await command(['status', 'steer'])).status };
  console.log('Resume passed.');
  const interrupt = await start('interrupt');
  console.log(`Interrupt proof started: ${interrupt.threadId}`);
  await until(() => ticks(interrupt.log, interrupt.turnId).includes(2), 'interrupt tick 2');
  await command(['interrupt', 'interrupt']);
  await finished(interrupt.handle, 130);
  const interrupted = await command(['status', 'interrupt']); assert.equal(interrupted.status, 'interrupted');
  const interruptTicks = ticks(interrupt.log, interrupt.turnId); assert.ok(Math.max(...interruptTicks) < 8);
  assert.ok(!events(interrupt.log).some(e => e.params?.item?.type === 'commandExecution' && /\b(pkill|killall|pgrep)\b/.test(e.params.item.command)), 'Proof violated process-selection boundaries');
  assert.ok(events(interrupt.log).some(e => e.method === 'turn/completed' && e.params.turn.status === 'interrupted'));
  evidence.interrupt = { threadId: interrupt.threadId, turnId: interrupt.turnId, ticks: interruptTicks, status: interrupted.status, log: interrupt.log };
  console.log('Interrupt passed.');
} finally {
  for (const child of children) child.kill('SIGTERM');
  for (const socket of connections) socket.destroy();
  if (proxy) await new Promise(r => proxy.close(r));
  try { if (ownsServer) evidence.cleanup = await command(['serve', '--stop', '--port', String(serverPort)]); }
  finally {
    if (existsSync(join(home, 'auth.json'))) unlinkSync(join(home, 'auth.json'));
    writeFileSync(join(run, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(`Evidence: ${join(run, 'evidence.json')}`); }
}
