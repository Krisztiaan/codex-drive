import { EventEmitter } from 'node:events';
import { validateCall } from './protocol.mjs';

export class Rpc extends EventEmitter {
  constructor(port) { super(); this.port = port; this.nextId = 1; this.pending = new Map(); }
  async connect(signal, initializeParams) {
    signal?.throwIfAborted();
    const socket = new WebSocket(`ws://127.0.0.1:${this.port}`);
    this.socket = socket;
    await new Promise((resolve, reject) => {
      const onAbort = () => { clearTimeout(timer); socket.close(); reject(signal.reason); };
      signal?.addEventListener('abort', onAbort, { once: true });
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
      const timer = setTimeout(() => { cleanup(); socket.close(); reject(new Error('Connection timeout')); }, 5000);
      socket.addEventListener('open', () => { cleanup(); resolve(); }, { once: true });
      socket.addEventListener('error', () => { cleanup(); reject(new Error(`Cannot connect to 127.0.0.1:${this.port}; run serve`)); }, { once: true });
    });
    socket.addEventListener('message', event => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { this.emit('protocolError', new Error('Invalid server JSON')); return; }
      if (message.id !== undefined && !message.method) {
        const p = this.pending.get(message.id);
        if (p) { p.cleanup(); this.pending.delete(message.id); message.error ? p.reject(Object.assign(new Error(JSON.stringify(message.error)), { rpcError: message.error })) : p.resolve(message.result); }
      } else this.emit('event', message);
    });
    socket.addEventListener('close', () => {
      for (const p of this.pending.values()) { p.cleanup(); p.reject(new Error('Connection dropped; request outcome may be unknown')); }
      this.pending.clear();
      this.emit('disconnect');
    });
    // Generated InitializeParams + ClientNotification; no JSON-RPC version field required.
    this.initializeResult = await this.request('initialize', initializeParams ?? { clientInfo: { name: 'codex-drive', title: 'codex-drive', version: '0.1.0' }, capabilities: { experimentalApi: true, requestAttestation: false } }, { signal });
    this.send({ method: 'initialized' });
  }
  send(message) { if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('Connection is closed'); this.socket.send(JSON.stringify(message)); }
  request(method, params, { signal } = {}) {
    signal?.throwIfAborted();
    validateCall(method, params);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const onAbort = () => { clearTimeout(timer); this.pending.delete(id); reject(signal.reason); };
      signal?.addEventListener('abort', onAbort, { once: true });
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
      const timer = setTimeout(() => { cleanup(); this.pending.delete(id); reject(new Error(`${method} timed out; outcome may be unknown (not retried)`)); }, 30000);
      this.pending.set(id, { resolve, reject, timer, cleanup });
      try { this.send({ id, method, params }); } catch (e) { cleanup(); this.pending.delete(id); reject(e); }
    });
  }
  close() { this.socket?.close(); }
}
