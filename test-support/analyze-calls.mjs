// Read-only journal census. Outputs counts and method names, never event payloads.
import { createReadStream, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const dir = resolve(process.argv[2]);
const files = readdirSync(dir).filter(name => name.endsWith('.jsonl')).flatMap(name => {
  const stat = lstatSync(join(dir, name));
  return stat.isFile() ? [{ name, bytes: stat.size }] : [];
}).sort((a, b) => b.bytes - a.bytes);
const totals = {}, signatures = {}, hours = {}, largest = [];
let malformed = 0, records = 0, observedBytes = 0;
const add = (table, key, bytes) => {
  const row = table[key] ??= { records: 0, bytes: 0 };
  row.records++; row.bytes += bytes;
};
for (const [index, file] of files.entries()) {
  const methods = {};
  let first, last, invalid = 0;
  const line = raw => {
    if (!raw) return;
    const bytes = Buffer.byteLength(raw) + 1;
    try {
      const event = JSON.parse(raw), method = event.method ?? '(no method)';
      add(totals, method, bytes); add(methods, method, bytes);
      records++; observedBytes += bytes;
      if (event.receivedAt) { first ??= event.receivedAt; last = event.receivedAt; }
    } catch { malformed++; invalid++; }
  };
  if (file.bytes < 1024 * 1024) readFileSync(join(dir, file.name), 'utf8').split('\n').forEach(line);
  else for await (const raw of createInterface({ input: createReadStream(join(dir, file.name)), crlfDelay: Infinity })) line(raw);
  const signature = methods['turn/diff/updated'] ? 'contains diff' :
    Object.keys(methods).every(method => ['account/rateLimits/updated', 'remoteControl/status/changed', 'thread/goal/cleared', 'account/updated'].includes(method)) ? 'ambient only' : 'other';
  const group = signatures[signature] ??= { files: 0, bytes: 0 };
  group.files++; group.bytes += file.bytes;
  if (first) hours[first.slice(0, 13)] = (hours[first.slice(0, 13)] ?? 0) + 1;
  if (index < 6) largest.push({ ...file, first, last, durationHours: (Date.parse(last) - Date.parse(first)) / 3600000, methods, invalid });
}
console.log(JSON.stringify({ startedFromDirectorySnapshot: true, files: files.length,
  bytes: files.reduce((sum, file) => sum + file.bytes, 0), medianBytes: files[Math.floor(files.length / 2)]?.bytes,
  records, observedBytes, malformed, signatures, methods: totals, filesByFirstRecordHourUTC: hours, largest }, null, 2));
