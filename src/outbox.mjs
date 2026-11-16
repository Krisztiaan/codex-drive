import { mkdirSync, readdirSync, readFileSync, writeFileSync, linkSync, unlinkSync, existsSync, statSync, watch } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { checkKey } from './state.mjs';
import { exitCode, failureDetails } from './failures.mjs';
import { duration, underDir } from './views.mjs';

// Completion outbox: one small JSON file per settled turn, named <threadId>-<turnId>.json. It is written to a
// temp file and published with link(), which never replaces an existing entry, so recording is idempotent and a
// crash never leaves a partial entry. Entries carry identity and outcome only; callers read content with `result`.
export const OUTBOX_MAX_AGE = '14d';      // CODEX_DRIVE_OUTBOX_MAX_AGE
export const OUTBOX_MAX_ENTRIES = 2000;   // CODEX_DRIVE_OUTBOX_MAX_ENTRIES
const STALE_MS = 3600000;                 // Temp files and orphan markers older than this are a crashed writer's.
const settled = ['completed', 'failed', 'interrupted'];
export const outboxDir = home => join(home, 'outbox');
const isEntry = name => name.endsWith('.json') && !name.startsWith('.');
const ackName = key => `${key}.acked`;
function limits({ maxAge, maxEntries } = {}) {
  const age = duration(maxAge ?? process.env.CODEX_DRIVE_OUTBOX_MAX_AGE ?? OUTBOX_MAX_AGE);
  const count = Number(maxEntries ?? process.env.CODEX_DRIVE_OUTBOX_MAX_ENTRIES ?? OUTBOX_MAX_ENTRIES);
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('CODEX_DRIVE_OUTBOX_MAX_ENTRIES must be a positive integer');
  return { age, count };
}
const list = dir => { try { return readdirSync(dir); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };
const remove = path => { try { unlinkSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; } };
const olderThan = (path, cutoff) => { try { return statSync(path).mtimeMs < cutoff; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
// Entries ordered by finish time, then name.
function entries(home) {
  const dir = outboxDir(home), result = [];
  for (const name of list(dir).filter(isEntry)) {
    let entry;
    try { entry = JSON.parse(readFileSync(join(dir, name), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') console.error(`codex-drive: skipping unreadable outbox entry ${name}: ${error.message}`); continue; }
    result.push({ key: name.slice(0, -'.json'.length), entry });
  }
  return result.sort((a, b) => Date.parse(a.entry.finishedAt) - Date.parse(b.entry.finishedAt) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
function prune(home, options, now = Date.now()) {
  const { age, count } = limits(options), dir = outboxDir(home), all = entries(home);
  const expired = all.filter(({ entry }, index) => Date.parse(entry.finishedAt) < now - age || index < all.length - count);
  for (const { key } of expired) { remove(join(dir, `${key}.json`)); remove(join(dir, ackName(key))); }
  // Only stale leftovers are swept, so a marker or temp file being written right now is never removed.
  for (const name of list(dir)) {
    const orphan = name.endsWith('.acked') && !existsSync(join(dir, name.slice(0, -'.acked'.length) + '.json'));
    if ((orphan || name.endsWith('.tmp')) && olderThan(join(dir, name), now - STALE_MS)) remove(join(dir, name));
  }
}
// Idempotent per thread and turn: a turn that already has an entry keeps it. finishedAt is the authoritative
// completion time when the caller knows it; otherwise the time of recording.
export function recordCompletion(home, state, { finishedAt, ...options } = {}) {
  if (!state?.turnId || !settled.includes(state.status)) return null;
  const time = finishedAt ?? Date.now();
  if (time < Date.now() - limits(options).age) return null; // Already past retention.
  const dir = outboxDir(home), path = join(dir, `${checkKey(state.threadId)}@${checkKey(state.turnId)}.json` /* '@' is outside checkKey's alphabet, so the pair is unambiguous */);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (existsSync(path)) return path;
  const entry = { name: state.name ?? null, threadId: state.threadId, turnId: state.turnId, cwd: state.cwd ?? null, status: state.status,
    failure: failureDetails(state.error, state.rateLimits)?.class ?? null, exitCode: exitCode(state), finishedAt: new Date(time).toISOString() };
  const temporary = join(dir, `.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify(entry) + '\n', { mode: 0o600 });
    try { linkSync(temporary, path); } catch (error) { if (error.code !== 'EEXIST') throw error; } // Another recorder won.
  } finally { remove(temporary); }
  prune(home, options);
  return path;
}
export const readCompletions = home => entries(home).map(({ entry }) => entry);
function acknowledge(home, keys) {
  for (const key of keys) writeFileSync(join(outboxDir(home), ackName(key)), '', { mode: 0o600 });
}
function selector(home, options, now = Date.now()) {
  if (options.since && options.unread) throw new Error('Choose --since or --unread');
  const within = underDir(options.cwd), inDir = ({ entry }) => within(entry.cwd);
  if (options.since) {
    const cutoff = /^\d+(?:\.\d+)?[smhdw]$/.test(options.since) ? now - duration(options.since) : Date.parse(options.since);
    if (Number.isNaN(cutoff)) throw new Error('--since must be a duration such as 24h or an ISO time');
    return item => inDir(item) && Date.parse(item.entry.finishedAt) >= cutoff;
  }
  if (options.unread) return item => inDir(item) && !existsSync(join(outboxDir(home), ackName(item.key)));
  return inDir;
}
export function inbox(home, options, print) {
  const chosen = entries(home).filter(selector(home, options));
  for (const { entry } of chosen) print(entry);
  if (options.ack) acknowledge(home, chosen.map(({ key }) => key));
}
// Takes a baseline scan, starts watching the directory (no polling), then rescans, so an entry published
// between the two is still printed; each later change triggers a rescan. Each entry prints once. With --unread
// or --since the matching baseline is printed too. Runs until the process ends or `signal` aborts.
export async function follow(home, options, print, { signal, afterBaseline } = {}) {
  const select = selector(home, options), dir = outboxDir(home), seen = new Set();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const scan = backlog => {
    const fresh = entries(home).filter(({ key }) => !seen.has(key));
    for (const item of fresh) seen.add(item.key);
    const chosen = backlog ? fresh.filter(select) : [];
    for (const { entry } of chosen) print(entry);
    if (options.ack) acknowledge(home, chosen.map(({ key }) => key));
  };
  scan(Boolean(options.unread || options.since));
  afterBaseline?.();
  let wake = null, pending = false;
  const notify = () => { pending = true; wake?.(); };
  const watcher = watch(dir, notify);
  signal?.addEventListener('abort', notify, { once: true });
  try {
    scan(true);
    while (!signal?.aborted) {
      if (!pending) await new Promise(resolve => { wake = resolve; });
      wake = null; pending = false;
      if (!signal?.aborted) scan(true);
    }
  } finally { watcher.close(); signal?.removeEventListener('abort', notify); }
}
