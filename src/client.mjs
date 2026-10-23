import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Rpc } from './rpc.mjs';
import { RequestBroker } from './requests.mjs';
import { stateHome } from './state.mjs';
import { DEFAULT_PERMISSIONS } from './defaults.mjs';

export function journal(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  return event => appendFileSync(path, JSON.stringify({ receivedAt: new Date().toISOString(), ...event }) + '\n', { mode: 0o600 });
}
export async function connection(port, signal, { log = journal(join(stateHome(), 'calls', randomUUID() + '.jsonl')), policy = DEFAULT_PERMISSIONS.requestPolicy, threadId, initializeParams } = {}) {
  const rpc = new Rpc(port);
  const brokerLog = event => { log(event); if (event.method === 'driver/requestPending') console.error(JSON.stringify(event)); };
  const broker = new RequestBroker({ home: stateHome(), log: brokerLog, policy, threadId });
  await broker.start();
  const closeSocket = rpc.close.bind(rpc);
  rpc.close = () => broker.close().finally(closeSocket);
  rpc.on('event', event => {
    try { log(event); broker.handle(rpc, event); }
    catch (error) { rpc.emit('protocolError', error); closeSocket(); }
  });
  try { await rpc.connect(signal, initializeParams); return rpc; }
  catch (error) { await rpc.close(); throw error; }
}
