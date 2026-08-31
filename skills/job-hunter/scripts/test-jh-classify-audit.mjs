#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { auditClassifications } from './jh-classify-audit.mjs';
import { ROLE_TAXONOMY_VERSION } from './role-taxonomy.mjs';

const home = process.env.JOBHUNTER_HOME || path.join(process.env.HOME, '.job-hunter');
const req = createRequire(path.join(home, 'package.json'));
const Database = req('better-sqlite3');
const root = mkdtempSync(path.join(tmpdir(), 'jh-classify-audit-test-'));
const dbPath = path.join(root, 'fixture.sqlite');
const scriptPath = new URL('./jh-classify-audit.mjs', import.meta.url).pathname;
const digest = () => createHash('sha256').update(readFileSync(dbPath)).digest('hex');

try {
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE jobs (
    source TEXT NOT NULL,
    job_id TEXT NOT NULL,
    role_family_inferred TEXT,
    role_taxonomy_version TEXT,
    PRIMARY KEY (source, job_id)
  )`);
  const insert = db.prepare('INSERT INTO jobs VALUES (?, ?, ?, ?)');
  insert.run('linkedin', '1', 'Exact architecture', ROLE_TAXONOMY_VERSION);
  insert.run('linkedin', '2', 'Adjacent technical', null);
  insert.run('linkedin', '3', 'Leadership lateral', 'legacy-v0');
  insert.run('linkedin', '4', 'ai_architecture', null);
  insert.run('linkedin', '5', null, null);
  db.close();

  const before = digest();
  const report = auditClassifications(dbPath);
  assert.deepEqual(report.counts, {
    total: 5,
    classified: 4,
    currentVersion: 1,
    unversioned: 2,
    staleVersion: 1,
    unknownLabel: 1,
  });
  assert.deepEqual(report.unknownLabels, { ai_architecture: 1 });
  assert.deepEqual(report.staleVersions, { 'legacy-v0': 1 });

  const cliReport = JSON.parse(execFileSync(process.execPath, [scriptPath, '--db', dbPath, '--json'], { encoding: 'utf8' }));
  assert.deepEqual(cliReport.counts, report.counts);
  assert.equal(digest(), before, 'audit leaves fixture database byte-identical');
  console.log('jh-classify-audit tests: PASS');
} finally {
  rmSync(root, { recursive: true, force: true });
}
