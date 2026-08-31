/**
 * benchmark-cache.mjs - Benchmark Cache Layer (Phase v1.0-06)
 *
 * Two-layer identity architecture:
 * 1. `benchmark_series_id` = deterministic 16-hex SHA-256 of canonical query cohort (NULL-safe).
 *    Canonicalized field order is part of the identity contract — changing order or adding/removing
 *    fields requires a `normalizer_version`-style migration.
 *
 * 2. `payload_hash` = deterministic 16-hex SHA-256 of canonicalized payload alone. Participates in
 *    UNIQUE (benchmark_series_id, payload_hash) — drives the per-series dedupe semantics for
 *    INSERT OR IGNORE.
 *
 * 3. `benchmark_id` = deterministic 16-hex SHA-256 of the TUPLE (benchmark_series_id, payload_hash, fetched_at).
 *    This is the salary_benchmarks PRIMARY KEY and MUST be globally unique across all series. Hashing
 *    the tuple (rather than the payload alone) prevents PK collisions when two different cohorts
 *    happen to share the same payload JSON.
 *
 * SHA-256 truncated to 64 bits (16 hex chars) — accepted up to ~5M benchmarks; widening to 128-bit
 * is HARDEN-01 in v2.
 *
 * Snapshots are immutable: never UPDATE; new payload → new row via INSERT OR IGNORE against
 * UNIQUE (benchmark_series_id, payload_hash).
 *
 * Field order in `deriveBenchmarkSeriesId` is part of the identity contract — changing order or
 * adding/removing fields requires a `normalizer_version`-style migration.
 */

import { createHash } from 'node:crypto';
import { NORMALIZER_VERSION } from './normalizers.mjs';

/**
 * Helper: Compute 16-character hex SHA-256 hash of a string.
 * @param {string} input
 * @returns {string} 16-char lowercase hex
 */
function hashSha256Truncated(input) {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

/**
 * Derive benchmark_series_id from query cohort (deterministic, NULL-safe).
 *
 * Canonical field order (NEVER reorder; mirrors RESEARCH.md Pattern 1):
 * 1. normalizedTitle (lowercase)
 * 2. seniority (default: '_any', lowercase)
 * 3. industry (default: '_any', lowercase)
 * 4. countryCode (2-letter ISO, uppercased)
 * 5. region (default: '', lowercase)
 * 6. city (default: '', lowercase)
 * 7. compensationType (default: 'unknown', lowercase)
 * 8. period (default: 'year', lowercase)
 *
 * @param {object} query - Benchmark query with cohort fields
 * @returns {string} 16-char lowercase hex hash
 */
export function deriveBenchmarkSeriesId(query) {
  const parts = [
    (query.normalizedTitle || '').toLowerCase(),
    (query.seniority || '_any').toLowerCase(),
    (query.industry || '_any').toLowerCase(),
    (query.countryCode || '').toUpperCase(),
    (query.region || '').toLowerCase(),
    (query.city || '').toLowerCase(),
    (query.compensationType || 'unknown').toLowerCase(),
    (query.period || 'year').toLowerCase()
  ];
  const canonical = parts.join('|');
  return hashSha256Truncated(canonical);
}

/**
 * Derive payload_hash from benchmark payload (deterministic, canonicalized).
 *
 * Canonicalize the payload BEFORE hashing to avoid key-order fragmentation:
 * - Parse JSON strings; fall back to raw string on parse failure.
 * - Sort top-level keys and re-serialize without extra whitespace.
 * - Hash the canonical string with SHA-256; truncate to 16 hex chars.
 *
 * This is the canonical content-hash for the `payload_hash` column on salary_benchmarks,
 * which participates in the UNIQUE (benchmark_series_id, payload_hash) constraint.
 *
 * @param {object|string} payload - Benchmark payload (object or JSON string)
 * @returns {string} 16-char lowercase hex hash
 */
export function derivePayloadHash(payload) {
  let parsed;

  if (typeof payload === 'string') {
    try {
      parsed = JSON.parse(payload);
    } catch {
      // Parse failed; hash the raw string as-is. This allows fallback for
      // non-JSON payloads while still providing deterministic hashing.
      return hashSha256Truncated(payload);
    }
  } else {
    parsed = payload;
  }

  // Canonicalize: sort top-level keys, serialize without extra whitespace
  const canonical = JSON.stringify(parsed, Object.keys(parsed).sort());
  return hashSha256Truncated(canonical);
}

/**
 * Derive benchmark_id from (seriesId, payloadHash, fetchedAt) tuple.
 *
 * benchmark_id is the salary_benchmarks PRIMARY KEY and MUST be globally unique.
 * We hash the (benchmarkSeriesId, payloadHash, fetchedAt) tuple instead of the payload
 * alone so that two different cohorts (series) carrying the same payload JSON do NOT
 * collide on the global PK. The schema enforces dedupe via UNIQUE (benchmark_series_id, payload_hash)
 * separately — INSERT OR IGNORE on that constraint no-ops before the benchmark_id PK is
 * even compared.
 *
 * @param {string} benchmarkSeriesId - Series ID (from deriveBenchmarkSeriesId)
 * @param {string} payloadHash - Payload hash (from derivePayloadHash)
 * @param {string|Date} fetchedAt - ISO string or Date object
 * @returns {string} 16-char lowercase hex hash
 * @throws {Error} if inputs are invalid
 */
export function deriveBenchmarkId(benchmarkSeriesId, payloadHash, fetchedAt) {
  // Validation
  if (typeof benchmarkSeriesId !== 'string' || !benchmarkSeriesId.length) {
    throw new Error('benchmarkSeriesId must be a non-empty string');
  }
  if (typeof payloadHash !== 'string' || !payloadHash.length) {
    throw new Error('payloadHash must be a non-empty string');
  }

  // Coerce fetchedAt to ISO string
  let fetchedAtIso;
  if (fetchedAt instanceof Date) {
    fetchedAtIso = fetchedAt.toISOString();
  } else if (typeof fetchedAt === 'string' && fetchedAt.length) {
    fetchedAtIso = fetchedAt;
  } else {
    throw new Error('fetchedAt must be a non-empty string or Date');
  }

  // Canonical form: serialize the tuple
  const canonical = `${benchmarkSeriesId}|${payloadHash}|${fetchedAtIso}`;
  return hashSha256Truncated(canonical);
}

/**
 * Check if a benchmark snapshot is stale.
 *
 * Returns true only if now is STRICTLY AFTER the boundary (latest.fetched_at + maxAgeDays).
 * At the exact boundary → false. 1ms past → true. (CACHE-05)
 *
 * @param {object} latest - Benchmark row with fetched_at field
 * @param {number} maxAgeDays - Maximum age in days (non-negative)
 * @param {string|Date} now - Current timestamp (ISO string or Date)
 * @returns {boolean} true if stale, false otherwise
 * @throws {Error} if inputs are invalid
 */
export function isBenchmarkStale(latest, maxAgeDays, now) {
  // Validation
  if (!latest || typeof latest !== 'object' || !latest.fetched_at) {
    throw new Error('latest benchmark row required with fetched_at field');
  }

  if (!Number.isFinite(maxAgeDays) || maxAgeDays < 0) {
    throw new Error('maxAgeDays must be a non-negative number');
  }

  if (!now) {
    throw new Error('now timestamp required (ISO string or Date)');
  }

  // Parse timestamps
  const fetchedTime = new Date(latest.fetched_at).getTime();
  const nowTime = now instanceof Date ? now.getTime() : new Date(now).getTime();

  // Compute stale boundary: fetched_at + maxAgeDays * 24 * 60 * 60 * 1000
  const staleBoundary = fetchedTime + maxAgeDays * 24 * 60 * 60 * 1000;

  // True only if now is STRICTLY AFTER the boundary — at-boundary returns false (CACHE-05).
  return nowTime > staleBoundary;
}

/**
 * Find the latest benchmark snapshot for a query cohort.
 *
 * Computes benchmark_series_id from the query (re-uses deriveBenchmarkSeriesId) and
 * returns the row with the max fetched_at. Secondary deterministic sort by benchmark_id ASC
 * guarantees stable ordering when two snapshots happen to share fetched_at to the millisecond
 * (mirrors v1.0-05 Plan-03's observation_id ASC secondary sort rule).
 *
 * @param {Database} db - better-sqlite3 connection
 * @param {object} query - Benchmark query with cohort fields
 * @returns {object|null} - The latest benchmark row, or null if no rows exist for the series
 */
export function findLatestBenchmark(db, query) {
  const benchmarkSeriesId = deriveBenchmarkSeriesId(query);
  // Secondary sort by benchmark_id ASC for deterministic ordering on identical-timestamp ties
  const stmt = db.prepare(
    'SELECT * FROM salary_benchmarks WHERE benchmark_series_id = ? ORDER BY fetched_at DESC, benchmark_id ASC LIMIT 1'
  );
  return stmt.get(benchmarkSeriesId) || null;
}

/**
 * Insert one benchmark snapshot using INSERT OR IGNORE semantics
 * (CACHE-03 idempotency against UNIQUE (benchmark_series_id, payload_hash)).
 *
 * PRECONDITION: Caller MUST hold the `salary_writer_lock` (acquired via
 * BEGIN IMMEDIATE in writer-lock.mjs) for this `db` connection. This function
 * does NOT acquire the lock — see Phase v1.0-09 orchestrator (bin/salary-cli)
 * for the lock-acquisition boundary. Calling this without holding the writer
 * lock risks SQLITE_BUSY under concurrent writers.
 *
 * Idempotent immutable snapshot insert. Same series + same payload → silent no-op
 * (changes()=0, existing row retained AND RETURNED in the row field per ROADMAP SC-2).
 * Same series + different payload → new row with new benchmark_id (changes()=1).
 * Different series + same payload → new row with new benchmark_id (the global PK is
 * derived from the tuple, not the payload alone — BLOCKER-1 fix).
 *
 * @param {Database} db - better-sqlite3 connection inside an active writer-lock transaction
 * @param {object} benchmark - benchmark payload with required cohort fields + rawPayloadJson
 * @returns {{ benchmarkId: string, inserted: boolean, changes: number, row: object }}
 */
export function storeBenchmarkSnapshot(db, benchmark) {
  // Pre-flight validation — aggregate errors before any DB roundtrip
  if (!benchmark || typeof benchmark !== 'object') {
    throw new Error('benchmark must be a non-null object');
  }
  const errors = [];
  if (typeof benchmark.normalizedTitle !== 'string' || !benchmark.normalizedTitle.length) {
    errors.push('normalizedTitle is required (non-empty string)');
  }
  if (typeof benchmark.countryCode !== 'string' || benchmark.countryCode.length !== 2) {
    errors.push('countryCode is required (exactly 2 chars)');
  }
  if (benchmark.currency !== undefined && benchmark.currency !== null && benchmark.currency.length !== 3) {
    errors.push('currency must be exactly 3 chars');
  }
  const validPeriods = ['hour', 'day', 'week', 'month', 'year'];
  if (!benchmark.period || !validPeriods.includes(benchmark.period)) {
    errors.push(`period is required (one of: ${validPeriods.join(', ')})`);
  }
  const validCompTypes = ['base_salary', 'total_compensation', 'ote', 'contract_rate', 'unknown'];
  if (!benchmark.compensationType || !validCompTypes.includes(benchmark.compensationType)) {
    errors.push(`compensationType is required (one of: ${validCompTypes.join(', ')})`);
  }
  if (benchmark.rawPayloadJson === undefined || benchmark.rawPayloadJson === null) {
    errors.push('rawPayloadJson is required (string or object)');
  }
  if (!benchmark.fetchedAt) {
    errors.push('fetchedAt is required (ISO string)');
  }
  if (errors.length) {
    throw new Error(`storeBenchmarkSnapshot validation failed: ${errors.join('; ')}`);
  }

  // Compute or verify series_id
  const derivedSeriesId = deriveBenchmarkSeriesId({
    normalizedTitle: benchmark.normalizedTitle,
    seniority: benchmark.seniority,
    industry: benchmark.industry,
    countryCode: benchmark.countryCode,
    region: benchmark.region,
    city: benchmark.city,
    compensationType: benchmark.compensationType,
    period: benchmark.period
  });
  let benchmarkSeriesId;
  if (benchmark.benchmarkSeriesId) {
    if (benchmark.benchmarkSeriesId !== derivedSeriesId) {
      throw new Error('benchmark.benchmarkSeriesId disagrees with derived value');
    }
    benchmarkSeriesId = benchmark.benchmarkSeriesId;
  } else {
    benchmarkSeriesId = derivedSeriesId;
  }

  // BLOCKER-1 fix: `benchmark_id` (global PK) and `payload_hash` (per-series UNIQUE column)
  // are DIFFERENT SHA-256 truncated hashes computed from DIFFERENT inputs. `payload_hash`
  // hashes the canonicalized payload alone. `benchmark_id` hashes the
  // (benchmark_series_id, payload_hash, fetched_at) tuple so that two different series carrying
  // the same payload do not collide on the global PRIMARY KEY.
  const rawPayloadString = typeof benchmark.rawPayloadJson === 'string'
    ? benchmark.rawPayloadJson
    : JSON.stringify(benchmark.rawPayloadJson);
  const payloadHash = derivePayloadHash(benchmark.rawPayloadJson);
  const benchmarkId = deriveBenchmarkId(benchmarkSeriesId, payloadHash, benchmark.fetchedAt);

  // Bind named parameters matching every column in salary_benchmarks schema (lines 137-188)
  // except created_at (schema default). Use null for optional columns the caller omits.
  const bindings = {
    benchmark_id: benchmarkId,
    benchmark_series_id: benchmarkSeriesId,
    data_source: benchmark.dataSource || 'unknown',
    data_source_url: benchmark.dataSourceUrl ?? null,
    raw_title: benchmark.rawTitle || benchmark.normalizedTitle,
    normalized_title: benchmark.normalizedTitle,
    role_family: benchmark.roleFamily ?? null,
    seniority: benchmark.seniority || '_any',
    industry: benchmark.industry || '_any',
    country_code: benchmark.countryCode,
    region: benchmark.region ?? '',
    city: benchmark.city ?? '',
    location_raw: benchmark.locationRaw ?? null,
    currency: benchmark.currency ?? 'USD',
    period: benchmark.period,
    compensation_type: benchmark.compensationType,
    amount_min: benchmark.amountMin ?? null,
    amount_max: benchmark.amountMax ?? null,
    amount_median: benchmark.amountMedian ?? null,
    amount_p10: benchmark.amountP10 ?? null,
    amount_p25: benchmark.amountP25 ?? null,
    amount_p75: benchmark.amountP75 ?? null,
    amount_p90: benchmark.amountP90 ?? null,
    sample_size: benchmark.sampleSize ?? null,
    confidence_score: benchmark.confidenceScore ?? null,
    effective_from: benchmark.effectiveFrom ?? null,
    effective_to: benchmark.effectiveTo ?? null,
    fetched_at: benchmark.fetchedAt,
    next_refresh_at: benchmark.nextRefreshAt ?? null,
    refresh_frequency_days: benchmark.refreshFrequencyDays ?? 30,
    payload_hash: payloadHash,
    evidence_snippet: benchmark.evidenceSnippet ?? null,
    raw_payload_json: rawPayloadString,
    // MEDIUM-3 fix: default sourced from the imported NORMALIZER_VERSION constant.
    // NEVER hardcode `?? 1`. Callers may override (e.g., for historical replay), but the
    // default is the live version from scripts/lib/normalizers.mjs.
    normalizer_version: benchmark.normalizerVersion ?? NORMALIZER_VERSION
  };

  const insertSql = `INSERT OR IGNORE INTO salary_benchmarks (
    benchmark_id, benchmark_series_id, data_source, data_source_url,
    raw_title, normalized_title, role_family, seniority, industry,
    country_code, region, city, location_raw,
    currency, period, compensation_type,
    amount_min, amount_max, amount_median,
    amount_p10, amount_p25, amount_p75, amount_p90,
    sample_size, confidence_score,
    effective_from, effective_to, fetched_at, next_refresh_at, refresh_frequency_days,
    payload_hash, evidence_snippet, raw_payload_json,
    normalizer_version
  ) VALUES (
    @benchmark_id, @benchmark_series_id, @data_source, @data_source_url,
    @raw_title, @normalized_title, @role_family, @seniority, @industry,
    @country_code, @region, @city, @location_raw,
    @currency, @period, @compensation_type,
    @amount_min, @amount_max, @amount_median,
    @amount_p10, @amount_p25, @amount_p75, @amount_p90,
    @sample_size, @confidence_score,
    @effective_from, @effective_to, @fetched_at, @next_refresh_at, @refresh_frequency_days,
    @payload_hash, @evidence_snippet, @raw_payload_json,
    @normalizer_version
  )`;

  let result;
  try {
    result = db.prepare(insertSql).run(bindings);
  } catch (err) {
    if (err && err.message && err.message.includes('FOREIGN KEY')) {
      throw new Error(`storeBenchmarkSnapshot FOREIGN KEY violation: ${err.message}`);
    }
    throw err;
  }

  // BLOCKER-2 fix: populate row on BOTH branches (ROADMAP SC-2)
  let row;
  if (result.changes === 1) {
    // Fresh insert — re-query by the freshly-known PK
    row = db.prepare('SELECT * FROM salary_benchmarks WHERE benchmark_id = ?').get(benchmarkId);
  } else {
    // INSERT OR IGNORE no-op (CACHE-03) — re-query the existing row by (series_id, payload_hash)
    row = db.prepare(
      'SELECT * FROM salary_benchmarks WHERE benchmark_series_id = ? AND payload_hash = ? LIMIT 1'
    ).get(benchmarkSeriesId, payloadHash);
  }

  // On the no-op path, the existing row's benchmark_id is the AUTHORITATIVE PK.
  const effectiveBenchmarkId = row ? row.benchmark_id : benchmarkId;
  return {
    benchmarkId: effectiveBenchmarkId,
    inserted: result.changes === 1,
    changes: result.changes,
    row
  };
}
