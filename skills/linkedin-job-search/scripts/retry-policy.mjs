/**
 * Finite retry policy for CDP-based LinkedIn scraping.
 *
 * Pure ESM module — no npm dependencies, no CDP/browser/network.
 * Designed to be importable in unit tests without any live infrastructure.
 *
 * Key contract:
 *   - Every resource is identified by a string key (typically a URL).
 *   - Every resource belongs to an origin (typically a hostname).
 *   - `canRetry(key, origin)` returns whether another attempt is allowed;
 *      it is the caller's responsibility to back off based on the attempt count.
 *   - `recordResult(key, origin, state, reason)` updates the tracker after
 *      each attempt regardless of outcome.
 *   - The circuit breaker trips when `circuitBreakerThreshold` consecutive
 *      attempts across the same origin return a blocking state (active_challenge,
 *      blocked, rate_limited). Once tripped, that origin is terminal.
 *
 * Usage:
 *   import { createRetryPolicy } from './retry-policy.mjs';
 *   const rp = createRetryPolicy({ maxRetries: 3, circuitBreakerThreshold: 3 });
 *
 *   const decision = rp.canRetry(someUrl, 'linkedin.com');
 *   if (!decision.allowed) { // terminal: stop retrying
 *     return;
 *   }
 *   // ... attempt ...
 *   rp.recordResult(someUrl, 'linkedin.com', 'active_challenge', 'CAPTCHA detected');
 */

/**
 * Retry-policy states the retry module itself uses to communicate decisions.
 */
export const RETRY_VERDICT = {
  ALLOWED: 'allowed',
  KEY_EXHAUSTED: 'key_exhausted',
  CIRCUIT_BROKEN: 'circuit_broken',
};

/**
 * @param {object} opts
 * @param {number} [opts.maxRetries=3]      max attempts per key
 * @param {number} [opts.circuitBreakerThreshold=3] consecutive blocking states across origin before circuit breaks
 * @returns {object} policy handle
 */
export function createRetryPolicy({ maxRetries = 3, circuitBreakerThreshold = 3 } = {}) {
  const keyTracker = new Map();    // key → { attempts, states[] }
  const originTracker = new Map(); // origin → { consecutive: number, broken: boolean }

  /**
   * Check whether another attempt on `key` within `origin` is allowed.
   * @param {string} key    resource identifier (URL, job ID, etc.)
   * @param {string} origin hostname or logical group (e.g. 'linkedin.com', 'linkedin-search', 'linkedin-detail')
   * @returns {{ allowed: boolean, reason?: string }}
   */
  function canRetry(key, origin) {
    const o = originTracker.get(origin);
    if (o?.broken) {
      return { allowed: false, reason: `Circuit broken for origin "${origin}" after ${circuitBreakerThreshold} consecutive blocking states` };
    }
    const k = keyTracker.get(key);
    if (!k || k.attempts < maxRetries) {
      return { allowed: true };
    }
    return { allowed: false, reason: `Key "${key}" exhausted after ${maxRetries} retries (last state: ${k.states[k.states.length - 1]?.state})` };
  }

  /**
   * Record the result of an attempt and update circuit state.
   * Call this regardless of success/failure so tracking stays accurate.
   * @param {string} key
   * @param {string} origin
   * @param {string} state   PAGE_STATE value of the result
   * @param {string} [reason] description
   */
  function recordResult(key, origin, state, reason = null) {
    // Per-key tracking
    let k = keyTracker.get(key);
    if (!k) {
      k = { attempts: 0, states: [] };
      keyTracker.set(key, k);
    }
    k.attempts++;
    k.states.push({ state, reason });

    // Per-origin circuit breaker: only advance on blocking states
    let o = originTracker.get(origin);
    if (!o) {
      o = { consecutive: 0, broken: false };
      originTracker.set(origin, o);
    }
    if (state === 'active_challenge' || state === 'blocked' || state === 'rate_limited') {
      o.consecutive++;
      if (o.consecutive >= circuitBreakerThreshold) {
        o.broken = true;
      }
    } else {
      o.consecutive = 0;
    }
  }

  /**
   * Check whether the circuit is currently broken for an origin.
   */
  function isCircuitBroken(origin) {
    return originTracker.get(origin)?.broken === true;
  }

  /**
   * Return an immutable snapshot of the current tracking state.
   * Useful for terminal run reporting.
   */
  function getStats() {
    const keys = [];
    for (const [key, k] of keyTracker) {
      keys.push({
        key,
        attempts: k.attempts,
        exhausted: k.attempts >= maxRetries,
        states: k.states.map((s) => s.state),
      });
    }
    const origins = [];
    for (const [origin, o] of originTracker) {
      origins.push({
        origin,
        consecutiveBlocking: o.consecutive,
        broken: o.broken,
      });
    }
    return { keys, origins, maxRetries, circuitBreakerThreshold };
  }

  return { canRetry, recordResult, isCircuitBroken, getStats };
}
