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
const syntheticAppliedAt = new Date(0).toISOString();

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
  assert.equal(first.linkedinAccessInitialized, true);
  assert.equal(second.linkedinAccessInitialized, false);
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


  const accessKey = 'source.linkedin.access';
  const edit = new Database(dbPath);
  const initial = JSON.parse(edit.prepare('SELECT value FROM jh_meta WHERE key = ?').get(accessKey).value);
  assert.deepEqual(Object.keys(initial).sort(), ['observedAt', 'operatorConfirmation', 'reason', 'runId', 'schemaVersion', 'state']);
  assert.equal(initial.state, 'paused');
  assert.equal(initial.reason, 'unreviewed installation');
  assert.equal(initial.schemaVersion, 1);
  assert.equal(new Date(initial.observedAt).toISOString(), initial.observedAt);
  assert.equal(initial.runId, null);
  assert.equal(initial.operatorConfirmation, null);
  edit.prepare('INSERT INTO jh_meta VALUES (?, ?, ?)').run('source_access:linkedin', 'old-key', 'old-time');
  edit.prepare('INSERT INTO jh_meta VALUES (?, ?, ?)').run('sentinel', 'sentinel-value', 'sentinel-time');
  edit.prepare("UPDATE jobs SET application_status = 'applied', applied_at = ? WHERE job_id = 'legacy-1'").run(syntheticAppliedAt);
  assert.equal(migrate(dbPath).appliedEventsBackfilled, 1);
  assert.equal(migrate(dbPath).appliedEventsBackfilled, 0);
  assert.deepEqual(edit.prepare('SELECT stage, occurred_at FROM application_stage_events').all(), [{ stage: 'applied', occurred_at: syntheticAppliedAt }]);
  const ready = { ...initial, state: 'ready', operatorConfirmation: { confirmedAt: initial.observedAt, reason: initial.reason } };
  for (const value of [JSON.stringify(initial), JSON.stringify(ready), '{corrupt', JSON.stringify({ ...initial, schemaVersion: 99 })]) {
    edit.prepare('UPDATE jh_meta SET value = ?, updated_at = ? WHERE key = ?').run(value, 'exact-original-time', accessKey);
    const before = edit.prepare('SELECT * FROM jh_meta ORDER BY key').all();
    assert.equal(migrate(dbPath).linkedinAccessInitialized, false);
    assert.equal(migrate(dbPath).linkedinAccessInitialized, false);
    assert.deepEqual(edit.prepare('SELECT * FROM jh_meta ORDER BY key').all(), before);
  }
  edit.close();

  const rollbackPath = path.join(root, 'rollback.sqlite');
  const rollback = new Database(rollbackPath);
  rollback.exec(`CREATE TABLE jobs (source TEXT, job_id TEXT, application_status TEXT, applied_at TEXT, PRIMARY KEY(source, job_id));
    CREATE TABLE application_stage_events (id INTEGER PRIMARY KEY, job_source TEXT, job_id TEXT, stage TEXT, note TEXT, occurred_at TEXT);
    CREATE TRIGGER reject_backfill BEFORE INSERT ON application_stage_events BEGIN SELECT RAISE(ABORT, 'deliberate failure'); END;`);
  rollback.prepare('INSERT INTO jobs VALUES (?, ?, ?, ?)').run('linkedin', 'rollback', 'applied', syntheticAppliedAt);
  const schemaBefore = rollback.prepare('SELECT * FROM sqlite_master ORDER BY name').all();
  assert.throws(() => migrate(rollbackPath), /deliberate failure/);
  assert.deepEqual(rollback.prepare('SELECT * FROM sqlite_master ORDER BY name').all(), schemaBefore);
  assert.equal(rollback.prepare('SELECT count(*) AS n FROM application_stage_events').get().n, 0);
  rollback.exec('DROP TRIGGER reject_backfill');
  assert.equal(migrate(rollbackPath).linkedinAccessInitialized, true);
  rollback.close();

  console.log('jh-migrate tests: PASS');
} finally {
  rmSync(root, { recursive: true, force: true });
}
