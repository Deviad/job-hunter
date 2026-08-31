#!/usr/bin/env node
import { Database } from '../../job-hunter/scripts/workspace-dependencies.mjs';
/**
 * Focused tests for save-to-sqlite.mjs: role_taxonomy_version column
 * migration, persistence with new/refreshed classifications, and
 * preservation on descriptionless updates.
 *
 * Uses :memory: databases only — no canonical DB is touched.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

import { normalizeJob } from './save-to-sqlite.mjs';
import * as roleTaxonomy from '../../job-hunter/scripts/role-taxonomy.mjs';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
  }
}

const SCHEMA_SQL = `PRAGMA foreign_keys = ON;
  CREATE TABLE jobs (
    source TEXT NOT NULL, job_id TEXT NOT NULL,
    url TEXT, title TEXT, company TEXT,
    description_raw TEXT, description_text TEXT,
    location_raw TEXT, country_code TEXT, region TEXT, city TEXT,
    job_posting_date TEXT, applicants_raw TEXT, applicants_count INTEGER,
    application_links_json TEXT, recruiter TEXT, recruiter_email TEXT,
    recruiter_profile_link TEXT, role_family_inferred TEXT,
    role_family_confidence REAL, role_family_reason TEXT,
    language_filter_reason TEXT, work_mode_reason TEXT,
    searched_keywords TEXT, searched_location TEXT,
    application_status TEXT NOT NULL DEFAULT 'saved', applied_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (source, job_id)
  );
  CREATE TABLE job_languages (
    source TEXT NOT NULL, job_id TEXT NOT NULL, language TEXT NOT NULL,
    importance TEXT NOT NULL CHECK (importance IN ('required', 'nice_to_have')),
    PRIMARY KEY (source, job_id, language, importance)
  );
  CREATE TABLE job_work_modes (
    source TEXT NOT NULL, job_id TEXT NOT NULL,
    work_mode TEXT NOT NULL, is_primary INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (source, job_id, work_mode)
  );`;

const ROLE_LABELS = roleTaxonomy.ROLE_LABELS;
const ROLE_LABEL_SQL = ROLE_LABELS.map((l) => `'${l.replaceAll("'", "''")}'`).join(', ');

const UPSERT_SQL = `
  INSERT INTO jobs (
    source, job_id, url, title, company, description_raw, description_text,
    location_raw, country_code, region, city, job_posting_date,
    applicants_raw, applicants_count, application_links_json,
    recruiter, recruiter_email, recruiter_profile_link,
    role_family_inferred, role_family_confidence, role_family_reason,
    language_filter_reason, work_mode_reason,
    searched_keywords, searched_location, role_taxonomy_version
  ) VALUES (
    @source, @jobId, @url, @title, @company, @descriptionRaw, @descriptionText,
    @locationRaw, @countryCode, @region, @city, @jobPostingDate,
    @applicantsRaw, @applicantsCount, @applicationLinksJson,
    @recruiter, @recruiterEmail, @recruiterProfileLink,
    @roleFamilyInferred, @roleFamilyConfidence, @roleFamilyReason,
    @languageFilterReason, @workModeReason,
    @searchedKeywords, @searchedLocation, @roleTaxonomyVersion
  )
  ON CONFLICT(source, job_id) DO UPDATE SET
    url = excluded.url,
    title = excluded.title,
    company = excluded.company,
    description_raw = excluded.description_raw,
    description_text = excluded.description_text,
    location_raw = excluded.location_raw,
    country_code = excluded.country_code,
    region = excluded.region,
    city = excluded.city,
    job_posting_date = excluded.job_posting_date,
    applicants_raw = excluded.applicants_raw,
    applicants_count = excluded.applicants_count,
    application_links_json = excluded.application_links_json,
    recruiter = excluded.recruiter,
    recruiter_email = excluded.recruiter_email,
    recruiter_profile_link = excluded.recruiter_profile_link,
    role_family_inferred = CASE
      WHEN NULLIF(trim(excluded.description_text), '') IS NULL
        AND role_family_inferred IN (${ROLE_LABEL_SQL})
        THEN COALESCE(role_family_inferred, excluded.role_family_inferred)
      ELSE COALESCE(excluded.role_family_inferred, role_family_inferred)
    END,
    role_family_confidence = CASE
      WHEN NULLIF(trim(excluded.description_text), '') IS NULL
        AND role_family_inferred IN (${ROLE_LABEL_SQL})
        THEN COALESCE(role_family_confidence, excluded.role_family_confidence)
      ELSE COALESCE(excluded.role_family_confidence, role_family_confidence)
    END,
    role_family_reason = CASE
      WHEN NULLIF(trim(excluded.description_text), '') IS NULL
        AND role_family_inferred IN (${ROLE_LABEL_SQL})
        THEN COALESCE(role_family_reason, excluded.role_family_reason)
      ELSE COALESCE(excluded.role_family_reason, role_family_reason)
    END,
    role_taxonomy_version = CASE
      WHEN NULLIF(trim(excluded.description_text), '') IS NULL
        AND role_family_inferred IN (${ROLE_LABEL_SQL})
        THEN COALESCE(role_taxonomy_version, excluded.role_taxonomy_version)
      ELSE COALESCE(excluded.role_taxonomy_version, role_taxonomy_version)
    END,
    language_filter_reason = excluded.language_filter_reason,
    work_mode_reason = excluded.work_mode_reason,
    searched_keywords = excluded.searched_keywords,
    searched_location = excluded.searched_location
`;

// ── normalizeJob includes roleTaxonomyVersion ──────────────────────────

test('normalizeJob includes roleTaxonomyVersion field', () => {
  const job = normalizeJob({
    source: 'linkedin',
    job_id: '9000001003',
    url: 'https://linkedin.example/jobs/view/9999999999',
    title: 'AI Architect',
    descriptionText: 'Own AI architecture for production systems',
    searchedKeywords: 'AI Architect',
  });
  assert.ok('row' in job, 'normalizeJob returns { row, languages, workModes }');
  assert.ok('roleTaxonomyVersion' in job.row, 'row must have roleTaxonomyVersion');
});

test('normalizeJob respects explicit roleTaxonomyVersion from input', () => {
  const job = normalizeJob({
    source: 'linkedin',
    job_id: '9000001003',
    url: 'https://linkedin.example/jobs/view/9999999999',
    title: 'AI Architect',
    descriptionText: 'Own AI architecture',
    searchedKeywords: 'AI Architect',
    roleTaxonomyVersion: 'test-v42',
  });
  assert.equal(job.row.roleTaxonomyVersion, 'test-v42');
});

// ── Column migration: ALTER TABLE adds role_taxonomy_version ──────────

test('ALTER TABLE adds role_taxonomy_version when missing', () => {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  const colsBefore = db.prepare(`PRAGMA table_info(jobs)`).all().map((c) => c.name);
  assert.ok(!colsBefore.includes('role_taxonomy_version'), 'column must not exist before migration');
  db.exec(`ALTER TABLE jobs ADD COLUMN role_taxonomy_version TEXT`);
  const colsAfter = db.prepare(`PRAGMA table_info(jobs)`).all().map((c) => c.name);
  assert.ok(colsAfter.includes('role_taxonomy_version'), 'column must exist after ALTER TABLE');
  db.close();
});

// ── New rows get ROLE_TAXONOMY_VERSION ────────────────────────────────

test('new row with description gets role_taxonomy_version on insert', () => {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  db.exec(`ALTER TABLE jobs ADD COLUMN role_taxonomy_version TEXT`);
  const stmt = db.prepare(UPSERT_SQL);
  stmt.run({
    source: 'linkedin', jobId: '9000001003',
    url: 'https://linkedin.example/jobs/view/9999999999',
    title: 'AI Architect', company: 'TestCo',
    descriptionRaw: '<div>desc</div>', descriptionText: 'AI architecture for production',
    locationRaw: null, countryCode: null, region: null, city: null, jobPostingDate: null,
    applicantsRaw: null, applicantsCount: null, applicationLinksJson: null,
    recruiter: null, recruiterEmail: null, recruiterProfileLink: null,
    roleFamilyInferred: 'Exact architecture', roleFamilyConfidence: 0.85,
    roleFamilyReason: 'AI architecture explicit',
    languageFilterReason: null, workModeReason: null,
    searchedKeywords: 'AI Architect', searchedLocation: 'Switzerland',
    roleTaxonomyVersion: 'v1.0',
  });
  const row = db.prepare(`SELECT role_taxonomy_version FROM jobs WHERE source = 'linkedin' AND job_id = '9000001003'`).get();
  assert.equal(row.role_taxonomy_version, 'v1.0');
  db.close();
});

// ── Descriptionless update preserves existing role_taxonomy_version ──

test('descriptionless update preserves existing role_taxonomy_version', () => {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  db.exec(`ALTER TABLE jobs ADD COLUMN role_taxonomy_version TEXT`);
  const stmt = db.prepare(UPSERT_SQL);

  // Insert with description and version
  stmt.run({
    source: 'linkedin', jobId: '9000001003',
    url: 'https://linkedin.example/jobs/view/9999999999',
    title: 'AI Architect', company: 'TestCo',
    descriptionRaw: '<div>desc</div>', descriptionText: 'AI architecture for production',
    locationRaw: null, countryCode: null, region: null, city: null, jobPostingDate: null,
    applicantsRaw: null, applicantsCount: null, applicationLinksJson: null,
    recruiter: null, recruiterEmail: null, recruiterProfileLink: null,
    roleFamilyInferred: 'Exact architecture', roleFamilyConfidence: 0.85,
    roleFamilyReason: 'AI architecture explicit',
    languageFilterReason: null, workModeReason: null,
    searchedKeywords: 'AI Architect', searchedLocation: 'Switzerland',
    roleTaxonomyVersion: 'v1.0',
  });

  // Update with empty description (listing-only refresh) and null version
  stmt.run({
    source: 'linkedin', jobId: '9000001003',
    url: 'https://linkedin.example/jobs/view/9999999999',
    title: 'AI Architect', company: 'TestCo',
    descriptionRaw: null, descriptionText: '',
    locationRaw: null, countryCode: null, region: null, city: null, jobPostingDate: null,
    applicantsRaw: null, applicantsCount: null, applicationLinksJson: null,
    recruiter: null, recruiterEmail: null, recruiterProfileLink: null,
    roleFamilyInferred: 'Exact architecture', roleFamilyConfidence: 0.85,
    roleFamilyReason: 'AI architecture explicit',
    languageFilterReason: null, workModeReason: null,
    searchedKeywords: 'AI Architect', searchedLocation: 'Switzerland',
    roleTaxonomyVersion: null,
  });

  const row = db.prepare(`SELECT role_taxonomy_version FROM jobs WHERE source = 'linkedin' AND job_id = '9000001003'`).get();
  assert.equal(row.role_taxonomy_version, 'v1.0', 'version must be preserved on descriptionless update');
  db.close();
});

// ── Refreshed (with description) update sets new role_taxonomy_version ─

test('refreshed row with description gets updated role_taxonomy_version', () => {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  db.exec(`ALTER TABLE jobs ADD COLUMN role_taxonomy_version TEXT`);
  const stmt = db.prepare(UPSERT_SQL);

  // Insert with old version
  stmt.run({
    source: 'linkedin', jobId: '9000001003',
    url: 'https://linkedin.example/jobs/view/9999999999',
    title: 'Stale Title', company: 'TestCo',
    descriptionRaw: '<div>old</div>', descriptionText: 'old description',
    locationRaw: null, countryCode: null, region: null, city: null, jobPostingDate: null,
    applicantsRaw: null, applicantsCount: null, applicationLinksJson: null,
    recruiter: null, recruiterEmail: null, recruiterProfileLink: null,
    roleFamilyInferred: 'Exact architecture', roleFamilyConfidence: 0.8,
    roleFamilyReason: 'old reason',
    languageFilterReason: null, workModeReason: null,
    searchedKeywords: 'AI Architect', searchedLocation: 'Switzerland',
    roleTaxonomyVersion: 'v1.0',
  });

  // Refresh with new description and new version
  stmt.run({
    source: 'linkedin', jobId: '9000001003',
    url: 'https://linkedin.example/jobs/view/9999999999',
    title: 'AI Architect', company: 'TestCo',
    descriptionRaw: '<div>new</div>', descriptionText: 'updated AI architecture description',
    locationRaw: null, countryCode: null, region: null, city: null, jobPostingDate: null,
    applicantsRaw: null, applicantsCount: null, applicationLinksJson: null,
    recruiter: null, recruiterEmail: null, recruiterProfileLink: null,
    roleFamilyInferred: 'Exact architecture', roleFamilyConfidence: 0.9,
    roleFamilyReason: 'updated reason',
    languageFilterReason: null, workModeReason: null,
    searchedKeywords: 'AI Architect', searchedLocation: 'Switzerland',
    roleTaxonomyVersion: 'v2.0',
  });

  const row = db.prepare(`SELECT role_taxonomy_version FROM jobs WHERE source = 'linkedin' AND job_id = '9000001003'`).get();
  assert.equal(row.role_taxonomy_version, 'v2.0', 'version must be updated when description is present');
  db.close();
});

// ── Old rows remain null until next touch (no bulk rewrite) ──────────

test('old rows without role_taxonomy_version remain null', () => {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  db.exec(`ALTER TABLE jobs ADD COLUMN role_taxonomy_version TEXT`);

  // Insert a historical row directly (without using the upsert, simulating old data)
  db.prepare(`INSERT INTO jobs (source, job_id, title, description_text, application_status)
    VALUES ('linkedin', '9999999999', 'Old Job', 'old desc', 'saved')`).run();

  const row = db.prepare(`SELECT role_taxonomy_version FROM jobs WHERE source = 'linkedin' AND job_id = '9999999999'`).get();
  assert.equal(row.role_taxonomy_version, null, 'historical row must have null version until next touch');
  db.close();
});

// ── CLI integration: save-to-sqlite.mjs end-to-end with temp DB ───────

test('CLI save-to-sqlite.mjs adds column and persists version', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'save-test-'));
  const dbPath = join(tmpDir, 'test.sqlite');
  const jsonPath = join(tmpDir, 'jobs.json');

  const jobs = [{
    source: 'linkedin',
    job_id: '9000001003',
    url: 'https://linkedin.example/jobs/view/9999999999',
    title: 'AI Architect',
    company: 'TestCo',
    descriptionText: 'AI architecture for production systems',
    searchedKeywords: 'AI Architect',
    searchedLocation: 'Switzerland',
    roleTaxonomyVersion: 'cli-test-v1',
  }];
  writeFileSync(jsonPath, JSON.stringify(jobs));

  const schemaPath = join(process.cwd(), 'skills/linkedin-job-search/schema.sql');
  execSync(
    `node skills/linkedin-job-search/scripts/save-to-sqlite.mjs "${jsonPath}" --db "${dbPath}" --schema "${schemaPath}"`,
    { encoding: 'utf8', cwd: process.cwd() },
  );

  const db = new Database(dbPath);
  const cols = db.prepare(`PRAGMA table_info(jobs)`).all().map((c) => c.name);
  assert.ok(cols.includes('role_taxonomy_version'), 'column must exist after CLI save');
  const row = db.prepare(`SELECT role_taxonomy_version FROM jobs WHERE source = 'linkedin' AND job_id = '9000001003'`).get();
  assert.equal(row.role_taxonomy_version, 'cli-test-v1', 'version must be persisted from input');
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── Run ───────────────────────────────────────────────────────────────

console.log('\n── test-save-to-sqlite.mjs ──');
console.log(`  Passed: ${passed}, Failed: ${failed}\n`);
if (failed > 0) process.exit(1);
