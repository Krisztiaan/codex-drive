import { mkdirSync, lstatSync, readlinkSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

try {
  if (process.argv.length > 3) throw new Error('Usage: node scripts/install.mjs [bin-directory]');
  const directory = resolve(process.argv[2] ?? join(homedir(), '.local', 'bin'));
  const destination = join(directory, 'codex-drive');
  const source = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
  mkdirSync(directory, { recursive: true });
  let existing;
  try { existing = lstatSync(destination); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (existing) {
    if (!existing.isSymbolicLink() || resolve(dirname(destination), readlinkSync(destination)) !== source) throw new Error(`Refusing to overwrite ${destination}`);
  } else symlinkSync(source, destination); // No force option; a concurrent occupant also causes refusal.
  console.log(`${destination} -> ${source}`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
