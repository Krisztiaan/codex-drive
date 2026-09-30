import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('PATH install is repeatable and refuses existing files and foreign or broken symlinks', t => {
  mkdirSync('/tmp/codex-drive-proof', { recursive: true });
  const dir = mkdtempSync('/tmp/codex-drive-proof/install-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const install = () => spawnSync(process.execPath, [resolve('scripts/install.mjs'), dir], { encoding: 'utf8' });
  const target = join(dir, 'codex-drive');
  assert.equal(install().status, 0);
  assert.equal(readlinkSync(target), resolve('src/cli.mjs'));
  assert.equal(install().status, 0);
  rmSync(target); writeFileSync(target, 'OWNED');
  assert.notEqual(install().status, 0);
  assert.equal(readFileSync(target, 'utf8'), 'OWNED');
  rmSync(target); symlinkSync(join(dir, 'missing'), target);
  assert.notEqual(install().status, 0);
  assert.equal(readlinkSync(target), join(dir, 'missing'));
  rmSync(target); mkdirSync(target);
  assert.notEqual(install().status, 0);
  rmSync(target, { recursive: true });
  const other = join(dir, 'another-cli'); writeFileSync(other, 'FOREIGN'); symlinkSync(other, target);
  assert.notEqual(install().status, 0);
  assert.equal(readlinkSync(target), other);
});
