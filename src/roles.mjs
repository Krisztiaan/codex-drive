import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const DEFAULT_ROLES = Object.freeze({
  architect: Object.freeze({
    provider: 'codex',
    model: 'gpt-6.2-sol',
    effort: 'high',
    sandbox: 'read-only',
    style: 'goal-driven',
    description: 'Planning, architecture, direction notes, and high-stakes review.',
  }),
  reviewer: Object.freeze({
    provider: 'codex',
    model: 'gpt-6.1-terra',
    effort: 'high',
    sandbox: 'read-only',
    style: 'goal-driven',
    description: 'Fast, high-recall read-only code review lenses.',
  }),
  'design-reviewer': Object.freeze({
    provider: 'codex',
    model: 'gpt-6.2-astra',
    effort: 'medium',
    sandbox: 'read-only',
    style: 'goal-driven',
    description: 'Pre-implementation design and direction note review.',
  }),
  implementer: Object.freeze({
    provider: 'codex',
    model: 'gpt-6.2-sol',
    effort: 'medium',
    sandbox: 'danger-full-access',
    style: 'goal-driven',
    description: 'Complex, logic-heavy implementation (state, concurrency, custody, schema).',
  }),
  mechanical: Object.freeze({
    provider: 'codex',
    model: 'gpt-6-luna',
    effort: 'high',
    sandbox: 'danger-full-access',
    style: 'prescriptive',
    description: 'Bounded mechanical edits, renames, codemods, and bulk updates.',
  }),
  mapper: Object.freeze({
    provider: 'codex',
    model: 'gpt-6.1-sol',
    effort: 'medium',
    sandbox: 'read-only',
    style: 'goal-driven',
    description: 'Read-only codebase mapping, ownership, and dependency tracing.',
  }),
  tester: Object.freeze({
    provider: 'codex',
    model: 'gpt-6.2-sol',
    effort: 'high',
    sandbox: 'danger-full-access',
    style: 'goal-driven',
    description: 'Adversarial failing-test prover for blocking review findings.',
  }),
  generalist: Object.freeze({
    provider: 'claude',
    model: 'opus',
    effort: 'high',
    sandbox: 'read-only',
    style: 'goal-driven',
    description: 'Cross-cutting generalist reviewer and UI/UX implementer.',
  }),
  slice: Object.freeze({
    provider: 'agy',
    model: 'gemini-4-hydrogen-high',
    effort: 'high',
    sandbox: 'danger-full-access',
    style: 'prescriptive',
    description: 'Well-defined implementation slice fully verified by tests or lint.',
  }),
});

const VALID_SANDBOXES = new Set(['read-only', 'workspace-write', 'danger-full-access']);
const VALID_STYLES = new Set(['goal-driven', 'prescriptive']);

function readRoleFile(file) {
  if (!existsSync(file)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid JSON in role config ${file}: ${error.message}`);
  }
  const table = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed.roles && typeof parsed.roles === 'object' && !Array.isArray(parsed.roles) ? parsed.roles : parsed)
    : null;
  if (!table) throw new Error(`Role config ${file} must be a JSON object`);
  for (const [name, entry] of Object.entries(table)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Role "${name}" in ${file} must be an object`);
    }
    if (entry.sandbox !== undefined && !VALID_SANDBOXES.has(entry.sandbox)) {
      throw new Error(`Role "${name}" in ${file} has invalid sandbox "${entry.sandbox}"`);
    }
    if (entry.style !== undefined && !VALID_STYLES.has(entry.style)) {
      throw new Error(`Role "${name}" in ${file} has invalid style "${entry.style}"`);
    }
  }
  return table;
}

export function defaultHome() {
  return process.env.CODEX_DRIVE_HOME || join(homedir(), '.codex-drive');
}

export function loadRoles({ home = defaultHome(), cwd = process.cwd() } = {}) {
  const roles = {};
  for (const [name, spec] of Object.entries(DEFAULT_ROLES)) {
    roles[name] = { ...spec, source: 'builtin' };
  }
  const sources = [];
  const candidates = [
    join(resolve(home), 'roles.json'),
    join(resolve(cwd), '.codex-drive', 'roles.json'),
  ];
  for (const file of candidates) {
    const overrides = readRoleFile(file);
    if (!overrides) continue;
    sources.push(file);
    for (const [name, patch] of Object.entries(overrides)) {
      roles[name] = { ...(roles[name] ?? { provider: 'codex', style: 'goal-driven' }), ...patch, source: file };
    }
  }
  return { roles, sources };
}

export function resolveRole(name, opts = {}) {
  const { roles } = loadRoles(opts);
  const spec = roles[name];
  if (!spec) {
    throw new Error(`Unknown role "${name}". Available roles: ${Object.keys(roles).sort().join(', ')}`);
  }
  return spec;
}

export function applyRoleToOptions(options, opts = {}) {
  if (!options.role) return options;
  const spec = resolveRole(options.role, { ...opts, cwd: options.cwd ?? opts.cwd });
  if (spec.provider && spec.provider !== 'codex') {
    throw new Error(`Role "${options.role}" targets provider "${spec.provider}", not "codex". Dispatch it with that provider's CLI or override the role in roles.json.`);
  }
  const merged = { ...options };
  if (merged.model === undefined && spec.model) merged.model = spec.model;
  if (merged.effort === undefined && spec.effort) merged.effort = spec.effort;
  if (!options.sandboxExplicit && spec.sandbox) merged.sandbox = spec.sandbox;
  Object.defineProperty(merged, 'sandboxExplicit', { value: options.sandboxExplicit || Boolean(spec.sandbox) });
  return merged;
}

export function formatRolesTable({ roles, sources }) {
  const names = Object.keys(roles).sort();
  const rows = [
    ['ROLE', 'PROVIDER', 'MODEL', 'EFFORT', 'SANDBOX', 'STYLE', 'DESCRIPTION'],
    ...names.map(name => {
      const r = roles[name];
      return [name, r.provider ?? '-', r.model ?? '-', r.effort ?? '-', r.sandbox ?? '-', r.style ?? '-', r.description ?? ''];
    }),
  ];
  const widths = rows[0].map((_, i) => Math.max(...rows.map(row => row[i].length)));
  const lines = rows.map(row => row.map((cell, i) => i === row.length - 1 ? cell : cell.padEnd(widths[i])).join('  '));
  lines.push('');
  lines.push(`Sources: ${sources.length ? sources.join(', ') : 'built-in defaults (~/.codex-drive/roles.json not set)'}`);
  return lines.join('\n');
}
