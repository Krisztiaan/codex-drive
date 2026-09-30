import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailure, exitCode, mergeRateLimits, failureDetails } from '../src/failures.mjs';

function error(codexErrorInfo, message = 'The provider failed') {
  return { message, codexErrorInfo, additionalDetails: null, misalignment: null };
}

test('explicit protocol overload variants are capacity failures with a temporary-failure exit code', () => {
  for (const variant of ['serverOverloaded', 'flexUnavailable']) {
    const failure = error(variant);
    assert.equal(classifyFailure(failure), 'capacity');
    assert.equal(exitCode({ status: 'failed', error: failure }), 75);
  }
});

test('protocol usage and budget limits are distinguished from retryable capacity', () => {
  for (const variant of ['usageLimitExceeded', 'rateLimitExceeded', 'sessionBudgetExceeded']) {
    const failure = error(variant, 'server overloaded, please retry');
    assert.equal(classifyFailure(failure), 'usageLimit');
    assert.equal(exitCode({ status: 'failed', error: failure }), 76);
  }
});

test('sparse rate-limit notifications retain known unavailable metadata without mutating snapshots', () => {
  const previous = { limitId: 'codex', limitName: 'Standard', normalModelSlug: 'gpt-6.1-sol',
    primary: { usedPercent: 95, windowDurationMins: 300, resetsAt: 1800000000 }, secondary: null,
    credits: { hasCredits: true, unlimited: false, balance: '10' }, individualLimit: null,
    spendControlReached: false, planType: 'plus', rateLimitReachedType: null };
  const update = { limitId: null, limitName: null, normalModelSlug: null,
    primary: { usedPercent: 100, windowDurationMins: null, resetsAt: null }, secondary: null,
    credits: null, individualLimit: null, spendControlReached: null, planType: null,
    rateLimitReachedType: 'rate_limit_reached' };
  const before = structuredClone(previous);
  const merged = mergeRateLimits(previous, update);
  assert.equal(merged.limitId, 'codex');
  assert.equal(merged.planType, 'plus');
  assert.deepEqual(merged.primary, { usedPercent: 100, windowDurationMins: null, resetsAt: null });
  assert.equal(merged.rateLimitReachedType, 'rate_limit_reached');
  assert.equal(merged.credits, null);
  assert.equal(merged.spendControlReached, null);
  assert.deepEqual(previous, before);
  merged.primary.usedPercent = 0;
  assert.equal(previous.primary.usedPercent, 95);
});

test('usage failures expose server-provided reset timestamps without inferring permission to retry', () => {
  const limits = { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1800000000 },
    secondary: { usedPercent: 50, windowDurationMins: 10080, resetsAt: 1800600000 },
    individualLimit: { limit: '100', used: '100', remainingPercent: 0, resetsAt: 1800010000 } };
  assert.deepEqual(failureDetails(error('usageLimitExceeded'), limits), {
    class: 'usageLimit', resetsAt: { primary: 1800000000, secondary: 1800600000, individualLimit: 1800010000 },
  });
  assert.deepEqual(failureDetails(error('rateLimitExceeded'), { primary: { resetsAt: null } }),
    { class: 'usageLimit', resetsAt: null });
  assert.deepEqual(failureDetails(error('serverOverloaded'), limits), { class: 'capacity', resetsAt: null });
  assert.equal(failureDetails(null, limits), null);
});

test('messages and upstream connection statuses cannot masquerade as capacity or usage classifications', () => {
  const variants = ['contextWindowExceeded', 'cyberPolicy', 'misalignmentPolicyViolation', 'tooManyDenials',
    'internalServerError', 'unauthorized', 'badRequest', 'threadRollbackFailed', 'sandboxError', 'other', null,
    { httpConnectionFailed: { httpStatusCode: 503 } },
    { responseStreamConnectionFailed: { httpStatusCode: 429 } },
    { responseStreamDisconnected: { httpStatusCode: null } },
    { responseTooManyFailedAttempts: { httpStatusCode: 503 } },
    { activeTurnNotSteerable: { turnKind: 'review' } }];
  for (const variant of variants) {
    const failure = error(variant, 'Model overloaded; usage limit exceeded; resets at 1800000000');
    failure.additionalDetails = 'serverOverloaded usageLimitExceeded';
    assert.equal(classifyFailure(failure), 'other');
    assert.equal(exitCode({ status: 'failed', error: failure }), 1);
    assert.deepEqual(failureDetails(failure), { class: 'other', resetsAt: null });
  }
});

test('terminal turn status controls successful and interrupted exit codes', () => {
  assert.equal(classifyFailure(null), null);
  assert.equal(classifyFailure(undefined), null);
  assert.equal(exitCode({ status: 'completed', error: null }), 0);
  assert.equal(exitCode({ status: 'interrupted', error: error('serverOverloaded') }), 130);
  assert.equal(exitCode({ status: 'failed', error: null }), 1);
});

test('rate-limit metadata never carries across different quota identities', () => {
  const previous = { limitId: 'quota-a', limitName: 'A', normalModelSlug: 'model-a', planType: 'pro', primary: { usedPercent: 100, resetsAt: 1800000000 } };
  const update = { limitId: 'quota-b', limitName: null, normalModelSlug: null, planType: null, primary: { usedPercent: 5, resetsAt: 1800100000 } };
  assert.deepEqual(mergeRateLimits(previous, update), update);
});
