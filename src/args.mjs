import { resolve } from 'node:path';

const values = new Set(['port', 'cwd', 'cd', 'model', 'effort', 'sandbox', 'approval', 'add-dir', 'name', 'log', 'turn', 'n', 'timeout']);
const allowed = {
  serve: ['port', 'stop'], start: ['port', 'cwd', 'cd', 'model', 'effort', 'sandbox', 'approval', 'add-dir', 'name', 'log', 'detach'],
  steer: ['port', 'turn'], interrupt: ['port', 'turn'], status: ['port'], wait: ['port', 'timeout'], tail: ['n'], resume: ['port', 'detach'],
};
export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!allowed[command]) throw new Error('Expected serve, start, steer, interrupt, status, tail, wait, or resume');
  const options = {}, positional = [];
  let literal = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--' && !literal) { literal = true; continue; }
    if (!literal && arg.startsWith('-')) {
      const key = arg === '-n' ? 'n' : arg.slice(2);
      if (!arg.startsWith('--') && arg !== '-n' || !allowed[command].includes(key)) throw new Error(`Unknown option: ${arg}`);
      if (key in options && key !== 'add-dir') throw new Error(`Duplicate option: ${arg}`);
      if (values.has(key)) {
        const value = rest[++i];
        if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
        if (key === 'add-dir') (options[key] ??= []).push(resolve(value));
        else options[key] = value;
      } else options[key] = true;
    } else positional.push(arg);
  }
  if ('port' in options && (!/^\d+$/.test(options.port) || +options.port < 1 || +options.port > 65535)) throw new Error('Port must be 1..65535');
  if ('timeout' in options && (!Number.isFinite(Number(options.timeout)) || Number(options.timeout) <= 0 || Number(options.timeout) * 1000 > 2147483647)) throw new Error('--timeout must be positive seconds within the Node timer range');
  if ('n' in options && (!/^\d+$/.test(options.n) || +options.n < 1)) throw new Error('-n must be a positive integer');
  const counts = { serve: [0], start: [1], steer: [2], interrupt: [1], status: [0, 1], tail: [1], wait: [1], resume: [2] };
  if (!counts[command].includes(positional.length) || positional.some(x => !x.trim())) throw new Error(`Wrong arguments for ${command}`);
  if (command === 'start') {
    for (const key of ['model', 'effort', 'log']) if (!options[key]) throw new Error(`start requires --${key}`);
    if (!options.cwd && !options.cd) throw new Error('start requires --cwd (or --cd)');
    if (options.cwd && options.cd) throw new Error('Choose --cwd or --cd');
    options.cwd = resolve(options.cwd ?? options.cd);
    options.log = resolve(options.log);
    options.sandbox ??= 'workspace-write';
    options.approval ??= 'on-request';
    if (!['read-only', 'workspace-write', 'danger-full-access'].includes(options.sandbox)) throw new Error('Invalid sandbox');
    if (!['untrusted', 'on-request', 'never'].includes(options.approval)) throw new Error('Invalid approval policy');
    if (options['add-dir'] && options.sandbox !== 'workspace-write') throw new Error('--add-dir requires workspace-write');
    if (options.name && !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(options.name)) throw new Error('Invalid thread name');
  }
  return { command, options, positional };
}
