#!/usr/bin/env node
import { appendFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from './args.mjs';
import { Store, applyEvent } from './state.mjs';
import { Rpc } from './rpc.mjs';
import { serve } from './server.mjs';

const print = value => console.log(JSON.stringify(value));
const input = text => [{ type: 'text', text, text_elements: [] }];
const terminal = status => ['completed', 'failed', 'interrupted'].includes(status);
function warning(state) {
  if (state.sandbox === 'danger-full-access') console.error(`WARNING: danger-full-access; approval=${state.approval}. Codex can modify files and run commands without sandbox protection.`);
}
function handleRequest(rpc, event) {
  console.error(`Server request ${event.method}: declined/unsupported by noninteractive driver.`);
  let result;
  switch (event.method) {
    case 'item/commandExecution/requestApproval': case 'item/fileChange/requestApproval': result = { decision: 'decline' }; break;
    case 'execCommandApproval': case 'applyPatchApproval': result = { decision: 'abort' }; break;
    case 'item/permissions/requestApproval': result = { permissions: {}, scope: 'turn' }; break;
    case 'item/tool/requestUserInput': result = { answers: {} }; break;
    case 'mcpServer/elicitation/request': result = { action: 'decline', content: null, _meta: null }; break;
    default: rpc.send({ id: event.id, error: { code: -32601, message: `Unsupported client request: ${event.method}` } }); return;
  }
  rpc.send({ id: event.id, result });
}
async function connection(port) {
  const rpc = new Rpc(port);
  rpc.on('event', event => {
    if (event.id !== undefined && event.method) handleRequest(rpc, event);
  });
  try { await rpc.connect(); return rpc; }
  catch (e) { rpc.close(); throw e; }
}
async function snapshot(rpc, state) {
  const { data } = await rpc.request('thread/turns/list', { threadId: state.threadId, limit: 1, sortDirection: 'desc', itemsView: 'full' });
  const turn = data[0];
  if (!turn) return;
  state.turnId = turn.id;
  state.status = turn.status === 'inProgress' ? 'running' : turn.status;
  state.error = turn.error;
  const message = turn.items.filter(item => item.type === 'agentMessage' && item.text.trim()).at(-1);
  if (message) state.lastAgentMessage = message.text.trim().split('\n').filter(Boolean).at(-1) ?? '';
}
async function runAttached(store, options, key, prompt, resume) {
  let state = resume ? store.read(key) : null;
  let unlock = !resume && !options.name ? () => {} : store.lock(key);
  let rpc, shuttingDown = false, reconnecting = false, ready = false;
  let recoveryTask = Promise.resolve();
  const buffered = [];
  let resolveDone, rejectDone;
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  // Setup failures may precede the await below.
  done.catch(() => {});
  const logPath = state?.logPath ?? options.log;
  const log = event => appendFileSync(logPath, JSON.stringify({ receivedAt: new Date().toISOString(), ...event }) + '\n', { mode: 0o600 });
  function reduce(event) {
    if (!ready) { buffered.push(event); return; }
    if (applyEvent(state, event)) store.save(state);
    if (terminal(state.status)) resolveDone();
  }
  function wire(client) {
    client.on('event', event => {
      try { log(event); reduce(event); if (event.id !== undefined && event.method) handleRequest(client, event); }
      catch (e) { rejectDone(e); }
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
            await delay(500);
            if (shuttingDown) return;
            next = new Rpc(state.port); rpc = next; wire(next); await next.connect();
            await next.request('thread/resume', { threadId: state.threadId });
            await snapshot(next, state);
            if (shuttingDown) return;
            if (next.socket.readyState !== WebSocket.OPEN) throw new Error('Recovery socket closed');
            log({ method: 'driver/reconnected', params: { threadId: state.threadId, turnId: state.turnId, status: state.status } });
            store.save(state); reconnecting = false;
            if (terminal(state.status)) resolveDone();
            return;
          } catch (e) { next?.close(); last = e; }
        }
        reconnecting = false;
        if (shuttingDown) return;
        rejectDone(new Error(`Reconnect failed; turn may still be running: ${last?.message}`));
      })().catch(rejectDone);
    });
  }
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    if (!resume && options.name && existsSync(store.path(key))) throw new Error(`Thread name already exists: ${key}`);
    if (resume) warning(state); else warning(options);
    rpc = new Rpc(state?.port ?? Number(options.port ?? 4700)); wire(rpc); await rpc.connect();
    if (resume) {
      await rpc.request('thread/resume', { threadId: state.threadId });
      await snapshot(rpc, state);
      if (!terminal(state.status)) throw new Error(`Thread has a running turn (${state.turnId}); use steer`);
    } else {
      // Shapes are generated in protocol/v2/ThreadStartParams.ts and TurnStartParams.ts.
      const result = await rpc.request('thread/start', {
        cwd: options.cwd, model: options.model, sandbox: options.sandbox, approvalPolicy: options.approval, approvalsReviewer: 'user',
      });
      state = { name: options.name ?? null, threadId: result.thread.id, turnId: null, cwd: options.cwd, model: result.model,
        effort: options.effort, sandbox: options.sandbox, approval: options.approval, addDirs: options['add-dir'] ?? [],
        logPath, port: Number(options.port ?? 4700), status: 'starting', lastEventTime: null, lastAgentMessage: '' };
      if (!options.name) {
        const canonicalUnlock = store.lock(state.threadId);
        unlock(); unlock = canonicalUnlock;
      }
      store.create(state);
    }
    const params = { threadId: state.threadId, input: input(prompt), effort: state.effort };
    if (state.addDirs.length) params.sandboxPolicy = { type: 'workspaceWrite', writableRoots: [state.cwd, ...state.addDirs], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
    const priorTurnId = state.turnId;
    let turn;
    try { ({ turn } = await rpc.request('turn/start', params)); }
    catch (error) {
      // A lost reply does not authorize replaying the input. Recover the known thread instead.
      log({ method: 'driver/startUncertain', params: { threadId: state.threadId, error: error.message } });
      rpc.close();
      let recovered = false;
      for (let attempt = 0; attempt < 15; attempt++) {
        try {
          await delay(500);
          rpc = new Rpc(state.port); wire(rpc); await rpc.connect();
          await rpc.request('thread/resume', { threadId: state.threadId });
          await snapshot(rpc, state);
          if (state.turnId && state.turnId !== priorTurnId) {
            turn = { id: state.turnId, status: state.status === 'running' ? 'inProgress' : state.status, error: state.error };
            recovered = true;
            log({ method: 'driver/startRecovered', params: { threadId: state.threadId, turnId: state.turnId, status: state.status } });
          }
          break;
        } catch { rpc.close(); }
      }
      if (!recovered) throw new Error(`turn/start outcome unconfirmed; input was not replayed. Inspect status before retrying: ${error.message}`);
    }
    state.turnId = turn.id; state.status = turn.status === 'inProgress' ? 'running' : turn.status; state.error = turn.error;
    ready = true;
    for (const event of buffered.splice(0)) reduce(event);
    store.save(state);
    print({ threadId: state.threadId, turnId: state.turnId });
    if (terminal(state.status)) resolveDone();
    // If the socket closed in the small interval before ready, trigger recovery now.
    if (rpc.socket.readyState !== WebSocket.OPEN) rpc.emit('disconnect');
    await done;
    if (state.status === 'failed') throw new Error(`Turn failed: ${JSON.stringify(state.error)}`);
    if (state.status === 'interrupted') process.exitCode = 130;
  } finally { shuttingDown = true; rpc?.close(); await recoveryTask; rpc?.close(); unlock(); }
}
function readable(event) {
  const p = event.params ?? {}, item = p.item;
  if (event.method === 'item/completed' && item?.type === 'agentMessage') return item.text;
  if (event.method === 'item/started' && item?.type === 'commandExecution') return `$ ${item.command}`;
  if (event.method === 'item/completed' && item?.type === 'commandExecution') return `exit ${item.exitCode}: ${item.aggregatedOutput ?? ''}`.trim();
  if (event.method === 'turn/completed') return `turn ${p.turn.id}: ${p.turn.status}${p.turn.error ? ' ' + JSON.stringify(p.turn.error) : ''}`;
  if (event.method === 'error' || event.method === 'warning' || event.method?.startsWith('driver/')) return `${event.method}: ${JSON.stringify(p)}`;
  return null;
}
async function main() {
  const { command, options, positional } = parseArgs(process.argv.slice(2));
  if (command === 'serve') { print(await serve(Number(options.port ?? 4700), options.stop)); return; }
  const store = new Store();
  if (command === 'start') { await runAttached(store, options, options.name ?? `pending-${process.pid}`, positional[0], false); return; }
  if (command === 'resume') { const state = store.read(positional[0]); if (options.port && +options.port !== state.port) throw new Error('Port differs from thread server'); await runAttached(store, options, state.name ?? state.threadId, positional[1], true); return; }
  if (command === 'tail') {
    const state = store.read(positional[0]);
    const lines = readFileSync(state.logPath, 'utf8').trim().split('\n').filter(Boolean).map(line => readable(JSON.parse(line))).filter(Boolean);
    console.log(lines.slice(-Number(options.n ?? 20)).join('\n')); return;
  }
  const states = positional.length ? [store.read(positional[0])] : store.all();
  if (!states.length) { print([]); return; }
  const port = Number(options.port ?? states[0].port);
  const rpc = await connection(port);
  try {
    if (command === 'status') {
      const results = [];
      for (const state of states) {
        if (state.port !== port) {
          const other = await connection(state.port); try { await snapshot(other, state); } finally { other.close(); }
        } else await snapshot(rpc, state);
        // Read-only commands must not overwrite an attached driver's newer event state.
        results.push(state);
      }
      print(positional.length ? results[0] : results); return;
    }
    const state = states[0];
    if (options.port && +options.port !== state.port) throw new Error('Port differs from thread server');
    await rpc.request('thread/resume', { threadId: state.threadId });
    await snapshot(rpc, state);
    if (state.status !== 'running') throw new Error(`No turn is running (${state.status})`);
    const turnId = options.turn ?? state.turnId;
    if (command === 'steer') print(await rpc.request('turn/steer', { threadId: state.threadId, expectedTurnId: turnId, input: input(positional[1]) }));
    else print(await rpc.request('turn/interrupt', { threadId: state.threadId, turnId }));
  } finally { rpc.close(); }
}
main().catch(error => { console.error(`codex-drive: ${error.message}`); process.exitCode = 1; });
