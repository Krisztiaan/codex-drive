import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRole } from './roles.mjs';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILTIN_PROMPTS_DIR = join(PACKAGE_ROOT, 'review-prompts');
const CLI_ENTRY = fileURLToPath(new URL('./cli.mjs', import.meta.url));

export const REVIEW_EXIT = Object.freeze({
  merge: 0,
  fixFirst: 1,
  usage: 2,
  incomplete: 3,
  void: 4,
  insufficientReading: 5,
  capacity: 75,
  timeout: 124,
  interrupted: 130,
});

export const LENSES = ['state', 'invariants', 'inventory', 'tests', 'record'];
export const MERGE_WINDOW = 5;

export const LEVELS = Object.freeze({
  0: Object.freeze({ scope: 'docs, mechanical moves, generated files', reviewers: [] }),
  1: Object.freeze({ scope: 'presentation: templates, copy, styles, wiring', reviewers: ['generalist'] }),
  2: Object.freeze({ scope: 'behaviour: workers, timers, flows, APIs', reviewers: ['generalist', 'state', 'tests'] }),
  3: Object.freeze({ scope: 'security, custody, permissions, persistence, schema', reviewers: ['generalist', ...LENSES] }),
});

export const DESIGN_PLAN = Object.freeze({
  scope: 'design and direction notes (--kind design)',
  reviewers: ['design-reviewer', 'generalist'],
});

export function levelTable() {
  const row = (level, plan, extra = '') => `  ${String(level).padEnd(6)} ${plan.scope}: ${plan.reviewers.length ? plan.reviewers.join(' + ') : 'gate only'}${extra}`;
  return [
    'Review levels (--level, else the brief\'s "Level:" line):',
    row('0', LEVELS[0], '; --record adds the record lens when docs make claims about code'),
    row('1', LEVELS[1]),
    row('2', LEVELS[2]),
    row('3', LEVELS[3]),
    row('design', DESIGN_PLAN),
    '  Reviewers resolve models/effort from roles.json (`generalist`, `reviewer`, `design-reviewer`).',
  ].join('\n');
}

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 1 << 26 }).trim();
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function extractSection(markdown, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^##\\s+${escaped}\\s*\\n([\\s\\S]*?)(?=^##\\s+|$(?!\\n))`, 'm').exec(markdown);
  if (!match) throw new Error(`Prompt template missing section "## ${heading}"`);
  const block = /```text\n([\s\S]*?)```/.exec(match[1]);
  return (block ? block[1] : match[1]).trim();
}

export function loadReviewPrompts(worktree) {
  const repoDir = join(worktree, '.codex-drive', 'review');
  const promptFile = existsSync(join(repoDir, 'REVIEW-PROMPT.md'))
    ? join(repoDir, 'REVIEW-PROMPT.md')
    : join(BUILTIN_PROMPTS_DIR, 'REVIEW-PROMPT.md');
  const template = readFileSync(promptFile, 'utf8');
  const lenses = {};
  for (const lens of LENSES) {
    const repoLens = join(repoDir, 'lenses', `${lens}.md`);
    const builtinLens = join(BUILTIN_PROMPTS_DIR, 'lenses', `${lens}.md`);
    const file = existsSync(repoLens) ? repoLens : builtinLens;
    const raw = readFileSync(file, 'utf8');
    const block = /```text\n([\s\S]*?)```/.exec(raw);
    lenses[lens] = { file, text: (block ? block[1] : raw).trim() };
  }
  return { promptFile, template, lenses };
}

export function detectBriefLevel(briefText) {
  const match = /^\*{0,2}Level:\*{0,2}\s*([0-3])\b/im.exec(briefText);
  return match ? Number(match[1]) : null;
}

export function buildMechanicalPrepass(worktree, mergeBase, head, changedFiles) {
  const lines = ['# Mechanical pre-pass (no model)', '', `Merge-base: ${mergeBase}`, `Head: ${head}`, ''];
  const symbols = new Set();
  let diff = '';
  try {
    diff = execFileSync('git', ['-C', worktree, 'diff', `${mergeBase}..${head}`], { encoding: 'utf8', maxBuffer: 1 << 26 });
  } catch { /* Empty diff. */ }
  for (const line of diff.split('\n')) {
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    const match = /\b(?:export\s+)?(?:async\s+)?(?:function|class|const|let|fn|struct|enum|trait|def|type|interface)\s+([A-Za-z_][A-Za-z0-9_]{2,})/.exec(line);
    if (match) symbols.add(match[1]);
  }
  lines.push(`## Changed files (${changedFiles.length})`);
  for (const file of changedFiles) lines.push(`- ${file}`);
  lines.push('');
  lines.push(`## Changed/added symbols and git grep references (${symbols.size} symbols)`);
  if (!symbols.size) {
    lines.push('No top-level symbols detected in added lines.');
  } else {
    for (const sym of [...symbols].sort().slice(0, 60)) {
      let refs = '';
      try {
        refs = execFileSync('git', ['-C', worktree, 'grep', '-n', '-F', sym], { encoding: 'utf8', maxBuffer: 1 << 23 });
      } catch { /* No references. */ }
      const hitLines = refs.split('\n').filter(Boolean);
      lines.push(`- \`${sym}\` (${hitLines.length} refs): ${hitLines.slice(0, 6).join(' | ')}${hitLines.length > 6 ? ` (+${hitLines.length - 6} more)` : ''}`);
    }
  }
  return { diff, mechanical: lines.join('\n') + '\n' };
}

export function parseReviewerOutput(text) {
  const lines = String(text ?? '').trim().split('\n');
  const findings = [];
  for (const line of lines) {
    const match = /^\*{0,2}(P[123])\*{0,2}\s+([^\s:]+):(\d+)(?::\d+)?\s*[-–—:]?\s*(.+)$/.exec(line.trim());
    if (match) {
      findings.push({ severity: match[1], file: match[2], line: Number(match[3]), detail: match[4].trim() });
    }
  }
  const readFiles = new Set();
  const ledgerIndex = lines.findIndex(line => /^READ LEDGER\b/.test(line.trim()));
  if (ledgerIndex >= 0) {
    for (let i = ledgerIndex + 1; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (!trimmed || /^FINDINGS\b/.test(trimmed) || /^VERDICT:/.test(trimmed)) break;
      const fileMatch = /^([^\s:]+):/.exec(trimmed);
      if (fileMatch) readFiles.add(fileMatch[1].replace(/^\.\//, ''));
    }
  }
  const trailerLine = lines.findLast(line => /^FINDINGS\s+P1=(\d+)\s+P2=(\d+)\s+P3=(\d+)\s*$/.test(line.trim()));
  const verdictLine = lines.findLast(line => /^VERDICT:\s*(merge|fix first)\s*$/i.test(line.trim()));
  const trailer = trailerLine ? /^FINDINGS\s+P1=(\d+)\s+P2=(\d+)\s+P3=(\d+)\s*$/.exec(trailerLine.trim()) : null;
  const verdict = verdictLine ? /^VERDICT:\s*(merge|fix first)\s*$/i.exec(verdictLine.trim())[1].toLowerCase() : null;
  return {
    findings,
    readFiles: [...readFiles],
    counts: trailer ? { P1: Number(trailer[1]), P2: Number(trailer[2]), P3: Number(trailer[3]) } : null,
    verdict,
    complete: Boolean(trailer && verdict),
  };
}

export function mergeFindings(perReviewer) {
  const rank = { P1: 1, P2: 2, P3: 3 };
  const merged = [];
  for (const { reviewer, findings } of perReviewer) {
    for (const item of findings) {
      const existing = merged.find(m => m.file === item.file && Math.abs(m.line - item.line) <= MERGE_WINDOW);
      if (existing) {
        if (rank[item.severity] < rank[existing.severity]) existing.severity = item.severity;
        if (!existing.reviewers.includes(reviewer)) existing.reviewers.push(reviewer);
      } else {
        merged.push({ ...item, reviewers: [reviewer] });
      }
    }
  }
  merged.sort((a, b) => rank[a.severity] - rank[b.severity] || a.file.localeCompare(b.file) || a.line - b.line);
  return merged;
}

function fillTemplate(template, vars) {
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, key) => vars[key] ?? '');
}

function runCommandAsync(cmd, args, { cwd, timeoutMs }) {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeoutMs) : null;
    child.on('close', code => {
      if (timer) clearTimeout(timer);
      resolvePromise({ code: timedOut ? REVIEW_EXIT.timeout : (code ?? 1), stdout, stderr, timedOut });
    });
    child.on('error', error => {
      if (timer) clearTimeout(timer);
      resolvePromise({ code: 1, stdout, stderr: error.message, timedOut: false });
    });
  });
}

function resolveReviewerSpec(reviewerName, { codexOnly, effortOverride, cwd }) {
  if (reviewerName === 'generalist') {
    const role = resolveRole(codexOnly ? 'architect' : 'generalist', { cwd });
    return {
      reviewer: reviewerName,
      provider: codexOnly ? 'codex' : (role.provider ?? 'claude'),
      model: role.model,
      effort: effortOverride ?? role.effort ?? 'high',
    };
  }
  if (reviewerName === 'design-reviewer') {
    const role = resolveRole('design-reviewer', { cwd });
    return {
      reviewer: reviewerName,
      provider: role.provider ?? 'codex',
      model: role.model,
      effort: effortOverride ?? role.effort ?? 'medium',
    };
  }
  const role = resolveRole('reviewer', { cwd });
  return {
    reviewer: reviewerName,
    provider: role.provider ?? 'codex',
    model: role.model,
    effort: effortOverride ?? role.effort ?? 'high',
  };
}

export async function runReview(options) {
  const worktree = resolve(options.worktree);
  const kind = options.kind;
  if (!['handoff', 'rereview', 'design'].includes(kind)) {
    throw new Error('--kind must be handoff, rereview, or design');
  }
  const briefPath = isAbsolute(options.brief) ? options.brief : resolve(worktree, options.brief);
  if (!existsSync(briefPath)) throw new Error(`Brief not found: ${briefPath}`);
  const briefText = readFileSync(briefPath, 'utf8');
  const briefRel = relative(worktree, briefPath);

  let level = null;
  if (kind !== 'design') {
    level = options.level !== undefined ? Number(options.level) : detectBriefLevel(briefText);
    if (![0, 1, 2, 3].includes(level)) {
      throw new Error('Review level (0..3) is required via --level or a "Level: N" line in the brief');
    }
  }

  const branch = git(worktree, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const head = git(worktree, ['rev-parse', options.head]);
  const base = git(worktree, ['rev-parse', options.base]);
  const mergeBase = git(worktree, ['merge-base', base, head]);
  const diffRange = `${mergeBase}..${head}`;
  const diffStat = git(worktree, ['diff', '--stat', diffRange]);
  const changedFiles = git(worktree, ['diff', '--name-only', diffRange]).split('\n').filter(Boolean);

  const plan = kind === 'design' ? DESIGN_PLAN : LEVELS[level];
  let reviewerNames = [...plan.reviewers];
  if (kind !== 'design' && level === 0 && options.record && !reviewerNames.includes('record')) {
    reviewerNames.push('record');
  }

  const prompts = loadReviewPrompts(worktree);
  const stateRoot = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = join(stateRoot, 'codex-drive', 'reviews', `${options.name}-${stamp}-${randomBytes(3).toString('hex')}`);

  const specs = reviewerNames.map(name => resolveReviewerSpec(name, {
    codexOnly: Boolean(options['codex-only']),
    effortOverride: options.effort,
    cwd: worktree,
  }));

  if (options['dry-run']) {
    return {
      exitCode: REVIEW_EXIT.merge,
      summary: {
        dryRun: true,
        kind,
        level,
        worktree,
        branch,
        base: mergeBase,
        head,
        brief: briefRel,
        changedFiles,
        promptFile: prompts.promptFile,
        reviewers: specs,
        runDir,
      },
    };
  }

  if (!specs.length) {
    return {
      exitCode: REVIEW_EXIT.merge,
      summary: { kind, level, verdict: 'merge', note: 'Level 0 gate-only: no model reviewers configured.', changedFiles },
    };
  }

  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const { diff, mechanical } = buildMechanicalPrepass(worktree, mergeBase, head, changedFiles);
  writeFileSync(join(runDir, 'change.diff'), diff);
  writeFileSync(join(runDir, 'mechanical.md'), mechanical);

  const basePrompt = extractSection(prompts.template, 'Prompt');
  const firstScope = extractSection(prompts.template, 'First review scope');
  const rereviewScope = extractSection(prompts.template, 'Re-review scope');
  const generalistTask = extractSection(prompts.template, 'Generalist task');
  const designTask = extractSection(prompts.template, 'Design task');
  const lensTask = extractSection(prompts.template, 'Lens task');

  let previousFindings = '';
  let previousSource = '';
  let round = 1;
  if (options.previous && existsSync(join(options.previous, 'summary.json'))) {
    const prev = JSON.parse(readFileSync(join(options.previous, 'summary.json'), 'utf8'));
    previousSource = prev.head ?? '';
    round = (prev.round ?? 1) + 1;
    previousFindings = (prev.findings ?? []).map((f, idx) => `F${idx + 1} ${f.severity} ${f.file}:${f.line} ${f.detail}`).join('\n');
  }

  const timeoutSec = Number(options.timeout ?? 2400);
  const startStatus = git(worktree, ['status', '--porcelain']);

  const results = await Promise.all(specs.map(async spec => {
    const task = kind === 'design'
      ? designTask
      : (spec.reviewer === 'generalist' ? generalistTask : fillTemplate(lensTask, { LENS: prompts.lenses[spec.reviewer].text }));
    const scope = kind === 'rereview'
      ? fillTemplate(rereviewScope, {
        ROUND: String(round),
        PREVIOUS_SOURCE: previousSource || mergeBase,
        NEW_DIFF: `git diff ${previousSource || mergeBase}..${head}`,
        PREVIOUS_FINDINGS: previousFindings || '(none)',
      })
      : firstScope;
    const prompt = fillTemplate(basePrompt, {
      WORKTREE: worktree,
      BRANCH: branch,
      BASE: mergeBase,
      SOURCE: `${head} (git diff ${diffRange})`,
      BRIEF: `${briefRel} (sha256:${sha256(briefText).slice(0, 12)})`,
      ENVIRONMENT: `${spec.provider} ${spec.model} effort=${spec.effort} read-only`,
      INPUTS: runDir,
      DIFF_STAT: diffStat || '(empty)',
      CHANGED_FILES: changedFiles.join('\n') || '(none)',
      TASK: task,
      SCOPE: scope,
    });
    writeFileSync(join(runDir, `${spec.reviewer}.prompt.txt`), prompt);

    if (spec.provider === 'claude') {
      const res = await runCommandAsync('claude', [
        '-p', prompt,
        '--model', spec.model,
        '--tools', 'Read,Grep,Glob',
        '--permission-mode', 'plan',
      ], { cwd: worktree, timeoutMs: timeoutSec * 1000 });
      writeFileSync(join(runDir, `${spec.reviewer}.out.txt`), res.stdout || res.stderr);
      return { spec, code: res.code, text: res.stdout, error: res.stderr };
    }

    const threadName = `${options.name}-${spec.reviewer}-${randomBytes(2).toString('hex')}`;
    const startRes = await runCommandAsync(process.execPath, [
      CLI_ENTRY, 'start',
      '--cwd', worktree,
      '--model', spec.model,
      '--effort', spec.effort,
      '--sandbox', 'read-only',
      '--name', threadName,
      '--quiet',
      '--detach',
      prompt,
    ], { cwd: worktree, timeoutMs: 60_000 });
    if (startRes.code !== 0) {
      return { spec, code: startRes.code, text: '', error: startRes.stderr || startRes.stdout };
    }
    const waitRes = await runCommandAsync(process.execPath, [
      CLI_ENTRY, 'wait', threadName, '--timeout', String(timeoutSec),
    ], { cwd: worktree, timeoutMs: (timeoutSec + 30) * 1000 });
    if (waitRes.code === 75 || waitRes.code === 76 || waitRes.code === 124 || waitRes.code === 130) {
      return { spec, code: waitRes.code, text: '', error: waitRes.stdout || waitRes.stderr };
    }
    const msgRes = await runCommandAsync(process.execPath, [
      CLI_ENTRY, 'result', threadName,
    ], { cwd: worktree, timeoutMs: 30_000 });
    writeFileSync(join(runDir, `${spec.reviewer}.out.txt`), msgRes.stdout || msgRes.stderr);
    return { spec, code: msgRes.code, text: msgRes.stdout, error: msgRes.stderr };
  }));

  const endHead = git(worktree, ['rev-parse', 'HEAD']);
  const endStatus = git(worktree, ['status', '--porcelain']);
  if (endHead !== head || endStatus !== startStatus) {
    return {
      exitCode: REVIEW_EXIT.void,
      summary: { runDir, void: true, reason: 'Worktree changed while review was running' },
    };
  }

  for (const r of results) {
    if (r.code === 75 || r.code === 76) return { exitCode: REVIEW_EXIT.capacity, summary: { runDir, failedReviewer: r.spec.reviewer, code: r.code } };
    if (r.code === 124) return { exitCode: REVIEW_EXIT.timeout, summary: { runDir, failedReviewer: r.spec.reviewer, code: r.code } };
    if (r.code === 130) return { exitCode: REVIEW_EXIT.interrupted, summary: { runDir, failedReviewer: r.spec.reviewer, code: r.code } };
  }

  const parsed = results.map(r => ({ reviewer: r.spec.reviewer, ...parseReviewerOutput(r.text) }));
  const incomplete = parsed.filter(p => !p.complete);
  const merged = mergeFindings(parsed);
  const blocking = merged.filter(f => f.severity === 'P1' || f.severity === 'P2');
  const insufficient = kind !== 'design'
    ? parsed.filter(p => changedFiles.some(file => !p.readFiles.includes(file)))
    : [];

  let exitCode = REVIEW_EXIT.merge;
  if (incomplete.length) exitCode = REVIEW_EXIT.incomplete;
  else if (blocking.length || parsed.some(p => p.verdict === 'fix first')) exitCode = REVIEW_EXIT.fixFirst;
  else if (insufficient.length) exitCode = REVIEW_EXIT.insufficientReading;

  const summary = {
    runDir,
    kind,
    level,
    round,
    worktree,
    branch,
    base: mergeBase,
    head,
    brief: briefRel,
    verdict: exitCode === REVIEW_EXIT.merge ? 'merge' : (exitCode === REVIEW_EXIT.fixFirst ? 'fix first' : 'incomplete'),
    exitCode,
    findings: merged,
    reviewers: parsed.map(p => ({
      reviewer: p.reviewer,
      complete: p.complete,
      verdict: p.verdict,
      counts: p.counts,
      readCount: p.readFiles.length,
    })),
  };
  writeFileSync(join(runDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  return { exitCode, summary };
}
