#!/usr/bin/env node
import { Database } from '../../job-hunter/scripts/workspace-dependencies.mjs';
// CLI orchestrator for the salary-schema installer.
// Composes preflight + writer-lock + drift + DDL constants in the locked order.
// Translates Errors → categorized exit codes:
//   0  ok (incl. silent no-op re-run)
//   2  preflight failure (file missing, FK off, jobs uniqueness missing)
//   3  schema drift (pre- OR post-DDL)
//   4  lock contention or lost heartbeat
//   1  other / unexpected
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';

import {
  assertDbFileExists, assertForeignKeysOn, assertJobsUnique
} from './lib/preflight.mjs';
import {
  makeIdentity, acquire, installSignalHandlers, formatContentionMessage
} from './lib/writer-lock.mjs';
import { ALL_DDL, COUNTS } from './lib/salary-schema.mjs';
import { detectDrift } from './lib/drift.mjs';
import { ensureNormalizerVersionColumn } from './lib/normalize/benchmark-stamp.mjs';

function main() {
  const { values } = parseArgs({
    options: {
      db:        { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      verbose:   { type: 'boolean', default: false },
      json:      { type: 'boolean', default: false },
      help:      { type: 'boolean', default: false },
    },
    strict: true,
  });

  const verbose = !!values.verbose;
  function vlog(...args) {
    if (verbose) process.stderr.write(`[ensure-salary-schema] ${args.join(' ')}\n`);
  }

  if (values.help) {
    process.stdout.write(
      `Usage: ensure-salary-schema.mjs --db <path> [--dry-run] [--verbose] [--json]\n` +
      `\n` +
      `Install the salary schema (4 tables, 8 indexes, 1 trigger) idempotently into\n` +
      `an existing SQLite database. Acquires the writer lock before DDL.\n` +
      `\n` +
      `Exit codes: 0 ok | 2 preflight | 3 drift | 4 lock | 1 other\n`
    );
    return 0;
  }
  if (!values.db) {
    const jh = process.env.JOBHUNTER_HOME || `${process.env.HOME}/.job-hunter`;
    values.db = process.env.JOBHUNTER_DB || `${jh}/jobhunter.sqlite`;
  }
  const absPath = resolve(process.cwd(), values.db);

  vlog('preflight: start', `db=${absPath}`);
  assertDbFileExists(absPath);
  vlog('preflight: db file exists');

  // Open. Do NOT touch journal_mode (persistent DB-header property; lock semantics
  // work in any journal mode). Do NOT touch foreign_keys (SCHEMA-03 verifiability).
  const db = new Database(absPath);

  assertForeignKeysOn(db);
  vlog('preflight: foreign_keys is ON');

  assertJobsUnique(db);
  vlog('preflight: jobs(source, job_id) uniqueness OK');

  // Pre-DDL drift check: only flag present-but-different. Missing objects are
  // expected on a fresh install (DDL will create them).
  const preDdlDrifts = detectDrift(db).filter(d => d.actual !== null);
  if (preDdlDrifts.length > 0) {
    process.stderr.write(`Schema drift detected before install:\n`);
    for (const d of preDdlDrifts) {
      process.stderr.write(`  [${d.type}] ${d.name}\n    expected: ${d.expected}\n    actual:   ${d.actual}\n`);
    }
    db.close();
    return 3;
  }
  vlog('preflight: pre-DDL drift check passed');

  // Acquire writer lock
  const handle = acquire(db, makeIdentity());
  if (!handle.acquired) {
    const msg = formatContentionMessage(handle.holder);
    process.stdout.write(msg + '\n');
    if (handle.holder) {
      process.stderr.write(`holder: ${handle.holder.hostname}:${handle.holder.pid}\n`);
    }
    db.close();
    return 4;
  }
  vlog('lock: acquired', handle.reclaimed ? '(reclaimed stale lock)' : '');

  const uninstall = installSignalHandlers(handle);
  handle.startHeartbeat();
  vlog('lock: heartbeat started');

  try {
    if (values['dry-run']) {
      for (const sql of ALL_DDL) process.stdout.write(sql + ';\n');
      vlog('dry-run: printed', String(ALL_DDL.length), 'DDL statements');
      handle.release();
      uninstall();
      db.close();
      return 0;
    }

    // Exec DDL OUTSIDE any explicit transaction. Each IF NOT EXISTS DDL auto-commits.
    for (const sql of ALL_DDL) {
      vlog('exec:', sql.split('\n')[0].slice(0, 80));
      db.exec(sql);
    }
    vlog('ddl: exec complete');

    // Ensure normalizer_version column exists (migrates existing v1.0-01 DBs)
    const stampMigration = ensureNormalizerVersionColumn(db);
    if (stampMigration.added) {
      vlog('migration: added normalizer_version column to salary_benchmarks');
    } else {
      vlog('migration: normalizer_version column already present');
    }

    // Post-DDL drift check (defense in depth — catches DDL bugs)
    const diffs = detectDrift(db);
    if (diffs.length > 0) {
      process.stderr.write(`Schema drift detected after install (DDL bug?):\n`);
      for (const d of diffs) {
        process.stderr.write(`  [${d.type}] ${d.name}\n    expected: ${d.expected}\n    actual:   ${d.actual ?? '<missing>'}\n`);
      }
      handle.release();
      uninstall();
      db.close();
      return 3;
    }
    vlog('drift: post-DDL check passed (', String(diffs.length), 'diffs)');

    const triggerWord = COUNTS.triggers === 1 ? 'trigger' : 'triggers';
    if (values.json) {
      process.stdout.write(JSON.stringify({
        status: 'ok',
        tables_created: COUNTS.tables,
        indexes_created: COUNTS.indexes,
        errors: [],
      }) + '\n');
    } else {
      process.stdout.write(
        `Schema OK at ${absPath} (${COUNTS.tables} tables, ${COUNTS.indexes} indexes, ${COUNTS.triggers} ${triggerWord}).\n`
      );
    }

    handle.release();
    uninstall();
    vlog('lock: released');
    db.close();
    return 0;
  } catch (e) {
    try { handle.release(); } catch {}
    try { uninstall(); } catch {}
    try { db.close(); } catch {}
    throw e;
  }
}

try {
  process.exit(main());
} catch (e) {
  if (e && typeof e.exitCode === 'number') {
    process.stderr.write(`${e.message}\n`);
    process.exit(e.exitCode);
  }
  process.stderr.write(`error: ${e.message ?? e}\n`);
  if (process.env.VERBOSE_STACK) process.stderr.write((e.stack || '') + '\n');
  process.exit(1);
}
