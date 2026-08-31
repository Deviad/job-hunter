// Preflight assertions for ensure-salary-schema. Pure side-effect-free except for throwing.
// Every Error thrown here carries `.exitCode = 2` so the CLI can map directly to its
// categorized exit code.
import { statSync } from 'node:fs';

function preflightError(message, exitCode = 2) {
  const e = new Error(message);
  e.exitCode = exitCode;
  e.kind = 'preflight';
  return e;
}

export function assertDbFileExists(path) {
  try {
    const st = statSync(path);
    if (!st.isFile()) {
      throw preflightError(
        `jobhunter.sqlite not found at ${path}. The job-hunter project owns DB creation; run its setup first.`
      );
    }
  } catch (e) {
    if (e.kind === 'preflight') throw e;
    if (e.code === 'ENOENT') {
      throw preflightError(
        `jobhunter.sqlite not found at ${path}. The job-hunter project owns DB creation; run its setup first.`
      );
    }
    throw e;
  }
}

/**
 * Verify PRAGMA foreign_keys is ON for this connection.
 *
 * IMPORTANT — explicit happy-path semantics:
 *   better-sqlite3 ≥ 7.0 enables `PRAGMA foreign_keys = ON` AUTOMATICALLY when
 *   opening via `new Database(path)` (default open mode). We READ the pragma but
 *   DELIBERATELY DO NOT SET it. SCHEMA-03 ("refuses if foreign_keys is off")
 *   becomes unverifiable if the installer flips the bit on the user's behalf.
 */
export function assertForeignKeysOn(db) {
  const v = db.pragma('foreign_keys', { simple: true });
  if (v !== 1) {
    throw preflightError(
      `PRAGMA foreign_keys is OFF on this connection (got ${v}). The installer reads but does not set this pragma; better-sqlite3 enables it by default. Open the DB with foreign_keys = ON before re-running.`
    );
  }
}

export function hasUniqueOnSourceJobId(db) {
  const tbl = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='jobs'`
  ).get();
  if (!tbl) return { exists: false, unique: false };

  const indexes = db.prepare(`PRAGMA index_list('jobs')`).all();
  for (const idx of indexes) {
    if (!idx.unique) continue;
    // PRAGMA does not accept bound parameters; index names come from PRAGMA index_list
    // (SQLite-internal source) so injection is not a concern.
    const cols = db.prepare(`PRAGMA index_info('${idx.name}')`).all().map(r => r.name);
    if (cols.length === 2 && cols[0] === 'source' && cols[1] === 'job_id') {
      return { exists: true, unique: true };
    }
  }
  return { exists: true, unique: false };
}

export function assertJobsUnique(db) {
  const { exists, unique } = hasUniqueOnSourceJobId(db);
  if (!exists) {
    throw preflightError(
      `jobs table is missing. The job-hunter project owns DB creation; run its setup first.`
    );
  }
  if (!unique) {
    throw preflightError(
      `jobs(source, job_id) lacks PRIMARY KEY or UNIQUE constraint. Cannot install salary schema (FK targets would be ambiguous).`
    );
  }
  return true;
}
