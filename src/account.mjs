import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const codexHome = () => process.env.CODEX_HOME ?? join(homedir(), '.codex');
// Only identity fields leave this function; credentials are never journaled.
export function diskIdentity(home = codexHome()) {
  try {
    const auth = JSON.parse(readFileSync(join(home, 'auth.json'), 'utf8'));
    let claims = {};
    try { claims = JSON.parse(Buffer.from(auth.tokens?.id_token?.split('.')[1] ?? '', 'base64url').toString()); } catch {}
    return { accountId: field(claims['https://api.openai.com/auth']?.chatgpt_account_id) ?? field(auth.tokens?.account_id), email: field(claims.email) };
  } catch (error) { return { unavailable: error.code === 'ENOENT' ? 'auth file absent' : 'auth metadata unreadable' }; }
}
const field = value => typeof value === 'string' && value.trim() ? value : null;
export const hasIdentity = account => Boolean(account?.accountId || account?.email);
export function accountLabel(account) {
  const label = [account?.email, account?.accountId].filter(Boolean).join(' / ') || account?.type || 'unknown';
  return label.replace(/[\x00-\x1f\x7f]/g, ' ');
}
export function compareAccounts(a, b) {
  if (a?.email && b?.email && a.email.toLowerCase() !== b.email.toLowerCase()) return 'mismatch';
  if (a?.accountId) return !b?.accountId ? 'unavailable' : a.accountId === b.accountId ? 'matched' : 'mismatch';
  return a?.email && b?.email ? 'matched' : 'unavailable';
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
export async function readServerAccount(rpc, { signal, readUsage = false } = {}) {
  const account = await rpc.request('account/read', { refreshToken: false }, { signal });
  const a = account.account;
  let usage = null;
  if (readUsage) {
    try { usage = await rpc.request('account/rateLimits/read', { excludeResetCreditDetails: true }, { signal }); }
    catch { /* The account read can still establish identity without usage. */ }
  }
  return { account, usage, identity: { type: field(a?.type), email: field(a?.email), accountId: field(a?.accountId) ?? field(usage?.accountId) } };
}
export function usageWarning({ account, usage }) {
  if (!usage) return 'WARNING: account usage unavailable; limit state is unknown.';
  if (usage.ordinaryUsageAllowed === false || quotas(usage).some(([, q]) => ['primary', 'secondary', 'individualLimit'].some(k => q[k]?.usedPercent >= 90 || q[k]?.remainingPercent != null && q[k].remainingPercent <= 10))) return 'WARNING: account usage is at or near its limit (90%); dispatching without retry.\n' + usageText(account, usage);
}
export function routingError(message) {
  return Object.assign(new Error(message), { accountRouting: true });
}
export function threadPort(options, state) {
  if (state && options.port && +options.port !== state.port) throw routingError(`Port differs from thread server for ${state.name ?? state.threadId}. Use its saved port ${state.port}.`);
  return state?.port ?? (options.port ? Number(options.port) : undefined);
}
export function threadUnavailable(state) {
  return routingError(`Cannot connect to the saved server on port ${state.port} for ${state.name ?? state.threadId}. Restore that server with ${accountLabel(state.account)} on port ${state.port}.`);
}
export async function checkServerAccount(rpc, options, state, { signal, readUsage = false, report = console.error } = {}) {
  const needsAccountId = diskIdentity().accountId || state?.account?.accountId;
  let health;
  try { health = await readServerAccount(rpc, { signal, readUsage: Boolean(readUsage || needsAccountId) }); }
  catch {
    signal?.throwIfAborted();
    throw routingError(`Cannot verify the account on port ${rpc.port}. Check the server with codex-drive account.`);
  }
  signal?.throwIfAborted();
  const active = diskIdentity();
  const { identity } = health;
  if (state?.account && compareAccounts(state.account, identity) !== 'matched') {
    throw routingError(`Saved server on port ${rpc.port} for ${state.name ?? state.threadId} could not be verified as ${accountLabel(state.account)} (reports ${accountLabel(identity)}). Restore or verify the original account on that port. Threads cannot move between accounts.`);
  }
  const identityCheck = compareAccounts(active, identity);
  if (identityCheck === 'matched') return { ...health, identityCheck };
  if (options.port && options['allow-other-account'] && hasIdentity(identity)) {
    report(`Server on port ${rpc.port} bills ${accountLabel(identity)} (active login: ${accountLabel(active)}).`);
    return { ...health, identityCheck };
  }
  const override = hasIdentity(identity) ? ` To use this account explicitly, pass --port ${rpc.port} --allow-other-account.` : '';
  throw routingError(`Server on port ${rpc.port} has account ${accountLabel(identity)} (active login: ${accountLabel(active)}).${override || ' Check codex login and run codex-drive account.'}`);
}
