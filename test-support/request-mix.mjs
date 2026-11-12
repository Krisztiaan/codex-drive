// Offline seven-thread comparison using source from a Git ref in a temp directory.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture, until } from './app-server.mjs';

const ref = process.argv[2] ?? 'main';
const baseline = mkdtempSync('/tmp/codex-drive-baseline-');
const cleanups = [];
try {
  mkdirSync(join(baseline, 'src'));
  for (const file of execFileSync('git', ['ls-tree', '-r', '--name-only', ref, 'src'], { encoding: 'utf8' }).trim().split('\n')) {
    writeFileSync(join(baseline, file), execFileSync('git', ['show', `${ref}:${file}`]));
  }
  for (const dir of ['protocol', 'node_modules']) symlinkSync(resolve(dir), join(baseline, dir));
  writeFileSync(join(baseline, 'package.json'), '{"type":"module"}');
  if (process.argv.includes('--regressions')) {
    const result = spawnSync(process.execPath, ['--test', '--test-name-pattern=internal resumes|snapshots page|quiet wait|--any reports|serve inspection', 'test/efficiency.test.mjs'], {
      encoding: 'utf8', env: { ...process.env, CODEX_DRIVE_TEST_SOURCE: join(baseline, 'src'), CODEX_DRIVE_TEST_CLI: join(baseline, 'src/cli.mjs') },
    });
    console.log(result.stdout, result.stderr);
    if (result.status === 0 || !/fail 5/.test(result.stdout)) throw new Error('Expected all five A/B/C/G/F regression tests to fail on baseline');
  }
  for (const [label, cliPath] of [[ref, join(baseline, 'src/cli.mjs')], ['after', resolve('src/cli.mjs')]]) {
    const f = await fixture({ after(fn) { cleanups.push(fn); } }, { cliPath });
    const names = [];
    f.threads.clear();
    for (let n = 0; n < 7; n++) {
      const threadId = `thread-${n + 1}`, name = `wait-${n + 1}`;
      names.push(name);
      f.threads.set(threadId, [{ id: `turn-${n + 1}`, status: 'inProgress', items: [], error: null }]);
      writeFileSync(join(f.home, 'threads', name + '.json'), JSON.stringify({ ...f.state, threadId, name, status: 'running', lastAgentMessage: null }));
    }
    const task = f.launch(['wait', ...names, '--any', '--timeout', '10']);
    await until(() => f.received.filter(m => m.method === 'thread/turns/list').length >= 7);
    const start = Date.now(), before = f.received.length;
    await delay(4000);
    const elapsed = (Date.now() - start) / 1000, steady = f.received.slice(before), counts = {};
    for (const m of steady) {
      const key = m.method + ' / ' + (m.params.itemsView ?? '-');
      counts[key] = (counts[key] ?? 0) + 1;
    }
    f.complete('completed', 'MEASURED', f.threads.get('thread-1')[0]);
    const result = await task.result;
    console.log(JSON.stringify({ label, elapsedSeconds: elapsed, steadyCounts: counts, perSecond: Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, +(v / elapsed).toFixed(2)])), totalCounts: f.requestCounts(), exitCode: result.code }));
  }
} finally {
  for (const cleanup of cleanups.reverse()) await cleanup();
  rmSync(baseline, { recursive: true, force: true });
}
