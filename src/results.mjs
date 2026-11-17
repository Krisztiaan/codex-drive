import { readFileSync } from 'node:fs';
import { connection } from './client.mjs';
import { failureDetails } from './failures.mjs';
import { findState, findTurn, agentMessage, portFor, recordQuietly } from './turns.mjs';

// Result exits: completed 0, failed or interrupted 1, unknown name or turn 2, not finished 3.
const exits = { completed: 0, failed: 1, interrupted: 1 };
const fail = (message, exitCode) => Object.assign(new Error(message), { exitCode });
const statusOf = turn => !turn ? 'idle' : turn.status === 'inProgress' ? 'running' : turn.status;
const view = (state, turn, message, source) => ({ name: state.name ?? null, threadId: state.threadId, turnId: turn?.id ?? null,
  status: statusOf(turn), failure: turn?.status === 'failed' ? failureDetails(turn.error) : null, source, message });
// History snapshots can lose a terminal error; the saved failure of the same turn wins, as in wait.
const reconcile = (state, turn) => turn && turn.id === state.turnId && state.status === 'failed' && ['failed', 'interrupted'].includes(turn.status) ? { ...turn, status: 'failed', error: state.error ?? turn.error } : turn;

// The app-server's errors for a thread it does not know; every other RPC error is reported as is.
const missingThread = error => /^(thread not found|no rollout found for thread id)\b/i.test(error.rpcError?.message ?? '');
// Unavailable means no server or a server without this thread.
async function fromServer(options, state, port) {
  let rpc;
  try { rpc = await connection(port); } catch (error) { return { unavailable: error }; }
  try {
    let turn;
    try { turn = reconcile(state, await findTurn(rpc, state.threadId, options.turn)); } // The latest turn, or --turn.
    catch (error) { if (missingThread(error)) return { unavailable: error }; throw error; }
    if (!turn) return { result: options.turn ? null : view(state, null, null, 'server') };
    const message = turn.status === 'inProgress' ? null : (await agentMessage(rpc, state.threadId, turn.id))?.text ?? null;
    return { result: view(state, turn, message, 'server'), turn, finishedAt: turn.completedAt ? turn.completedAt * 1000 : undefined };
  } finally { await rpc.close(); }
}
// A log-only session: the journal's own turn, agent-message and recovery records for this thread.
// A recovery record carries what the reconnect snapshot found: status, error, full message and completion time.
function fromLog(options, state) {
  const turns = new Map(), update = (id, values) => turns.set(id, { id, status: 'inProgress', error: null, message: null, ...turns.get(id), ...values });
  const contents = readFileSync(state.logPath, 'utf8');
  for (const line of contents.slice(0, contents.lastIndexOf('\n') + 1).split('\n').filter(Boolean)) {
    const { method, params, receivedAt } = JSON.parse(line);
    if (params?.threadId !== state.threadId) continue;
    const at = completedAt => completedAt ? completedAt * 1000 : Date.parse(receivedAt) || undefined;
    if (method === 'turn/started') update(params.turn.id, {});
    else if (method === 'turn/completed') update(params.turn.id, { status: params.turn.status, error: params.turn.error ?? null, finishedAt: at(params.turn.completedAt) });
    else if (method === 'item/completed' && params.item?.type === 'agentMessage' && params.item.text?.trim()) update(params.turnId, { message: params.item.text });
    else if (['driver/reconnected', 'driver/startRecovered'].includes(method) && params.turnId) {
      // A recovery snapshot names the turn even when its start event was missed; a running one stays in progress.
      if (params.status === 'running') update(params.turnId, {});
      else update(params.turnId, { status: params.status, error: params.error ?? null, finishedAt: at(params.completedAt), ...(params.message ? { message: params.message } : {}) });
    }
  }
  const all = [...turns.values()];
  const turn = reconcile(state, options.turn ? turns.get(options.turn) : all.at(-1));
  if (!turn) return { result: options.turn ? null : view(state, null, null, 'log') };
  return { result: view(state, turn, turn.status === 'inProgress' ? null : turn.message ?? null, 'log'), turn, finishedAt: turn.finishedAt };
}
export async function turnResult(store, options, key) {
  const state = findState(store, key);
  if (!state) throw fail(`Unknown thread: ${key}`, 2);
  const port = portFor(options, state);
  let found = await fromServer(options, state, port);
  if (found.unavailable) {
    if (!state.logPath) throw found.unavailable;
    try { found = fromLog(options, state); }
    catch (error) { if (error.code === 'ENOENT') throw found.unavailable; throw error; }
  }
  const { result, turn, finishedAt } = found;
  if (!result) throw fail(`Unknown turn ${options.turn} for ${key}`, 2);
  if (turn && result.status in exits) recordQuietly(store.home, { ...state, turnId: turn.id, status: result.status, error: turn.error }, { finishedAt });
  return { result, exitCode: exits[result.status] ?? 3 };
}
export function resultText(result) {
  const header = [result.name ?? result.threadId, result.status, result.turnId ?? '-', ...(result.failure ? [result.failure.class] : [])].join(' ');
  return result.message == null ? header : `${header}\n${result.message}`;
}
