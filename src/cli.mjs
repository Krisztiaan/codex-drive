#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from './args.mjs';
import { Store, applyEvent } from './state.mjs';
import { serve } from './server.mjs';
import { methods, methodSchema } from './protocol.mjs';
import { readJson, callParams, textInput, turnParams } from './params.mjs';
import { connection } from './client.mjs';
import { pendingRequests, respond } from './requests.mjs';
import { findState, portFor, snapshot, statusView, runAttached, waitForTurn, warning, effectiveState } from './turns.mjs';

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
  serve [--port 4700] [--stop]
  methods
  call <method> [<params-json>|@file|-] [--param key=<json>]
  start ["<prompt>"] [--cwd <dir>] [--model <m>] [--effort <e>] [--log <file>] [--name <n>] [--detach]
  resume <name|threadId> ["<prompt>"] [--detach]
  adopt|attach <threadId> [--name <n>] [--log <file>] [--detach]
  fork <name|threadId> [--name <new-name>] [--log <file>]
  wait <name|threadId> [--timeout <seconds>]
  status [<name|threadId>]
  events <name|threadId> [--follow]
  tail <name|threadId> [-n 20]
  pending [<name|threadId>]
  respond <requestId> <result-json>|@file|- [--error]
  steer <name|threadId> [--turn <turnId>] "<text>"
  interrupt <name|threadId> [--turn <turnId>]
  list | read <id> | archive <id> | unarchive <id> | rollback <id> | compact <id> | name <id> <name>
  models | account | rate-limits
Server commands accept --port; saved threads use their saved port.
Protocol calls and turn compositions accept --param key=<json>.
Start/resume accept --thread-params <json>|@file|- and --turn-params <json>|@file|-.
--param thread.key=<json> / turn.key=<json> explicitly scopes composed options.
Turn conveniences: --sandbox workspace-write|read-only|danger-full-access, --approval <mode>, --add-dir <dir>.
Defaults: workspace-write, on-request, --request-policy manual (or approve|decline).
--retry-capacity <n> on start/resume opts into same-thread continuation retries.
Wait exits: completed 0, other/error 1, capacity 75, usage limit 76, interrupted 130, timeout 124.`;
async function main() {
  if (process.argv.length === 2 || ['--help', '-h', 'help'].includes(process.argv[2])) { console.log(usage); return; }
  const { command, options, positional } = parseArgs(process.argv.slice(2));
  if (command === 'methods') { print(methods()); return; }
  if (command === 'serve') { print(await serve(Number(options.port ?? 4700), options.stop)); return; }
  const store = new Store();
  if (options.detach) {
    const workerArgs = detachedArgs(process.argv.slice(2));
    const normalized = parseArgs(workerArgs).options;
    const state = command === 'start' ? null : findState(store, positional[0]);
    const prepared = turnParams(command === 'start' ? 'thread/start' : 'thread/resume', normalized, normalized, {}, { threadOnly: ['adopt', 'attach'].includes(command) });
    warning({ ...state, ...normalized, ...prepared.thread, approval: prepared.thread.approvalPolicy ?? normalized.approval ?? state?.approval, sandboxPolicy: prepared.turn.sandboxPolicy ?? state?.sandboxPolicy });
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
  if (command === 'wait') { await waitForTurn(store, options, positional[0]); return; }
  if (command === 'tail' || command === 'events') {
    const state = store.read(positional[0]);
    if (command === 'events') { await events(state, options.follow); return; }
    const contents = readFileSync(state.logPath, 'utf8');
    const lines = contents.slice(0, contents.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(line => readable(JSON.parse(line))).filter(Boolean);
    console.log(lines.slice(-Number(options.n ?? 20)).join('\n')); return;
  }
  if (command === 'status') {
    const states = positional.length ? [store.read(positional[0])] : store.all(), results = [];
    for (const state of states) {
      const rpc = await connection(portFor(options, state), undefined, { threadId: state.threadId });
      rpc.on('event', event => applyEvent(state, event));
      try { await snapshot(rpc, state); results.push(statusView(store, state)); } finally { await rpc.close(); }
    }
    print(positional.length ? results[0] : results); return;
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
    const raw = readJson(options['thread-params']);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Thread parameters must be a JSON object');
    params = callParams(method, options, { threadId: state?.threadId ?? positional[0], ...raw });
    if (options.name && findState(store, options.name)) throw new Error(`Thread name already exists: ${options.name}`);
  }
  const rpc = await connection(port, undefined, { policy: options['request-policy'] ?? 'manual', threadId: state?.threadId, ...(method === 'initialize' ? { initializeParams: params } : {}) });
  try {
    if (method) {
      const result = method === 'initialize' ? rpc.initializeResult : await rpc.request(method, params);
      if (command === 'fork') {
        const thread = result.thread;
        const forked = { ...state, name: options.name ?? null, threadId: thread.id, turnId: null, port, logPath: options.log ?? join(store.home, 'logs', thread.id + '.jsonl'),
          cwd: result.cwd ?? thread.cwd ?? state?.cwd, model: result.model ?? state?.model, effort: result.reasoningEffort ?? state?.effort ?? null,
          sandbox: params.sandbox ?? state?.sandbox ?? 'workspace-write', approval: params.approvalPolicy ?? state?.approval ?? 'on-request', addDirs: state?.addDirs ?? [],
          status: 'idle', lastAgentMessage: null, lastEventTime: null, error: null, failure: null, driverPid: null, sourceThreadId: params.threadId, requestPolicy: options['request-policy'] ?? state?.requestPolicy ?? 'manual' };
        effectiveState(forked, result);
        await snapshot(rpc, forked); store.create(forked); print({ threadId: thread.id, turnId: forked.turnId });
      } else print(result);
      return;
    }
    if (!state) throw new Error('Unknown thread; adopt it first');
    await rpc.request('thread/resume', { threadId: state.threadId }); await snapshot(rpc, state);
    if (state.status !== 'running') throw new Error(`No turn is running (${state.status})`);
    const turnId = options.turn ?? state.turnId;
    if (command === 'steer') print(await rpc.request('turn/steer', callParams('turn/steer', options, { threadId: state.threadId, expectedTurnId: turnId, input: textInput(positional[1]) })));
    else print(await rpc.request('turn/interrupt', callParams('turn/interrupt', options, { threadId: state.threadId, turnId })));
  } finally { await rpc.close(); }
}
main().catch(error => {
  if (detachedWorker && process.connected) process.send({ error: error.message }, () => process.disconnect());
  console.error(error.rpcError ? JSON.stringify(error.rpcError) : `codex-drive: ${error.message}`); process.exitCode = error.exitCode ?? 1;
});
