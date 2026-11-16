import { appendFileSync, existsSync, readFileSync, mkdirSync, unlinkSync, lstatSync, statSync, realpathSync, readdirSync } from 'node:fs';
import { join, resolve, sep, dirname } from 'node:path';
import { checkKey } from './state.mjs';
import { quotas } from './account.mjs';

export function duration(value) {
  const match = /^(\d+(?:\.\d+)?)(s|m|h|d|w)$/.exec(value ?? '');
  if (!match || !Number.isFinite(+match[1]) || +match[1] <= 0) throw new Error('Duration must be positive with s, m, h, d or w (for example 24h)');
  return +match[1] * { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 }[match[2]];
}
const clean = value => String(value ?? '-').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
// --cwd selects a directory and everything under it, for sessions and outbox entries alike.
export function underDir(prefix) {
  if (!prefix) return () => true;
  const dir = resolve(prefix), base = dir.endsWith(sep) ? dir : dir + sep;
  return cwd => cwd === dir || Boolean(cwd?.startsWith(base));
}
export function filterStates(states, options, now = Date.now()) {
  const cutoff = options.since ? now - duration(options.since) : null;
  const glob = options.name ? new RegExp('^' + options.name.split('*').map(s => s.split('?').map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.')).join('.*') + '$') : null;
  const within = underDir(options.cwd);
  return states.filter(s => (!options.active || s.status === 'running') && within(s.cwd) && (!cutoff || Date.parse(s.lastEventTime) >= cutoff) && (!glob || glob.test(s.name ?? s.threadId)));
}
export function table(states) {
  const rows = [['NAME', 'STATUS', 'MODEL', 'CWD', 'EVENT AGE', 'LAST MESSAGE', 'USAGE LEFT']];
  for (const s of states) {
    const used = quotas({ rateLimits: s.rateLimits, rateLimitsByLimitId: s.rateLimitsByLimitId }).flatMap(([id, q]) => ['primary', 'secondary'].filter(k => q[k]).map(k => `${id}/${k}: ${Math.max(0, 100 - q[k].usedPercent)}%`));
    rows.push([s.name ?? s.threadId, s.refreshError ? 'unavailable' : s.status, s.model, s.cwd?.split(sep).slice(-2).join(sep), s.lastEventTime ? `${Math.max(0, Math.floor((Date.now() - Date.parse(s.lastEventTime)) / 1000))}s` : '-', s.lastAgentMessage, used.join(', ') || 'unknown']);
  }
  const widths = [28, 13, 20, 28, 12, 55, 60];
  return rows.map(row => row.map((v, i) => clean(v).slice(0, widths[i]).padEnd(widths[i])).join('  ').trimEnd()).join('\n');
}
function steerPath(store, state) { return join(store.home, 'steers', checkKey(state.threadId) + '.jsonl'); }
export function steersFor(store, state) {
  const path = steerPath(store, state);
  return [...(state.steers ?? []), ...(existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [])];
}
export function recordSteer(store, state, text, turnId) {
  const path = steerPath(store, state); mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, JSON.stringify({ time: new Date().toISOString(), text, turnId }) + '\n', { mode: 0o600 });
}
export function pruneCandidates(store, olderThan) {
  const cutoff = Date.now() - duration(olderThan ?? '30d');
  return store.all().filter(s => ['completed', 'failed', 'interrupted', 'idle'].includes(s.status) && Date.parse(s.lastEventTime) < cutoff && !existsSync(store.path(s.name ?? s.threadId) + '.lock'));
}
export function pruneCalls(store, olderThan, apply = false) {
  const age = olderThan ?? '30d';
  const cutoff = Date.now() - duration(/^\d+(?:\.\d+)?$/.test(age) ? age + 'd' : age);
  const dir = join(realpathSync(store.home), 'calls');
  let directory;
  try { directory = lstatSync(dir); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  if (!directory.isDirectory()) throw new Error('Refusing prune: calls must be a real directory');
  const sameDirectory = stat => stat.isDirectory() && stat.dev === directory.dev && stat.ino === directory.ino;
  const previous = process.cwd();
  try {
    // Pin the directory as cwd for this synchronous operation: relative lstat and
    // unlink cannot follow a replacement calls/ symlink. Node has no unlinkat.
    process.chdir(dir);
    const checkDirectory = () => {
      if (!sameDirectory(statSync('.')) || !sameDirectory(lstatSync(dir)) || realpathSync('.') !== dir) {
        throw new Error('Refusing prune: calls directory changed');
      }
    };
    checkDirectory();
    const calls = [];
    for (const name of readdirSync('.').filter(name => name.endsWith('.jsonl')).sort()) {
      checkDirectory();
      try {
        const stat = lstatSync(name);
        if (!stat.isFile() || stat.mtimeMs >= cutoff) continue;
        if (apply) unlinkSync(name); // Unlinks the entry itself, never a link target.
        calls.push(name);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return calls;
  } finally { process.chdir(previous); }
}
export function removeSession(store, state) {
  const all = store.all();
  unlinkSync(store.path(state.name ?? state.threadId));
  const path = state.logPath && resolve(state.logPath);
  // Explicitly supplied external logs and shared logs are never removed.
  if (path && path.startsWith(resolve(store.home, 'logs') + sep) && !all.some(s => (s.threadId !== state.threadId || s.name !== state.name) && s.logPath && resolve(s.logPath) === path) && existsSync(path)) unlinkSync(path);
  const steers = steerPath(store, state); if (!all.some(s => s.threadId === state.threadId && s.name !== state.name) && existsSync(steers)) unlinkSync(steers);
}
