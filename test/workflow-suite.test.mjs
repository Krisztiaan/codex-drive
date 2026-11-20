import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyRoleToOptions, DEFAULT_ROLES, loadRoles } from '../src/roles.mjs';
import { evaluateHook, stashGuardReason, waitGuardReason } from '../src/hooks.mjs';
import { laneState, inspectLanes } from '../src/lanes.mjs';
import { detectBriefLevel, mergeFindings, parseReviewerOutput, runReview } from '../src/review.mjs';
import { runSetup } from '../src/setup.mjs';

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));

test('roles load defaults and layer home and project overrides', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cd-roles-'));
  const home = join(dir, 'home');
  const project = join(dir, 'proj');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(project, '.codex-drive'), { recursive: true });
  try {
    writeFileSync(join(home, 'roles.json'), JSON.stringify({ roles: { reviewer: { model: 'custom-reviewer', effort: 'medium' } } }));
    writeFileSync(join(project, '.codex-drive', 'roles.json'), JSON.stringify({ reviewer: { effort: 'low' } }));
    const { roles, sources } = loadRoles({ home, cwd: project });
    assert.equal(sources.length, 2);
    assert.equal(roles.reviewer.model, 'custom-reviewer');
    assert.equal(roles.reviewer.effort, 'low');
    assert.equal(roles.architect.model, DEFAULT_ROLES.architect.model);

    const applied = applyRoleToOptions({ role: 'reviewer', cwd: project, sandbox: 'danger-full-access' }, { home });
    assert.equal(applied.model, 'custom-reviewer');
    assert.equal(applied.effort, 'low');
    assert.equal(applied.sandbox, 'read-only');

    const explicit = Object.defineProperty({ role: 'reviewer', cwd: project, model: 'explicit-m', sandbox: 'workspace-write' }, 'sandboxExplicit', { value: true });
    const appliedExplicit = applyRoleToOptions(explicit, { home });
    assert.equal(appliedExplicit.model, 'explicit-m');
    assert.equal(appliedExplicit.sandbox, 'workspace-write');

    assert.throws(() => applyRoleToOptions({ role: 'generalist', cwd: project }, { home }), /provider "claude"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('wait-guard and stash-guard refuse unsafe commands and allow safe ones', () => {
  assert.match(waitGuardReason('sleep 5 && echo hi'), /sleep N/);
  assert.match(waitGuardReason('until test -f done; do sleep 1; done'), /until/);
  assert.match(waitGuardReason('while pgrep -f worker; do sleep 2; done'), /pgrep/);
  assert.match(waitGuardReason('while true; do sleep 3; done'), /no deadline/);
  assert.equal(waitGuardReason('while [ $SECONDS -lt 30 ]; do sleep 1; done'), null);
  assert.equal(waitGuardReason('codex-drive wait foo --timeout 60'), null);

  assert.match(stashGuardReason('git stash'), /refs\/stash/);
  assert.match(stashGuardReason('git -C /tmp/repo stash push -m wip'), /refs\/stash/);
  assert.match(stashGuardReason('git stash pop'), /refs\/stash/);
  assert.equal(stashGuardReason('git stash list'), null);
  assert.equal(stashGuardReason('git stash show -p'), null);
  assert.equal(stashGuardReason('git commit -m "WIP: stash-free"'), null);

  const claudeDeny = evaluateHook('all', { tool_input: { command: 'git stash' } }, 'claude');
  assert.equal(claudeDeny.hookSpecificOutput.permissionDecision, 'deny');
  const codexAllow = evaluateHook('all', { tool_input: { command: 'git status' } }, 'codex');
  assert.equal(codexAllow, null);
});

test('lanes classifies active, idle, and STALLED worktrees', async () => {
  assert.equal(laneState({ commitAge: 100, dirty: 2, newestChange: 5000, running: [{ pid: 1, name: 'node' }] }, 60), 'active');
  assert.equal(laneState({ commitAge: 5000, dirty: 0, newestChange: null, running: [] }, 60), 'idle');
  assert.equal(laneState({ commitAge: 5000, dirty: 3, newestChange: 4000, running: [] }, 60), 'STALLED');

  const dir = mkdtempSync(join(tmpdir(), 'cd-lanes-'));
  try {
    execFileSync('git', ['init', '-b', 'main', dir]);
    execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
    writeFileSync(join(dir, 'README.md'), 'hi\n');
    execFileSync('git', ['-C', dir, 'add', '.']);
    execFileSync('git', ['-C', dir, 'commit', '-m', 'init']);
    const wt = join(dir, '.worktrees', 'slot-1');
    execFileSync('git', ['-C', dir, 'worktree', 'add', '-b', 'feat/demo', wt]);
    writeFileSync(join(wt, 'dirty.txt'), 'uncommitted\n');

    const report = await inspectLanes({
      cwd: dir,
      minutes: 60,
      processes: async () => [],
      now: (Date.now() / 1000) + 7200,
    });
    assert.equal(report.lanes.length, 1);
    assert.equal(report.lanes[0].state, 'STALLED');
    assert.equal(report.stalled.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('review parses structured output, merges findings, and supports dry-run', async () => {
  assert.equal(detectBriefLevel('**Level:** 2\n'), 2);
  const parsed = parseReviewerOutput([
    '**P1** src/foo.mjs:42 missing auth check on write path',
    '**P2** src/bar.mjs:10 unhandled timeout error',
    'READ LEDGER',
    'src/foo.mjs: 1-80',
    'FINDINGS P1=1 P2=1 P3=0',
    'VERDICT: fix first',
  ].join('\n'));
  assert.equal(parsed.complete, true);
  assert.equal(parsed.verdict, 'fix first');
  assert.equal(parsed.findings.length, 2);
  assert.deepEqual(parsed.readFiles, ['src/foo.mjs']);

  const merged = mergeFindings([
    { reviewer: 'generalist', findings: [{ severity: 'P2', file: 'src/foo.mjs', line: 40, detail: 'auth' }] },
    { reviewer: 'invariants', findings: [{ severity: 'P1', file: 'src/foo.mjs', line: 42, detail: 'auth gate' }] },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].severity, 'P1');
  assert.deepEqual(merged[0].reviewers, ['generalist', 'invariants']);

  const dir = mkdtempSync(join(tmpdir(), 'cd-review-'));
  try {
    execFileSync('git', ['init', '-b', 'main', dir]);
    execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
    writeFileSync(join(dir, 'a.js'), 'export const a = 1;\n');
    writeFileSync(join(dir, 'BRIEF.md'), '# Test\n**Level:** 2\n');
    execFileSync('git', ['-C', dir, 'add', '.']);
    execFileSync('git', ['-C', dir, 'commit', '-m', 'base']);
    writeFileSync(join(dir, 'a.js'), 'export const a = 2;\n');
    execFileSync('git', ['-C', dir, 'commit', '-am', 'change']);

    const { exitCode, summary } = await runReview({
      worktree: dir, base: 'HEAD~1', head: 'HEAD', brief: 'BRIEF.md', name: 'demo', kind: 'handoff', 'dry-run': true,
    });
    assert.equal(exitCode, 0);
    assert.equal(summary.dryRun, true);
    assert.equal(summary.level, 2);
    assert.deepEqual(summary.reviewers.map(r => r.reviewer), ['generalist', 'state', 'tests']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('setup installs roles, codex pack, and templates non-destructively', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cd-setup-'));
  const home = join(dir, 'cd-home');
  const codexHome = join(dir, 'codex-home');
  const templatesDir = join(dir, 'templates');
  try {
    const first = runSetup({ roles: true, codex: true, claude: true, templates: templatesDir, home, 'codex-home': codexHome });
    assert.ok(existsSync(join(home, 'roles.json')));
    assert.ok(existsSync(join(codexHome, 'skills', 'bounded-handoff', 'SKILL.md')));
    assert.ok(existsSync(join(codexHome, 'agents', 'risk_reviewer.toml')));
    assert.ok(existsSync(join(templatesDir, 'BRIEF.md')));
    assert.ok(first.actions.every(a => a.status === 'installed'));

    writeFileSync(join(home, 'roles.json'), '{"custom":true}\n');
    const second = runSetup({ roles: true, home });
    assert.equal(second.actions[0].status, 'skipped (exists)');
    assert.equal(readFileSync(join(home, 'roles.json'), 'utf8'), '{"custom":true}\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI smoke checks for roles, progressive help, review --help, and hook stdin', () => {
  const rolesJson = JSON.parse(execFileSync(process.execPath, [CLI, 'roles', '--json'], { encoding: 'utf8' }));
  assert.ok(rolesJson.roles.architect);
  const compactHelp = execFileSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
  assert.match(compactHelp, /Expand any topic: codex-drive help/);
  const topicHelp = execFileSync(process.execPath, [CLI, 'help', 'roles'], { encoding: 'utf8' });
  assert.match(topicHelp, /roles\.json/);
  const helpOut = execFileSync(process.execPath, [CLI, 'review', '--help'], { encoding: 'utf8' });
  assert.match(helpOut, /Review levels/);
  const hookOut = JSON.parse(execFileSync(process.execPath, [CLI, 'hook', 'stash-guard'], {
    encoding: 'utf8',
    input: JSON.stringify({ tool_input: { command: 'git stash' } }),
  }));
  assert.equal(hookOut.hookSpecificOutput.permissionDecision, 'deny');
});
