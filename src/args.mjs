import { resolve } from 'node:path';
import { DEFAULT_PERMISSIONS } from './defaults.mjs';

const values = new Set(['port', 'cwd', 'cd', 'model', 'effort', 'sandbox', 'approval', 'add-dir', 'name', 'log', 'turn', 'n', 'timeout', 'param', 'thread-params', 'turn-params', 'request-policy', 'retry-capacity', 'since', 'older-than']);
const turnOptions = ['cwd', 'cd', 'model', 'effort', 'sandbox', 'approval', 'add-dir', 'detach', 'thread-params', 'turn-params', 'request-policy', 'retry-capacity'];
const allowed = {
  serve: ['port', 'stop', 'restart', 'force', 'timeout'], start: [...turnOptions, 'name', 'log'], resume: [...turnOptions, 'name', 'log'],
  adopt: ['name', 'log', 'detach', 'sandbox', 'approval', 'thread-params', 'request-policy'], attach: ['name', 'log', 'detach', 'sandbox', 'approval', 'thread-params', 'request-policy'],
  fork: ['name', 'log', 'sandbox', 'approval', 'thread-params', 'request-policy'],
  steer: ['turn'], interrupt: ['turn'], status: ['json', 'active', 'cwd', 'since', 'name'], result: ['turn', 'json'], inbox: ['follow', 'since', 'unread', 'ack'], wait: ['timeout', 'all', 'any'], tail: ['n'], events: ['follow'],
  pending: [], respond: ['error'], call: ['request-policy'], methods: [],
  list: [], read: [], archive: [], unarchive: [], rollback: [], compact: [], name: [], models: [], account: ['json'], 'rate-limits': ['json'], prune: ['older-than', 'apply', 'calls'],
};
const counts = { serve: [0], start: [0, 1], resume: [1, 2], adopt: [1], attach: [1], fork: [1], steer: [2], interrupt: [1], status: [0, 1], result: [1], inbox: [0], wait: [1], tail: [1], events: [1], pending: [0, 1], respond: [2], call: [1, 2], methods: [0], list: [0], read: [1], archive: [1], unarchive: [1], rollback: [1], compact: [1], name: [2], models: [0], account: [0], 'rate-limits': [0], prune: [0] };
export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!allowed[command]) throw new Error('Unknown command; use codex-drive --help');
  const options = {}, positional = [];
  let literal = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--' && !literal) { literal = true; continue; }
    if (!literal && arg !== '-' && arg.startsWith('-')) {
      const key = arg === '-n' ? 'n' : arg.slice(2);
      if (!arg.startsWith('--') && arg !== '-n' || !['port', 'param', ...allowed[command]].includes(key)) throw new Error(`Unknown option: ${arg}`);
      if (key in options && !['add-dir', 'param'].includes(key)) throw new Error(`Duplicate option: ${arg}`);
      if (values.has(key)) {
        const value = rest[++i];
        if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
        if (key === 'add-dir') (options[key] ??= []).push(resolve(value));
        else if (key === 'param') (options[key] ??= []).push(value);
        else options[key] = value;
      } else options[key] = true;
    } else positional.push(arg);
  }
  if ('port' in options && (!/^\d+$/.test(options.port) || +options.port < 1 || +options.port > 65535)) throw new Error('Port must be 1..65535');
  if ('timeout' in options && (!Number.isFinite(Number(options.timeout)) || Number(options.timeout) <= 0 || Number(options.timeout) * 1000 > 2147483647)) throw new Error('--timeout must be positive seconds within the Node timer range');
  for (const [key, minimum] of [['n', 1], ['retry-capacity', 0]]) if (key in options && (!/^\d+$/.test(options[key]) || !Number.isSafeInteger(+options[key]) || +options[key] < minimum)) throw new Error(`--${key} must be a ${minimum ? 'positive' : 'nonnegative'} integer`);
  if (!(command === 'wait' ? positional.length >= 1 : counts[command].includes(positional.length)) || positional.some(x => !x.trim())) throw new Error(`Wrong arguments for ${command}`);
  if (options.all && options.any) throw new Error('Choose --all or --any');
  if (options.stop && options.restart) throw new Error('Choose --stop or --restart');
  if (options.force && !options.stop && !options.restart) throw new Error('--force requires --stop or --restart');
  if (options.cwd && options.cd) throw new Error('Choose --cwd or --cd');
  if (options.cwd || options.cd) options.cwd = resolve(options.cwd ?? options.cd);
  if (options.log) options.log = resolve(options.log);
  Object.defineProperty(options, 'sandboxExplicit', { value: options.sandbox !== undefined });
  if (command === 'start') { options.cwd ??= resolve('.'); options.sandbox ??= DEFAULT_PERMISSIONS.sandbox; options.approval ??= DEFAULT_PERMISSIONS.approval; }
  if (options.sandbox && !['read-only', 'workspace-write', 'danger-full-access'].includes(options.sandbox)) throw new Error('Invalid sandbox');
  // Rich protocol variants are accepted through --param approvalPolicy=<json>.
  if (options.approval && !['untrusted', 'on-failure', 'on-request', 'never'].includes(options.approval)) throw new Error('Invalid approval policy');
  if (options['add-dir'] && options.sandbox && options.sandbox !== 'workspace-write') throw new Error('--add-dir requires workspace-write');
  if (options.name && command !== 'status' && !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(options.name)) throw new Error('Invalid thread name');
  if (options.param && !['start', 'resume', 'adopt', 'attach', 'fork', 'call', 'steer', 'interrupt', 'list', 'read', 'archive', 'unarchive', 'rollback', 'compact', 'name', 'models', 'account', 'rate-limits'].includes(command)) throw new Error(`--param is not supported by ${command}; use call for protocol parameters`);
  if (options['request-policy'] && !['manual', 'approve', 'decline'].includes(options['request-policy'])) throw new Error('--request-policy must be manual, approve, or decline');
  return { command, options, positional };
}
