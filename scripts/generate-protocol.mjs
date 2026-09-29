// Retain the generated types used to build/review this CLI, including their imports.
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join, dirname, relative } from 'node:path';

const out = resolve('protocol');
const temporary = resolve('.drive/protocol-generated');
mkdirSync(temporary, { recursive: true });
execFileSync('codex', ['app-server', 'generate-ts', '--out', temporary], { stdio: 'inherit' });
const roots = ['InitializeParams', 'ClientNotification', 'ServerRequest', 'ServerNotificationEnvelope',
  ...['ThreadStartParams', 'ThreadStartResponse', 'ThreadResumeParams', 'ThreadResumeResponse',
    'ThreadTurnsListParams', 'ThreadTurnsListResponse', 'TurnStartParams', 'TurnStartResponse',
    'TurnSteerParams', 'TurnSteerResponse', 'TurnInterruptParams', 'TurnInterruptResponse',
    'CommandExecutionRequestApprovalResponse', 'FileChangeRequestApprovalResponse',
    'PermissionsRequestApprovalResponse', 'ToolRequestUserInputResponse', 'McpServerElicitationRequestResponse'].map(n => `v2/${n}`),
  'ExecCommandApprovalResponse', 'ApplyPatchApprovalResponse'];
const files = new Map();
function visit(path) {
  if (files.has(path)) return;
  const source = readFileSync(path, 'utf8'); files.set(path, source);
  for (const match of source.matchAll(/from "([^\"]+)"/g)) visit(resolve(dirname(path), match[1] + '.ts'));
}
for (const root of roots) visit(join(temporary, root + '.ts'));
rmSync(out, { recursive: true, force: true });
for (const [path, source] of files) { const target = join(out, relative(temporary, path)); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, source); }
writeFileSync(join(out, 'README.md'), `Generated with \`codex app-server generate-ts\` from ${execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim()}.\n\nRun \`node scripts/generate-protocol.mjs\` to regenerate this dependency-closed subset.\nRuntime is plain ESM; these files document the actual protocol contract, with no runtime dependency.\n`);
rmSync(temporary, { recursive: true, force: true });
console.log(`Retained ${files.size} generated protocol files.`);
