// Native, non-billable proof. No credentials, model turns, shared state or live ports.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { listening } from '../src/server.mjs';

mkdirSync('/tmp/codex-drive-proof', { recursive: true });
const run = mkdtempSync('/tmp/codex-drive-proof/account-');
const home = join(run, 'state'), authHome = join(run, 'codex');
mkdirSync(home); mkdirSync(authHome);
const env = { ...process.env, CODEX_DRIVE_HOME: home, CODEX_HOME: authHome };
const probe = createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r));
const port = probe.address().port; await new Promise(r => probe.close(r)); assert.notEqual(port, 4700);
const evidence = { run, node: process.version, port, steps: [] };
async function command(args) {
  const child = spawn(process.execPath, [resolve('src/cli.mjs'), ...args, '--port', String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
  const code = await new Promise((r, reject) => { child.once('error', reject); child.once('exit', r); });
  evidence.steps.push({ args, code, stdout, stderr }); assert.equal(code, 0, stderr);
  return stdout;
}
let owned = false;
try {
  const first = JSON.parse(await command(['serve'])); assert.ok(first.pid); owned = true;
  assert.match(await command(['account']), /Account:.*unavailable/);
  const health = JSON.parse(await command(['serve'])); assert.equal(health.alreadyListening, true); assert.equal(health.identityCheck, 'unavailable');
  assert.deepEqual(JSON.parse(await command(['status', '--json'])), []);
  const restarted = JSON.parse(await command(['serve', '--restart'])); assert.ok(restarted.pid); assert.notEqual(restarted.pid, first.pid);
  evidence.passed = true;
} finally {
  if (owned) { await command(['serve', '--stop']); assert.equal(await listening(port), false); }
  writeFileSync(join(run, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(`Evidence: ${join(run, 'evidence.json')}`);
}
