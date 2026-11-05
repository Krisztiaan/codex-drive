import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { stateHome } from './state.mjs';

export const codexHome = () => process.env.CODEX_HOME ?? join(homedir(), '.codex');
// Only identity fields leave this function; credentials are never journaled.
export function diskIdentity(home = codexHome()) {
  try {
    const auth = JSON.parse(readFileSync(join(home, 'auth.json'), 'utf8'));
    let claims = {};
    try { claims = JSON.parse(Buffer.from(auth.tokens?.id_token?.split('.')[1] ?? '', 'base64url').toString()); } catch {}
    return { accountId: auth.tokens?.account_id ?? claims['https://api.openai.com/auth']?.chatgpt_account_id ?? null, email: claims.email ?? null };
  } catch (error) { return { unavailable: error.code === 'ENOENT' ? 'auth file absent' : 'auth metadata unreadable' }; }
}
export function serverCodexHome(port) {
  const path = join(stateHome(), `server-${port}.json`);
  if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8')).codexHome ?? codexHome();
  return codexHome();
}
export function quotas(usage) {
  const entries = Object.entries(usage?.rateLimitsByLimitId ?? {});
  return entries.length ? entries : usage?.rateLimits ? [[usage.rateLimits.limitId ?? 'default', usage.rateLimits]] : [];
}
export function usageText(account, usage) {
  const a = account?.account;
  const lines = [`Account: ${a?.email ?? a?.type ?? 'unavailable'} | plan: ${a?.planType ?? usage?.rateLimits?.planType ?? 'unknown'}`, `Ordinary usage allowed: ${usage?.ordinaryUsageAllowed == null ? 'unknown' : usage.ordinaryUsageAllowed ? 'yes' : 'no'}`];
  for (const [id, quota] of quotas(usage)) for (const key of ['primary', 'secondary', 'individualLimit']) {
    const w = quota[key];
    if (w) lines.push(`${id} ${key}: ${w.usedPercent ?? (w.remainingPercent == null ? '?' : 100 - w.remainingPercent)}% used; resets ${w.resetsAt == null ? 'unknown' : new Date(w.resetsAt * 1000).toLocaleString()}`);
  }
  return lines.join('\n');
}
export async function accountHealth(rpc, { warnUsage = false } = {}) {
  const account = await rpc.request('account/read', { refreshToken: false });
  let usage = null;
  try { usage = await rpc.request('account/rateLimits/read', {}); }
  catch { console.error('WARNING: account usage unavailable; limit state is unknown.'); }
  const disk = diskIdentity(serverCodexHome(rpc.port));
  const a = account.account;
  const mismatch = Boolean(disk.accountId && usage?.accountId && disk.accountId !== usage.accountId || disk.email && a?.email && disk.email.toLowerCase() !== a.email.toLowerCase());
  const identityCheck = mismatch ? 'mismatch' : disk.accountId && usage?.accountId || disk.email && a?.email ? 'matched' : 'unavailable';
  if (mismatch) console.error(`WARNING: server account differs from auth on disk on port ${rpc.port}. Use serve --restart --port ${rpc.port} when idle, or serve on another port with the current account. Saved thread IDs remain usable.`);
  if (warnUsage && (usage?.ordinaryUsageAllowed === false || quotas(usage).some(([, q]) => ['primary', 'secondary', 'individualLimit'].some(k => q[k]?.usedPercent >= 90 || q[k]?.remainingPercent != null && q[k].remainingPercent <= 10)))) console.error('WARNING: account usage is at or near its limit (90%); dispatching without retry.\n' + usageText(account, usage));
  return { account, usage, identityCheck };
}
