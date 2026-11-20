import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ROLES, defaultHome } from './roles.mjs';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function copySafe(src, dest, { force = false, dryRun = false, actions }) {
  if (existsSync(dest) && !force) {
    actions.push({ status: 'skipped (exists)', src, dest });
    return;
  }
  if (!dryRun) {
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest, { recursive: true, force });
  }
  actions.push({ status: dryRun ? 'would copy' : 'installed', src, dest });
}

export function runSetup(options = {}) {
  const dryRun = Boolean(options['dry-run']);
  const force = Boolean(options.force);
  const actions = [];
  const nextSteps = [];
  const home = options.home ? resolve(options.home) : defaultHome();
  const codexHome = options['codex-home'] ? resolve(options['codex-home']) : (process.env.CODEX_HOME || join(homedir(), '.codex'));

  const all = !options.roles && !options.codex && !options.claude && !options.templates;

  if (all || options.roles) {
    const rolesFile = join(home, 'roles.json');
    if (existsSync(rolesFile) && !force) {
      actions.push({ status: 'skipped (exists)', dest: rolesFile });
    } else {
      if (!dryRun) {
        mkdirSync(dirname(rolesFile), { recursive: true, mode: 0o700 });
        writeFileSync(rolesFile, JSON.stringify({ roles: DEFAULT_ROLES }, null, 2) + '\n', { mode: 0o600 });
      }
      actions.push({ status: dryRun ? 'would write' : 'installed', dest: rolesFile });
    }
  }

  if (all || options.codex) {
    copySafe(
      join(PACKAGE_ROOT, 'codex-pack', 'skills', 'bounded-handoff'),
      join(codexHome, 'skills', 'bounded-handoff'),
      { force, dryRun, actions },
    );
    for (const agent of ['code_mapper.toml', 'mechanical_worker.toml', 'risk_reviewer.toml']) {
      copySafe(
        join(PACKAGE_ROOT, 'codex-pack', 'agents', agent),
        join(codexHome, 'agents', agent),
        { force, dryRun, actions },
      );
    }
    nextSteps.push(
      `Codex additive instructions template: ${join(PACKAGE_ROOT, 'templates', 'AGENTS.md')} -> copy/merge into ${join(codexHome, 'AGENTS.md')} (never set model_instructions_file).`,
      `Codex PreToolUse hook snippet (wait-guard + stash-guard): ${join(PACKAGE_ROOT, 'codex-pack', 'hooks.json')}.`,
    );
  }

  if (all || options.claude) {
    const pluginDir = join(PACKAGE_ROOT, 'claude-plugin');
    nextSteps.push(
      `Install the Claude Code plugin (SessionStart summary, completion monitor, /codex-workers, codex-goals skill, wait-guard + stash-guard hooks):`,
      `  claude plugin marketplace add "${PACKAGE_ROOT}"`,
      `  claude plugin install codex-drive@codex-drive`,
      `Or load for a single session: claude --plugin-dir "${pluginDir}"`,
    );
  }

  if (options.templates) {
    const targetDir = resolve(options.templates);
    for (const file of ['AGENTS.md', 'CLAUDE.md', 'BRIEF.md', 'roles.json']) {
      copySafe(join(PACKAGE_ROOT, 'templates', file), join(targetDir, file), { force, dryRun, actions });
    }
  }

  return { packageRoot: PACKAGE_ROOT, dryRun, actions, nextSteps };
}
