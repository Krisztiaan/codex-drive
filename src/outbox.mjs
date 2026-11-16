import { appendFileSync, mkdirSync, existsSync, readFileSync, renameSync, statSync, openSync, closeSync, fstatSync, readSync, watch } from 'node:fs';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { Store, atomicWrite } from './state.mjs';
import { exitCode, failureDetails } from './failures.mjs';
import { duration } from './views.mjs';

// Completion outbox: one JSON line per settled turn, appended by the turn's logger.
// Lines stay far below PIPE_BUF, so O_APPEND writes from concurrent loggers never interleave.
export const OUTBOX_LIMIT_BYTES = 1024 * 1024;
export const MESSAGE_PREVIEW_CHARS = 300;
const settled = ['completed', 'failed', 'interrupted'];
export const outboxDir = home => join(home, 'outbox');
const current = home => join(outboxDir(home), 'outbox.jsonl');
const previous = home => join(outboxDir(home), 'outbox.1.jsonl');
const ackPath = home => join(outboxDir(home), 'acked.json');
const keyOf = entry => `${entry.threadId}:${entry.turnId}`;
const locks = home => new Store(outboxDir(home));
function limitBytes(limit) {
  const value = Number(limit ?? process.env.CODEX_DRIVE_OUTBOX_BYTES ?? OUTBOX_LIMIT_BYTES);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('CODEX_DRIVE_OUTBOX_BYTES must be a positive integer');
  return value;
}

// Only identity, outcome class and a bounded preview; never errors, prompts or rate-limit payloads.
export function completionEntry(state, message, finishedAt = new Date().toISOString()) {
  if (!state.turnId || !settled.includes(state.status)) return null;
  return { name: state.name ?? null, threadId: state.threadId, turnId: state.turnId, cwd: state.cwd ?? null, status: state.status,
    failure: failureDetails(state.error, state.rateLimits)?.class ?? null, exitCode: exitCode(state), finishedAt,
    message: message == null ? null : [...message].slice(0, MESSAGE_PREVIEW_CHARS).join('') };
}
function rotate(home, limit) {
  let unlock;
  try { unlock = locks(home).lock('rotate'); }
  catch (error) { if (/Another driver owns/.test(error.message)) return; throw error; } // The owner rotates.
  try { if (statSync(current(home)).size >= limit) renameSync(current(home), previous(home)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  finally { unlock(); }
}
export function appendCompletion(home, entry, { limit } = {}) {
  const bytes = limitBytes(limit);
  mkdirSync(outboxDir(home), { recursive: true, mode: 0o700 });
  try { if (statSync(current(home)).size >= bytes) rotate(home, bytes); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  appendFileSync(current(home), JSON.stringify(entry) + '\n', { mode: 0o600 });
}
function parse(text) {
  // An unfinished final append is ignored; complete corrupt records are rejected.
  return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(line => JSON.parse(line));
}
const read = path => { try { return readFileSync(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return ''; throw error; } };
const inode = path => { try { return statSync(path).ino; } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
export function readCompletions(home) {
  for (;;) {
    const before = inode(current(home));
    const text = parse(read(previous(home))).concat(parse(read(current(home))));
    if (inode(current(home)) === before) return text; // Retry if a rotation ran between the two reads.
  }
}
function acked(home) { const text = read(ackPath(home)); return new Set(text ? JSON.parse(text).acked : []); }
export function acknowledge(home, entries) {
  if (!entries.length) return;
  mkdirSync(outboxDir(home), { recursive: true, mode: 0o700 });
  const unlock = locks(home).lock('ack');
  try {
    const present = new Set(readCompletions(home).map(keyOf)), keys = acked(home);
    for (const entry of entries) keys.add(keyOf(entry));
    // Keys of rotated-out entries are dropped, so the ack file stays bounded by the outbox.
    atomicWrite(ackPath(home), { acked: [...keys].filter(key => present.has(key)) });
  } finally { unlock(); }
}
function selector(home, options, now = Date.now()) {
  if (options.since && options.unread) throw new Error('Choose --since or --unread');
  if (options.since) {
    const cutoff = /^\d+(?:\.\d+)?[smhdw]$/.test(options.since) ? now - duration(options.since) : Date.parse(options.since);
    if (Number.isNaN(cutoff)) throw new Error('--since must be a duration such as 24h or an ISO time');
    return entry => Date.parse(entry.finishedAt) >= cutoff;
  }
  if (options.unread) { const keys = acked(home); return entry => !keys.has(keyOf(entry)); }
  return () => true;
}
export function inbox(home, options, print) {
  const select = selector(home, options);
  const entries = readCompletions(home).filter(select);
  for (const entry of entries) print(entry);
  if (options.ack) acknowledge(home, entries);
}
// Follows appended completions by watching the outbox directory; no polling. Runs until the process ends.
// With --unread or --since the matching backlog is printed first; otherwise only new entries.
export async function follow(home, options, print) {
  const select = selector(home, options);
  mkdirSync(outboxDir(home), { recursive: true, mode: 0o700 });
  const emit = entries => { const chosen = entries.filter(select); for (const entry of chosen) print(entry); if (options.ack) acknowledge(home, chosen); };
  let fd = null, offset = 0, carry = '', decoder;
  const open = () => { try { fd = openSync(current(home), 'r'); } catch (error) { if (error.code !== 'ENOENT') throw error; fd = null; } offset = 0; carry = ''; decoder = new StringDecoder('utf8'); };
  const take = () => {
    if (fd == null) return [];
    const size = fstatSync(fd).size, buffer = Buffer.alloc(64 * 1024);
    while (offset < size) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
      if (!count) break;
      offset += count; carry += decoder.write(buffer.subarray(0, count));
    }
    const boundary = carry.lastIndexOf('\n');
    if (boundary < 0) return [];
    const entries = parse(carry.slice(0, boundary + 1)); carry = carry.slice(boundary + 1);
    return entries;
  };
  const drain = () => {
    for (;;) {
      emit(take());
      const now = inode(current(home));
      if (fd == null ? now == null : now === fstatSync(fd).ino) return;
      // Rotated or created: finish the old file through its descriptor, then switch.
      if (fd != null) { emit(take()); closeSync(fd); }
      open();
    }
  };
  const backlog = options.unread || options.since;
  for (;;) {
    // Pair the previous generation with the current file it belongs to.
    const before = inode(current(home)), older = backlog ? parse(read(previous(home))) : [];
    open();
    if (fd == null ? before == null : fstatSync(fd).ino === before) { if (backlog) emit(older); else if (fd != null) offset = fstatSync(fd).size; break; }
    if (fd != null) closeSync(fd);
  }
  let wake = null, pending = false;
  const watcher = watch(outboxDir(home), () => { pending = true; wake?.(); });
  try {
    drain(); // Also catches appends that landed before the watcher started.
    for (;;) {
      if (!pending) await new Promise(resolve => { wake = resolve; });
      wake = null; pending = false; drain();
    }
  } finally { watcher.close(); if (fd != null) closeSync(fd); }
}
