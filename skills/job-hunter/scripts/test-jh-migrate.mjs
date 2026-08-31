#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { migrate } from './jh-migrate.mjs';

const home = process.env.JOBHUNTER_HOME || path.join(process.env.HOME, '.job-hunter');
const req = createRequire(path.join(home, 'package.json'));
const Database = req('better-sqlite3');
const root = mkdtempSync(path.join(tmpdir(), 'jh-migrate-test-'));
const dbPath = path.join(root, 'fixture.sqlite');

try {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE jobs (
      source TEXT NOT NULL,
      job_id TEXT NOT NULL,
      application_status TEXT,
      applied_at TEXT,
      role_family_inferred TEXT,
      PRIMARY KEY (source, job_id)
    );
    INSERT INTO jobs (source, job_id, application_status, role_family_inferred)
    VALUES ('linkedin', 'legacy-1', 'saved', 'ai_architecture');
  `);
  db.close();

  const first = migrate(dbPath);
  const second = migrate(dbPath);
  assert.equal(first.taxonomyColumnAdded, true);
  assert.equal(second.taxonomyColumnAdded, false);

  const check = new Database(dbPath, { readonly: true });
  const columns = check.prepare('PRAGMA table_info(jobs)').all().map((column) => column.name);
  assert.equal(columns.filter((name) => name === 'role_taxonomy_version').length, 1);
  const legacy = check.prepare('SELECT role_family_inferred, role_taxonomy_version FROM jobs WHERE job_id = ?').get('legacy-1');
  assert.deepEqual(legacy, { role_family_inferred: 'ai_architecture', role_taxonomy_version: null });
  assert.ok(check.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='application_stage_events'").get());
  assert.ok(check.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='jh_meta'").get());
  check.close();

  console.log('jh-migrate tests: PASS');
} finally {
  rmSync(root, { recursive: true, force: true });
}
