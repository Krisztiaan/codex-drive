// Controllable app-server boundary for CLI regressions; no real model or Codex daemon.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

function frame(message) {
  const body = Buffer.from(JSON.stringify(message));
  const header = body.length < 126 ? Buffer.from([0x81, body.length]) : Buffer.from([0x81, 126, body.length >> 8, body.length & 255]);
  return Buffer.concat([header, body]);
}
export async function fixture(t) {
  mkdirSync('/tmp/codex-drive-proof', { recursive: true });
  const home = mkdtempSync('/tmp/codex-drive-proof/cli-unit-');
  mkdirSync(join(home, 'threads'));
  const sockets = new Set(), children = new Set();
  const paused = new Set();
  const turns = [{ id: 'turn-1', status: 'completed', items: [{ type: 'agentMessage', id: 'message-1', text: 'PREVIOUS' }], error: null }];
  let nextTurn = 2, reads = 0, loseStartReply = false;
  const threadId = 'thread-1';
  const server = createServer();
  function emit(method, params) { for (const socket of sockets) if (socket.subscribed) socket.write(frame({ method, params })); }
  function complete(status = 'completed', text = 'CURRENT', turn = turns.at(-1)) {
    if (text) {
      const item = { type: 'agentMessage', id: `message-${turn.id}`, text };
      turn.items.push(item); emit('item/completed', { threadId, turnId: turn.id, item });
    }
    turn.status = status; turn.error = status === 'failed' ? { message: 'Backend failed' } : null;
    emit('turn/completed', { threadId, turn: structuredClone(turn) });
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
        if (length === 127) { if (buffered.length < 10) return; length = Number(buffered.readBigUInt64BE(2)); offset = 10; }
        const masked = Boolean(buffered[1] & 128), maskOffset = offset;
        if (masked) offset += 4;
        if (buffered.length < offset + length) return;
        const body = Buffer.from(buffered.subarray(offset, offset + length));
        if (masked) for (let i = 0; i < body.length; i++) body[i] ^= buffered[maskOffset + (i % 4)];
        buffered = buffered.subarray(offset + length);
        if (opcode === 8) { socket.end(Buffer.from([0x88, 0])); return; }
        if (opcode !== 1) continue;
        const message = JSON.parse(body.toString());
        if (message.id === undefined || !message.method) continue;
        const { id, method, params } = message;
        if (paused.has(method)) continue;
        let result;
        switch (method) {
          case 'initialize': result = {}; break;
          case 'thread/start': socket.subscribed = true; result = { thread: { id: threadId }, model: params.model }; break;
          case 'thread/resume': socket.subscribed = true; result = { thread: { id: threadId, turns } }; break;
          case 'thread/turns/list': {
            reads++;
            const data = [...turns].reverse(), offset = Number(params.cursor ?? 0), end = offset + (params.limit ?? data.length);
            result = { data: data.slice(offset, end), nextCursor: end < data.length ? String(end) : null }; break;
          }
          case 'turn/start': {
            const turn = { id: `turn-${nextTurn++}`, status: 'inProgress', items: [], error: null };
            turns.push(turn); emit('turn/started', { threadId, turn });
            if (loseStartReply) {
              loseStartReply = false;
              setTimeout(() => { socket.destroy(); complete('completed', 'RECOVERED'); }, 20);
              continue;
            }
            result = { turn }; break;
          }
          case 'turn/steer': result = { turnId: params.expectedTurnId }; complete('completed', 'STEERED'); break;
          case 'turn/interrupt': result = {}; complete('interrupted', null); break;
          default: socket.write(frame({ id, error: { code: -32601, message: `Unexpected fixture method ${method}` } })); continue;
        }
        socket.write(frame({ id, result }));
      }
    }
    socket.on('data', read);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const state = { name: 'demo', threadId, turnId: 'turn-1', cwd: home, model: 'gpt-6.1-sol', effort: 'low', sandbox: 'workspace-write', approval: 'on-request', addDirs: [], logPath: join(home, 'events.jsonl'), port, status: 'completed', lastAgentMessage: 'PREVIOUS', lastEventTime: null };
  function seed(overrides = {}) { writeFileSync(join(home, 'threads/demo.json'), JSON.stringify({ ...state, ...overrides })); }
  seed();
  function launch(args, { cwd } = {}) {
    const child = spawn(process.execPath, [resolve('src/cli.mjs'), ...args], { env: { ...process.env, CODEX_DRIVE_HOME: home }, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
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
    for (const file of readdirSync(join(home, 'threads')).filter(f => f.endsWith('.json'))) {
      const saved = JSON.parse(readFileSync(join(home, 'threads', file), 'utf8'));
      const lock = join(home, 'threads', file) + '.lock';
      if (saved.driverPid && existsSync(lock) && Number(readFileSync(lock, 'utf8')) === saved.driverPid) { try { process.kill(saved.driverPid, 'SIGTERM'); } catch (e) { if (e.code !== 'ESRCH') throw e; } }
    }
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    rmSync(home, { recursive: true, force: true });
  });
  return { home, port, state, seed, turns, complete, launch, command, hasRead: () => reads > 0, pause(method) { paused.add(method); }, loseNextStartReply() { loseStartReply = true; }, disconnect() { for (const socket of sockets) socket.destroy(); } };
}
export async function until(check, label = 'condition') {
  for (let n = 0; n < 200; n++) { const value = await check(); if (value) return value; await delay(25); }
  throw new Error(`Timed out waiting for ${label}`);
}
