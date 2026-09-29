import { createConnection } from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, openSync, closeSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store, stateHome, atomicWrite } from './state.mjs';

export function listening(port) {
  return new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = result => { socket.destroy(); resolve(result); };
    socket.setTimeout(300, () => finish(false)); socket.once('connect', () => finish(true)); socket.once('error', () => finish(false));
  });
}
function listenerPids(port) {
  // No process-name matching: inspect only the requested loopback listener.
  try {
    const lines = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-FpFn'], { encoding: 'utf8' }).split('\n');
    let pid; const pids = new Set();
    for (const line of lines) { if (line.startsWith('p')) pid = +line.slice(1); if (line === `n127.0.0.1:${port}` && pid) pids.add(pid); }
    return [...pids];
  } catch (e) { if (e.status === 1) return []; throw e; }
}
function descendedFrom(pid, ancestor) {
  const visited = new Set();
  while (pid > 1 && !visited.has(pid)) {
    if (pid === ancestor) return true;
    visited.add(pid);
    try { pid = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim()); }
    catch { return false; }
  }
  return false;
}
export async function serve(port, stop = false) {
  const home = stateHome(); mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = join(home, `server-${port}.json`);
  const unlock = new Store(join(home, 'servers')).lock(String(port));
  try {
    if (stop) {
      const recorded = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
      const pids = listenerPids(port);
      if (recorded && pids.some(pid => !descendedFrom(pid, recorded.pid))) throw new Error('Recorded pid differs from current listener; refusing to stop a replacement');
      // A stale recorded pid must never kill a recycled unrelated process.
      const targets = recorded ? pids.filter(pid => descendedFrom(pid, recorded.pid)) : pids;
      for (const pid of targets) process.kill(pid, 'SIGTERM');
      for (let i = 0; i < 50 && await listening(port); i++) await delay(100);
      if (await listening(port)) throw new Error('Listener did not stop after SIGTERM');
      if (existsSync(path)) unlinkSync(path);
      return { port, stopped: targets };
    }
    if (await listening(port)) return { port, alreadyListening: true };
    const fd = openSync(join(home, `server-${port}.log`), 'a', 0o600);
    const child = spawn('codex', ['app-server', '--listen', `ws://127.0.0.1:${port}`], { detached: true, stdio: ['ignore', fd, fd] });
    closeSync(fd);
    let spawnError; child.once('error', error => { spawnError = error; }); child.unref();
    for (let i = 0; i < 100; i++) {
      if (spawnError) throw spawnError;
      if (await listening(port)) {
        const owned = listenerPids(port).filter(pid => descendedFrom(pid, child.pid));
        if (!owned.length) {
          if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid, 'SIGTERM');
          return { port, alreadyListening: true };
        }
        atomicWrite(path, { pid: owned[0], launcherPid: child.pid, port }); return { pid: owned[0], port };
      }
      if (child.exitCode !== null || child.signalCode !== null) break;
      await delay(100);
    }
    if (child.pid && child.exitCode === null && child.signalCode === null) process.kill(-child.pid, 'SIGTERM');
    throw new Error(`App-server failed to listen; inspect ${join(home, `server-${port}.log`)}`);
  } finally { unlock(); }
}
