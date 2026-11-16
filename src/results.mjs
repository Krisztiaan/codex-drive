import { readFileSync } from 'node:fs';
import { connection } from './client.mjs';
import { failureDetails } from './failures.mjs';
import { findState, findTurn, agentMessage, portFor } from './turns.mjs';

// Result exits: completed 0, failed or interrupted 1, unknown name or turn 2, not finished 3.
const exits = { completed: 0, failed: 1, interrupted: 1 };
const fail = (message, exitCode) => Object.assign(new Error(message), { exitCode });
const view = (state, turn, message, source) => ({ name: state.name ?? null, threadId: state.threadId, turnId: turn?.id ?? null,
  status: !turn ? 'idle' : turn.status === 'inProgress' ? 'running' : turn.status, failure: turn?.status === 'failed' ? failureDetails(turn.error) : null, source, message });

async function fromServer(options, state) {
  const rpc = await connection(portFor(options, state));
  try {
    const turn = await findTurn(rpc, state.threadId, options.turn);
    if (!turn) return options.turn ? null : view(state, null, null, 'server');
    const settled = turn.status !== 'inProgress';
    return view(state, turn, settled ? (await agentMessage(rpc, state.threadId, turn.id))?.text ?? null : null, 'server');
  } finally { await rpc.close(); }
}
// A log-only session: the journal's own turn and agent-message events for this thread.
function fromLog(options, state) {
  const turns = new Map();
  const contents = readFileSync(state.logPath, 'utf8');
  for (const line of contents.slice(0, contents.lastIndexOf('\n') + 1).split('\n').filter(Boolean)) {
    const { method, params } = JSON.parse(line);
    if (params?.threadId !== state.threadId) continue;
    if (method === 'turn/started') turns.set(params.turn.id, { id: params.turn.id, status: 'inProgress', error: null, message: null });
    else if (method === 'turn/completed') turns.set(params.turn.id, { ...turns.get(params.turn.id), id: params.turn.id, status: params.turn.status, error: params.turn.error ?? null });
    else if (method === 'item/completed' && params.item?.type === 'agentMessage' && params.item.text?.trim()) {
      const turn = turns.get(params.turnId) ?? { id: params.turnId, status: 'inProgress', error: null };
      turns.set(params.turnId, { ...turn, message: params.item.text });
    }
  }
  const turn = options.turn ? turns.get(options.turn) : [...turns.values()].at(-1);
  if (!turn) return options.turn ? null : view(state, null, null, 'log');
  return view(state, turn, turn.status === 'inProgress' ? null : turn.message ?? null, 'log');
}
export async function turnResult(store, options, key) {
  const state = findState(store, key);
  if (!state) throw fail(`Unknown thread: ${key}`, 2);
  let result;
  try { result = await fromServer(options, state); }
  catch (error) {
    if (!state.logPath) throw error;
    try { result = fromLog(options, state); } catch (logError) { if (logError.code === 'ENOENT') throw error; throw logError; }
  }
  if (!result) throw fail(`Unknown turn ${options.turn} for ${key}`, 2);
  return { result, exitCode: exits[result.status] ?? 3 };
}
export function resultText(result) {
  const header = [result.name ?? result.threadId, result.status, result.turnId ?? '-', ...(result.failure ? [result.failure.class] : [])].join(' ');
  return result.message == null ? header : `${header}\n${result.message}`;
}
