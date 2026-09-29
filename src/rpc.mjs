import { EventEmitter } from 'node:events';

export class Rpc extends EventEmitter {
  constructor(port) { super(); this.port = port; this.nextId = 1; this.pending = new Map(); }
  async connect() {
    const socket = new WebSocket(`ws://127.0.0.1:${this.port}`);
    this.socket = socket;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error('Connection timeout')); }, 5000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error(`Cannot connect to 127.0.0.1:${this.port}; run serve`)); }, { once: true });
    });
    socket.addEventListener('message', event => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { this.emit('protocolError', new Error('Invalid server JSON')); return; }
      if (message.id !== undefined && !message.method) {
        const p = this.pending.get(message.id);
        if (p) { clearTimeout(p.timer); this.pending.delete(message.id); message.error ? p.reject(new Error(JSON.stringify(message.error))) : p.resolve(message.result); }
      } else this.emit('event', message);
    });
    socket.addEventListener('close', () => {
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Connection dropped; request outcome may be unknown')); }
      this.pending.clear();
      this.emit('disconnect');
    });
    // Generated InitializeParams + ClientNotification; no JSON-RPC version field required.
    await this.request('initialize', { clientInfo: { name: 'codex-drive', title: 'codex-drive', version: '0.1.0' }, capabilities: { experimentalApi: false, requestAttestation: false } });
    this.send({ method: 'initialized' });
  }
  send(message) { if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('Connection is closed'); this.socket.send(JSON.stringify(message)); }
  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out; outcome may be unknown (not retried)`)); }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  close() { this.socket?.close(); }
}
