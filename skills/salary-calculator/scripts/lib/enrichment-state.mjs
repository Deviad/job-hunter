// Enrichment state UPSERT helper for job_enrichment_state.
//
// Core responsibility: apply per-axis retry transitions (exact OR benchmark)
// to job_enrichment_state without ever clobbering the other axis (RETRY-04
// independence). First write inserts a default row; subsequent writes UPDATE
// only the 5 columns of the named axis.
//
// PRECONDITION: All write operations (applyRetryTransition) assume the caller
// holds the `salary_writer_lock` for this `db` connection. This module does
// NOT acquire the lock — see Phase v1.0-09 orchestrator for the lock-
// acquisition boundary. Calling without the lock risks SQLITE_BUSY under
// concurrent writers.
//
// SQL design:
//   * Two hardcoded UPDATE statements (one per axis) — no dynamic SQL column-
//     name interpolation (injection-safe + prepared-statement-cache-friendly).
//   * `updated_at` is OMITTED from every UPDATE SET clause; the
//     `trg_state_updated` trigger bumps it AFTER UPDATE (single source of
//     truth — RESEARCH Pitfall #4).
//   * Two-step INSERT-OR-IGNORE → UPDATE rather than `ON CONFLICT DO UPDATE`
//     for sqlite3-version portability and easier reasoning about idempotence.

const VALID_AXES = new Set(['exact', 'benchmark']);
const VALID_STATUSES = new Set(['pending', 'found', 'not_found', 'error']);

const INSERT_DEFAULT_SQL = `INSERT OR IGNORE INTO job_enrichment_state
  (job_source, job_id, exact_status, exact_attempt_count, benchmark_status, benchmark_attempt_count)
  VALUES (?, ?, 'pending', 0, 'pending', 0)`;

const UPDATE_EXACT_SQL = `UPDATE job_enrichment_state
  SET exact_status = ?,
      exact_attempt_count = ?,
      next_exact_retry_at = ?,
      exact_last_attempt_at = ?,
      exact_error = ?
  WHERE job_source = ? AND job_id = ?`;

const UPDATE_BENCHMARK_SQL = `UPDATE job_enrichment_state
  SET benchmark_status = ?,
      benchmark_attempt_count = ?,
      next_benchmark_retry_at = ?,
      benchmark_last_attempt_at = ?,
      benchmark_error = ?
  WHERE job_source = ? AND job_id = ?`;

// forceResetAxis SQL — two hardcoded per-axis statements (no dynamic column
// interpolation, mirrors v1.0-09 Plan 03 injection-safety pattern). The
// trg_state_updated trigger bumps updated_at on UPDATE (single source of
// truth — RESEARCH Pitfall #4); these SET clauses deliberately OMIT
// updated_at. Resets touch ONLY the named axis's 5 columns; the OTHER axis
// is preserved byte-for-byte (RETRY-04 axis independence).
const RESET_EXACT_SQL = `UPDATE job_enrichment_state
  SET exact_status = 'pending',
      exact_attempt_count = 0,
      next_exact_retry_at = NULL,
      exact_error = NULL,
      exact_last_attempt_at = NULL
  WHERE job_source = ? AND job_id = ?`;

const RESET_BENCHMARK_SQL = `UPDATE job_enrichment_state
  SET benchmark_status = 'pending',
      benchmark_attempt_count = 0,
      next_benchmark_retry_at = NULL,
      benchmark_error = NULL,
      benchmark_last_attempt_at = NULL
  WHERE job_source = ? AND job_id = ?`;

const SELECT_STATE_SQL = `SELECT * FROM job_enrichment_state WHERE job_source = ? AND job_id = ?`;

// Prepared-statement cache, keyed by db handle (mirrors salary-db.mjs pattern).
const stmtCache = new WeakMap();

function getStmts(db) {
  let cached = stmtCache.get(db);
  if (!cached) {
    cached = {
      insertDefault: db.prepare(INSERT_DEFAULT_SQL),
      updateExact: db.prepare(UPDATE_EXACT_SQL),
      updateBenchmark: db.prepare(UPDATE_BENCHMARK_SQL),
      resetExact: db.prepare(RESET_EXACT_SQL),
      resetBenchmark: db.prepare(RESET_BENCHMARK_SQL),
      selectState: db.prepare(SELECT_STATE_SQL),
    };
    stmtCache.set(db, cached);
  }
  return cached;
}

/**
 * UPSERT job_enrichment_state for (jobSource, jobId), mutating ONLY the
 * named axis. The other axis's columns are preserved verbatim, which is the
 * storage-layer guarantee for RETRY-04 (axis independence).
 *
 * PRECONDITION: caller holds the salary_writer_lock.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} jobSource
 * @param {string} jobId
 * @param {'exact'|'benchmark'} axis
 * @param {{status: string, attemptCount: number, nextRetryAtIso: (string|null), errorMessage: (string|null)}} transition
 * @param {string} nowIso - ISO-8601 timestamp recorded as <axis>_last_attempt_at
 * @returns {{inserted: boolean, axis: string}}
 */
export function applyRetryTransition(db, jobSource, jobId, axis, transition, nowIso) {
  if (!VALID_AXES.has(axis)) {
    throw new TypeError(`applyRetryTransition: invalid axis '${axis}' (must be 'exact' or 'benchmark')`);
  }
  if (!transition || typeof transition !== 'object') {
    throw new TypeError('applyRetryTransition: transition must be a non-null object');
  }
  if (!VALID_STATUSES.has(transition.status)) {
    throw new TypeError(`applyRetryTransition: invalid transition.status '${transition.status}' (must be one of pending|found|not_found|error)`);
  }

  const stmts = getStmts(db);

  const insertResult = stmts.insertDefault.run(jobSource, jobId);
  const inserted = insertResult.changes === 1;

  const stmt = axis === 'exact' ? stmts.updateExact : stmts.updateBenchmark;
  stmt.run(
    transition.status,
    transition.attemptCount,
    transition.nextRetryAtIso ?? null,
    nowIso,
    transition.errorMessage ?? null,
    jobSource,
    jobId,
  );

  return { inserted, axis };
}

/**
 * Force-reset the named axis to its pristine ('pending', count=0, next NULL)
 * state, leaving the OTHER axis byte-for-byte unchanged. Used by the batch
 * CLI's `--force-exact-retry` / `--force-benchmark-retry` flags.
 *
 * Behavior:
 *   1. INSERT OR IGNORE default row (ensures UPDATE has a target row).
 *   2. UPDATE the 5 columns of the named axis to their pristine defaults:
 *        <axis>_status            = 'pending'
 *        <axis>_attempt_count     = 0
 *        next_<axis>_retry_at     = NULL
 *        <axis>_error             = NULL
 *        <axis>_last_attempt_at   = NULL
 *
 * Axis independence (RETRY-04): the OTHER axis's 5 columns are NEVER named in
 * the UPDATE SET clause, so they remain byte-for-byte equal pre/post — proved
 * by force-reset-axis.test.mjs snapshot tests.
 *
 * @precondition Caller holds the salary_writer_lock for this db connection.
 * @note updated_at is bumped by the trg_state_updated trigger (single source
 *       of truth — RESEARCH Pitfall #4). This function does NOT write
 *       updated_at directly.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} jobSource
 * @param {string} jobId
 * @param {'exact'|'benchmark'} axis - must be one of 'exact' or 'benchmark'
 * @returns {{reset: boolean, axis: string}}
 * @throws {TypeError} on invalid axis
 */
export function forceResetAxis(db, jobSource, jobId, axis) {
  if (!VALID_AXES.has(axis)) {
    throw new TypeError(`forceResetAxis: invalid axis '${axis}' (must be 'exact' or 'benchmark')`);
  }

  const stmts = getStmts(db);

  // Ensure a row exists so the UPDATE has a target.
  stmts.insertDefault.run(jobSource, jobId);

  const stmt = axis === 'exact' ? stmts.resetExact : stmts.resetBenchmark;
  const result = stmt.run(jobSource, jobId);

  return { reset: result.changes === 1, axis };
}

/**
 * Read the full job_enrichment_state row for (jobSource, jobId). Returns the
 * raw snake_case row shape (or null when no row exists). Consumed by Plan 04
 * pipeline + Plan 05 CLI envelope formatter.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} jobSource
 * @param {string} jobId
 * @returns {object|null}
 */
export function getEnrichmentState(db, jobSource, jobId) {
  const stmts = getStmts(db);
  const row = stmts.selectState.get(jobSource, jobId);
  return row ?? null;
}
