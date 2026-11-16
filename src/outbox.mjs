import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, existsSync, statSync, watch } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { checkKey } from './state.mjs';
import { exitCode, failureDetails } from './failures.mjs';
import { duration } from './views.mjs';

// Completion outbox: one small JSON file per settled turn, <finishedAt>-<threadId>-<turnId>.json,
// published by rename so readers never see a partial entry. Entries carry identity and outcome only;
// callers read content with `result`.
export const OUTBOX_MAX_AGE = '14d';      // CODEX_DRIVE_OUTBOX_MAX_AGE
export const OUTBOX_MAX_ENTRIES = 2000;   // CODEX_DRIVE_OUTBOX_MAX_ENTRIES
const STALE_TEMP_MS = 3600000;            // An unpublished temp file older than this is a crashed writer's.
const settled = ['completed', 'failed', 'interrupted'];
const ISO_LENGTH = 24;                    // 2026-11-16T12:00:00.000Z
export const outboxDir = home => join(home, 'outbox');
const entryName = name => /^\d{4}-.*\.json$/.test(name);
const keyOf = name => name.slice(ISO_LENGTH + 1, -'.json'.length); // <threadId>-<turnId>
const ackName = key => `${key}.acked`;
function limits({ maxAge, maxEntries } = {}) {
  const age = duration(maxAge ?? process.env.CODEX_DRIVE_OUTBOX_MAX_AGE ?? OUTBOX_MAX_AGE);
  const count = Number(maxEntries ?? process.env.CODEX_DRIVE_OUTBOX_MAX_ENTRIES ?? OUTBOX_MAX_ENTRIES);
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('CODEX_DRIVE_OUTBOX_MAX_ENTRIES must be a positive integer');
  return { age, count };
}
const list = dir => { try { return readdirSync(dir); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };
const remove = path => { try { unlinkSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; } };
function prune(dir, options, now = Date.now()) {
  const { age, count } = limits(options);
  const names = list(dir);
  const entries = names.filter(entryName).sort();
  const expired = entries.filter((name, index) => Date.parse(name.slice(0, ISO_LENGTH)) < now - age || index < entries.length - count);
  for (const name of expired) remove(join(dir, name));
  const kept = new Set(entries.filter(name => !expired.includes(name)).map(keyOf));
  for (const name of names) {
    if (name.endsWith('.acked') && !kept.has(name.slice(0, -'.acked'.length))) remove(join(dir, name));
    else if (name.endsWith('.tmp')) { try { if (statSync(join(dir, name)).mtimeMs < now - STALE_TEMP_MS) remove(join(dir, name)); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  }
}
// Idempotent per thread and turn: a turn that already has an entry is left as it is.
// Two recorders racing on the same turn may both publish; readers keep the first by name.
export function recordCompletion(home, state, { finishedAt, ...options } = {}) {
  if (!state?.turnId || !settled.includes(state.status)) return null;
  const key = `${checkKey(state.threadId)}-${checkKey(state.turnId)}`, dir = outboxDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const existing = list(dir).find(name => entryName(name) && keyOf(name) === key);
  if (existing) return join(dir, existing);
  const time = new Date(finishedAt ?? Date.now()).toISOString();
  const entry = { name: state.name ?? null, threadId: state.threadId, turnId: state.turnId, cwd: state.cwd ?? null, status: state.status,
    failure: failureDetails(state.error, state.rateLimits)?.class ?? null, exitCode: exitCode(state), finishedAt: time };
  const path = join(dir, `${time}-${key}.json`), temporary = join(dir, `.${randomUUID()}.tmp`);
  try { writeFileSync(temporary, JSON.stringify(entry) + '\n', { mode: 0o600 }); renameSync(temporary, path); }
  finally { remove(temporary); }
  prune(dir, options);
  return path;
}
// Entries sorted by name (finish time), one per thread and turn.
function entries(home) {
  const dir = outboxDir(home), seen = new Set(), result = [];
  for (const name of list(dir).filter(entryName).sort()) {
    const key = keyOf(name);
    if (seen.has(key)) continue;
    let entry;
    try { entry = JSON.parse(readFileSync(join(dir, name), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') continue; console.error(`codex-drive: skipping unreadable outbox entry ${name}: ${error.message}`); continue; }
    seen.add(key); result.push({ key, entry });
  }
  return result;
}
export const readCompletions = home => entries(home).map(({ entry }) => entry);
function acknowledge(home, keys) {
  for (const key of keys) writeFileSync(join(outboxDir(home), ackName(key)), '', { mode: 0o600 });
}
function selector(home, options, now = Date.now()) {
  if (options.since && options.unread) throw new Error('Choose --since or --unread');
  if (options.since) {
    const cutoff = /^\d+(?:\.\d+)?[smhdw]$/.test(options.since) ? now - duration(options.since) : Date.parse(options.since);
    if (Number.isNaN(cutoff)) throw new Error('--since must be a duration such as 24h or an ISO time');
    return ({ entry }) => Date.parse(entry.finishedAt) >= cutoff;
  }
  if (options.unread) return ({ key }) => !existsSync(join(outboxDir(home), ackName(key)));
  return () => true;
}
export function inbox(home, options, print) {
  const chosen = entries(home).filter(selector(home, options));
  for (const { entry } of chosen) print(entry);
  if (options.ack) acknowledge(home, chosen.map(({ key }) => key));
}
// Watches the outbox directory (no polling) and rescans on start and on every change, printing each
// new entry once. With --unread or --since the matching backlog is printed first. Runs until the process ends.
export async function follow(home, options, print) {
  const select = selector(home, options), dir = outboxDir(home), seen = new Set();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let wake = null, pending = false;
  const watcher = watch(dir, () => { pending = true; wake?.(); });
  const scan = (backlog = true) => {
    const fresh = entries(home).filter(({ key }) => !seen.has(key));
    for (const item of fresh) seen.add(item.key);
    const chosen = backlog ? fresh.filter(select) : [];
    for (const { entry } of chosen) print(entry);
    if (options.ack) acknowledge(home, chosen.map(({ key }) => key));
  };
  try {
    scan(Boolean(options.unread || options.since));
    for (;;) {
      if (!pending) await new Promise(resolve => { wake = resolve; });
      wake = null; pending = false; scan();
    }
  } finally { watcher.close(); }
}
