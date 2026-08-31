/**
 * benchmark-stamp.mjs - Stamp benchmark rows with normalizer version
 *
 * Provides idempotent migration helper for the normalizer_version column
 * and a helper function to apply the current NORMALIZER_VERSION to benchmark rows.
 *
 * Exports:
 * - ensureNormalizerVersionColumn(db) → { added: boolean }
 * - stampBenchmarkVersion(row) → row with normalizer_version added
 */

import { NORMALIZER_VERSION } from './rules-loader.mjs';

/**
 * Idempotently ensure salary_benchmarks has the normalizer_version column.
 * Safe to call on:
 *   - fresh DBs created by current DDL (column already present → no-op)
 *   - DBs created by Phase v1.0-01 DDL (column absent → ALTER TABLE ADD COLUMN)
 *
 * MUST be called by the schema installer AFTER the main DDL loop runs.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {{ added: boolean }}
 */
export function ensureNormalizerVersionColumn(db) {
  const cols = db.prepare("PRAGMA table_info('salary_benchmarks')").all();
  const present = cols.some(c => c.name === 'normalizer_version');
  if (present) return { added: false };

  // SQLite ALTER TABLE ADD COLUMN with NOT NULL requires a non-NULL DEFAULT.
  // DEFAULT 1 backfills every existing row to version 1 (the only legal version at v1.0-02 ship).
  db.exec(`ALTER TABLE salary_benchmarks ADD COLUMN normalizer_version INTEGER NOT NULL DEFAULT 1 CHECK (normalizer_version >= 1)`);
  return { added: true };
}

/**
 * Apply the current NORMALIZER_VERSION stamp to a benchmark row object.
 * Phase v1.0-06's storeBenchmarkSnapshot() will call this immediately before INSERT.
 * Idempotent: if the input already has a normalizer_version, it is OVERWRITTEN (we always
 * stamp at insert time per the current loaded rules; historical inserts retain their stamp
 * in the database because INSERT OR IGNORE no-ops on conflict).
 *
 * @param {object} row
 * @returns {object} new object with normalizer_version added
 */
export function stampBenchmarkVersion(row) {
  return { ...row, normalizer_version: NORMALIZER_VERSION };
}
