import { execFile } from 'node:child_process';
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const DEFAULT_MINUTES = 60;

const formatAge = seconds => {
  if (seconds === null) return '-';
  if (seconds < 90) return `${Math.round(seconds)}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
};

export function laneState({ commitAge, dirty, newestChange, running }, minutes = DEFAULT_MINUTES) {
  if (running.length) return 'active';
  const windowSeconds = minutes * 60;
  if (commitAge !== null && commitAge < windowSeconds) return 'active';
  if (newestChange !== null && newestChange < windowSeconds) return 'active';
  return dirty ? 'STALLED' : 'idle';
}

export async function localProcesses() {
  const commands = new Map();
  try {
    const { stdout } = await run('ps', ['-axo', 'pid=,command='], { maxBuffer: 1 << 26 });
    for (const line of stdout.split('\n')) {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (match) commands.set(Number(match[1]), match[2]);
    }
  } catch { /* Unavailable on this host. */ }
  const cwds = new Map();
  if (typeof process.getuid === 'function') {
    const listing = await run('lsof', ['-nP', '-w', '-a', '-d', 'cwd', '-u', String(process.getuid()), '-Fpn'], { maxBuffer: 1 << 26 })
      .then(result => result.stdout, error => String(error.stdout ?? ''));
    let pid = null;
    for (const line of listing.split('\n')) {
      if (line.startsWith('p')) pid = Number(line.slice(1));
      else if (line.startsWith('n') && pid !== null) cwds.set(pid, line.slice(1));
    }
  }
  return [...commands]
    .filter(([pid]) => pid !== process.pid && pid !== process.ppid)
    .map(([pid, command]) => ({ pid, command, cwd: cwds.get(pid) ?? null }));
}

const inside = (file, directory) => file === directory || file.startsWith(`${directory}${sep}`);

export function laneProcesses(processes, { worktree, branch }) {
  const escapedBranch = branch ? branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : null;
  const mentions = command => command.includes(worktree) || (escapedBranch && new RegExp(`(?:^|[\\s=:])${escapedBranch}(?:$|\\s)`).test(command));
  return processes
    .filter(item => (item.cwd && inside(item.cwd, worktree)) || mentions(item.command))
    .filter(item => !/\bcodex-drive\b.*\blanes\b/.test(item.command))
    .map(item => ({ pid: item.pid, name: basename(item.command.split(/\s+/)[0] ?? '?') }));
}

async function git(worktree, ...args) {
  return (await run('git', ['-C', worktree, ...args], { maxBuffer: 1 << 28 })).stdout;
}

export async function laneFacts(worktree, processes, now = Date.now() / 1000) {
  let branch = (await git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD').catch(() => '?')).trim();
  if (branch === 'HEAD') branch = 'detached';
  const committed = Number((await git(worktree, 'log', '-1', '--format=%ct').catch(() => '')).trim());
  const status = (await git(worktree, 'status', '--porcelain=v1', '--untracked-files=all', '-z').catch(() => ''))
    .split('\0').filter(Boolean);
  const paths = status.filter(entry => /^[ MADRCU?!]{2} /.test(entry)).map(entry => entry.slice(3));
  let newest = null;
  for (const file of paths) {
    try {
      newest = Math.max(newest ?? 0, statSync(join(worktree, file)).mtimeMs / 1000);
    } catch { /* Deleted file. */ }
  }
  return {
    name: basename(worktree),
    worktree,
    branch,
    commitAge: Number.isFinite(committed) && committed > 0 ? Math.max(0, now - committed) : null,
    dirty: paths.length,
    newestChange: newest === null ? null : Math.max(0, now - newest),
    running: laneProcesses(processes, { worktree, branch: branch === 'detached' ? null : branch }),
  };
}

export function laneLine(facts, minutes = DEFAULT_MINUTES) {
  const running = facts.running.length
    ? facts.running.slice(0, 4).map(item => `${item.name} ${item.pid}`).join(', ') + (facts.running.length > 4 ? ` +${facts.running.length - 4}` : '')
    : 'nothing';
  return `${laneState(facts, minutes).padEnd(7)} ${facts.name}  ${facts.branch}  commit ${formatAge(facts.commitAge)} ago, ${facts.dirty} uncommitted`
    + `${facts.newestChange === null ? '' : ` (newest ${formatAge(facts.newestChange)} ago)`}, running: ${running}`;
}

export async function inspectLanes({ cwd = process.cwd(), dir, minutes = DEFAULT_MINUTES, processes = localProcesses, now = Date.now() / 1000 } = {}) {
  let directory;
  if (dir) {
    directory = resolve(dir);
  } else {
    const common = (await git(resolve(cwd), 'rev-parse', '--path-format=absolute', '--git-common-dir')).trim();
    directory = join(dirname(common), '.worktrees');
  }
  const lanes = existsSync(directory)
    ? readdirSync(directory)
      .map(name => join(directory, name))
      .filter(lane => existsSync(join(lane, '.git')))
      .map(lane => realpathSync(lane))
      .sort()
    : [];
  const listed = await processes();
  const facts = await Promise.all(lanes.map(lane => laneFacts(lane, listed, now)));
  const annotated = facts.map(item => ({ ...item, state: laneState(item, minutes) }));
  const stalled = annotated.filter(item => item.state === 'STALLED');
  return { directory, minutes, lanes: annotated, stalled };
}
