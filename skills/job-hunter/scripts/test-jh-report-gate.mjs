#!/usr/bin/env node
/**
 * Unit tests for jh-report-gate.mjs — remediation R6 final-report gate.
 * Uses a temp SQLite DB seeded with jobs/match_results/job_salary_observations;
 * does NOT touch ~/.job-hunter/jobhunter.sqlite.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripPartialSuffix, partialSuffixPath } from './jh-report-gate.mjs';

const SCRIPT_DIR = resolve(fileURLToPath(import.meta.url), '..');
const GATE_SCRIPT = join(SCRIPT_DIR, 'jh-report-gate.mjs');
const DAY_MS = 86_400_000;
const daysAgo = (days) => new Date(Date.now() - days * DAY_MS).toISOString();
const today = new Date().toISOString();

function makeTempDb() {
  const dbPath = join(tmpdir(), `test-report-gate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sqlite`);
  const schema = `
    CREATE TABLE jobs (
      source TEXT, job_id TEXT, title TEXT, company TEXT,
      job_posting_date TEXT, created_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (source, job_id)
    );
    CREATE TABLE match_results (search_id TEXT, source TEXT, job_id TEXT, cta TEXT, fit_score REAL);
    CREATE TABLE job_salary_observations (
      job_source TEXT, job_id TEXT, observation_id TEXT,
      is_posted_salary INTEGER, benchmark_id TEXT, observed_at TEXT,
      PRIMARY KEY (job_source, job_id, observation_id)
    );
  `;
  execFileSync('sqlite3', [dbPath], { input: schema });
  return dbPath;
}

function sql(dbPath, statement) {
  execFileSync('sqlite3', [dbPath], { input: statement });
}

function cleanupDb(dbPath) {
  try { unlinkSync(dbPath); } catch {}
}

function runGate(args) {
  try {
    const out = execFileSync('node', [GATE_SCRIPT, ...args, '--json'], { encoding: 'utf8' });
    return { status: 0, result: JSON.parse(out) };
  } catch (e) {
    return { status: e.status, result: e.stdout ? JSON.parse(e.stdout) : null, stderr: e.stderr };
  }
}

// ── Pure helpers: PARTIAL suffix round-trip ───────────────────────────
{
  assert.equal(partialSuffixPath('/tmp/report.md'), '/tmp/report.PARTIAL.md');
  assert.equal(partialSuffixPath('/tmp/report.PARTIAL.md'), '/tmp/report.PARTIAL.md', 'idempotent on already-PARTIAL');
  assert.equal(stripPartialSuffix('/tmp/report.PARTIAL.md'), '/tmp/report.md');
  assert.equal(stripPartialSuffix('/tmp/report.md'), '/tmp/report.md', 'no-op on non-PARTIAL');
  console.log('✓ PARTIAL suffix helpers round-trip correctly');
}

// ── Gate passes when every Apply row has provenance ───────────────────
{
  const db = makeTempDb();
  sql(db, `
    INSERT INTO jobs (source,job_id,title,company) VALUES ('linkedin','1','AI Architect','Acme');
    INSERT INTO match_results VALUES ('search-1','linkedin','1','Apply',85);
    INSERT INTO job_salary_observations VALUES ('linkedin','1','obs-1',1,NULL,'${today}');
  `);
  const { status, result } = runGate(['--search-id', 'search-1', '--db', db]);
  assert.equal(status, 0, 'gate exits 0 when all Apply rows have provenance');
  assert.equal(result.passed, true);
  assert.equal(result.missingProvenance.length, 0);
  cleanupDb(db);
  console.log('✓ gate PASSes when every Apply row has salary provenance');
}

// ── Gate fails when an Apply row has no observation at all ────────────
{
  const db = makeTempDb();
  sql(db, `
    INSERT INTO jobs (source,job_id,title,company) VALUES ('linkedin','2','AI Architect','Acme');
    INSERT INTO match_results VALUES ('search-2','linkedin','2','Apply',85);
  `);
  const { status, result } = runGate(['--search-id', 'search-2', '--db', db]);
  assert.equal(status, 1, 'gate exits 1 when an Apply row has no salary observation');
  assert.equal(result.passed, false);
  assert.equal(result.missingProvenance.length, 1);
  assert.equal(result.missingProvenance[0].job_id, '2');
  cleanupDb(db);
  console.log('✓ gate fails when an Apply row has no salary observation at all');
}

// ── Estimate with benchmark_id counts as provenance; estimate WITHOUT benchmark_id does not ──
{
  const db = makeTempDb();
  sql(db, `
    INSERT INTO jobs (source,job_id,title,company) VALUES ('linkedin','3','AI Architect','Acme'), ('linkedin','4','AI Architect','Beta');
    INSERT INTO match_results VALUES ('search-3','linkedin','3','Apply',85), ('search-3','linkedin','4','Apply',80);
    INSERT INTO job_salary_observations VALUES ('linkedin','3','obs-3',0,'bench-1','${today}');
    INSERT INTO job_salary_observations VALUES ('linkedin','4','obs-4',0,NULL,'${today}');
  `);
  const { status, result } = runGate(['--search-id', 'search-3', '--db', db]);
  assert.equal(status, 1);
  assert.equal(result.missingProvenance.length, 1, 'only the benchmark_id-less estimate is missing provenance');
  assert.equal(result.missingProvenance[0].job_id, '4');
  cleanupDb(db);
  console.log('✓ estimate requires a real benchmark_id to count as provenance');
}

// ── Skip/Maybe rows never gate the report (only Apply rows matter) ────
{
  const db = makeTempDb();
  sql(db, `
    INSERT INTO jobs (source,job_id,title,company) VALUES ('linkedin','5','AI Architect','Acme');
    INSERT INTO match_results VALUES ('search-4','linkedin','5','Skip',30);
  `);
  const { status, result } = runGate(['--search-id', 'search-4', '--db', db]);
  assert.equal(status, 0, 'no Apply rows means nothing to gate on');
  assert.equal(result.totalApplyRows, 0);
  cleanupDb(db);
  console.log('✓ Skip/Maybe rows do not block the gate; only Apply rows are checked');
}

// ── Degraded --run source status fails the gate even with clean provenance ──
{
  const db = makeTempDb();
  sql(db, `
    INSERT INTO jobs (source,job_id,title,company) VALUES ('linkedin','6','AI Architect','Acme');
    INSERT INTO match_results VALUES ('search-5','linkedin','6','Apply',85);
    INSERT INTO job_salary_observations VALUES ('linkedin','6','obs-6',1,NULL,'${today}');
  `);
  const { status, result } = runGate(['--search-id', 'search-5', '--db', db, '--run', 'nonexistent-run-id']);
  assert.equal(status, 1, 'gate fails when a named run has no checkpoint (degraded source)');
  assert.equal(result.degradedSources.length, 1);
  cleanupDb(db);
  console.log('✓ a --run with no/non-ok checkpoint degrades the gate regardless of provenance');
}

// ── Report file is renamed to .PARTIAL.md on failure, with findings appended ──
{
  const db = makeTempDb();
  sql(db, `
    INSERT INTO jobs (source,job_id,title,company) VALUES ('linkedin','7','AI Architect','Acme');
    INSERT INTO match_results VALUES ('search-6','linkedin','7','Apply',85);
  `);
  const reportDir = join(tmpdir(), `gate-report-test-${Date.now()}`);
  mkdirSync(reportDir, { recursive: true });
  const reportPath = join(reportDir, 'report.md');
  writeFileSync(reportPath, '# Report\nbody\n');

  runGate(['--search-id', 'search-6', '--db', db, '--report', reportPath]);
  assert.equal(existsSync(reportPath), false, 'original report.md renamed away');
  const partialPath = join(reportDir, 'report.PARTIAL.md');
  assert.equal(existsSync(partialPath), true, 'report.PARTIAL.md created');
  const content = readFileSync(partialPath, 'utf8');
  assert.match(content, /Degraded sources \/ missing provenance/);
  assert.match(content, /linkedin:7/);

  cleanupDb(db);
  rmSync(reportDir, { recursive: true, force: true });
  console.log('✓ failing gate renames report.md -> report.PARTIAL.md with findings appended');
}

// ── Stale posting (>30d, real signal) fails the gate even with clean provenance ──
{
  const db = makeTempDb();
  sql(db, `
    INSERT INTO jobs (source,job_id,title,company,job_posting_date,created_at)
      VALUES ('indeed','8','AI Architect','Acme','${daysAgo(60)}','${daysAgo(60)}');
    INSERT INTO match_results VALUES ('search-7','indeed','8','Apply',85);
    INSERT INTO job_salary_observations VALUES ('indeed','8','obs-8',1,NULL,'${today}');
  `);
  const { status, result } = runGate(['--search-id', 'search-7', '--db', db]);
  assert.equal(status, 1, 'gate fails when an Apply row has a real posting date older than the default 30-day cutoff');
  assert.equal(result.stalePostings.length, 1);
  assert.equal(result.stalePostings[0].job_id, '8');
  cleanupDb(db);
  console.log('✓ gate fails on a >30-day-old real posting date even with clean salary provenance');
}

// ── Fresh posting (<30d) passes the freshness check ──
{
  const db = makeTempDb();
  sql(db, `
    INSERT INTO jobs (source,job_id,title,company,job_posting_date,created_at)
      VALUES ('indeed','9','AI Architect','Acme','${daysAgo(5)}','${daysAgo(5)}');
    INSERT INTO match_results VALUES ('search-8','indeed','9','Apply',85);
    INSERT INTO job_salary_observations VALUES ('indeed','9','obs-9',1,NULL,'${today}');
  `);
  const { status } = runGate(['--search-id', 'search-8', '--db', db]);
  assert.equal(status, 0, 'a recently posted Apply row with clean provenance passes');
  cleanupDb(db);
  console.log('✓ gate PASSes on a fresh (<30d) posting with clean provenance');
}

// ── Custom --max-age-days is honored ──
{
  const db = makeTempDb();
  sql(db, `
    INSERT INTO jobs (source,job_id,title,company,job_posting_date,created_at)
      VALUES ('indeed','10','AI Architect','Acme','${daysAgo(26)}','${daysAgo(26)}');
    INSERT INTO match_results VALUES ('search-9','indeed','10','Apply',85);
    INSERT INTO job_salary_observations VALUES ('indeed','10','obs-10',1,NULL,'${today}');
  `);
  // ~26 days old: passes default 30-day cutoff, fails a stricter 14-day cutoff
  const { status: status30 } = runGate(['--search-id', 'search-9', '--db', db]);
  assert.equal(status30, 0, '~26 days old passes the default 30-day cutoff');
  const { status: status14 } = runGate(['--search-id', 'search-9', '--db', db, '--max-age-days', '14']);
  assert.equal(status14, 1, '~26 days old fails a stricter --max-age-days 14');
  cleanupDb(db);
  console.log('✓ --max-age-days is a real parameter, not hardcoded to 30');
}

console.log('\n── All jh-report-gate.mjs tests passed ──\n');
