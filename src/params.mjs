import { readFileSync } from 'node:fs';
import { methodSchema, validateCall } from './protocol.mjs';
import { DEFAULT_PERMISSIONS } from './defaults.mjs';

export const textInput = text => [{ type: 'text', text, text_elements: [] }];
export function readJson(source, fallback = {}) {
  if (source === undefined) return fallback;
  try { return JSON.parse(source === '-' ? readFileSync(0, 'utf8') : source.startsWith('@') ? readFileSync(source.slice(1), 'utf8') : source); }
  catch (error) { throw new Error(`Invalid JSON input: ${error.message}`); }
}
export function overrides(options) {
  return (options.param ?? []).map(entry => {
    const split = entry.indexOf('=');
    if (split < 1) throw new Error('--param expects key=<json>');
    return [entry.slice(0, split), readJson(entry.slice(split + 1))];
  });
}
export function callParams(method, options, initial = {}) {
  const entries = overrides(options);
  if (initial === null && entries.length) throw new Error('Cannot add parameters to null');
  if (entries.length && (initial === null || typeof initial !== 'object' || Array.isArray(initial))) throw new Error('Parameters with --param must be a JSON object');
  const params = initial !== null && typeof initial === 'object' && !Array.isArray(initial) ? { ...initial } : initial;
  for (const [key, value] of entries) Object.defineProperty(params, key, { value, enumerable: true, configurable: true, writable: true });
  validateCall(method, params);
  return params;
}
export function turnParams(threadMethod, options, threadDefaults, turnDefaults, { threadOnly = false } = {}) {
  const threadRaw = readJson(options['thread-params']), turnRaw = readJson(options['turn-params']);
  for (const value of [threadRaw, turnRaw]) if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Thread and turn parameters must be JSON objects');
  const thread = { ...threadDefaults, ...threadRaw };
  const turn = { ...turnDefaults, ...turnRaw };
  const entries = overrides(options);
  const threadKeys = methodSchema(threadMethod).properties;
  const turnKeys = methodSchema('turn/start').properties;
  for (const [key, value] of entries) {
    if (threadOnly && (key.startsWith('turn.') || !key.startsWith('thread.') && !Object.hasOwn(threadKeys, key))) throw new Error(`Parameter ${key} does not belong to ${threadMethod}`);
    if (key.startsWith('thread.')) Object.defineProperty(thread, key.slice(7), { value, enumerable: true, configurable: true, writable: true });
    else if (key.startsWith('turn.')) Object.defineProperty(turn, key.slice(5), { value, enumerable: true, configurable: true, writable: true });
    else {
      let found = false;
      if (Object.hasOwn(threadKeys, key)) { Object.defineProperty(thread, key, { value, enumerable: true, configurable: true, writable: true }); found = true; }
      if (!threadOnly && Object.hasOwn(turnKeys, key)) { Object.defineProperty(turn, key, { value, enumerable: true, configurable: true, writable: true }); found = true; }
      if (!found) throw new Error(`Unknown parameter: ${key}; use thread.<key> or turn.<key> for an explicit scope`);
    }
  }
  const explicitSandbox = options.sandboxExplicit || Object.hasOwn(threadRaw, 'sandbox') || entries.some(([key]) => ['sandbox', 'thread.sandbox'].includes(key));
  if (thread.permissions != null && !explicitSandbox && thread.sandbox === DEFAULT_PERMISSIONS.sandbox) delete thread.sandbox;
  return { thread, turn };
}
