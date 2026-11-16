// Controllable app-server boundary for CLI regressions; no real model or Codex daemon.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

function frame(message) {
  const body = Buffer.from(JSON.stringify(message));
  const header = body.length < 126 ? Buffer.from([0x81, body.length]) : body.length <= 65535 ? Buffer.from([0x81, 126, body.length >> 8, body.length & 255]) : Buffer.alloc(10);
  if (body.length > 65535) { header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(body.length), 2); }
  return Buffer.concat([header, body]);
}
export async function fixture(t, { port: requestedPort = 0, diagnostics, turnsList, account, usage, historyFile, cliPath, initializeEvents = [], resumeEvents = [], threadStatus, threadFlags = [], turnsListError } = {}) {
  mkdirSync('/tmp/codex-drive-proof', { recursive: true });
  const home = mkdtempSync('/tmp/codex-drive-proof/cli-unit-');
  mkdirSync(join(home, 'threads'));
  const sockets = new Set(), children = new Set(), received = [], replies = [];
  const paused = new Set();
  const turns = [{ id: 'turn-1', status: 'completed', items: [{ type: 'agentMessage', id: 'message-1', text: 'PREVIOUS' }], error: null }];
  let nextTurn = 2, reads = 0, loseStartReply = false, lostReplyRateLimits = null;
  const threadId = 'thread-1';
  const threads = new Map([[threadId, turns]]);
  if (historyFile && existsSync(historyFile)) {
    threads.clear(); for (const [id, history] of JSON.parse(readFileSync(historyFile, 'utf8'))) threads.set(id, history);
    turns.splice(0, turns.length, ...(threads.get(threadId) ?? [])); threads.set(threadId, turns);
    nextTurn = 1 + Math.max(1, ...[...threads.values()].flat().map(t => Number(t.id.replace('turn-', '')) || 0));
  }
  const persist = () => { if (historyFile) writeFileSync(historyFile, JSON.stringify([...threads])); };
  function threadMetadata(id, includeTurns = false) {
    const history = threads.get(id) ?? turns;
    const type = threadStatus ?? (history.some(t => t.status === 'inProgress') ? 'active' : 'idle');
    return { id, cwd: home, status: { type, ...(type === 'active' ? { activeFlags: threadFlags } : {}) }, turns: includeTurns ? history : [] };
  }
  let nextFork = 1;
  const server = createServer();
  function emit(method, params) { for (const socket of sockets) if (socket.subscribed && !socket.optOut?.includes(method)) socket.write(frame({ method, params })); }
  function complete(status = 'completed', text = 'CURRENT', turn = turns.at(-1), error = null) {
    const owner = [...threads].find(([, history]) => history.includes(turn))?.[0] ?? threadId;
    if (text) {
      const item = { type: 'agentMessage', id: `message-${turn.id}`, text };
      turn.items.push(item); emit('item/completed', { threadId: owner, turnId: turn.id, item });
    }
    turn.status = status; turn.error = status === 'failed' ? error ?? { message: 'Backend failed', codexErrorInfo: 'other', additionalDetails: null } : null;
    persist();
    emit('turn/completed', { threadId: owner, turn: structuredClone(turn) });
  }
  server.on('upgrade', (request, socket, head) => {
    const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    let buffered = head;
    function read(chunk) {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 2) {
        const opcode = buffered[0] & 15; let length = buffered[1] & 127, offset = 2;
        if (length === 126) { if (buffered.length < 4) return; length = buffered.readUInt16BE(2); offset = 4; }
        else if (length === 127) { if (buffered.length < 10) return; length = Number(buffered.readBigUInt64BE(2)); offset = 10; }
        const masked = Boolean(buffered[1] & 128), maskOffset = offset;
        if (masked) offset += 4;
        if (buffered.length < offset + length) return;
        const body = Buffer.from(buffered.subarray(offset, offset + length));
        if (masked) for (let i = 0; i < body.length; i++) body[i] ^= buffered[maskOffset + (i % 4)];
        buffered = buffered.subarray(offset + length);
        if (opcode === 8) { socket.end(Buffer.from([0x88, 0])); return; }
        if (opcode !== 1) continue;
        const message = JSON.parse(body.toString());
        if (message.id !== undefined && !message.method) { replies.push(message); continue; }
        if (message.id === undefined || !message.method) continue;
        received.push({ ...message, receivedAt: Date.now() });
        const { id, method, params } = message;
        if (paused.has(method)) continue;
        let result;
        switch (method) {
          case 'initialize': socket.optOut = params.capabilities?.optOutNotificationMethods; for (const event of initializeEvents) if (!socket.optOut?.includes(event.method)) socket.write(frame(event)); result = {}; break;
          case 'server/diagnostics': result = diagnostics ? diagnostics() : { diagnostics: ['PASSTHROUGH'] }; break;
          case 'thread/read': {
            if (params.threadId === 'missing') { socket.write(frame({ id, error: { code: -32001, message: 'Not found', data: { detail: 'original' } } })); continue; }
            result = { thread: threadMetadata(params.threadId, params.includeTurns || method === 'thread/resume' && !params.excludeTurns) }; break;
          }
          case 'thread/start': socket.subscribed = true; result = { thread: { id: threadId, cwd: home }, model: params.model }; break;
          case 'thread/resume': socket.subscribed = true; for (const event of resumeEvents) if (!socket.optOut?.includes(event.method)) socket.write(frame(event)); result = { thread: threadMetadata(params.threadId, params.includeTurns || method === 'thread/resume' && !params.excludeTurns) }; break;
          case 'thread/fork': { const id = `fork-${nextFork++}`; const history = structuredClone(threads.get(params.threadId) ?? turns); threads.set(id, history); result = { thread: { id, cwd: home, turns: history } }; break; }
          case 'model/list': result = { data: [], nextCursor: null }; break;
          case 'account/read': result = typeof account === 'function' ? account() : account ?? { account: null, requiresOpenaiAuth: false }; break;
          case 'account/rateLimits/read': result = typeof usage === 'function' ? usage() : usage ?? { rateLimits: null, rateLimitsByLimitId: null }; break;
          case 'thread/loaded/list': result = { data: [...threads.keys()], nextCursor: null }; break;
          case 'thread/list': result = { data: [...threads.keys()].map(id => ({ id })), nextCursor: null }; break;
          case 'thread/archive': case 'thread/unarchive': case 'thread/revert': case 'thread/compact/start': case 'thread/name/set': result = {}; break;
          case 'thread/turns/list': {
            reads++;
            const listError = turnsListError?.(params);
            if (listError) { socket.write(frame({ id, error: listError })); continue; }
            if (!(threads.get(params.threadId) ?? turns).length) { socket.write(frame({ id, error: { code: -32600, message: 'Thread not materialized before first user message' } })); continue; }
            const data = [...(threads.get(params.threadId) ?? turns)].reverse(), offset = Number(params.cursor ?? 0), end = offset + (params.limit ?? data.length);
            result = { data: data.slice(offset, end).map(turn => ({ ...turn, items: params.itemsView === 'notLoaded' ? [] : params.itemsView === 'summary' ? turn.items.filter(item => item.phase !== 'commentary') : turn.items })), nextCursor: end < data.length ? String(end) : null };
            if (turnsList) {
              Promise.resolve(turnsList(params, structuredClone(result))).then(result => socket.write(frame({ id, result })));
              continue;
            }
            break;
          }
          case 'thread/items/list': {
            const history = threads.get(params.threadId) ?? turns;
            let data = history.filter(t => !params.turnId || t.id === params.turnId).flatMap(t => t.items.map(item => ({ turnId: t.id, item })));
            if (params.sortDirection === 'desc') data.reverse();
            const offset = Number(params.cursor ?? 0), end = offset + (params.limit ?? data.length);
            result = { data: data.slice(offset, end), nextCursor: end < data.length ? String(end) : null }; break;
          }
          case 'turn/start': {
            const turn = { id: `turn-${nextTurn++}`, status: 'inProgress', items: [], error: null };
            const history = threads.get(params.threadId) ?? turns; history.push(turn); persist(); socket.turnOwner = true; emit('turn/started', { threadId: params.threadId, turn });
            if (loseStartReply) {
              loseStartReply = false;
              if (lostReplyRateLimits) { emit('account/rateLimits/updated', { rateLimits: lostReplyRateLimits }); lostReplyRateLimits = null; }
              setTimeout(() => { socket.destroy(); complete('completed', 'RECOVERED'); }, 20);
              continue;
            }
            result = { turn }; break;
          }
          case 'turn/steer': result = { turnId: params.expectedTurnId }; complete('completed', 'STEERED', (threads.get(params.threadId) ?? turns).at(-1)); break;
          case 'turn/interrupt': result = {}; complete('interrupted', null, (threads.get(params.threadId) ?? turns).at(-1)); break;
          default: socket.write(frame({ id, error: { code: -32601, message: `Unexpected fixture method ${method}` } })); continue;
        }
        socket.write(frame({ id, result }));
      }
    }
    socket.on('data', read);
  });
  await new Promise(resolve => server.listen(requestedPort, '127.0.0.1', resolve));
  const port = server.address().port;
  const state = { name: 'demo', threadId, turnId: 'turn-1', cwd: home, model: 'gpt-6.1-sol', effort: 'low', sandbox: 'workspace-write', approval: 'on-request', addDirs: [], logPath: join(home, 'events.jsonl'), port, status: 'completed', lastAgentMessage: 'PREVIOUS', lastEventTime: null };
  function seed(overrides = {}) { writeFileSync(join(home, 'threads/demo.json'), JSON.stringify({ ...state, ...overrides })); }
  seed();
  function launch(args, { cwd, stdin } = {}) {
    const child = spawn(process.execPath, [cliPath ?? process.env.CODEX_DRIVE_TEST_CLI ?? resolve('src/cli.mjs'), ...args], { env: { ...process.env, CODEX_DRIVE_HOME: home, CODEX_HOME: join(home, 'codex') }, cwd, stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    if (stdin !== undefined) child.stdin.end(stdin);
    children.add(child); let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
    const result = new Promise((resolve, reject) => {
      child.once('error', reject); child.once('exit', (code, signal) => { children.delete(child); resolve({ code, signal, stdout, stderr }); });
    });
    return { child, result, stdout: () => stdout };
  }
  async function command(args, options) { return launch(args, options).result; }
  t.after(async () => {
    for (const child of children) child.kill('SIGTERM');
    // Detached driver PID is an owned test resource, never selected by name.
    const drivers = [];
    for (const file of readdirSync(join(home, 'threads')).filter(f => f.endsWith('.json'))) {
      const saved = JSON.parse(readFileSync(join(home, 'threads', file), 'utf8'));
      const lock = join(home, 'threads', file) + '.lock';
      if (saved.driverPid && existsSync(lock) && Number(readFileSync(lock, 'utf8')) === saved.driverPid) { try { process.kill(saved.driverPid, 'SIGTERM'); } catch (e) { if (e.code !== 'ESRCH') throw e; } }
      if (saved.driverPid) drivers.push(saved.driverPid);
    }
    // A detached logger that just settled may still be writing; let it exit before removing its home.
    const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; } };
    for (let n = 0; n < 100 && drivers.some(alive); n++) await delay(50);
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    rmSync(home, { recursive: true, force: true });
  });
  return { requestCounts() {
    const counts = {};
    for (const m of received) {
      const key = m.method + ' / ' + (m.params?.itemsView ?? '-');
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  }, home, port, state, seed, persist, turns, threads, received, replies, complete, emit, request(method, params, id = 'server-1') { for (const socket of sockets) if (socket.turnOwner) socket.write(frame({ id, method, params })); }, launch, command, hasRead: () => reads > 0, pause(method) { paused.add(method); }, loseNextStartReply(rateLimits = null) { loseStartReply = true; lostReplyRateLimits = rateLimits; }, disconnect() { for (const socket of sockets) socket.destroy(); } };
}
export async function until(check, label = 'condition') {
  for (let n = 0; n < 400; n++) { const value = await check(); if (value) return value; await delay(25); }
  throw new Error(`Timed out waiting for ${label}`);
}
