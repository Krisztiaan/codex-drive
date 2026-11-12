import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, until } from './app-server.mjs';

const ambient = [
  { method: 'account/rateLimits/updated', params: { rateLimits: null } },
  { method: 'remoteControl/status/changed', params: { status: 'disabled' } },
  { method: 'thread/goal/cleared', params: { threadId: 'thread-1' } },
  { method: 'account/updated', params: { authMode: null, planType: null } },
];
function volume(paths) {
  const methods = {};
  for (const path of paths) for (const line of readFileSync(path, 'utf8').trim().split('\n').filter(Boolean)) {
    const method = JSON.parse(line).method;
    const row = methods[method] ??= { records: 0, bytes: 0 };
    row.records++; row.bytes += Buffer.byteLength(line) + 1;
  }
  return { files: paths.length, bytes: paths.reduce((sum, path) => sum + statSync(path).size, 0), methods };
}
export function journalVolume(home, logPath) {
  const dir = join(home, 'calls');
  return { calls: volume(existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.jsonl')).map(f => join(dir, f)) : []),
    log: volume(logPath && existsSync(logPath) ? [logPath] : []) };
}
export async function journalScenario(t, scenario, cliPath) {
  const f = await fixture(t, { cliPath, initializeEvents: ambient });
  let measured;
  if (['short calls', 'status', 'serve health'].includes(scenario)) {
    const args = scenario === 'short calls' ? ['call', 'model/list', '{}', '--port', String(f.port)] :
      scenario === 'status' ? ['status', 'demo'] : ['serve', '--port', String(f.port)];
    const count = scenario === 'short calls' ? 20 : 5;
    for (let n = 0; n < count; n++) {
      const result = await f.command(args);
      assert.equal(result.code, 0, result.stderr);
    }
  } else {
    f.turns[0].status = 'inProgress'; f.turns[0].items = [];
    f.seed({ status: 'running', lastAgentMessage: null });
    const task = f.launch(scenario === 'wait' ? ['wait', 'demo', '--timeout', '10'] : ['adopt', 'demo']);
    await until(f.hasRead, scenario + ' ready');
    for (let n = 1; n <= 8; n++) {
      f.emit('turn/diff/updated', { threadId: 'thread-1', turnId: 'turn-1', diff: 'x'.repeat(n * 16384) });
      f.emit('item/agentMessage/delta', { threadId: 'thread-1', turnId: 'turn-1', delta: 'x'.repeat(1024) });
      f.emit('item/started', { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'commandExecution', id: 'cmd-' + n, command: 'echo fixture' } });
      f.emit('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'commandExecution', id: 'cmd-' + n, aggregatedOutput: 'x'.repeat(1024) } });
      f.emit('thread/tokenUsage/updated', { threadId: 'thread-1', turnId: 'turn-1', tokenUsage: {} });
    }
    f.complete('completed', 'JOURNAL FIXTURE');
    const result = await task.result;
    assert.equal(result.code, 0, result.stderr);
    measured = journalVolume(f.home, f.state.logPath);
    if (scenario === 'wait') assert.equal(JSON.parse(result.stdout).lastAgentMessage, 'JOURNAL FIXTURE');
    else {
      const events = await f.command(['events', 'demo']);
      assert.equal(events.code, 0, events.stderr);
      const rows = events.stdout.trim().split('\n').map(JSON.parse);
      assert.equal(rows.filter(e => e.method === 'turn/diff/updated').length, 8);
      assert.equal(rows.filter(e => e.method === 'item/agentMessage/delta').length, 8);
      const tail = await f.command(['tail', 'demo']);
      assert.equal(tail.code, 0, tail.stderr);
      assert.match(tail.stdout, /JOURNAL FIXTURE/);
      const status = await f.command(['status', 'demo']);
      assert.equal(status.code, 0, status.stderr);
      assert.equal(JSON.parse(status.stdout).lastAgentMessage, 'JOURNAL FIXTURE');
    }
  }
  return measured ?? journalVolume(f.home, f.state.logPath);
}
