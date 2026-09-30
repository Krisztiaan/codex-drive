// CodexErrorInfo is generated in protocol/schema.json (definitions.v2.CodexErrorInfo).
export function classifyFailure(error) {
  if (error == null) return null;
  if (['serverOverloaded', 'flexUnavailable'].includes(error.codexErrorInfo)) return 'capacity';
  if (['usageLimitExceeded', 'rateLimitExceeded', 'sessionBudgetExceeded'].includes(error.codexErrorInfo)) return 'usageLimit';
  return 'other';
}

export function exitCode(state) {
  if (state.status === 'completed') return 0;
  if (state.status === 'interrupted') return 130;
  return { capacity: 75, usageLimit: 76 }[classifyFailure(state.error)] ?? 1;
}

// AccountRateLimitsUpdatedNotification is sparse: unavailable values do not
// erase previously observed account metadata. Window values remain authoritative.
export function mergeRateLimits(previous, update) {
  if (update == null) return structuredClone(previous ?? null);
  if (previous?.limitId != null && update.limitId != null && previous.limitId !== update.limitId) previous = null;
  const result = structuredClone({ ...previous, ...update });
  for (const key of ['limitId', 'limitName', 'normalModelSlug', 'planType']) {
    if (update[key] == null && previous?.[key] != null) result[key] = previous[key];
  }
  return result;
}

export function failureDetails(error, rateLimits) {
  const failureClass = classifyFailure(error);
  if (failureClass == null) return null;
  const resetsAt = {};
  if (failureClass === 'usageLimit') {
    for (const key of ['primary', 'secondary', 'individualLimit']) {
      const time = rateLimits?.[key]?.resetsAt;
      if (typeof time === 'number' && Number.isFinite(time)) resetsAt[key] = time;
    }
  }
  return { class: failureClass, resetsAt: Object.keys(resetsAt).length ? resetsAt : null };
}
