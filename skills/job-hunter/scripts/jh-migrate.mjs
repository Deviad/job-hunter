#!/usr/bin/env node
// Apply idempotent job-hunter schema additions to an explicit or canonical DB.
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const JOBHUNTER_HOME = process.env.JOBHUNTER_HOME || path.join(process.env.HOME, '.job-hunter');
const DEFAULT_DB = process.env.JOBHUNTER_DB || path.join(JOBHUNTER_HOME, 'jobhunter.sqlite');

function parseArgs(argv) {
  let db = DEFAULT_DB;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--db') {
      if (index + 1 >= argv.length) throw new Error('missing value for --db');
      db = argv[++index];
    } else if (arg === '--help' || arg === '-h') {
      return { help: true, db };
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { help: false, db };
}

function databaseConstructor() {
  const req = createRequire(path.join(JOBHUNTER_HOME, 'package.json'));
  return req('better-sqlite3');
}

function migrate(dbPath = DEFAULT_DB) {
  const Database = databaseConstructor();
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');

  db.exec(`
CREATE TABLE IF NOT EXISTS application_stage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_source TEXT NOT NULL,
  job_id TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN
    ('applied','screening','interview','offer','rejected','withdrawn','ghosted')),
  note TEXT,
  occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (job_source, job_id) REFERENCES jobs(source, job_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_stage_events_job
  ON application_stage_events(job_source, job_id, occurred_at);

CREATE TABLE IF NOT EXISTS jh_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

  const jobColumns = new Set(db.prepare('PRAGMA table_info(jobs)').all().map((column) => column.name));
  let taxonomyColumnAdded = false;
  if (!jobColumns.has('role_taxonomy_version')) {
    db.exec('ALTER TABLE jobs ADD COLUMN role_taxonomy_version TEXT');
    taxonomyColumnAdded = true;
  }

  const backfilled = db.prepare(`
    INSERT INTO application_stage_events (job_source, job_id, stage, note, occurred_at)
    SELECT j.source, j.job_id, 'applied', 'backfilled from jobs.applied_at',
           COALESCE(j.applied_at, CURRENT_TIMESTAMP)
    FROM jobs j
    WHERE j.application_status = 'applied'
      AND NOT EXISTS (
        SELECT 1 FROM application_stage_events e
        WHERE e.job_source = j.source AND e.job_id = j.job_id
      )
  `).run();

  db.close();
  return { db: dbPath, taxonomyColumnAdded, appliedEventsBackfilled: backfilled.changes };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: jh-migrate.mjs [--db /path/to/jobhunter.sqlite]');
    return;
  }
  const result = migrate(options.db);
  console.log('migration OK — application_stage_events + jh_meta + jobs.role_taxonomy_version present');
  console.log(`taxonomy column added: ${result.taxonomyColumnAdded}`);
  console.log(`backfilled ${result.appliedEventsBackfilled} 'applied' stage event(s)`);
}

export { DEFAULT_DB, parseArgs, migrate };

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
