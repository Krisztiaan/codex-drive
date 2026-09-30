// The canonical bundle contains the entire protocol, including experimental APIs.
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';

const out = resolve('protocol');
const temporaryRoot = '/tmp/codex-drive-proof';
mkdirSync(temporaryRoot, { recursive: true });
const temporary = mkdtempSync(join(temporaryRoot, 'protocol-'));
try {
  execFileSync('codex', ['app-server', 'generate-json-schema', '--experimental', '--out', temporary], { stdio: 'inherit' });
  const source = readFileSync(join(temporary, 'codex_app_server_protocol.schemas.json'), 'utf8');
  const schema = JSON.parse(source);
  // Generated request parameter/response types share a name stem. Fail regeneration
  // rather than silently leave a newly introduced server request unanswerable.
  for (const request of schema.definitions.ServerRequest.oneOf) {
    const response = request.properties.params.$ref.replace(/Params$/, 'Response');
    const value = response.slice(2).split('/').reduce((node, key) => node?.[key], schema);
    if (!value) throw new Error(`No generated response schema for ${request.properties.method.enum[0]} (${response})`);
  }
  const version = execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim();
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'schema.json'), source);
  writeFileSync(join(out, 'README.md'), `Generated with \`codex app-server generate-json-schema --experimental\` from ${version}.\n\nRun \`npm run protocol\` to regenerate the complete canonical JSON Schema bundle from the installed Codex. It includes client requests, notifications, server requests, responses, errors, and experimental APIs. Runtime validation reads this bundle directly; no method or parameter lists are maintained by hand.\n`);
  console.log(`Retained the complete protocol: ${schema.definitions.ClientRequest.oneOf.length} client methods, ${schema.definitions.ServerRequest.oneOf.length} server requests.`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
