import { createConnection, createServer } from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, openSync, closeSync, readFileSync, existsSync, unlinkSync, statSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { connection } from './client.mjs';
import { accountLabel, checkServerAccount, codexHome, compareAccounts, diskIdentity, hasIdentity, readServerAccount, routingError, threadPort } from './account.mjs';
import { Rpc } from './rpc.mjs';
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
export function warnServerDirectory(port) {
  for (const pid of listenerPids(port)) {
    let lines;
    try { lines = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fni'], { encoding: 'utf8' }).split('\n'); }
    catch (error) { if (error.status === 1) continue; throw error; }
    const cwd = lines.find(line => line.startsWith('n'))?.slice(1);
    if (!cwd?.startsWith('/')) continue; // No pathname evidence; don't claim it was deleted.
    const inode = lines.find(line => line.startsWith('i'))?.slice(1);
    let missing = false;
    try {
      const stat = statSync(cwd, { bigint: true });
      missing = !stat.isDirectory() || Boolean(inode && inode !== String(stat.ino));
    } catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) missing = true; else throw error; }
    if (missing) console.error(`WARNING: app-server on 127.0.0.1:${port} (pid ${pid}) working directory no longer exists: ${JSON.stringify(cwd)}. Configuration loading and thread resume/adopt may fail. Restart this server from a stable directory when its sessions can be safely resumed.`);
  }
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
export async function activeTurns(port, { otherThan, options } = {}) {
  const rpc = await connection(port);
  try {
    if (otherThan) {
      const { identity } = await readServerAccount(rpc, { readUsage: Boolean(otherThan.accountId) });
      if (compareAccounts(otherThan, identity) !== 'mismatch') return { skipped: 'account is active or could not be verified', account: identity };
      return { account: identity, active: await loadedTurns(rpc) };
    }
    if (options) await checkServerAccount(rpc, options);
    return await loadedTurns(rpc);
  } finally { await rpc.close(); }
}
async function loadedTurns(rpc) {
  const active = []; let cursor;
  do {
    const page = await rpc.request('thread/loaded/list', { ...(cursor ? { cursor } : {}) });
    for (const id of page.data) {
      const { thread } = await rpc.request('thread/read', { threadId: id, includeTurns: false });
      if (!['idle', 'active'].includes(thread.status?.type)) throw new Error('Unknown or unreadable thread status: ' + id);
      if (thread.status.type === 'active') active.push(id);
    }
    cursor = page.nextCursor;
  } while (cursor);
  const states = new Store().all();
  return active.map(id => states.find(s => s.port === rpc.port && s.threadId === id)?.name ?? id);
}
export async function serverInventory(options = {}, active = diskIdentity()) {
  const store = new Store();
  const recorded = readdirSync(store.home).flatMap(file => {
    const match = /^server-(\d+)\.json$/.exec(file);
    return match ? [Number(match[1])] : [];
  });
  const ports = [...new Set([...recorded, ...store.all().map(s => s.port), ...(options.port ? [+options.port] : [])])]
    .filter(port => Number.isInteger(port) && port > 0 && port <= 65535).sort((a, b) => a - b);
  return Promise.all(ports.map(async port => {
    const rpc = new Rpc(port);
    const signal = AbortSignal.timeout(5000);
    try {
      await rpc.connect(signal);
      const { identity, account, usage } = await readServerAccount(rpc, { signal, readUsage: Boolean(active.accountId || options.port || options.accountSummary) });
      return { port, account: identity, identityCheck: compareAccounts(active, identity), plan: account.account?.planType, usage };
    } catch { return { port, account: null, identityCheck: 'unavailable' }; }
    finally { rpc.close(); }
  }));
}
export async function routePort(options, state) {
  const port = threadPort(options, state);
  if (port != null) return port;
  const active = diskIdentity();
  if (!hasIdentity(active)) throw routingError('Active Codex login identity is unavailable. Run codex login, then codex-drive serve.');
  const server = (await serverInventory({}, active)).find(server => server.identityCheck === 'matched');
  if (!server) throw routingError(`No known server serves ${accountLabel(active)}. Run codex-drive serve.`);
  return server.port;
}
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(error => error ? reject(error) : resolve(port));
    });
  });
}
export async function manageServers(options) {
  if (options.port) return serve(+options.port, options.stop, options);
  const active = diskIdentity();
  if (!hasIdentity(active)) throw routingError('Active Codex login identity is unavailable. Run codex login first.');
  const home = resolve(stateHome());
  const unlock = new Store(join(home, 'servers')).lock('selection');
  try {
    const servers = await serverInventory(options, active);
    if (options.stop || options.prune) {
      const stopped = [], skipped = [];
      for (const { port, identityCheck, account } of servers) {
        if (identityCheck !== 'mismatch') continue;
        try {
          const result = await serve(port, true, { ...options, otherThan: active });
          if (result.skipped) skipped.push({ port, account: result.account, reason: result.skipped });
          else if (result.stopped.length) stopped.push(result);
        } catch (error) { skipped.push({ port, account, reason: error.message }); }
      }
      return { stopped, skipped };
    }
    const matching = servers.find(server => server.identityCheck === 'matched');
    return await serve(matching?.port ?? await freePort(), false, options);
  } finally { unlock(); }
}
export async function serve(port, stop = false, options = {}) {
  const home = resolve(stateHome()); mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = join(home, `server-${port}.json`);
  const unlock = new Store(join(home, 'servers')).lock(String(port));
  try {
    let stoppedAccount;
    if (stop || options.restart) {
      const initialPids = listenerPids(port);
      let inspected = false;
      // A timed-out TCP probe is not evidence of an idle/absent listener.
      // Any PID we may signal must first pass active-turn inspection.
      if (initialPids.length || await listening(port)) {
        const deadline = Date.now() + Number(options.timeout ?? 30) * 1000;
        for (;;) {
          const inspection = await activeTurns(port, { otherThan: options.otherThan, options: options.restart ? options : undefined });
          if (inspection.skipped) return { port, ...inspection };
          stoppedAccount = inspection.account;
          const active = inspection.active ?? inspection;
          if (!active.length) break;
          const message = `Active sessions on port ${port}: ${active.join(', ')}`;
          if (options.force) { console.error(`WARNING: forcing shutdown. ${message}; turns may be interrupted.`); break; }
          if (!options.restart || Date.now() >= deadline) throw new Error(`${message}. Refusing shutdown; wait for idle or explicitly use --force.`);
          console.error(`${message}; waiting for idle.`); await delay(500);
        }
        inspected = true;
      }
      const recorded = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
      const pids = listenerPids(port);
      if (pids.length && (!inspected || pids.some(pid => !initialPids.includes(pid)))) throw new Error('Listener changed during shutdown inspection; refusing to signal an unchecked listener');
      if (recorded && pids.some(pid => !descendedFrom(pid, recorded.pid))) throw new Error('Recorded pid differs from current listener; refusing to stop a replacement');
      // A stale recorded pid must never kill a recycled unrelated process.
      const targets = recorded ? pids.filter(pid => descendedFrom(pid, recorded.pid)) : pids;
      if (targets.length && options.otherThan && compareAccounts(diskIdentity(), stoppedAccount) !== 'mismatch') {
        return { port, account: stoppedAccount, skipped: 'account is active or could not be verified' };
      }
      for (const pid of targets) process.kill(pid, 'SIGTERM');
      for (let i = 0; i < 50 && await listening(port); i++) await delay(100);
      if (await listening(port)) throw new Error('Listener did not stop after SIGTERM');
      if (existsSync(path)) unlinkSync(path);
      if (!options.restart) return { port, ...(stoppedAccount ? { account: stoppedAccount } : {}), stopped: targets };
    }
    if (await listening(port)) {
      const rpc = await connection(port);
      try {
        const { identity, identityCheck } = await checkServerAccount(rpc, options);
        warnServerDirectory(port);
        const [pid] = listenerPids(port);
        if (pid && !existsSync(path)) atomicWrite(path, { port, pid, account: identity });
        return { port, alreadyListening: true, account: identity, identityCheck };
      } finally { await rpc.close(); }
    }
    if (!hasIdentity(diskIdentity())) throw routingError('Active Codex login identity is unavailable. Run codex login first.');
    const fd = openSync(join(home, `server-${port}.log`), 'a', 0o600);
    const child = spawn('codex', ['app-server', '--listen', `ws://127.0.0.1:${port}`], { cwd: home, detached: true, stdio: ['ignore', fd, fd] });
    closeSync(fd);
    let spawnError; child.once('error', error => { spawnError = error; }); child.unref();
    for (let i = 0; i < 100; i++) {
      if (spawnError) throw spawnError;
      if (await listening(port)) {
        const owned = listenerPids(port).filter(pid => descendedFrom(pid, child.pid));
        if (!owned.length) {
          if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid, 'SIGTERM');
          throw new Error(`Port ${port} was taken during startup. Run serve again.`);
        }
        try {
          const rpc = await connection(port);
          try {
            const { identity, identityCheck } = await checkServerAccount(rpc, options);
            atomicWrite(path, { pid: owned[0], launcherPid: child.pid, port, cwd: home, codexHome: codexHome(), account: identity });
            return { pid: owned[0], port, account: identity, identityCheck };
          } finally { await rpc.close(); }
        } catch (error) {
          if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid, 'SIGTERM');
          throw error;
        }
      }
      if (child.exitCode !== null || child.signalCode !== null) break;
      await delay(100);
    }
    if (child.pid && child.exitCode === null && child.signalCode === null) process.kill(-child.pid, 'SIGTERM');
    throw new Error(`App-server failed to listen; inspect ${join(home, `server-${port}.log`)}`);
  } finally { unlock(); }
}
