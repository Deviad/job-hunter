#!/usr/bin/env node
/**
 * Unit tests for retry-policy.mjs — pure module, no CDP/browser/network.
 */
import assert from 'node:assert/strict';
import { createRetryPolicy, createStrictSourceRetryPolicy, RETRY_VERDICT } from './retry-policy.mjs';

// ── Basic: first attempt always allowed ──────────────────────────────
{
  const rp = createRetryPolicy({ maxRetries: 3, circuitBreakerThreshold: 3 });
  const d = rp.canRetry('job-1', 'linkedin.com');
  assert.equal(d.allowed, true, 'first attempt allowed');
}

// ── Retry exhaustion: key eventually runs out ────────────────────────
{
  const rp = createRetryPolicy({ maxRetries: 3, circuitBreakerThreshold: 10 });
  const key = 'job-exhaust';
  const origin = 'linkedin.com';

  assert.equal(rp.canRetry(key, origin).allowed, true);
  rp.recordResult(key, origin, 'active_challenge', 'captcha');
  assert.equal(rp.canRetry(key, origin).allowed, true);
  rp.recordResult(key, origin, 'active_challenge', 'captcha');
  assert.equal(rp.canRetry(key, origin).allowed, true);
  rp.recordResult(key, origin, 'active_challenge', 'captcha');
  // 3 attempts exhausted
  const d = rp.canRetry(key, origin);
  assert.equal(d.allowed, false, 'exhausted after maxRetries');
  assert.ok(d.reason.includes('exhausted'), 'reason mentions exhausted');
}

// ── Distinct keys are tracked independently ──────────────────────────
{
  const rp = createRetryPolicy({ maxRetries: 3, circuitBreakerThreshold: 10 });
  const origin = 'linkedin.com';

  rp.recordResult('a', origin, 'active_challenge', 'x');
  rp.recordResult('a', origin, 'active_challenge', 'x');
  rp.recordResult('a', origin, 'active_challenge', 'x');
  assert.equal(rp.canRetry('a', origin).allowed, false, 'key a exhausted');

  assert.equal(rp.canRetry('b', origin).allowed, true, 'key b still allowed');
  rp.recordResult('b', origin, 'healthy', null);
  assert.equal(rp.canRetry('b', origin).allowed, true, 'key b has 1 attempt left');
}

// ── Circuit breaker trips on consecutive blocking states ─────────────
{
  const rp = createRetryPolicy({ maxRetries: 10, circuitBreakerThreshold: 3 });
  const origin = 'linkedin.com';

  // 3 consecutive blocking states from different keys => circuit broken
  rp.recordResult('page-1', origin, 'active_challenge', 'captcha on page 1');
  assert.equal(rp.isCircuitBroken(origin), false);
  rp.recordResult('page-2', origin, 'blocked', 'blocked on page 2');
  assert.equal(rp.isCircuitBroken(origin), false);
  rp.recordResult('page-3', origin, 'blocked', 'blocked on page 3');
  assert.equal(rp.isCircuitBroken(origin), true, 'circuit broken after 3 consecutive blocks');

  const d = rp.canRetry('page-4', origin);
  assert.equal(d.allowed, false, 'new key denied because circuit broken');
  assert.ok(d.reason.includes('Circuit broken'), 'reason mentions circuit broken');
}

// ── Circuit breaker does NOT trip on non-blocking states ─────────────
{
  const rp = createRetryPolicy({ maxRetries: 10, circuitBreakerThreshold: 3 });
  const origin = 'linkedin.com';

  rp.recordResult('page-1', origin, 'active_challenge', 'x');
  rp.recordResult('page-2', origin, 'healthy', null);
  assert.equal(rp.isCircuitBroken(origin), false, 'healthy resets consecutive count');

  rp.recordResult('page-3', origin, 'transient_error', 'timeout');
  assert.equal(rp.isCircuitBroken(origin), false, 'transient_error not a circuit-breaker state');

  rp.recordResult('page-4', origin, 'active_challenge', 'x');
  rp.recordResult('page-5', origin, 'rate_limited', 'x');
  rp.recordResult('page-6', origin, 'blocked', 'x');
  assert.equal(rp.isCircuitBroken(origin), true, '3 consecutive blocks after reset => broken');
}

// ── Different origins have independent circuits ──────────────────────
{
  const rp = createRetryPolicy({ maxRetries: 10, circuitBreakerThreshold: 2 });
  const origin1 = 'linkedin.com';
  const origin2 = 'linkedin-detail';

  rp.recordResult('a', origin1, 'active_challenge', 'x');
  rp.recordResult('b', origin1, 'blocked', 'x');
  assert.equal(rp.isCircuitBroken(origin1), true, 'origin1 broken');
  assert.equal(rp.isCircuitBroken(origin2), false, 'origin2 still healthy');
}

// ── getStats returns correct snapshot ─────────────────────────────────
{
  const rp = createRetryPolicy({ maxRetries: 3, circuitBreakerThreshold: 3 });
  rp.recordResult('k1', 'o1', 'active_challenge', 'test');
  rp.recordResult('k1', 'o1', 'healthy', null);
  rp.recordResult('k2', 'o2', 'blocked', 'test');

  const stats = rp.getStats();
  assert.equal(stats.keys.length, 2);
  assert.equal(stats.origins.length, 2);
  assert.equal(stats.maxRetries, 3);
  assert.equal(stats.circuitBreakerThreshold, 3);

  const k1 = stats.keys.find((k) => k.key === 'k1');
  assert.equal(k1.attempts, 2);
  assert.deepEqual(k1.states, ['active_challenge', 'healthy']);
  assert.equal(k1.exhausted, false);

  const o1 = stats.origins.find((o) => o.origin === 'o1');
  assert.equal(o1.consecutiveBlocking, 0, 'healthy reset consecutive');
  assert.equal(o1.broken, false);

  const o2 = stats.origins.find((o) => o.origin === 'o2');
  assert.equal(o2.consecutiveBlocking, 1);
  assert.equal(o2.broken, false);
}

console.log('retry-policy legacy tests: PASS');

// ═══ Strict source mode (S04) ═════════════════════════════════════

// ── S1: first canonical block terminates the whole source ──────────
{
  const rp = createStrictSourceRetryPolicy();
  assert.equal(rp.canRetry('page-1', 'linkedin.com').allowed, true);
  rp.recordResult('page-1', 'linkedin.com', 'blocked', 'HTTP 403');
  const d1 = rp.canRetry('page-2', 'linkedin.com');
  assert.equal(d1.allowed, false, 'any key denied after first block');
  assert.equal(d1.verdict, RETRY_VERDICT.SOURCE_TERMINATED);
  assert.match(d1.reason, /Source terminated after first blocked observation/);
  const d2 = rp.canRetry('other-key', 'other-origin');
  assert.equal(d2.allowed, false, 'termination is source-wide, not per-origin');
  assert.equal(rp.isCircuitBroken('anything'), true, 'strict termination dominates isCircuitBroken');
  const t = rp.isSourceTerminated();
  assert.equal(t.terminated, true);
  assert.equal(t.state, 'blocked');
  assert.equal(t.key, 'page-1');
  console.log('  S1. first block terminates source: PASS');
}

// ── S2: each canonical restriction state terminates on first sight ─
{
  for (const state of ['active_challenge', 'rate_limited', 'login_required']) {
    const rp = createStrictSourceRetryPolicy();
    rp.recordResult('k', 'linkedin.com', state, `observed ${state}`);
    const d = rp.canRetry('k2', 'linkedin.com');
    assert.equal(d.allowed, false, `${state} terminates`);
    assert.equal(d.verdict, RETRY_VERDICT.SOURCE_TERMINATED, `${state} verdict`);
  }
  console.log('  S2. challenge/rate-limit/login-required all terminate: PASS');
}

// ── S3: non-blocking chains do not terminate; key exhaustion intact ─
{
  const rp = createStrictSourceRetryPolicy({ maxRetries: 2 });
  rp.recordResult('k1', 'linkedin.com', 'healthy', null);
  rp.recordResult('k1', 'linkedin.com', 'transient_error', 'timeout');
  assert.equal(rp.isSourceTerminated().terminated, false, 'no canonical restriction observed');
  const d = rp.canRetry('k1', 'linkedin.com');
  assert.equal(d.allowed, false, 'per-key exhaustion still applies in strict mode');
  assert.equal(d.verdict, RETRY_VERDICT.KEY_EXHAUSTED);
  assert.equal(rp.isSourceTerminated().terminated, false);
  console.log('  S3. strict non-blocking chain: exhaustion without termination: PASS');
}

// ── S4: legacy behavior preserved, including login_required not a ──
// ──    circuit-breaker state and per-policy independence ───────────
{
  const legacy = createRetryPolicy({ maxRetries: 10, circuitBreakerThreshold: 3 });
  for (let i = 0; i < 5; i++) legacy.recordResult(`p${i}`, 'linkedin.com', 'login_required', 'x');
  assert.equal(legacy.isCircuitBroken('linkedin.com'), false, 'login_required never breaks a legacy circuit (unchanged behavior)');
  assert.equal(legacy.canRetry('p9', 'linkedin.com').allowed, true);

  const strict = createStrictSourceRetryPolicy();
  strict.recordResult('k', 'o', 'blocked', 'x');
  const legacy2 = createRetryPolicy({ maxRetries: 3, circuitBreakerThreshold: 3 });
  assert.equal(legacy2.canRetry('k', 'o').allowed, true, 'strict termination does not leak into other policies');
  console.log('  S4. legacy behavior and policy independence: PASS');
}

// ── S5: decision shape and stats expose the strict state ────────────
{
  const rp = createStrictSourceRetryPolicy();
  const allowed = rp.canRetry('k', 'o');
  assert.equal(allowed.verdict, RETRY_VERDICT.ALLOWED, 'allow carries a verdict');
  assert.equal(allowed.allowed, true);
  rp.recordResult('k', 'o', 'blocked', 'x');
  const stats = rp.getStats();
  assert.equal(stats.strictSource, true);
  assert.equal(stats.sourceTerminated.state, 'blocked');
  // Legacy decisions keep their compatibility surface.
  const legacy = createRetryPolicy({ maxRetries: 1, circuitBreakerThreshold: 2 });
  legacy.recordResult('k', 'o', 'transient_error', 'x');
  const d = legacy.canRetry('k', 'o');
  assert.equal(d.allowed, false);
  assert.ok(typeof d.reason === 'string' && d.reason.includes('exhausted'), 'legacy reason text unchanged');
  console.log('  S5. decision shape + stats: PASS');
}

// ── S6: first LinkedIn blocking state terminates origin ─────────────
// One shared source-wide strict policy drives both the search phase and
// the detail phase (the shape the strict caller wires): a restriction
// observed on any page stops every later navigation, on either phase.
{
  const rp = createStrictSourceRetryPolicy({ maxRetries: 3 });
  assert.equal(rp.canRetry('search:q1:0', 'linkedin.com').allowed, true);
  // First blocking observation anywhere terminates the source.
  rp.recordResult('search:q1:0', 'linkedin.com', 'rate_limited', 'rate limit page');
  assert.equal(rp.isSourceTerminated().terminated, true, 'first canonical restriction terminates the source');
  assert.equal(rp.isSourceTerminated().state, 'rate_limited');
  // Search-phase continuation is stopped.
  const dSearch = rp.canRetry('search:q1:7', 'linkedin.com');
  assert.equal(dSearch.allowed, false);
  assert.equal(dSearch.verdict, RETRY_VERDICT.SOURCE_TERMINATED);
  // Detail-phase navigation on an unrelated key is stopped before sending,
  // including a detail fetch's first attempt.
  const dDetail = rp.canRetry('view:12345', 'linkedin.com');
  assert.equal(dDetail.allowed, false);
  assert.equal(dDetail.verdict, RETRY_VERDICT.SOURCE_TERMINATED);
  assert.ok(typeof dDetail.reason === 'string' && dDetail.reason.includes('rate_limited'), 'termination reason names the observed state');
  console.log('  S6. first LinkedIn blocking state terminates origin: PASS');
}

// ── S7: bounded transient retries stay finite under the shared policy ─
// Transient errors never terminate the source, but each key stops after
// maxRetries — no unbounded loops on one shared policy instance.
{
  const rp = createStrictSourceRetryPolicy({ maxRetries: 3 });
  const keys = ['search:q1:0', 'search:q1:7', 'search:q2:0'];
  for (const key of keys) {
    for (let attempt = 0; attempt < 3; attempt++) {
      rp.recordResult(key, 'linkedin.com', 'transient_error', 'cdp timeout');
    }
    const d = rp.canRetry(key, 'linkedin.com');
    assert.equal(d.allowed, false, `${key} stops after its capped attempts`);
    assert.equal(d.verdict, RETRY_VERDICT.KEY_EXHAUSTED);
  }
  assert.equal(rp.isSourceTerminated().terminated, false, 'transient errors never terminate the source');
  // A fresh key stays reachable — exhaustion is per key, not a hidden loop.
  assert.equal(rp.canRetry('view:99999', 'linkedin.com').allowed, true);
  const stats = rp.getStats();
  assert.equal(stats.strictSource, true);
  console.log('  S7. bounded transient retries stay finite under the shared policy: PASS');
}

console.log('retry-policy tests: PASS');
