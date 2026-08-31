// Phase v1.0-09 Plan 02 — Pure retry state machine.
//
// Two exported functions: computeNextRetry, classifyError.
// Zero I/O, zero wall-clock reads, zero module-scope mutable state.
// Same inputs → byte-identical outputs (RETRY-03 reproducibility).

const NOT_FOUND_DAYS = { exact: 14, benchmark: 30 };
const MAX_TRANSIENT_ATTEMPTS = 5;
const BACKOFF_CAP_DAYS = 7;

/**
 * Compute the next retry-state for one axis given previous state + outcome event.
 * Pure function — no I/O, no wall-clock reads, no module-scope mutable state.
 *
 * @param {object} args
 * @param {'exact'|'benchmark'} args.axis
 * @param {string} args.prevStatus
 * @param {number} args.prevAttemptCount
 * @param {{kind:'success'|'not_found'|'transient_error'|'unrecoverable_error', message?:string}} args.event
 * @param {string} args.nowIso  ISO 8601 timestamp
 * @returns {{status:string, attemptCount:number, nextRetryAtIso:string|null, errorMessage:string|null}}
 */
export function computeNextRetry({ axis, prevStatus, prevAttemptCount, event, nowIso }) {
  if (axis !== 'exact' && axis !== 'benchmark') {
    throw new TypeError('unknown axis: ' + axis);
  }
  void prevStatus;
  const newCount = prevAttemptCount + 1;
  const addDays = (n) => new Date(new Date(nowIso).getTime() + n * 86400000).toISOString();

  switch (event.kind) {
    case 'success':
      return {
        status: 'found',
        attemptCount: newCount,
        nextRetryAtIso: null,
        errorMessage: null,
      };
    case 'not_found':
      return {
        status: 'not_found',
        attemptCount: newCount,
        nextRetryAtIso: addDays(NOT_FOUND_DAYS[axis]),
        errorMessage: null,
      };
    case 'unrecoverable_error':
      return {
        status: 'error',
        attemptCount: newCount,
        nextRetryAtIso: null,
        errorMessage: event.message ?? null,
      };
    case 'transient_error': {
      if (newCount > MAX_TRANSIENT_ATTEMPTS) {
        return {
          status: 'error',
          attemptCount: newCount,
          nextRetryAtIso: null,
          errorMessage: event.message ?? null,
        };
      }
      const days = Math.min(Math.pow(2, newCount - 1), BACKOFF_CAP_DAYS);
      return {
        status: 'error',
        attemptCount: newCount,
        nextRetryAtIso: addDays(days),
        errorMessage: event.message ?? null,
      };
    }
    default:
      throw new RangeError('unknown event kind: ' + event.kind);
  }
}

/**
 * Map an adapter return value or thrown error to the closed-set retry event taxonomy.
 * Pure function. No I/O.
 *
 * @param {Array|Error|Response|*} result  Adapter return value (Array of candidates) OR thrown error/Response.
 * @param {object} [ctx]                   Reserved for future context-aware classification (unused in v1).
 * @returns {{kind:'success'|'not_found'|'transient_error'|'unrecoverable_error', message?:string}}
 */
export function classifyError(result, ctx = {}) {
  void ctx;

  // 1. Array branch — self-contained, must NOT fall through (opencode improvement #2).
  if (Array.isArray(result)) {
    const hasSuccess = result.some(
      (c) =>
        c &&
        (c.extraction_status === null || c.extraction_status === undefined) &&
        c.is_posted_salary === 1,
    );
    const allMarkers =
      result.length > 0 &&
      result.every(
        (c) =>
          c &&
          (c.extraction_status === 'absent' ||
            c.extraction_status === 'competitive' ||
            c.extraction_status === 'doe'),
      );
    // Branch A — at least one real candidate
    if (hasSuccess) return { kind: 'success' };
    // Branch B — empty or all-markers
    if (result.length === 0 || allMarkers) return { kind: 'not_found' };
    // Branch C (EXPLICIT else for arrays) — non-empty, not all markers, no success.
    // HTTP succeeded, parser produced output, but nothing usable. NOT unrecoverable.
    return { kind: 'not_found', message: 'array contained no usable candidate' };
  }

  // 2. Response duck-type (check BEFORE instanceof Error — Responses are object-like).
  if (result && typeof result.status === 'number' && typeof result.ok === 'boolean') {
    const status = result.status;
    if (status === 404) return { kind: 'not_found' };
    if (status === 401 || status === 403) {
      return { kind: 'unrecoverable_error', message: 'HTTP ' + status };
    }
    if (status >= 500) return { kind: 'transient_error', message: 'HTTP ' + status };
    return { kind: 'unrecoverable_error', message: 'HTTP ' + status };
  }

  // 3. TypeError — fetch failure / network transport
  if (result instanceof TypeError) {
    return { kind: 'transient_error', message: result.message };
  }

  // 4. Generic Error
  if (result instanceof Error) {
    if (result.code === 'ECONNRESET' || result.code === 'ETIMEDOUT') {
      return { kind: 'transient_error', message: result.message };
    }
    const httpMatch = /^HTTP (\d{3})/.exec(result.message);
    if (httpMatch) {
      const parsed = Number(httpMatch[1]);
      return classifyError({ status: parsed, ok: false });
    }
    if (/Job title not found in ITJobsWatch/.test(result.message)) {
      return { kind: 'not_found' };
    }
    return { kind: 'unrecoverable_error', message: result.message };
  }

  // 5. Fallback
  return { kind: 'unrecoverable_error', message: result?.message ?? String(result) };
}
