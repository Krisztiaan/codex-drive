import { readFileSync } from 'node:fs';
import Ajv from 'ajv';

const generated = JSON.parse(readFileSync(new URL('../protocol/schema.json', import.meta.url), 'utf8'));
const validated = structuredClone(generated);

// Serde permits extra struct keys; the CLI rejects them to catch misspellings.
// Explicit maps (config overrides, schemas, metadata, etc.) stay open.
function closeObjects(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return;
  if (schema.properties && schema.additionalProperties === undefined) schema.additionalProperties = false;
  for (const key of ['properties', 'patternProperties', 'definitions']) {
    for (const child of Object.values(schema[key] || {})) closeObjects(child);
  }
  for (const key of ['oneOf', 'anyOf', 'allOf']) schema[key]?.forEach(closeObjects);
  for (const key of ['items', 'additionalProperties', 'not', 'if', 'then', 'else', 'contains', 'propertyNames']) {
    if (Array.isArray(schema[key])) schema[key].forEach(closeObjects);
    else closeObjects(schema[key]);
  }
}
closeObjects(validated);
// The canonical bundle namespaces all v2 definitions in a dictionary.
for (const definition of Object.values(validated.definitions.v2)) closeObjects(definition);

const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
ajv.addSchema(validated, 'protocol');
const client = new Map(generated.definitions.ClientRequest.oneOf.map(request => [request.properties.method.enum[0], request]));
const server = new Map(generated.definitions.ServerRequest.oneOf.map(request => [request.properties.method.enum[0], request]));
const cache = new Map();

export function methods() { return [...client.keys()].sort(); }
export function serverMethods() { return [...server.keys()].sort(); }
export function resolveSchema(schema) {
  if (typeof schema === 'string') schema = { $ref: schema };
  return schema?.$ref ? schema.$ref.slice(2).split('/').reduce((node, key) => node?.[key], generated) : schema;
}
export function methodSchema(method) {
  const request = client.get(method);
  if (!request) throw new Error(`Unknown client method: ${method}; use methods to list the generated protocol`);
  return resolveSchema(request.properties.params);
}
export function serverRequestSchema(method) {
  const request = server.get(method);
  if (!request) throw new Error(`Unknown server request method: ${method}`);
  return resolveSchema(request.properties.params);
}
export function responseSchema(method) {
  const request = server.get(method);
  if (!request) throw new Error(`Unknown server request method: ${method}`);
  return resolveSchema(request.properties.params.$ref.replace(/Params$/, 'Response'));
}
function validate(method, value, schema, label) {
  const key = `${label}:${method}`;
  let check = cache.get(key);
  if (!check) {
    check = ajv.compile({ ...schema, definitions: validated.definitions });
    cache.set(key, check);
  }
  if (!check(value)) {
    const detail = check.errors.map(error => `${error.instancePath || '/'} ${error.message}${error.params.additionalProperty ? ` (${error.params.additionalProperty})` : ''}`).join('; ');
    throw Object.assign(new Error(`Invalid ${label} for ${method}: ${detail}`), { validationErrors: check.errors });
  }
  return value;
}
export function validateCall(method, params) {
  methodSchema(method);
  const request = client.get(method);
  // Compile the reference against the strict copy, preserving generated refs.
  return validate(method, params, request.properties.params, 'parameters');
}
export function validateResponse(method, result) {
  responseSchema(method);
  const request = server.get(method);
  return validate(method, result, { $ref: request.properties.params.$ref.replace(/Params$/, 'Response') }, 'response');
}
