#!/usr/bin/env node
/**
 * Unit tests for retry-policy.mjs — pure module, no CDP/browser/network.
 */
import assert from 'node:assert/strict';
import { createRetryPolicy } from './retry-policy.mjs';

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

console.log('retry-policy tests: PASS');
