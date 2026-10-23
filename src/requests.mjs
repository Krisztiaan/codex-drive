import { createServer, createConnection } from 'node:net';
import { mkdirSync, readFileSync, readdirSync, existsSync, unlinkSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWrite } from './state.mjs';
import { validateResponse } from './protocol.mjs';
import { DEFAULT_PERMISSIONS } from './defaults.mjs';

function policyResponse(policy, event) {
  if (policy === 'manual') return undefined;
  const approve = policy === 'approve';
  switch (event.method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval': return { decision: approve ? 'accept' : 'decline' };
    case 'item/permissions/requestApproval': return { permissions: approve ? event.params.permissions : {}, scope: 'turn' };
    case 'applyPatchApproval':
    case 'execCommandApproval': return { decision: approve ? 'approved' : { denied: { rejection: 'Declined by client policy' } } };
    case 'mcpServer/elicitation/request':
      if (!approve) return { action: 'decline', content: null, _meta: null };
  }
  // Tools, authentication, attestation and input require a caller-provided result.
  return undefined;
}

function requestPath(home, id) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid pending request ID');
  return join(home, 'requests', `${id}.json`);
}
export function pendingRequests(home, threadId) {
  const dir = join(home, 'requests');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => f.endsWith('.json')).flatMap(file => {
    let envelope;
    try { envelope = JSON.parse(readFileSync(join(dir, file), 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    return !threadId || envelope.threadId === threadId ? [envelope] : [];
  });
}

export async function respond(home, requestId, result, { error } = {}) {
  let envelope;
  try { envelope = JSON.parse(readFileSync(requestPath(home, requestId), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') throw new Error(`Request is no longer pending: ${requestId}`); throw e; }
  return new Promise((resolve, reject) => {
    const socket = createConnection(envelope.socket);
    let buffer = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Request owner timed out; response outcome may be unknown')); }, 5000);
    const done = () => clearTimeout(timer);
    socket.on('error', e => { done(); reject(new Error(`Request owner disconnected: ${e.message}`)); });
    socket.on('connect', () => socket.write(JSON.stringify({ requestId, result, error }) + '\n'));
    socket.on('data', data => {
      buffer += data;
      if (!buffer.includes('\n')) return;
      done(); socket.end();
      try { const reply = JSON.parse(buffer.split('\n')[0]); reply.error ? reject(new Error(reply.error)) : resolve(reply); }
      catch (e) { reject(e); }
    });
    socket.on('close', () => { done(); if (!buffer.includes('\n')) reject(new Error('Request owner disconnected before replying; outcome may be unknown')); });
  });
}

export class RequestBroker {
  constructor({ home, log = () => {}, policy = DEFAULT_PERMISSIONS.requestPolicy, threadId } = {}) {
    if (!['manual', 'approve', 'decline'].includes(policy)) throw new Error('Approval policy must be manual, approve or decline');
    this.home = home; this.log = log; this.policy = policy; this.threadId = threadId;
    this.requests = new Map(); this.connections = new Map(); this.clients = new Set();
  }
  async start() {
    this.dir = join(this.home, 'requests'); mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.socket = join(this.dir, `${randomUUID().slice(0, 12)}.sock`);
    this.server = createServer(socket => {
      this.clients.add(socket); socket.on('close', () => this.clients.delete(socket));
      let buffer = '', handled = false;
      socket.on('error', () => {});
      socket.on('data', data => {
        if (handled) return;
        buffer += data;
        if (!buffer.includes('\n')) return;
        handled = true;
        try {
          const { requestId, result, error } = JSON.parse(buffer.split('\n')[0]);
          this.answer(requestId, result, error);
          socket.end(JSON.stringify({ requestId, responded: true }) + '\n');
        } catch (e) { socket.end(JSON.stringify({ error: e.message }) + '\n'); }
      });
    });
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.socket, resolve); });
    chmodSync(this.socket, 0o600);
    return this;
  }
  handle(rpc, event) {
    if (event.method === 'serverRequest/resolved') {
      for (const [id, request] of this.requests) {
        if (request.rpc === rpc && request.envelope.serverRequestId === event.params?.requestId && request.envelope.threadId === event.params?.threadId) {
          this.remove(id); this.log({ method: 'driver/requestResolved', params: { requestId: id, serverRequestId: event.params.requestId } });
        }
      }
      return false;
    }
    if (event.id === undefined || !event.method) return false;
    if (this.closing) {
      this.rejectClosed(rpc, event.id);
      this.log({ method: 'driver/requestCanceled', params: { serverRequestId: event.id, reason: 'request owner closed' } });
      return true;
    }
    if ([...this.requests.values()].some(r => r.rpc === rpc && r.envelope.serverRequestId === event.id)) return true;
    if (!this.connections.has(rpc)) {
      const disconnect = () => this.cancel(rpc, 'connection disconnected');
      this.connections.set(rpc, disconnect); rpc.once('disconnect', disconnect);
    }
    const requestId = randomUUID();
    const envelope = { requestId, serverRequestId: event.id, method: event.method, params: event.params,
      threadId: event.params?.threadId ?? this.threadId ?? null, port: rpc.port, pid: process.pid,
      socket: this.socket, createdAt: new Date().toISOString() };
    atomicWrite(requestPath(this.home, requestId), envelope);
    this.requests.set(requestId, { rpc, envelope });
    this.log({ method: 'driver/requestPending', params: envelope });
    const result = policyResponse(this.policy, event);
    if (result !== undefined) {
      try { validateResponse(event.method, result); }
      catch (e) { this.log({ method: 'driver/requestPolicyError', params: { requestId, error: e.message } }); return true; }
      this.answer(requestId, result);
    }
    return true;
  }
  pending() { return [...this.requests.values()].map(r => r.envelope); }
  answer(requestId, result, error) {
    const request = this.requests.get(requestId);
    if (!request) throw new Error(`Request is no longer pending: ${requestId}`);
    if (error !== undefined) {
      if (!error || !Number.isInteger(error.code) || typeof error.message !== 'string') throw new Error('Protocol error needs an integer code and string message');
      request.rpc.send({ id: request.envelope.serverRequestId, error });
    } else {
      validateResponse(request.envelope.method, result);
      request.rpc.send({ id: request.envelope.serverRequestId, result });
    }
    this.remove(requestId);
    this.log({ method: 'driver/requestResponded', params: { requestId, serverRequestId: request.envelope.serverRequestId } });
  }
  remove(id) { this.requests.delete(id); try { unlinkSync(requestPath(this.home, id)); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
  cancel(rpc, reason) {
    for (const [id, request] of this.requests) if (request.rpc === rpc) {
      this.remove(id); this.log({ method: 'driver/requestCanceled', params: { requestId: id, reason } });
    }
    this.connections.delete(rpc);
  }
  rejectClosed(rpc, serverRequestId, requestId) {
    try { rpc.send({ id: serverRequestId, error: { code: -32000, message: 'Client request owner closed before responding' } }); }
    catch (error) { this.log({ method: 'driver/requestCancelError', params: { requestId, serverRequestId, error: error.message } }); }
  }
  close() {
    if (this.closing) return this.closing;
    this.closing = Promise.resolve().then(async () => {
      for (const [requestId, request] of this.requests) this.rejectClosed(request.rpc, request.envelope.serverRequestId, requestId);
      for (const [rpc, listener] of this.connections) { rpc.off('disconnect', listener); this.cancel(rpc, 'request owner closed'); }
      this.connections.clear();
      for (const socket of this.clients) socket.destroy();
      if (this.server) await new Promise(resolve => this.server.close(resolve));
      if (this.socket) { try { unlinkSync(this.socket); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
    });
    return this.closing;
  }
}
