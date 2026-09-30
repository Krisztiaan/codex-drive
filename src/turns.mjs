import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Rpc } from './rpc.mjs';
import { applyEvent } from './state.mjs';
import { RequestBroker, pendingRequests } from './requests.mjs';
import { textInput, turnParams } from './params.mjs';
import { validateCall } from './protocol.mjs';
import { exitCode, failureDetails } from './failures.mjs';
import { connection, journal } from './client.mjs';

export const terminal = status => ['completed', 'failed', 'interrupted', 'idle'].includes(status);
export function findState(store, key) {
  const all = store.all();
  return all.find(state => state.threadId === key) ?? all.find(state => state.name === key) ?? null;
}
export function portFor(options, state) {
  if (state && options.port && +options.port !== state.port) throw new Error('Port differs from thread server');
  return state?.port ?? Number(options.port ?? 4700);
}
export function statusView(store, state) {
  return { ...state, failure: state.status === 'failed' ? failureDetails(state.error, state.rateLimits) : null, pendingRequests: pendingRequests(store.home, state.threadId) };
}
export async function snapshot(rpc, state, signal, targetTurnId) {
  let cursor, turn;
  do {
    const page = await rpc.request('thread/turns/list', { threadId: state.threadId, limit: targetTurnId ? 20 : 1, sortDirection: 'desc', itemsView: 'full', ...(cursor ? { cursor } : {}) }, { signal });
    turn = targetTurnId ? page.data.find(turn => turn.id === targetTurnId) : page.data[0]; cursor = page.nextCursor;
  } while (!turn && cursor);
  if (!turn) {
    if (targetTurnId) throw new Error(`Turn ${targetTurnId} is unavailable`);
    state.turnId = null; state.status = 'idle'; state.error = null; state.lastAgentMessage = null; state.failure = null; return;
  }
  state.turnId = turn.id; state.status = turn.status === 'inProgress' ? 'running' : turn.status; state.error = turn.error;
  const message = turn.items.filter(item => item.type === 'agentMessage' && item.text.trim()).at(-1);
  state.lastAgentMessage = message ? message.text.trim().split('\n').filter(Boolean).at(-1) ?? null : null;
  state.failure = state.status === 'failed' ? failureDetails(state.error, state.rateLimits) : null;
}
export function warning(state) {
  if (state.sandbox === 'danger-full-access' || state.sandboxPolicy?.type === 'dangerFullAccess') console.error(`WARNING: danger-full-access; approval=${typeof state.approval === 'string' ? state.approval : JSON.stringify(state.approvalPolicy)}. Codex can modify files and run commands without sandbox protection.`);
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
function defaults(options, state, prompt, command) {
  const thread = {}, turn = { input: prompt === undefined ? [] : textInput(prompt) };
  for (const key of ['cwd', 'model']) if (options[key] !== undefined) thread[key] = turn[key] = options[key];
  if (options.sandbox) thread.sandbox = options.sandbox;
  if (options.approval) thread.approvalPolicy = turn.approvalPolicy = options.approval;
  if (options.approval || command === 'start') thread.approvalsReviewer = 'user';
  if (options.effort !== undefined || state?.effort !== undefined) turn.effort = options.effort ?? state.effort;
  const roots = options['add-dir'] ?? state?.addDirs ?? [];
  if (roots.length) {
    if ((options.sandbox ?? state?.sandbox ?? 'workspace-write') !== 'workspace-write') throw new Error('--add-dir requires workspace-write');
    turn.sandboxPolicy = { type: 'workspaceWrite', writableRoots: [options.cwd ?? state?.cwd ?? process.cwd(), ...roots], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
  }
  return { thread, turn };
}
export async function runAttached(store, command, options, key, prompt, readyCallback) {
  let state = command === 'start' ? null : findState(store, key);
  if (state && options.name && options.name !== state.name) throw new Error('This thread already has local state; --name cannot rename its alias');
  const port = portFor(options, state);
  const threadMethod = command === 'start' ? 'thread/start' : 'thread/resume';
  const base = defaults(options, state, prompt, command);
  const prepared = turnParams(threadMethod, options, { ...(state ? { threadId: state.threadId } : command !== 'start' ? { threadId: key } : {}), ...base.thread }, { ...base.turn }, { threadOnly: ['adopt', 'attach'].includes(command) });
  if (command !== 'start' && prepared.thread.threadId !== (state?.threadId ?? key)) throw new Error('threadId must match the addressed thread; use call for raw requests');
  validateCall(threadMethod, prepared.thread);
  // Validate the whole turn before creating a thread or resuming it.
  if (prepared.turn.threadId !== undefined && prepared.turn.threadId !== state?.threadId) throw new Error('turn.threadId must match the addressed thread; use call for raw requests');
  validateCall('turn/start', { ...prepared.turn, threadId: state?.threadId ?? key });
  const controller = new AbortController();
  const onSignal = signal => {
    const error = Object.assign(new Error(`Attached logger stopped by ${signal}; inspect status for the turn`), { exitCode: signal === 'SIGINT' ? 130 : 143 });
    controller.abort(error); rejectDone(error);
  };
  const onInt = () => onSignal('SIGINT'), onTerm = () => onSignal('SIGTERM');
  const logPath = options.log ?? state?.logPath ?? join(store.home, 'logs', randomUUID() + '.jsonl');
  const log = journal(logPath), buffered = [];
  const brokerLog = event => { log(event); if (event.method === 'driver/requestPending') console.error(JSON.stringify(event)); };
  const broker = new RequestBroker({ home: store.home, log: brokerLog, policy: options['request-policy'] ?? state?.requestPolicy ?? 'manual', threadId: state?.threadId ?? (command === 'start' ? undefined : key) });
  let unlock = options.name || state ? store.lock(state?.name ?? options.name ?? key) : () => {};
  let ownedTurnId;
  let rpc, shuttingDown = false, reconnecting = false, ready = false, recoveryTask = Promise.resolve();
  let resolveDone, rejectDone;
  const newDone = () => { const promise = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; }); promise.catch(() => {}); return promise; };
  let done = newDone();
  process.once('SIGINT', onInt); process.once('SIGTERM', onTerm);
  function reduce(event) {
    if (!ready) { buffered.push(event); return; }
    const eventTurnId = event.params?.turnId ?? event.params?.turn?.id;
    if (ownedTurnId && eventTurnId && eventTurnId !== ownedTurnId) return;
    if (applyEvent(state, event)) store.save(state);
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
            await delay(500, undefined, { signal: controller.signal }); if (shuttingDown) return;
            next = new Rpc(port); rpc = next; wire(next); await next.connect(controller.signal);
            await next.request('thread/resume', { threadId: state.threadId }, { signal: controller.signal }); await snapshot(next, state, controller.signal, ownedTurnId);
            if (shuttingDown) return;
            if (next.socket.readyState !== WebSocket.OPEN) throw new Error('Recovery socket closed');
            log({ method: 'driver/reconnected', params: { threadId: state.threadId, turnId: state.turnId, status: state.status } });
            store.save(state); reconnecting = false; if (terminal(state.status)) resolveDone(); return;
          } catch (error) { next?.close(); last = error; }
        }
        reconnecting = false; if (!shuttingDown) rejectDone(new Error(`Reconnect failed; turn may still be running: ${last?.message}`));
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
          await delay(500, undefined, { signal: controller.signal }); rpc = new Rpc(port); wire(rpc); await rpc.connect(controller.signal);
          await rpc.request('thread/resume', { threadId: state.threadId }, { signal: controller.signal }); await snapshot(rpc, state, controller.signal);
          if (state.turnId && state.turnId !== priorTurnId) {
            for (const event of buffered) if (event.method === 'account/rateLimits/updated') applyEvent(state, event);
            buffered.length = 0; state.lastEventTime = new Date().toISOString();
            turn = { id: state.turnId, status: state.status === 'running' ? 'inProgress' : state.status, error: state.error }; recovered = true;
            log({ method: 'driver/startRecovered', params: { threadId: state.threadId, turnId: state.turnId, status: state.status } });
          }
          break;
        } catch (error) { rpc.close(); if (controller.signal.aborted) throw error; }
      }
      if (!recovered) throw new Error(`turn/start outcome unconfirmed; input was not replayed. Inspect status before retrying: ${error.message}`);
    }
    if (state.turnId !== turn.id) state.lastAgentMessage = null;
    ownedTurnId = turn.id;
    state.turnId = turn.id; state.status = turn.status === 'inProgress' ? 'running' : turn.status; state.error = turn.error;
    for (const key of ['cwd', 'model', 'effort']) if (params[key] !== undefined) state[key] = params[key];
    if (params.approvalPolicy !== undefined) state.approval = params.approvalPolicy;
    if (params.sandboxPolicy !== undefined && params.sandboxPolicy !== null) effectiveState(state, { sandbox: params.sandboxPolicy });
  }
  try {
    if (command === 'start' && options.name && findState(store, options.name)) throw new Error(`Thread name already exists: ${options.name}`);
    await broker.start(); warning({ ...state, ...prepared.thread, approval: prepared.thread.approvalPolicy ?? state?.approval, sandboxPolicy: prepared.turn.sandboxPolicy });
    rpc = new Rpc(port); wire(rpc); await rpc.connect(controller.signal);
    const result = await rpc.request(threadMethod, prepared.thread, { signal: controller.signal });
    const thread = result.thread;
    if (state && thread.id !== state.threadId) throw new Error('Resume returned a different thread; use adopt or call');
    if (!state) {
      state = { name: options.name ?? null, threadId: thread.id, turnId: null, cwd: result.cwd ?? thread.cwd ?? prepared.thread.cwd,
        model: result.model ?? prepared.thread.model, effort: prepared.turn.effort ?? result.reasoningEffort ?? null,
        sandbox: prepared.thread.sandbox ?? 'workspace-write', approval: prepared.thread.approvalPolicy ?? result.approvalPolicy ?? 'on-request',
        addDirs: options['add-dir'] ?? [], logPath, port, status: 'idle', lastEventTime: null, lastAgentMessage: null };
      if (!options.name) { const canonicalUnlock = store.lock(state.threadId); unlock(); unlock = canonicalUnlock; }
      store.create(state);
    }
    broker.threadId = state.threadId;
    state.logPath = logPath; state.requestPolicy = options['request-policy'] ?? state.requestPolicy ?? 'manual';
    for (const k of ['cwd', 'model', 'sandbox']) if (prepared.thread[k] !== undefined) state[k] = prepared.thread[k];
    if (prepared.thread.approvalPolicy !== undefined) state.approval = prepared.thread.approvalPolicy;
    if (prepared.turn.effort !== undefined) state.effort = prepared.turn.effort;
    if (options['add-dir']) state.addDirs = options['add-dir'];
    effectiveState(state, result);
    if (command !== 'start') { await snapshot(rpc, state, controller.signal); ownedTurnId = state.turnId; }
    if (command === 'start' || command === 'resume' && (prompt !== undefined || prepared.turn.input.length)) {
      if (state.status === 'running') throw new Error(`Thread has a running turn (${state.turnId}); use steer`);
      await startTurn({ ...prepared.turn, threadId: state.threadId });
    }
    ready = true; for (const event of buffered.splice(0)) reduce(event); store.save(state);
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
      ready = false; done = newDone();
      await startTurn({ ...prepared.turn, threadId: state.threadId, input: textInput('Continue from where you stopped.') });
      ready = true; for (const event of buffered.splice(0)) reduce(event); store.save(state);
    }
    store.save(state); process.exitCode = ['adopt', 'attach'].includes(command) && terminal(state.status) ? 0 : exitCode(state);
    if (state.status === 'failed') console.error(JSON.stringify(state.error));
  } finally {
    shuttingDown = true;
    await broker.close(); rpc?.close(); await recoveryTask; rpc?.close();
    process.off('SIGINT', onInt); process.off('SIGTERM', onTerm); unlock();
  }
}
export async function waitForTurn(store, options, key) {
  const state = store.read(key); portFor(options, state);
  const completions = new Map();
  const rememberFailure = known => {
    if (known.turnId && known.status === 'failed' && !completions.has(known.turnId)) {
      completions.set(known.turnId, { status: known.status, error: known.error,
        ...(known.lastAgentMessage != null ? { lastAgentMessage: known.lastAgentMessage } : {}) });
    }
  };
  rememberFailure(state);
  const controller = new AbortController();
  const timer = options.timeout ? setTimeout(() => controller.abort(new Error('Wait timed out')), Number(options.timeout) * 1000) : null;
  let rpc;
  try {
    let targetTurnId, failures = 0;
    for (;;) {
      try {
        if (!rpc) {
          rpc = await connection(state.port, controller.signal, { threadId: state.threadId });
          rpc.on('event', event => {
            const eventTurnId = event.params?.turnId ?? event.params?.turn?.id;
            if (!targetTurnId || !eventTurnId || eventTurnId === targetTurnId) {
              applyEvent(state, event);
              if (event.method === 'turn/completed' && event.params.threadId === state.threadId) {
                const { status, error } = event.params.turn;
                completions.set(eventTurnId, { status, error,
                  ...(state.turnId === eventTurnId && state.lastAgentMessage != null ? { lastAgentMessage: state.lastAgentMessage } : {}) });
              }
            }
          });
          await rpc.request('thread/resume', { threadId: state.threadId }, { signal: controller.signal });
        }
        await snapshot(rpc, state, controller.signal, targetTurnId);
        if (!state.turnId) throw new Error('Thread has no current turn');
        targetTurnId ??= state.turnId; failures = 0;
        // History snapshots can lose terminal errors. The observed completion
        // (or attached logger's saved failure) is authoritative for this turn.
        if (terminal(state.status) && !completions.has(state.turnId)) rememberFailure(store.read(key));
        const completion = completions.get(state.turnId);
        if (completion) Object.assign(state, completion);
        if (terminal(state.status)) break;
        await delay(100, undefined, { signal: controller.signal });
      } catch (error) {
        if (controller.signal.aborted || error.rpcError || rpc?.socket.readyState === WebSocket.OPEN) throw error;
        await rpc?.close(); rpc = null; if (++failures > 15) throw error;
        await delay(100, undefined, { signal: controller.signal });
      }
    }
    console.log(JSON.stringify(statusView(store, state))); process.exitCode = exitCode(state);
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    console.log(JSON.stringify({ ...statusView(store, state), timedOut: true })); process.exitCode = 124;
  } finally { clearTimeout(timer); await rpc?.close(); }
}
