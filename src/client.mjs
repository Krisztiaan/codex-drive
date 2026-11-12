import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Rpc } from './rpc.mjs';
import { RequestBroker } from './requests.mjs';
import { stateHome } from './state.mjs';
import { DEFAULT_PERMISSIONS } from './defaults.mjs';

// Pure observers use completed items, never streaming text fragments or diffs.
export const WAIT_NOTIFICATION_OPT_OUTS = Object.freeze([
  'item/agentMessage/delta', 'item/commandExecution/outputDelta',
  'item/fileChange/outputDelta', 'item/plan/delta',
  'item/reasoning/summaryTextDelta', 'item/reasoning/textDelta',
  'turn/diff/updated',
]);

export function lifecycleEvent(event) {
  return event.method?.startsWith('driver/') ||
    ['turn/started', 'turn/completed', 'error', 'warning', 'account/rateLimits/updated', 'thread/status/changed'].includes(event.method) ||
    event.method === 'item/completed' && event.params?.item?.type === 'agentMessage';
}
export function journal(path, { buffered = false, onError } = {}) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let lines = '', timer;
  const flush = () => {
    clearTimeout(timer); timer = null;
    if (lines) { appendFileSync(path, lines, { mode: 0o600 }); lines = ''; }
  };
  const log = event => {
    lines += JSON.stringify({ receivedAt: new Date().toISOString(), ...event }) + '\n';
    if (!buffered || lifecycleEvent(event)) flush();
    else timer ??= setTimeout(() => { try { flush(); } catch (error) { if (onError) onError(error); else throw error; } }, 1000).unref();
  };
  log.flush = flush;
  return log;
}
// Callers needing durable events supply a logger. Pending requests have their own
// broker records; ordinary connections do not need a second raw event journal.
export async function connection(port, signal, { log = () => {}, policy = DEFAULT_PERMISSIONS.requestPolicy, threadId, initializeParams, observer = false } = {}) {
  const rpc = new Rpc(port);
  const brokerLog = event => { log(event); if (event.method === 'driver/requestPending') console.error(JSON.stringify(event)); };
  const broker = new RequestBroker({ home: stateHome(), log: brokerLog, policy, threadId });
  await broker.start();
  const closeSocket = rpc.close.bind(rpc);
  rpc.close = () => broker.close().finally(closeSocket);
  rpc.on('event', event => {
    try { if (!observer || lifecycleEvent(event) || event.id !== undefined) log(event); broker.handle(rpc, event); }
    catch (error) { rpc.emit('protocolError', error); closeSocket(); }
  });
  if (observer && !initializeParams) initializeParams = {
    clientInfo: { name: 'codex-drive', title: 'codex-drive', version: '0.1.0' },
    capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: WAIT_NOTIFICATION_OPT_OUTS },
  };
  try { await rpc.connect(signal, initializeParams); return rpc; }
  catch (error) { await rpc.close(); throw error; }
}
