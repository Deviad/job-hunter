// Salary observation persistence layer.
//
// Core responsibility: INSERT and SELECT salary observations with conflict handling
// (idempotency via observation_id uniqueness) and pre-flight validation.
//
// The CHECK partition enforced by SQLite ensures that exact observations
// (benchmark_id IS NULL, is_posted_salary=1) are strictly separated from estimate
// observations (benchmark_id IS NOT NULL, is_posted_salary=0). This module validates
// the partition in application code (friendlier error messages) before passing to SQL;
// SQL remains the authoritative gate.
//
// PRECONDITION: All write operations (insertObservation) assume the caller holds
// the salary_writer_lock (acquired via BEGIN IMMEDIATE in writer-lock.mjs).
// This module does NOT acquire the lock — see Phase v1.0-09 orchestrator (bin/salary-cli).
// Calling without the lock risks SQLITE_BUSY under concurrent writers.

import { calculateObservationId } from './observation-id.mjs';

// Sourced from scripts/lib/salary-schema.mjs lines 109-114 (exact-side CHECK partition); keep in sync
export const EXACT_CONFIDENCE_LABELS = Object.freeze([
  'posted_exact',
  'external_exact',
  'api_exact_match',
  'unknown_exact',
]);

// Sourced from scripts/lib/salary-schema.mjs lines 116-122 (estimate-side CHECK partition); keep in sync
export const ESTIMATE_CONFIDENCE_LABELS = Object.freeze([
  'aggregated_exact_title',
  'company_benchmark',
  'estimated_market',
  'official_baseline',
  'unknown_estimate',
]);

// Sourced from scripts/lib/salary-schema.mjs line 74 (period CHECK); keep in sync
const VALID_PERIODS = Object.freeze(['hour', 'day', 'week', 'month', 'year']);

// Sourced from scripts/lib/salary-schema.mjs lines 75-77 (compensation_type CHECK); keep in sync
const VALID_COMPENSATION_TYPES = Object.freeze(['base_salary', 'total_compensation', 'ote', 'contract_rate', 'unknown']);

// Sourced from scripts/lib/salary-schema.mjs lines 55-65 (matched_by CHECK); keep in sync
const VALID_MATCHED_BY = Object.freeze(['exact_job', 'title_company_location', 'title_company', 'role_location', 'company_role_level', 'occupation_baseline', 'manual']);

/**
 * Insert one salary observation using INSERT OR IGNORE semantics (DB-06 idempotency).
 *
 * PRECONDITION: Caller MUST hold the `salary_writer_lock` (acquired via
 * BEGIN IMMEDIATE in writer-lock.mjs) for this `db` connection. This function
 * does NOT acquire the lock — see Phase v1.0-09 orchestrator (bin/salary-cli)
 * for the lock-acquisition boundary. Calling this without holding the writer
 * lock risks SQLITE_BUSY under concurrent writers.
 *
 * @param {Database} db - better-sqlite3 connection inside an active writer-lock transaction
 * @param {object} observation - validated observation payload
 * @param {object} [opts] - optional parameters (reserved for future use)
 * @returns {{ observation_id: string, inserted: boolean, changes: number }}
 */
export function insertObservation(db, observation, opts = {}) {
  // Pre-flight validation (throws Error with descriptive message; happens BEFORE any DB roundtrip)
  const errors = [];

  if (!observation || typeof observation !== 'object') {
    throw new Error('observation must be a non-null object');
  }

  if (!observation.job_source || typeof observation.job_source !== 'string' || observation.job_source.trim() === '') {
    errors.push('job_source must be a non-empty string');
  }

  if (!observation.job_id || typeof observation.job_id !== 'string' || observation.job_id.trim() === '') {
    errors.push('job_id must be a non-empty string');
  }

  if (!observation.data_source || typeof observation.data_source !== 'string' || observation.data_source.trim() === '') {
    errors.push('data_source must be a non-empty string');
  }

  if (!observation.currency || typeof observation.currency !== 'string' || observation.currency.length !== 3) {
    errors.push('currency must be a 3-letter string');
  }

  if (!VALID_PERIODS.includes(observation.period)) {
    errors.push(`period must be one of: ${VALID_PERIODS.join(', ')}`);
  }

  if (!VALID_COMPENSATION_TYPES.includes(observation.compensation_type)) {
    errors.push(`compensation_type must be one of: ${VALID_COMPENSATION_TYPES.join(', ')}`);
  }

  const all_confidence_labels = [...EXACT_CONFIDENCE_LABELS, ...ESTIMATE_CONFIDENCE_LABELS];
  if (!all_confidence_labels.includes(observation.confidence_label)) {
    errors.push(`confidence_label must be one of: ${all_confidence_labels.join(', ')}`);
  }

  if (!VALID_MATCHED_BY.includes(observation.matched_by)) {
    errors.push(`matched_by must be one of: ${VALID_MATCHED_BY.join(', ')}`);
  }

  if (observation.is_posted_salary !== 0 && observation.is_posted_salary !== 1) {
    errors.push('is_posted_salary must be 0 or 1');
  }

  if (observation.is_predicted !== 0 && observation.is_predicted !== 1) {
    errors.push('is_predicted must be 0 or 1');
  }

  // At least one of amount_min, amount_max, amount_median must be a finite number
  const hasValidAmount = (
    (Number.isFinite(observation.amount_min)) ||
    (Number.isFinite(observation.amount_max)) ||
    (Number.isFinite(observation.amount_median))
  );
  if (!hasValidAmount) {
    errors.push('At least one of amount_min, amount_max, amount_median must be a number');
  }

  // Cross-field consistency (mirrors the schema CHECK so we get a friendlier error message before SQLite fires)
  if (observation.is_posted_salary === 1) {
    if (observation.benchmark_id != null) {
      errors.push('Exact observations (is_posted_salary=1) must have benchmark_id IS NULL');
    }
    if (!EXACT_CONFIDENCE_LABELS.includes(observation.confidence_label)) {
      errors.push(`Exact observations (is_posted_salary=1) must have confidence_label in: ${EXACT_CONFIDENCE_LABELS.join(', ')}`);
    }
  }

  if (observation.is_posted_salary === 0) {
    if (observation.benchmark_id == null || observation.benchmark_id === '') {
      errors.push('Estimate observations (is_posted_salary=0) must have a non-empty benchmark_id');
    }
    if (!ESTIMATE_CONFIDENCE_LABELS.includes(observation.confidence_label)) {
      errors.push(`Estimate observations (is_posted_salary=0) must have confidence_label in: ${ESTIMATE_CONFIDENCE_LABELS.join(', ')}`);
    }
  }

  if (observation.is_predicted === 1) {
    if (observation.is_posted_salary !== 0) {
      errors.push('Predicted observations (is_predicted=1) must have is_posted_salary=0');
    }
    if (observation.benchmark_id == null || observation.benchmark_id === '') {
      errors.push('Predicted observations (is_predicted=1) must have a non-empty benchmark_id');
    }
  }

  if (errors.length > 0) {
    throw new Error(`Invalid observation: ${errors.join('; ')}`);
  }

  // Compute identity
  const observation_id = calculateObservationId(observation);

  // Build INSERT OR IGNORE statement against job_salary_observations
  // Bind every column from the schema; use null for optional columns the observation does not set
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO job_salary_observations (
      job_source, job_id, observation_id,
      data_source, data_source_url, benchmark_id,
      confidence_label, matched_by,
      is_posted_salary, is_predicted,
      currency, amount_min, amount_max, amount_median, period, compensation_type,
      annualized_min, annualized_max, annualized_median, annualization_note,
      fx_currency, fx_annualized_median, fx_rate, fx_rate_as_of,
      location_raw, country_code, region, city,
      evidence_snippet, raw_payload_json
    ) VALUES (
      @job_source, @job_id, @observation_id,
      @data_source, @data_source_url, @benchmark_id,
      @confidence_label, @matched_by,
      @is_posted_salary, @is_predicted,
      @currency, @amount_min, @amount_max, @amount_median, @period, @compensation_type,
      @annualized_min, @annualized_max, @annualized_median, @annualization_note,
      @fx_currency, @fx_annualized_median, @fx_rate, @fx_rate_as_of,
      @location_raw, @country_code, @region, @city,
      @evidence_snippet, @raw_payload_json
    )
  `);

  // Normalize the observation: handle optional fields as null if missing
  const normalizedObs = {
    ...observation,
    observation_id,
    data_source_url: observation.data_source_url ?? null,
    benchmark_id: observation.benchmark_id ?? null,
    annualized_min: observation.annualized_min ?? null,
    annualized_max: observation.annualized_max ?? null,
    annualized_median: observation.annualized_median ?? null,
    annualization_note: observation.annualization_note ?? null,
    fx_currency: observation.fx_currency ?? null,
    fx_annualized_median: observation.fx_annualized_median ?? null,
    fx_rate: observation.fx_rate ?? null,
    fx_rate_as_of: observation.fx_rate_as_of ?? null,
    location_raw: observation.location_raw ?? null,
    country_code: observation.country_code ?? null,
    region: observation.region ?? null,
    city: observation.city ?? null,
    evidence_snippet: observation.evidence_snippet ?? null,
    raw_payload_json: (typeof observation.raw_payload_json === 'string')
      ? observation.raw_payload_json
      : (observation.raw_payload_json ? JSON.stringify(observation.raw_payload_json) : null),
  };

  let result;
  try {
    result = stmt.run(normalizedObs);
  } catch (err) {
    // Re-throw better-sqlite3 errors with context
    if (err.message && err.message.includes('FOREIGN KEY')) {
      throw new Error(`Foreign key constraint failed: ${err.message}`);
    }
    if (err.message && err.message.includes('CHECK')) {
      throw new Error(`CHECK constraint failed: ${err.message}`);
    }
    throw err;
  }

  return {
    observation_id,
    inserted: result.changes === 1,
    changes: result.changes,
  };
}

/**
 * Retrieve a single observation by job source, job ID, and observation ID.
 *
 * @param {Database} db - better-sqlite3 connection
 * @param {string} jobSource - job source (e.g., 'linkedin')
 * @param {string} jobId - job ID
 * @param {string} observationId - observation ID (hash)
 * @returns {object|null} - observation object or null if not found
 */
export function getObservationById(db, jobSource, jobId, observationId) {
  const stmt = db.prepare(`
    SELECT * FROM job_salary_observations
    WHERE job_source = ? AND job_id = ? AND observation_id = ?
  `);

  return stmt.get(jobSource, jobId, observationId) || null;
}

/**
 * Retrieve all observations for one job, ordered by most recent first.
 *
 * Deterministic secondary sort by observation_id ensures stable ordering for
 * observations inserted at identical timestamps (RESEARCH pitfall #6).
 *
 * @param {Database} db - better-sqlite3 connection
 * @param {string} jobSource - job source (e.g., 'linkedin')
 * @param {string} jobId - job ID
 * @returns {Array<object>} - array of observation objects (possibly empty)
 * @throws {Error} - if jobSource or jobId is not a non-empty string
 */
export function getObservationsByJob(db, jobSource, jobId) {
  if (!jobSource || typeof jobSource !== 'string' || jobSource.trim() === '') {
    throw new Error('jobSource and jobId required');
  }
  if (!jobId || typeof jobId !== 'string' || jobId.trim() === '') {
    throw new Error('jobSource and jobId required');
  }

  const stmt = db.prepare(`
    SELECT * FROM job_salary_observations
    WHERE job_source = ? AND job_id = ?
    ORDER BY observed_at DESC, observation_id ASC
  `);

  return stmt.all(jobSource, jobId);
}

/**
 * Retrieve the most recent observation for one job.
 *
 * @param {Database} db - better-sqlite3 connection
 * @param {string} jobSource - job source (e.g., 'linkedin')
 * @param {string} jobId - job ID
 * @returns {object|null} - most recent observation or null if none exist
 * @throws {Error} - if jobSource or jobId is not a non-empty string
 */
export function getLatestObservationPerJob(db, jobSource, jobId) {
  if (!jobSource || typeof jobSource !== 'string' || jobSource.trim() === '') {
    throw new Error('jobSource and jobId required');
  }
  if (!jobId || typeof jobId !== 'string' || jobId.trim() === '') {
    throw new Error('jobSource and jobId required');
  }

  const stmt = db.prepare(`
    SELECT * FROM job_salary_observations
    WHERE job_source = ? AND job_id = ?
    ORDER BY observed_at DESC, observation_id ASC
    LIMIT 1
  `);

  return stmt.get(jobSource, jobId) || null;
}

/**
 * Count observations for a job with a specific confidence label.
 *
 * @param {Database} db - better-sqlite3 connection
 * @param {string} jobSource - job source (e.g., 'linkedin')
 * @param {string} jobId - job ID
 * @param {string} confidenceLabel - confidence label to count
 * @returns {number} - count of matching observations (0 if none)
 * @throws {Error} - if jobSource/jobId are not non-empty strings, or confidenceLabel is not valid
 */
// ---------------------------------------------------------------------------
// Batch candidate query helpers (Phase v1.0-10 — BATCH-01, BATCH-02, BATCH-03)
// ---------------------------------------------------------------------------
//
// Four new exports used by the batch-mode CLI dispatch (Plan 04):
//   - selectBatchCandidates         (BATCH-01 + BATCH-02 inclusion/exclusion semantics)
//   - selectBatchCandidatesForceRetry (BATCH-03 force-retry semantics)
//   - countBatchCandidates           (total count for [N/M] progress markers)
//   - countBatchCandidatesForceRetry (total count for force-retry path)
//
// Pitfall 8 (RESEARCH, MEDIUM risk): SQLite timestamp columns are TEXT. When
// applyRetryTransition writes ISO-8601 strings with a 'T' separator and 'Z'
// suffix ('2026-05-23T14:30:00.000Z') and we compare against datetime('now')
// (which produces '2026-05-23 14:30:00' — space separator, no Z), a raw
// `next_exact_retry_at <= datetime('now')` becomes a lexicographic TEXT
// compare. 'T' (0x54) > ' ' (0x20), so eligible past rows are NEVER selected.
// Fix: wrap BOTH sides in datetime(...). SQLite's datetime() parser
// normalizes both shapes to '%Y-%m-%d %H:%M:%S', enabling a correct
// chronological comparison.

const BATCH_CANDIDATES_WHERE = `
  s.job_source IS NULL
  OR s.exact_status = 'pending'
  OR (s.exact_status IN ('not_found', 'error')
      AND s.next_exact_retry_at IS NOT NULL
      AND datetime(s.next_exact_retry_at) <= datetime('now'))
`;

const SELECT_BATCH_CANDIDATES_SQL = `SELECT j.source, j.job_id, j.title, j.company, j.url,
       j.country_code, j.region, j.city, j.location_raw
FROM jobs j
LEFT JOIN job_enrichment_state s
  ON s.job_source = j.source AND s.job_id = j.job_id
WHERE ${BATCH_CANDIDATES_WHERE}
ORDER BY j.source, j.job_id
LIMIT ?`;

const COUNT_BATCH_CANDIDATES_SQL = `SELECT COUNT(*) AS total
FROM jobs j
LEFT JOIN job_enrichment_state s
  ON s.job_source = j.source AND s.job_id = j.job_id
WHERE ${BATCH_CANDIDATES_WHERE}`;

const FORCE_RETRY_WHERE = `NOT EXISTS (
  SELECT 1
  FROM job_salary_observations o
  WHERE o.job_source = j.source
    AND o.job_id = j.job_id
    AND o.is_posted_salary = 1
)`;

const SELECT_BATCH_CANDIDATES_FORCE_RETRY_SQL = `SELECT j.source, j.job_id, j.title, j.company, j.url,
       j.country_code, j.region, j.city, j.location_raw
FROM jobs j
WHERE ${FORCE_RETRY_WHERE}
ORDER BY j.source, j.job_id
LIMIT ?`;

const COUNT_BATCH_CANDIDATES_FORCE_RETRY_SQL = `SELECT COUNT(*) AS total
FROM jobs j
WHERE ${FORCE_RETRY_WHERE}`;

// Prepared-statement cache keyed by db handle (mirrors enrichment-state.mjs).
const batchStmtCache = new WeakMap();

function getBatchStmts(db) {
  let cached = batchStmtCache.get(db);
  if (!cached) {
    cached = {
      selectBatchCandidates: db.prepare(SELECT_BATCH_CANDIDATES_SQL),
      selectBatchCandidatesForceRetry: db.prepare(SELECT_BATCH_CANDIDATES_FORCE_RETRY_SQL),
      countBatchCandidates: db.prepare(COUNT_BATCH_CANDIDATES_SQL),
      countBatchCandidatesForceRetry: db.prepare(COUNT_BATCH_CANDIDATES_FORCE_RETRY_SQL),
    };
    batchStmtCache.set(db, cached);
  }
  return cached;
}

function assertPositiveIntegerLimit(limit) {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new TypeError(`limit must be a positive integer (got ${typeof limit} ${limit})`);
  }
}

/**
 * Select batch candidates — jobs needing an exact-salary enrichment attempt.
 *
 * Requirements: BATCH-01 (inclusion) + BATCH-02 (exclusion).
 *
 * Inclusion (BATCH-01): jobs with no job_enrichment_state row, OR
 * exact_status='pending', OR exact_status IN ('not_found','error') with
 * next_exact_retry_at in the past (datetime() wrapper — Pitfall 8).
 *
 * Exclusion (BATCH-02): exact_status='found', OR
 * exact_status IN ('not_found','error') with next_exact_retry_at IS NULL
 * (terminal — already exhausted backoff), OR next_exact_retry_at in the future.
 *
 * Pitfall 8: datetime() wrapper on BOTH sides of the timestamp comparison so
 * ISO-8601 'T...Z' shape written by applyRetryTransition compares correctly
 * against SQLite's space-separated datetime('now') output.
 *
 * @param {{db: import('better-sqlite3').Database, limit: number}} args
 * @returns {Array<{source, job_id, title, company, url, country_code, region, city, location_raw}>}
 */
export function selectBatchCandidates({ db, limit }) {
  assertPositiveIntegerLimit(limit);
  return getBatchStmts(db).selectBatchCandidates.all(limit);
}

/**
 * Select batch candidates for --force-*-retry / --all-unsalaried path.
 *
 * Requirement: BATCH-03 — returns every job lacking ANY is_posted_salary=1
 * observation, regardless of retry schedule (ignores job_enrichment_state
 * entirely).
 *
 * Pitfall 8 does not apply here (no timestamp comparison).
 *
 * @param {{db: import('better-sqlite3').Database, limit: number}} args
 * @returns {Array<{source, job_id, title, company, url, country_code, region, city, location_raw}>}
 */
export function selectBatchCandidatesForceRetry({ db, limit }) {
  assertPositiveIntegerLimit(limit);
  return getBatchStmts(db).selectBatchCandidatesForceRetry.all(limit);
}

/**
 * Count batch candidates (same WHERE as selectBatchCandidates, no LIMIT).
 *
 * Requirements: BATCH-01 + BATCH-02. Used for [N/M] progress markers in the
 * batch CLI's NDJSON output. Pitfall 8 wrapper applies.
 *
 * @param {{db: import('better-sqlite3').Database}} args
 * @returns {number}
 */
export function countBatchCandidates({ db }) {
  const row = getBatchStmts(db).countBatchCandidates.get();
  return row?.total ?? 0;
}

/**
 * Count batch candidates for force-retry path (same WHERE as
 * selectBatchCandidatesForceRetry, no LIMIT).
 *
 * Requirement: BATCH-03.
 *
 * @param {{db: import('better-sqlite3').Database}} args
 * @returns {number}
 */
export function countBatchCandidatesForceRetry({ db }) {
  const row = getBatchStmts(db).countBatchCandidatesForceRetry.get();
  return row?.total ?? 0;
}

// ---------------------------------------------------------------------------
// Health-metric hit-rate helpers (Phase v1.0-11 — HEALTH-02 / HEALTH-03)
// ---------------------------------------------------------------------------
//
// Two read-only aggregate queries powering the `--health` CLI report:
//   - getCurrent30DayHitRates: (today_midnight - 30 days) .. (today_midnight)
//   - getPrior30DayHitRates:   (today_midnight - 60 days) .. (today_midnight - 30 days)
//
// Both windows EXCLUDE today via the 'start of day' modifier so partial-day
// noise never corrupts the trailing-30 comparison.
//
// Pitfall 8 closure: observed_at TEXT can be either 'YYYY-MM-DD HH:MM:SS'
// (SQLite CURRENT_TIMESTAMP default) or 'YYYY-MM-DDTHH:MM:SS.sssZ'
// (ISO-8601 from v1.0-09 retry paths). Bare lexicographic compare of the two
// shapes misclassifies — 'T' (0x54) > ' ' (0x20). Wrap BOTH sides in
// datetime(...) so SQLite normalises to '%Y-%m-%d %H:%M:%S' on both sides.

const HIT_RATE_CURRENT_SQL = `
  SELECT job_source, COUNT(*) AS total, SUM(is_posted_salary) AS hits
  FROM job_salary_observations
  WHERE datetime(observed_at) >= datetime('now', '-30 days', 'start of day')
    AND datetime(observed_at) <  datetime('now', 'start of day')
  GROUP BY job_source
`;

const HIT_RATE_PRIOR_SQL = `
  SELECT job_source, COUNT(*) AS total, SUM(is_posted_salary) AS hits
  FROM job_salary_observations
  WHERE datetime(observed_at) >= datetime('now', '-60 days', 'start of day')
    AND datetime(observed_at) <  datetime('now', '-30 days', 'start of day')
  GROUP BY job_source
`;

const healthStmtCache = new WeakMap();

function getHealthStmts(db) {
  let cached = healthStmtCache.get(db);
  if (!cached) {
    cached = {
      current: db.prepare(HIT_RATE_CURRENT_SQL),
      prior: db.prepare(HIT_RATE_PRIOR_SQL),
    };
    healthStmtCache.set(db, cached);
  }
  return cached;
}

function coerceHitRateRow(row) {
  // SUM(is_posted_salary) is INTEGER over a non-empty group (GROUP BY filters
  // empty groups out), but defensive coercion costs nothing and guards against
  // a hypothetical NULL.
  return {
    job_source: row.job_source,
    total: row.total ?? 0,
    hits: row.hits ?? 0,
  };
}

/**
 * Aggregate posted-salary hit rates per job_source over the trailing 30
 * complete days (today excluded). Read-only; does NOT take the writer lock.
 *
 * @param {{db: import('better-sqlite3').Database}} args
 * @returns {Array<{job_source: string, total: number, hits: number}>}
 */
export function getCurrent30DayHitRates({ db }) {
  return getHealthStmts(db).current.all().map(coerceHitRateRow);
}

/**
 * Aggregate posted-salary hit rates per job_source over the prior 30-day
 * window (60..30 days ago). Read-only; does NOT take the writer lock.
 *
 * @param {{db: import('better-sqlite3').Database}} args
 * @returns {Array<{job_source: string, total: number, hits: number}>}
 */
export function getPrior30DayHitRates({ db }) {
  return getHealthStmts(db).prior.all().map(coerceHitRateRow);
}

export function countObservationsByConfidence(db, jobSource, jobId, confidenceLabel) {
  if (!jobSource || typeof jobSource !== 'string' || jobSource.trim() === '') {
    throw new Error('jobSource and jobId required');
  }
  if (!jobId || typeof jobId !== 'string' || jobId.trim() === '') {
    throw new Error('jobSource and jobId required');
  }

  const all_confidence_labels = [...EXACT_CONFIDENCE_LABELS, ...ESTIMATE_CONFIDENCE_LABELS];
  if (!all_confidence_labels.includes(confidenceLabel)) {
    throw new Error(`confidenceLabel must be one of: ${all_confidence_labels.join(', ')}`);
  }

  const stmt = db.prepare(`
    SELECT COUNT(*) AS count
    FROM job_salary_observations
    WHERE job_source = ? AND job_id = ? AND confidence_label = ?
  `);

  const row = stmt.get(jobSource, jobId, confidenceLabel);
  return row?.count ?? 0;
}
