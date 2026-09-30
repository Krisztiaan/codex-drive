import { mkdirSync, readFileSync, writeFileSync, renameSync, linkSync, readdirSync, existsSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

export function stateHome() { return process.env.CODEX_DRIVE_HOME ?? join(homedir(), '.codex-drive'); }
export function checkKey(key) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(key)) throw new Error('Invalid thread name or id');
  return key;
}
export function atomicWrite(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); renameSync(temporary, path); }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
export class Store {
  constructor(home = stateHome()) { this.home = home; this.dir = join(home, 'threads'); mkdirSync(this.dir, { recursive: true, mode: 0o700 }); }
  path(key) { return join(this.dir, checkKey(key) + '.json'); }
  all() { return readdirSync(this.dir).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(this.dir, f), 'utf8'))); }
  read(key) {
    const path = this.path(key);
    const state = this.all().find(s => s.threadId === key) ?? (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null);
    if (!state) throw new Error(`Unknown thread: ${key}`);
    return state;
  }
  create(state) {
    const key = state.name ?? state.threadId;
    this.path(key);
    if (!existsSync(this.path(key)) && this.all().some(s => s.threadId === key || s.name === state.threadId)) throw new Error('Thread name collides with a canonical thread ID');
    const path = this.path(key), temporary = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
      linkSync(temporary, path); // Publish a complete file without replacing an existing name.
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
    return state;
  }
  save(state) { atomicWrite(this.path(state.name ?? state.threadId), state); }
  lock(key) {
    const path = this.path(key) + '.lock';
    try { const fd = openSync(path, 'wx', 0o600); writeFileSync(fd, String(process.pid)); closeSync(fd); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(readFileSync(path, 'utf8'));
      try { process.kill(pid, 0); } catch (probe) { if (probe.code === 'ESRCH') { unlinkSync(path); return this.lock(key); } throw probe; }
      throw new Error(`Another driver owns ${key} (pid ${pid})`);
    }
    return () => unlinkSync(path);
  }
}
export function applyEvent(state, event, time = new Date().toISOString()) {
  const p = event.params;
  if (p?.threadId !== state.threadId) return false;
  state.lastEventTime = time;
  if (event.method === 'turn/started') {
    if (state.turnId !== p.turn.id) state.lastAgentMessage = null;
    state.turnId = p.turn.id; state.status = 'running'; state.error = null;
  }
  if (event.method === 'turn/completed' && p.turn.id === state.turnId) {
    state.status = p.turn.status;
    state.error = p.turn.error;
  }
  if (event.method === 'item/completed' && p.turnId === state.turnId && p.item?.type === 'agentMessage') {
    state.lastAgentMessage = p.item.text.trim().split('\n').filter(Boolean).at(-1) ?? null;
  }
  return true;
}
