import { join } from 'node:path';
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Rpc } from './rpc.mjs';
import { Store, applyEvent, turnNotification } from './state.mjs';
import { RequestBroker, pendingRequests } from './requests.mjs';
import { textInput, turnParams } from './params.mjs';
import { validateCall } from './protocol.mjs';
import { exitCode, failureDetails } from './failures.mjs';
import { checkedConnection, journal, lifecycleEvent } from './client.mjs';
import { checkServerAccount, threadPort, threadUnavailable, usageWarning } from './account.mjs';
import { routePort } from './server.mjs';
import { steersFor } from './views.mjs';
import { DEFAULT_PERMISSIONS } from './defaults.mjs';
import { recordCompletion } from './outbox.mjs';

const reconnectDelay = () => 500 + Math.floor(Math.random() * 251);
export const terminal = status => ['completed', 'failed', 'interrupted', 'idle'].includes(status);
export function findState(store, key) {
  const all = store.all();
  return all.find(state => state.threadId === key) ?? all.find(state => state.name === key) ?? null;
}
export function statusView(store, state) {
  const { turnNotifications, ...view } = state;
  return { ...view, ...turnNotification(state), steers: steersFor(store, state), failure: state.status === 'failed' ? failureDetails(state.error, state.rateLimits) : null, pendingRequests: pendingRequests(store.home, state.threadId) };
}
// The latest turn, or the target turn, without items.
export async function findTurn(rpc, threadId, targetTurnId, signal) {
  let cursor, turn;
  do {
    const page = await rpc.request('thread/turns/list', { threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded', ...(cursor ? { cursor } : {}) }, { signal });
    turn = targetTurnId ? page.data.find(turn => turn.id === targetTurnId) : page.data[0]; cursor = page.nextCursor;
  } while (!turn && cursor);
  return turn ?? null;
}
export async function snapshot(rpc, state, signal, targetTurnId) {
  const turn = await findTurn(rpc, state.threadId, targetTurnId, signal);
  if (!turn) {
    if (targetTurnId) throw new Error(`Turn ${targetTurnId} is unavailable`);
    state.turnId = null; state.status = 'idle'; state.error = null; state.lastAgentMessage = null; state.failure = null; return;
  }
  if (state.turnId !== turn.id || turn.status === 'inProgress' && terminal(state.status)) state.lastAgentMessage = null;
  state.turnId = turn.id; state.status = turn.status === 'inProgress' ? 'running' : turn.status; state.error = turn.error;
  if (terminal(state.status) && state.lastAgentMessage == null) await finalMessage(rpc, state, signal);
  state.failure = state.status === 'failed' ? failureDetails(state.error, state.rateLimits) : null;
  return turn;
}
// Items are fetched only for a settled target lacking an event-captured message.
// Summary turns can omit commentary, including the last message before failure.
const messageReads = new WeakMap();
async function finalMessage(rpc, state, signal) {
  let read = messageReads.get(rpc);
  if (!read) messageReads.set(rpc, read = new Set());
  const key = state.threadId + ':' + state.turnId;
  if (read.has(key)) return;
  const item = await agentMessage(rpc, state.threadId, state.turnId, signal);
  if (item) applyEvent(state, { method: 'item/completed', params: { threadId: state.threadId, turnId: state.turnId, item } });
  read.add(key);
}
// The turn's final (newest non-empty) agent message item, searched newest first.
export async function agentMessage(rpc, threadId, turnId, signal) {
  let cursor;
  do {
    const page = await rpc.request('thread/items/list', { threadId, turnId, sortDirection: 'desc', limit: 1, ...(cursor ? { cursor } : {}) }, { signal });
    const item = page.data.find(entry => entry.item.type === 'agentMessage' && entry.item.text.trim())?.item;
    if (item) return item;
    cursor = page.nextCursor;
  } while (cursor);
  return null;
}
// The outbox is best effort: a failure is reported through a sink that never throws and never leaves pending
// journal data, so it cannot change a command's outcome. wait and result repair a missing entry.
const stderrSink = message => { try { process.stderr.write(`codex-drive: ${message}\n`); } catch { /* Best effort. */ } };
export const journalSink = path => message => {
  try { appendFileSync(path, JSON.stringify({ receivedAt: new Date().toISOString(), method: 'driver/diagnostic', params: { message } }) + '\n', { mode: 0o600 }); }
  catch { /* Best effort. */ }
};
export function recordQuietly(home, state, options, report = stderrSink) {
  try { recordCompletion(home, state, options); }
  catch (error) { report(`Outbox entry not recorded: ${error.message}`); }
}
const completedTime = turn => turn?.completedAt ? turn.completedAt * 1000 : undefined;
// A recovery record that lets a log-only result reconstruct a turn that settled while disconnected.
async function recoveryParams(rpc, state, turn, signal) {
  const params = { threadId: state.threadId, turnId: state.turnId, status: state.status };
  if (!terminal(state.status) || !state.turnId) return params;
  let message = null;
  try { message = (await agentMessage(rpc, state.threadId, state.turnId, signal))?.text ?? null; } catch { /* The status is still worth recording. */ }
  return { ...params, error: state.error ?? null, message, completedAt: turn?.completedAt ?? null };
}
function warnSandbox(state, report) {
  if (state.sandbox === 'danger-full-access' || state.sandboxPolicy?.type === 'dangerFullAccess') report(`WARNING: danger-full-access; approval=${typeof state.approval === 'string' ? state.approval : JSON.stringify(state.approvalPolicy)}. Codex can modify files and run commands without sandbox protection.`);
}
export function effectiveState(state, result) {
  for (const key of ['cwd', 'model']) if (result[key] !== undefined) state[key] = result[key];
  if (result.approvalPolicy !== undefined) state.approval = result.approvalPolicy;
  if (result.reasoningEffort !== undefined) state.effort = result.reasoningEffort;
  if (result.sandbox && typeof result.sandbox === 'object') {
    state.sandboxPolicy = result.sandbox;
    state.sandbox = { dangerFullAccess: 'danger-full-access', workspaceWrite: 'workspace-write', readOnly: 'read-only' }[result.sandbox.type] ?? null;
  }
  if (result.activePermissionProfile !== undefined) state.activePermissionProfile = result.activePermissionProfile;
}
export function attachedDefaults(options, state, prompt, command) {
  const thread = { ...(command !== 'start' ? { excludeTurns: true } : {}) }, turn = { input: prompt === undefined ? [] : textInput(prompt) };
  for (const key of ['cwd', 'model']) if (options[key] !== undefined) thread[key] = turn[key] = options[key];
  if (options.sandbox || !state) thread.sandbox = options.sandbox ?? DEFAULT_PERMISSIONS.sandbox;
  if (options.approval || !state) thread.approvalPolicy = turn.approvalPolicy = options.approval ?? DEFAULT_PERMISSIONS.approval;
  if (options.approval || command === 'start') thread.approvalsReviewer = 'user';
  if (options.effort !== undefined || state?.effort !== undefined) turn.effort = options.effort ?? state.effort;
  const roots = options['add-dir'] ?? state?.addDirs ?? [];
  if (roots.length) {
    if ((options.sandbox ?? state?.sandbox ?? DEFAULT_PERMISSIONS.sandbox) !== 'workspace-write') throw new Error('--add-dir requires workspace-write');
    turn.sandboxPolicy = { type: 'workspaceWrite', writableRoots: [options.cwd ?? state?.cwd ?? process.cwd(), ...roots], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
  }
  return { thread, turn };
}
export async function runAttached(store, command, options, key, prompt, { ready: readyCallback, diagnostic } = {}) {
  let state = command === 'start' ? null : findState(store, key);
  if (state && options.name && options.name !== state.name) throw new Error('This thread already has local state; --name cannot rename its alias');
  const threadMethod = command === 'start' ? 'thread/start' : 'thread/resume';
  const base = attachedDefaults(options, state, prompt, command);
  const prepared = turnParams(threadMethod, options, { ...(state ? { threadId: state.threadId } : command !== 'start' ? { threadId: key } : {}), ...base.thread }, { ...base.turn }, { threadOnly: ['adopt', 'attach'].includes(command) });
  if (command !== 'start' && prepared.thread.threadId !== (state?.threadId ?? key)) throw new Error('threadId must match the addressed thread; use call for raw requests');
  validateCall(threadMethod, prepared.thread);
  // Validate the whole turn before creating a thread or resuming it.
  if (prepared.turn.threadId !== undefined && prepared.turn.threadId !== state?.threadId) throw new Error('turn.threadId must match the addressed thread; use call for raw requests');
  validateCall('turn/start', { ...prepared.turn, threadId: state?.threadId ?? key });
  const port = await routePort(options, state);
  const controller = new AbortController();
  const onSignal = signal => {
    const error = Object.assign(new Error(`Attached logger stopped by ${signal}; inspect status for the turn`), { exitCode: signal === 'SIGINT' ? 130 : 143 });
    controller.abort(error); rejectDone(error);
  };
  const onInt = () => onSignal('SIGINT'), onTerm = () => onSignal('SIGTERM');
  const logPath = options.log ?? state?.logPath ?? join(store.home, 'logs', randomUUID() + '.jsonl');
  const log = journal(logPath, { buffered: true, onError: error => rejectDone(error) }), buffered = [];
  const brokerLog = event => { log(event); if (event.method === 'driver/requestPending') console.error(JSON.stringify(event)); };
  const broker = new RequestBroker({ home: store.home, log: brokerLog, policy: options['request-policy'] ?? state?.requestPolicy ?? DEFAULT_PERMISSIONS.requestPolicy, threadId: state?.threadId ?? (command === 'start' ? undefined : key) });
  let unlock = options.name || state ? store.lock(state?.name ?? options.name ?? key) : () => {};
  let releaseServer;
  let ownedTurnId, announceTurnId;
  const completedAt = new Map(); // Server completion time per turn, for the outbox entry.
  let rpc, shuttingDown = false, reconnecting = false, ready = false, recoveryTask = Promise.resolve();
  let billingReported = false;
  const report = message => {
    console.error(message);
    diagnostic?.(message);
  };
  async function verify(client, readUsage = false) {
    const health = await checkServerAccount(client, options, state, {
      signal: controller.signal, readUsage, report: message => {
        if (!billingReported) { report(message); billingReported = true; }
      },
    });
    if (readUsage) {
      const warning = usageWarning(health);
      if (warning) report(warning);
    }
    return health.identity;
  }
  const owner = process.env.CLAUDE_CODE_SESSION_ID?.trim() || null;
  const quiet = Boolean(options.quiet);
  function registerTurn() {
    const existing = turnNotification(state);
    // Attaching another logger to a running turn preserves its original owner.
    if (existing.owner && existing.owner !== owner) return;
    if (owner || quiet) {
      state.turnNotifications = { ...state.turnNotifications, [state.turnId]: { owner, quiet: quiet || existing.quiet } };
    }
  }
  let resolveDone, rejectDone;
  const newDone = () => { const promise = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; }); promise.catch(() => {}); return promise; };
  let done = newDone();
  process.once('SIGINT', onInt); process.once('SIGTERM', onTerm);
  let saveTimer, dirty = false;
  function flushState() { clearTimeout(saveTimer); saveTimer = null; if (dirty && state) { store.save(state); dirty = false; } }
  function reduce(event) {
    if (!ready) { buffered.push(event); return; }
    const eventTurnId = event.params?.turnId ?? event.params?.turn?.id;
    if (ownedTurnId && eventTurnId && eventTurnId !== ownedTurnId) return;
    if (event.method === 'turn/completed' && event.params.threadId === state.threadId && event.params.turn.completedAt) completedAt.set(event.params.turn.id, event.params.turn.completedAt * 1000);
    if (applyEvent(state, event)) {
      dirty = true;
      if (lifecycleEvent(event)) flushState();
      else saveTimer ??= setTimeout(() => { try { flushState(); } catch (error) { rejectDone(error); } }, 1000).unref();
    }
    if (terminal(state.status)) resolveDone();
  }
  function wire(client) {
    client.on('event', event => {
      try { log(event); broker.handle(client, event); reduce(event); }
      catch (error) { rejectDone(error); }
    });
    client.on('protocolError', rejectDone);
    client.on('disconnect', () => {
      if (shuttingDown || !ready || terminal(state.status) || reconnecting) return;
      reconnecting = true;
      log({ method: 'driver/disconnected', params: { threadId: state.threadId, note: 'Events during the gap may be missing; mutations are never replayed.' } });
      recoveryTask = (async () => {
        let last;
        for (let attempt = 1; attempt <= 15 && !shuttingDown; attempt++) {
          let next;
          try {
            await delay(reconnectDelay(), undefined, { signal: controller.signal }); if (shuttingDown) return;
            next = new Rpc(port); rpc = next; wire(next); await next.connect(controller.signal);
            await verify(next);
            await next.request('thread/resume', { threadId: state.threadId, excludeTurns: prepared.thread.excludeTurns ?? true }, { signal: controller.signal });
            const recovered = await snapshot(next, state, controller.signal, ownedTurnId);
            if (completedTime(recovered)) completedAt.set(recovered.id, completedTime(recovered));
            const record = await recoveryParams(next, state, recovered, controller.signal);
            if (shuttingDown) return;
            if (next.socket.readyState !== WebSocket.OPEN) throw new Error('Recovery socket closed');
            log({ method: 'driver/reconnected', params: record });
            store.save(state); reconnecting = false; if (terminal(state.status)) resolveDone(); return;
          } catch (error) { next?.close(); last = error; if (error.accountRouting) break; }
        }
        reconnecting = false;
        if (!shuttingDown) rejectDone(last?.accountRouting ? last : new Error(`Reconnect failed; turn may still be running: ${last?.message}`));
      })().catch(rejectDone);
    });
  }
  async function startTurn(params) {
    validateCall('turn/start', params);
    const priorTurnId = state.turnId;
    let turn;
    try { ({ turn } = await rpc.request('turn/start', params, { signal: controller.signal })); }
    catch (error) {
      if (controller.signal.aborted || error.rpcError || error.validationErrors) throw error;
      log({ method: 'driver/startUncertain', params: { threadId: state.threadId, error: error.message } }); rpc.close();
      let recovered = false;
      for (let attempt = 0; attempt < 15; attempt++) {
        try {
          await delay(reconnectDelay(), undefined, { signal: controller.signal }); rpc = new Rpc(port); wire(rpc); await rpc.connect(controller.signal);
          await verify(rpc);
          await rpc.request('thread/resume', { threadId: state.threadId, excludeTurns: prepared.thread.excludeTurns ?? true }, { signal: controller.signal });
          const latest = await snapshot(rpc, state, controller.signal);
          if (state.turnId && state.turnId !== priorTurnId) {
            if (completedTime(latest)) completedAt.set(latest.id, completedTime(latest));
            for (const event of buffered) if (event.method === 'account/rateLimits/updated') applyEvent(state, event);
            buffered.length = 0; state.lastEventTime = new Date().toISOString();
            turn = { id: state.turnId, status: state.status === 'running' ? 'inProgress' : state.status, error: state.error }; recovered = true;
            log({ method: 'driver/startRecovered', params: await recoveryParams(rpc, state, latest, controller.signal) });
          }
          break;
        } catch (error) { rpc.close(); if (controller.signal.aborted || error.accountRouting) throw error; }
      }
      if (!recovered) throw new Error(`turn/start outcome unconfirmed; input was not replayed. Inspect status before retrying: ${error.message}`);
    }
    if (state.turnId !== turn.id) state.lastAgentMessage = null;
    ownedTurnId = announceTurnId = turn.id;
    state.turnId = turn.id; state.status = turn.status === 'inProgress' ? 'running' : turn.status; state.error = turn.error;
    registerTurn();
    for (const key of ['cwd', 'model', 'effort']) if (params[key] !== undefined) state[key] = params[key];
    if (params.approvalPolicy !== undefined) state.approval = params.approvalPolicy;
    if (params.sandboxPolicy !== undefined && params.sandboxPolicy !== null) effectiveState(state, { sandbox: params.sandboxPolicy });
  }
  // Announce a turn this logger saw running once it settles, whether or not any client waits.
  // Best effort: wait and result repair a missing entry; the turn's outcome never depends on it.
  function announce() {
    if (!announceTurnId || state.turnId !== announceTurnId) return;
    announceTurnId = null;
    recordQuietly(store.home, state, { finishedAt: completedAt.get(state.turnId) }, journalSink(logPath));
  }
  try {
    if (command === 'start' && options.name && findState(store, options.name)) throw new Error(`Thread name already exists: ${options.name}`);
    releaseServer = new Store(join(store.home, 'servers')).lock(String(port));
    await broker.start();
    rpc = new Rpc(port); wire(rpc);
    try { await rpc.connect(controller.signal); }
    catch (error) { if (state && !controller.signal.aborted) throw threadUnavailable(state); throw error; }
    const account = await verify(rpc, ['start', 'resume'].includes(command));
    warnSandbox({ ...state, ...prepared.thread, approval: prepared.thread.approvalPolicy ?? state?.approval, sandboxPolicy: prepared.turn.sandboxPolicy ?? state?.sandboxPolicy }, report);
    const result = await rpc.request(threadMethod, prepared.thread, { signal: controller.signal });
    const thread = result.thread;
    if (state && thread.id !== state.threadId) throw new Error('Resume returned a different thread; use adopt or call');
    if (!state) {
      state = { name: options.name ?? null, threadId: thread.id, turnId: null, cwd: result.cwd ?? thread.cwd ?? prepared.thread.cwd,
        model: result.model ?? prepared.thread.model, effort: prepared.turn.effort ?? result.reasoningEffort ?? null,
        sandbox: prepared.thread.sandbox ?? DEFAULT_PERMISSIONS.sandbox, approval: prepared.thread.approvalPolicy ?? result.approvalPolicy ?? DEFAULT_PERMISSIONS.approval,
        addDirs: options['add-dir'] ?? [], logPath, port, account, status: 'idle', lastEventTime: null, lastAgentMessage: null };
      if (!options.name) { const canonicalUnlock = store.lock(state.threadId); unlock(); unlock = canonicalUnlock; }
      store.create(state);
    }
    state.account ??= account;
    broker.threadId = state.threadId;
    state.logPath = logPath; state.requestPolicy = options['request-policy'] ?? state.requestPolicy ?? DEFAULT_PERMISSIONS.requestPolicy;
    for (const k of ['cwd', 'model', 'sandbox']) if (prepared.thread[k] !== undefined) state[k] = prepared.thread[k];
    if (prepared.thread.approvalPolicy !== undefined) state.approval = prepared.thread.approvalPolicy;
    if (prepared.turn.effort !== undefined) state.effort = prepared.turn.effort;
    if (options['add-dir']) state.addDirs = options['add-dir'];
    effectiveState(state, result);
    if (command !== 'start') {
      await snapshot(rpc, state, controller.signal);
      ownedTurnId = state.turnId;
      if (state.status === 'running') {
        if (command === 'resume' && (prompt !== undefined || prepared.turn.input.length)) throw new Error(`Thread has a running turn (${state.turnId}); use steer`);
        announceTurnId = state.turnId;
        registerTurn();
      }
    }
    if (command === 'start' || command === 'resume' && (prompt !== undefined || prepared.turn.input.length)) {
      await startTurn({ ...prepared.turn, threadId: state.threadId });
    }
    ready = true; for (const event of buffered.splice(0)) reduce(event); store.save(state);
    releaseServer(); releaseServer = null;
    if (readyCallback) {
      state.driverPid = process.pid; store.save(state); log({ method: 'driver/attached', params: { threadId: state.threadId, turnId: state.turnId, pid: process.pid } });
    }
    const ids = { threadId: state.threadId, turnId: state.turnId };
    if (readyCallback) readyCallback(ids); else console.log(JSON.stringify(ids));
    for (let retry = 0; ; retry++) {
      if (terminal(state.status)) resolveDone();
      if (rpc.socket.readyState !== WebSocket.OPEN) rpc.emit('disconnect');
      await done;
      state.failure = state.status === 'failed' ? failureDetails(state.error, state.rateLimits) : null;
      announce();
      if (state.failure?.class !== 'capacity' || retry >= Number(options['retry-capacity'] ?? 0)) break;
      const failedTurnId = state.turnId;
      const backoff = Math.min(30000, 1000 * 2 ** retry);
      log({ method: 'driver/capacityRetry', params: { threadId: state.threadId, failedTurnId: state.turnId, attempt: retry + 1, backoffMs: backoff } });
      await delay(backoff, undefined, { signal: controller.signal });
      const latest = { ...state };
      await snapshot(rpc, latest, controller.signal);
      if (latest.turnId !== failedTurnId || latest.status !== 'failed') {
        log({ method: 'driver/capacityRetrySkipped', params: { threadId: state.threadId, failedTurnId, currentTurnId: latest.turnId, reason: 'Thread advanced during backoff' } });
        break;
      }
      releaseServer = new Store(join(store.home, 'servers')).lock(String(port));
      await verify(rpc, true);
      ready = false; done = newDone();
      await startTurn({ ...prepared.turn, threadId: state.threadId, input: textInput('Continue from where you stopped.') });
      ready = true; for (const event of buffered.splice(0)) reduce(event); store.save(state);
      releaseServer(); releaseServer = null;
    }
    store.save(state); process.exitCode = ['adopt', 'attach'].includes(command) && terminal(state.status) ? 0 : exitCode(state);
    if (state.status === 'failed') console.error(JSON.stringify(state.error));
  } finally {
    releaseServer?.();
    shuttingDown = true;
    await broker.close(); rpc?.close(); await recoveryTask; rpc?.close();
    try { flushState(); log.flush(); } finally { process.off('SIGINT', onInt); process.off('SIGTERM', onTerm); unlock(); }
  }
}
export async function waitForTurn(store, options, key, report = value => console.log(JSON.stringify(value)), externalSignal) {
  const state = store.read(key), port = threadPort(options, state);
  state.lastAgentMessage = null;
  const completions = new Map();
  const rememberFailure = known => {
    if (known.turnId && known.status === 'failed' && !completions.has(known.turnId)) {
      completions.set(known.turnId, { status: known.status, error: known.error,
        ...(known.lastAgentMessage != null ? { lastAgentMessage: known.lastAgentMessage } : {}) });
    }
  };
  rememberFailure(state);
  const controller = new AbortController();
  const cancel = () => controller.abort(externalSignal.reason);
  externalSignal?.addEventListener('abort', cancel, { once: true });
  if (externalSignal?.aborted) cancel();
  const timer = options.timeout ? setTimeout(() => controller.abort(new Error('Wait timed out')), Number(options.timeout) * 1000) : null;
  let rpc, wake, pendingWake = false, completedAt;
  const notify = () => { pendingWake = true; wake?.(); };
  const waitUntil = async deadline => {
    if (pendingWake) { pendingWake = false; return; }
    await new Promise((resolve, reject) => {
      const finish = () => { clearTimeout(timeout); controller.signal.removeEventListener('abort', abort); wake = null; resolve(); };
      const abort = () => { finish(); reject(controller.signal.reason); };
      const timeout = setTimeout(finish, Math.max(0, deadline - Date.now()));
      wake = finish; controller.signal.addEventListener('abort', abort, { once: true });
      if (controller.signal.aborted) abort();
    });
    pendingWake = false;
  };
  try {
    let targetTurnId, failures = 0, interval = 1000, nextSnapshot = 0, connected = false;
    for (;;) {
      try {
        if (!rpc) {
          rpc = await checkedConnection(port, options, state, controller.signal, { observer: true, threadId: state.threadId, policy: state.requestPolicy ?? DEFAULT_PERMISSIONS.requestPolicy }, { recovering: connected });
          connected = true;
          state.account ??= rpc.accountHealth.identity;
          rpc.on('event', event => {
            if (event.params?.threadId && event.params.threadId !== state.threadId) return;
            const eventTurnId = event.params?.turnId ?? event.params?.turn?.id;
            if (!targetTurnId || !eventTurnId || eventTurnId === targetTurnId) {
              applyEvent(state, event);
              if (event.method === 'turn/completed' && event.params.threadId === state.threadId) {
                const { status, error } = event.params.turn;
                completedAt ??= completedTime(event.params.turn);
                completions.set(eventTurnId, { status, error,
                  ...(state.turnId === eventTurnId && state.lastAgentMessage != null ? { lastAgentMessage: state.lastAgentMessage } : {}) });
              }
            }
            notify();
          });
          rpc.on('disconnect', notify);
          await rpc.request('thread/resume', { threadId: state.threadId, excludeTurns: true }, { signal: controller.signal });
          nextSnapshot = 0; interval = 1000;
        }
        if (Date.now() >= nextSnapshot) {
          const seen = await snapshot(rpc, state, controller.signal, targetTurnId);
          if (!targetTurnId || seen?.id === targetTurnId) completedAt ??= completedTime(seen);
          nextSnapshot = Date.now() + interval; interval = Math.min(10000, interval * 2);
        }
        if (!state.turnId) throw new Error('Thread has no current turn');
        targetTurnId ??= state.turnId; failures = 0;
        // History snapshots can lose terminal errors. The observed completion
        // (or attached logger's saved failure) is authoritative for this turn.
        const latest = terminal(state.status) ? findState(store, key) : null;
        const saved = latest?.threadId === state.threadId ? latest : null;
        if (saved && !completions.has(state.turnId)) rememberFailure(saved);
        const completion = completions.get(state.turnId);
        if (completion) Object.assign(state, completion);
        if (terminal(state.status)) {
          if (state.lastAgentMessage == null) await finalMessage(rpc, state, controller.signal);
          if (saved) state.turnNotifications = saved.turnNotifications;
          recordQuietly(store.home, state, { finishedAt: completedAt }); // Repairs the entry of a logger that died.
          break;
        }
        if (rpc.socket.readyState !== WebSocket.OPEN) throw new Error('Wait socket closed');
        await waitUntil(nextSnapshot);
      } catch (error) {
        if (controller.signal.aborted || error.accountRouting || error.rpcError || !error.requestTimeout && rpc?.socket.readyState === WebSocket.OPEN) throw error;
        await rpc?.close(); rpc = null; if (++failures > 15) throw error;
        await delay(reconnectDelay(), undefined, { signal: controller.signal });
      }
    }
    const result = statusView(store, state); report(result); return exitCode(state);
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    if (externalSignal?.aborted) return null;
    report({ ...statusView(store, state), timedOut: true }); return 124;
  } finally { clearTimeout(timer); externalSignal?.removeEventListener('abort', cancel); await rpc?.close(); }
}
