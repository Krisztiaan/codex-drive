// Offline call-journal comparison. Only fixture homes and an exported Git source copy are written.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { journalScenario } from './journal-scenarios.mjs';

const ref = process.argv[2] ?? '079ce7c';
const baseline = mkdtempSync('/tmp/codex-drive-journal-baseline-');
try {
  mkdirSync(join(baseline, 'src'));
  for (const file of execFileSync('git', ['ls-tree', '-r', '--name-only', ref, 'src'], { encoding: 'utf8' }).trim().split('\n')) {
    writeFileSync(join(baseline, file), execFileSync('git', ['show', `${ref}:${file}`]));
  }
  for (const dir of ['protocol', 'node_modules']) symlinkSync(resolve(dir), join(baseline, dir));
  writeFileSync(join(baseline, 'package.json'), '{"type":"module"}');
  if (process.argv.includes('--regressions')) {
    const result = spawnSync(process.execPath, ['--test', 'test/calls-journal.test.mjs'], {
      encoding: 'utf8', env: { ...process.env, CODEX_DRIVE_TEST_SOURCE: join(baseline, 'src'), CODEX_DRIVE_TEST_CLI: join(baseline, 'src/cli.mjs') },
    });
    console.log(result.stdout, result.stderr);
    if (result.status === 0 || !/fail 8\b/.test(result.stdout) || !/pass 1\b/.test(result.stdout)) throw new Error('Expected eight regressions to fail and attached-log preservation to pass on baseline');
  }
  for (const [label, cliPath] of [[ref, join(baseline, 'src/cli.mjs')], ['after', resolve('src/cli.mjs')]]) {
    for (const scenario of ['wait', 'attached logger', 'short calls', 'status', 'serve health']) {
      const cleanups = [];
      try {
        const result = await journalScenario({ after(fn) { cleanups.push(fn); } }, scenario, cliPath);
        console.log(JSON.stringify({ label, scenario, ...result }));
      } finally { for (const cleanup of cleanups.reverse()) await cleanup(); }
    }
  }
} finally { rmSync(baseline, { recursive: true, force: true }); }
