#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setMaxListeners } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from './args.mjs';
import { Store, applyEvent } from './state.mjs';
import { serve, warnServerDirectory } from './server.mjs';
import { methods, methodSchema, validateCall } from './protocol.mjs';
import { readJson, callParams, textInput, turnParams } from './params.mjs';
import { connection } from './client.mjs';
import { accountHealth, usageText } from './account.mjs';
import { filterStates, table, recordSteer, pruneCandidates, removeSession } from './views.mjs';
import { DEFAULT_PERMISSIONS } from './defaults.mjs';
import { pendingRequests, respond } from './requests.mjs';
import { findState, portFor, snapshot, statusView, runAttached, waitForTurn, warning, effectiveState, attachedDefaults } from './turns.mjs';

const detachedWorker = typeof process.send === 'function';
const print = value => console.log(JSON.stringify(value));
const aliases = { list: 'thread/list', read: 'thread/read', archive: 'thread/archive', unarchive: 'thread/unarchive', rollback: 'thread/revert', compact: 'thread/compact/start', name: 'thread/name/set', models: 'model/list', account: 'account/read', 'rate-limits': 'account/rateLimits/read' };
function readable(event) {
  const p = event.params ?? {}, item = p.item;
  if (event.method === 'item/completed' && item?.type === 'agentMessage') return item.text;
  if (event.method === 'item/started' && item?.type === 'commandExecution') return `$ ${item.command}`;
  if (event.method === 'item/completed' && item?.type === 'commandExecution') return `exit ${item.exitCode}: ${item.aggregatedOutput ?? ''}`.trim();
  if (event.method === 'turn/completed') return `turn ${p.turn.id}: ${p.turn.status}${p.turn.error ? ' ' + JSON.stringify(p.turn.error) : ''}`;
  if (event.method === 'error' || event.method === 'warning' || event.method?.startsWith('driver/')) return `${event.method}: ${JSON.stringify(p)}`;
  return null;
}
async function events(state, follow) {
  let offset = 0, carry = '';
  do {
    const contents = existsSync(state.logPath) ? readFileSync(state.logPath, 'utf8') : '';
    if (contents.length < offset) throw new Error('Event log was truncated while following');
    carry += contents.slice(offset); offset = contents.length;
    const boundary = carry.lastIndexOf('\n');
    if (boundary >= 0) {
      for (const line of carry.slice(0, boundary).split('\n').filter(Boolean)) {
        const event = JSON.parse(line);
        if (event.method && !event.method.startsWith('driver/')) print(event);
      }
      carry = carry.slice(boundary + 1);
    }
    if (follow) await delay(100);
  } while (follow);
}
function detachedArgs(argv) {
  let literal = false;
  const args = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') literal = true;
    if (!literal && arg === '--detach') continue;
    args.push(arg);
    if (!literal && ['--thread-params', '--turn-params'].includes(arg)) args.push(JSON.stringify(readJson(argv[++i])));
    else if (!literal && arg === '--param') {
      const value = argv[++i], split = value.indexOf('=');
      args.push(value.slice(0, split + 1) + JSON.stringify(readJson(value.slice(split + 1))));
    }
  }
  return args;
}
async function detach(args) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...args], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const ids = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.on('message', message => { if (message.ids) resolve(message.ids); else if (message.error) reject(new Error(message.error)); });
    child.once('exit', (code, signal) => reject(new Error(`Detached logger exited before starting (code ${code}, signal ${signal})`)));
  });
  child.unref(); print(ids);
}
const usage = `Usage: codex-drive <command>
  serve [--port 4700] [--stop | --restart] [--force] [--timeout seconds]
  methods
  call <method> [<params-json>|@file|-] [--param key=<json>]
  start ["<prompt>"] [--cwd <dir>] [--model <m>] [--effort <e>] [--log <file>] [--name <n>] [--detach]
  resume <name|threadId> ["<prompt>"] [--detach]
  adopt|attach <threadId> [--name <n>] [--log <file>] [--detach]
  fork <name|threadId> [--name <new-name>] [--log <file>]
  wait <name|threadId> [...] [--all | --any] [--timeout <seconds>]
  status [<name|threadId>] [--json] [--active] [--cwd prefix] [--since 24h] [--name glob]
  prune [--older-than 30d] [--apply]
  events <name|threadId> [--follow]
  tail <name|threadId> [-n 20]
  pending [<name|threadId>]
  respond <requestId> <result-json>|@file|- [--error]
  steer <name|threadId> [--turn <turnId>] "<text>"
  interrupt <name|threadId> [--turn <turnId>]
  list | read <id> | archive <id> | unarchive <id> | rollback <id> | compact <id> | name <id> <name>
  models | account [--json] | rate-limits [--json]
Server commands accept --port; saved threads use their saved port.
Protocol calls and turn compositions accept --param key=<json>.
Start/resume accept --thread-params <json>|@file|- and --turn-params <json>|@file|-.
--param thread.key=<json> / turn.key=<json> explicitly scopes composed options.
Start/resume/adopt/attach/fork: --sandbox workspace-write|read-only|danger-full-access, --approval <mode>.
Start/resume: --add-dir <dir> (requires --sandbox workspace-write).
Defaults: --sandbox ${DEFAULT_PERMISSIONS.sandbox}, --approval ${DEFAULT_PERMISSIONS.approval}, --request-policy ${DEFAULT_PERMISSIONS.requestPolicy}.
Use --request-policy manual|decline for stricter request handling; resume respects saved thread settings.
--retry-capacity <n> on start/resume opts into same-thread continuation retries.
Multi-wait defaults to --all; --any closes observers without interrupting turns.
Combined exit: 76 if any usage limit, otherwise largest observed exit code.
Prune defaults to dry-run; --apply removes confirmed old terminal local sessions.
Wait exits: completed 0, other/error 1, capacity 75, usage limit 76, interrupted 130, timeout 124.`;
async function main() {
  if (process.argv.length === 2 || ['--help', '-h', 'help'].includes(process.argv[2])) { console.log(usage); return; }
  const { command, options, positional } = parseArgs(process.argv.slice(2));
  if (command === 'methods') { print(methods()); return; }
  if (command === 'serve') { print(await serve(Number(options.port ?? 4700), options.stop, options)); return; }
  const store = new Store();
  if (options.detach) {
    const workerArgs = detachedArgs(process.argv.slice(2));
    const normalized = parseArgs(workerArgs).options;
    const state = command === 'start' ? null : findState(store, positional[0]);
    const base = attachedDefaults(normalized, state, undefined, command);
    const prepared = turnParams(command === 'start' ? 'thread/start' : 'thread/resume', normalized, base.thread, base.turn, { threadOnly: ['adopt', 'attach'].includes(command) });
    warning({ ...state, ...prepared.thread, approval: prepared.thread.approvalPolicy ?? state?.approval, sandboxPolicy: prepared.turn.sandboxPolicy ?? state?.sandboxPolicy });
    if (['start', 'resume'].includes(command)) { const rpc = await connection(portFor(normalized, state)); try { await accountHealth(rpc, { warnUsage: true }); } finally { await rpc.close(); } }
    await detach(workerArgs); return;
  }
  if (['start', 'resume', 'adopt', 'attach'].includes(command)) {
    if (detachedWorker) {
      const state = command === 'start' ? null : findState(store, positional[0]);
      const logPath = options.log ?? state?.logPath ?? join(store.home, 'logs', `detached-${process.pid}.jsonl`);
      options.log = logPath; mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
      console.error = (...parts) => appendFileSync(logPath, JSON.stringify({ receivedAt: new Date().toISOString(), method: 'driver/diagnostic', params: { message: parts.join(' ') } }) + '\n', { mode: 0o600 });
    }
    const key = command === 'start' ? options.name ?? `pending-${process.pid}` : positional[0];
    await runAttached(store, command, options, key, command === 'start' ? positional[0] : positional[1], detachedWorker ? ids => process.send({ ids }, () => process.disconnect()) : null); return;
  }
  if (command === 'pending') { print(pendingRequests(store.home, positional[0] ? findState(store, positional[0])?.threadId ?? positional[0] : undefined)); return; }
  if (command === 'respond') { const payload = readJson(positional[1]); print(await respond(store.home, positional[0], options.error ? undefined : payload, { error: options.error ? payload : undefined })); return; }
  if (command === 'wait') {
    if (positional.length === 1) { process.exitCode = await waitForTurn(store, options, positional[0]); return; }
    // Validate every identity before opening concurrent observers.
    for (const key of positional) portFor(options, store.read(key));
    const cancel = new AbortController(), codes = [];
    setMaxListeners(0, cancel.signal);
    let winner = false;
    const tasks = [...new Set(positional)].map(async key => {
      let reported = false;
      const report = value => {
        if (options.any && winner) return;
        reported = true; print(value);
        if (options.any) { winner = true; cancel.abort(new Error('Another goal settled')); }
      };
      try {
        const code = await waitForTurn(store, options, key, report, cancel.signal);
        if (code != null && reported) codes.push(code);
      } catch (error) { if (!cancel.signal.aborted) { report({ name: key, error: error.message }); codes.push(1); } }
    });
    await Promise.all(tasks);
    process.exitCode = codes.includes(76) ? 76 : Math.max(0, ...codes); return;
  }
  if (command === 'prune') {
    const removed = [];
    for (const state of pruneCandidates(store, options['older-than'])) {
      if (options.apply) {
        const unlock = store.lock(state.name ?? state.threadId);
        try {
          const saved = store.read(state.threadId);
          if (saved.turnId !== state.turnId || saved.lastEventTime !== state.lastEventTime || !['completed', 'failed', 'interrupted', 'idle'].includes(saved.status)) continue;
          const rpc = await connection(portFor(options, saved));
          try { await snapshot(rpc, saved); if (saved.status === 'running' || saved.turnId !== state.turnId) continue; removeSession(store, saved); }
          finally { await rpc.close(); }
        } finally { unlock(); }
      }
      removed.push({ name: state.name, threadId: state.threadId, logPath: state.logPath });
    }
    print({ dryRun: !options.apply, sessions: removed }); return;
  }
  if (command === 'tail' || command === 'events') {
    const state = store.read(positional[0]);
    if (command === 'events') { await events(state, options.follow); return; }
    const contents = readFileSync(state.logPath, 'utf8');
    const lines = contents.slice(0, contents.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(line => readable(JSON.parse(line))).filter(Boolean);
    console.log(lines.slice(-Number(options.n ?? 20)).join('\n')); return;
  }
  if (command === 'status') {
    const states = positional.length ? [store.read(positional[0])] : filterStates(store.all(), { ...options, active: false }), results = [], inspected = new Set(), usageByPort = new Map();
    if (!states.length) warnServerDirectory(Number(options.port ?? 4700));
    for (const state of states) {
      const port = portFor(options, state);
      if (!inspected.has(port)) { warnServerDirectory(port); inspected.add(port); }
      let rpc;
      try {
        rpc = await connection(port, undefined, { threadId: state.threadId, policy: state.requestPolicy ?? DEFAULT_PERMISSIONS.requestPolicy });
        rpc.on('event', event => applyEvent(state, event));
        await snapshot(rpc, state);
        if (!usageByPort.has(port)) { try { usageByPort.set(port, await rpc.request('account/rateLimits/read', {})); } catch { usageByPort.set(port, null); } }
        const usage = usageByPort.get(port);
        if (usage?.rateLimits) state.rateLimits = usage.rateLimits;
        if (usage?.rateLimitsByLimitId) state.rateLimitsByLimitId = usage.rateLimitsByLimitId;
        results.push(statusView(store, state));
      } catch (error) {
        if (positional.length) throw error;
        results.push({ ...statusView(store, state), refreshError: error.message });
      } finally { await rpc?.close(); }
    }
    if (positional.length) print(results[0]);
    else { const filtered = filterStates(results, options); if (options.json) print(filtered); else console.log(table(filtered)); } return;
  }
  const state = command !== 'call' && positional[0] ? findState(store, positional[0]) : null;
  if (['steer', 'interrupt'].includes(command) && !state) throw new Error('Unknown thread; adopt it first');
  const port = portFor(options, state);
  let method, params;
  if (command === 'call') {
    method = positional[0];
    const schema = methodSchema(method);
    params = callParams(method, options, readJson(positional[1], schema.type === 'null' ? null : {}));
  } else if (aliases[command]) {
    method = aliases[command];
    params = callParams(method, options, positional.length ? { threadId: state?.threadId ?? positional[0], ...(command === 'name' ? { name: positional[1] } : {}) } : {});
  } else if (command === 'fork') {
    method = 'thread/fork';
    const threadDefaults = { threadId: state?.threadId ?? positional[0] };
    if (options.sandbox || !state) threadDefaults.sandbox = options.sandbox ?? DEFAULT_PERMISSIONS.sandbox;
    if (options.approval || !state) threadDefaults.approvalPolicy = options.approval ?? DEFAULT_PERMISSIONS.approval;
    params = turnParams(method, options, threadDefaults, {}, { threadOnly: true }).thread;
    validateCall(method, params);
    if (options.name && findState(store, options.name)) throw new Error(`Thread name already exists: ${options.name}`);
  }
  const rpc = await connection(port, undefined, { policy: options['request-policy'] ?? state?.requestPolicy ?? DEFAULT_PERMISSIONS.requestPolicy, threadId: state?.threadId, ...(method === 'initialize' ? { initializeParams: params } : {}) });
  try {
    if (method) {
      const result = method === 'initialize' ? rpc.initializeResult : await rpc.request(method, params);
      if (command === 'fork') {
        const thread = result.thread;
        const forked = { ...state, name: options.name ?? null, threadId: thread.id, turnId: null, port, logPath: options.log ?? join(store.home, 'logs', thread.id + '.jsonl'),
          cwd: result.cwd ?? thread.cwd ?? state?.cwd, model: result.model ?? state?.model, effort: result.reasoningEffort ?? state?.effort ?? null,
          sandbox: params.sandbox ?? state?.sandbox ?? DEFAULT_PERMISSIONS.sandbox, approval: params.approvalPolicy ?? state?.approval ?? DEFAULT_PERMISSIONS.approval, addDirs: state?.addDirs ?? [],
          status: 'idle', lastAgentMessage: null, lastEventTime: null, error: null, failure: null, driverPid: null, sourceThreadId: params.threadId, requestPolicy: options['request-policy'] ?? state?.requestPolicy ?? DEFAULT_PERMISSIONS.requestPolicy };
        effectiveState(forked, result);
        await snapshot(rpc, forked); store.create(forked); print({ threadId: thread.id, turnId: forked.turnId });
      } else if (['account', 'rate-limits'].includes(command) && !options.json) {
        const health = await accountHealth(rpc);
        console.log(usageText(command === 'account' ? result : health.account, command === 'rate-limits' ? result : health.usage));
      } else print(result);
      return;
    }
    if (!state) throw new Error('Unknown thread; adopt it first');
    await rpc.request('thread/resume', { threadId: state.threadId, excludeTurns: true }); await snapshot(rpc, state);
    if (state.status !== 'running') throw new Error(`No turn is running (${state.status})`);
    const turnId = options.turn ?? state.turnId;
    if (command === 'steer') {
      const params = callParams('turn/steer', options, { threadId: state.threadId, expectedTurnId: turnId, input: textInput(positional[1]) });
      const result = await rpc.request('turn/steer', params);
      try { recordSteer(store, state, params.input.filter(item => item.type === 'text').map(item => item.text).join('\n'), params.expectedTurnId); }
      catch (error) { throw new Error(`Steer accepted, but bookkeeping failed: ${error.message}. Do not resend the steer.`); }
      print(result);
    }
    else print(await rpc.request('turn/interrupt', callParams('turn/interrupt', options, { threadId: state.threadId, turnId })));
  } finally { await rpc.close(); }
}
main().catch(error => {
  if (detachedWorker && process.connected) process.send({ error: error.message }, () => process.disconnect());
  console.error(error.rpcError ? JSON.stringify(error.rpcError) : `codex-drive: ${error.message}`); process.exitCode = error.exitCode ?? 1;
});
