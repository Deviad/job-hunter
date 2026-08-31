#!/usr/bin/env node
import { Database } from '../../job-hunter/scripts/workspace-dependencies.mjs';
/**
 * Save extracted LinkedIn job data to SQLite using the normalized skill schema.
 *
 * Usage:
 *   node scripts/save-to-sqlite.mjs <json_data> [--db /path/to/jobhunter.sqlite]
 *
 * Where <json_data> is either:
 *   - a JSON string (inline)
 *   - a file path (starts with ./ or /)
 *   - '-' for stdin
 *
 * Default DB path: $PWD/jobhunter.sqlite (i.e. the directory Pi Agent was
 * launched from — `path.join(process.cwd(), 'jobhunter.sqlite')`).
 * Default schema path: ../schema.sql relative to this script.
 * Use --db ':memory:' only for smoke/integration tests.
 *
 * Deduplication rule:
 *   Jobs are uniquely identified by (source, job_id).
 *   The URL is stored only as a reference and is never used for uniqueness.
 *
 * Normalization rules:
 *   - languages are stored in job_languages with canonical values such as English/German/French/Italian
 *   - work modes are stored in job_work_modes as onsite/hybrid/remote rows
 *   - applicants_raw keeps LinkedIn's original wording; applicants_count stores the first parsed number
 *     e.g. "Over 100 applicants" -> applicants_raw="Over 100 applicants", applicants_count=100
 */

import { readFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import {
  ROLE_LABELS,
  ROLE_TAXONOMY_VERSION,
  classifyRole,
  assertRoleClassification,
} from '../../job-hunter/scripts/role-taxonomy.mjs';

const JOBHUNTER_HOME = process.env.JOBHUNTER_HOME || join(process.env.HOME || process.cwd(), '.job-hunter');
const DEFAULT_DB = process.env.JOBHUNTER_DB || join(JOBHUNTER_HOME, 'jobhunter.sqlite');
const DEFAULT_SOURCE = 'linkedin';
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = dirname(SCRIPT_DIR);
const DEFAULT_SCHEMA = join(SKILL_DIR, 'schema.sql');
const ROLE_LABEL_SQL = ROLE_LABELS.map((label) => `'${label.replaceAll("'", "''")}'`).join(', ');

const LANGUAGE_ALIASES = new Map([
  ['english', 'English'],
  ['englisch', 'English'],
  ['anglais', 'English'],
  ['inglese', 'English'],
  ['german', 'German'],
  ['deutsch', 'German'],
  ['deutschkenntnisse', 'German'],
  ['allemand', 'German'],
  ['tedesco', 'German'],
  ['french', 'French'],
  ['français', 'French'],
  ['francais', 'French'],
  ['französisch', 'French'],
  ['franzoesisch', 'French'],
  ['francese', 'French'],
  ['italian', 'Italian'],
  ['italienisch', 'Italian'],
  ['italien', 'Italian'],
  ['italiano', 'Italian'],
]);

const COUNTRY_CODES = new Map([
  ['switzerland', 'CH'],
  ['schweiz', 'CH'],
  ['suisse', 'CH'],
  ['svizzera', 'CH'],
  ['germany', 'DE'],
  ['deutschland', 'DE'],
  ['france', 'FR'],
  ['francia', 'FR'],
  ['italy', 'IT'],
  ['italia', 'IT'],
  ['united kingdom', 'GB'],
  ['uk', 'GB'],
  ['great britain', 'GB'],
  ['united states', 'US'],
  ['usa', 'US'],
]);

function parseCliArgs(argv) {
  let dbPath = DEFAULT_DB;
  let schemaPath = DEFAULT_SCHEMA;
  let dataInput = null;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--db') {
      dbPath = argv[++i];
    } else if (argv[i] === '--schema') {
      schemaPath = argv[++i];
    } else if (dataInput === null) {
      dataInput = argv[i];
    }
  }

  return { dbPath, schemaPath, dataInput };
}

function printUsage() {
  console.error(`\n❌ Usage: node scripts/save-to-sqlite.mjs <json_data> [--db /path/to/db] [--schema /path/to/schema.sql]`);
  console.error(`   Provide JSON inline, as a file path, or '-' for stdin`);
  console.error(`   Default DB: ${DEFAULT_DB}`);
  console.error(`   Default schema: ${DEFAULT_SCHEMA}`);
  console.error(`   Use --db ':memory:' only for smoke/integration tests.\n`);
}

async function loadInput(input) {
  if (input === '-') {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString();
  }
  if (input.startsWith('/') || input.startsWith('./') || input.startsWith('~')) {
    const resolved = input.replace('~', process.env.HOME || require('os').homedir());
    return readFileSync(resolved, 'utf-8');
  }
  return input;
}

function normalizeSource(value) {
  return String(value || DEFAULT_SOURCE).trim().toLowerCase();
}

function extractJobIdFromUrl(url) {
  if (!url) return null;
  const match = String(url).match(/\/jobs\/view\/(\d+)/);
  return match ? match[1] : null;
}

function normalizeJobId(job) {
  const value = job.job_id ?? job.jobId ?? job.linkedinJobId ?? job.id ?? extractJobIdFromUrl(job.url);
  if (value === undefined || value === null || String(value).trim() === '') return null;
  return String(value).trim();
}

function defaultUrlFor(source, jobId, providedUrl) {
  if (providedUrl) return String(providedUrl);
  if (source === 'linkedin') return `https://www.linkedin.com/jobs/view/${jobId}`;
  return null;
}

function firstNonBlank(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const text = typeof value === 'string' ? value.trim() : value;
    if (text === '') continue;
    return value;
  }
  return null;
}

function coerceArray(value) {
  if (value === undefined || value === null || value === '') return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
      try {
        const parsed = JSON.parse(trimmed);
        return Array.isArray(parsed) ? parsed : [parsed];
      } catch {}
    }
    return trimmed.split(/[;,]/).map((item) => item.trim()).filter(Boolean);
  }
  return [value];
}

function uniqStrings(values) {
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
}

function stripHtml(value) {
  if (value === undefined || value === null) return null;
  return String(value)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim() || null;
}

function normalizeApplicantCount(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.trunc(value));
  const match = String(value).match(/(\d[\d.,]*)/);
  if (!match) return null;
  const digits = match[1].replace(/[^\d]/g, '');
  if (!digits) return null;
  return Math.max(0, parseInt(digits, 10));
}

function normalizeConfidence(value) {
  if (value === undefined || value === null || value === '') return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  if (num >= 0 && num <= 1) return num;
  if (num > 1 && num <= 100) return num / 100;
  return null;
}

function canonicalizeLanguage(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const compact = text.toLowerCase();
  if (LANGUAGE_ALIASES.has(compact)) return LANGUAGE_ALIASES.get(compact);
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
}

function normalizeLanguageList(value) {
  return uniqStrings(coerceArray(value).map(canonicalizeLanguage).filter(Boolean));
}

function getRequiredLanguages(job) {
  return job.languageRequirements?.required ?? job.requiredLanguages ?? job.required_languages ?? [];
}

function getNiceToHaveLanguages(job) {
  return job.languageRequirements?.niceToHave ?? job.niceToHaveLanguages ?? job.nice_to_have_languages ?? [];
}

function normalizeLanguageRows(job) {
  const required = normalizeLanguageList(getRequiredLanguages(job));
  const niceToHave = normalizeLanguageList(getNiceToHaveLanguages(job)).filter((lang) => !required.includes(lang));
  return [
    ...required.map((language) => ({ language, importance: 'required' })),
    ...niceToHave.map((language) => ({ language, importance: 'nice_to_have' })),
  ];
}

function normalizeWorkModeToken(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return null;
  if (text === 'remote') return 'remote';
  if (text === 'hybrid') return 'hybrid';
  if (text === 'onsite' || text === 'on-site' || text === 'on site' || text === 'office') return 'onsite';
  return null;
}

function splitWorkModeString(value) {
  return String(value || '')
    .split(/[,/|]|\bor\b|\band\b/gi)
    .map((part) => part.trim())
    .filter(Boolean);
}

function normalizeWorkModeRows(job) {
  const explicit = firstNonBlank(job.workModes, job.work_modes, job.jobWorkModes, job.job_work_modes);
  const single = firstNonBlank(job.workMode, job.work_mode);
  const rawItems = explicit !== null ? coerceArray(explicit) : (single !== null ? splitWorkModeString(single) : []);

  const rows = [];
  for (const item of rawItems) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const workMode = normalizeWorkModeToken(item.work_mode ?? item.workMode ?? item.mode);
      if (!workMode) continue;
      const isPrimary = item.is_primary === 1 || item.is_primary === true || item.isPrimary === 1 || item.isPrimary === true ? 1 : 0;
      rows.push({ work_mode: workMode, is_primary: isPrimary });
      continue;
    }
    const workMode = normalizeWorkModeToken(item);
    if (workMode) rows.push({ work_mode: workMode, is_primary: 0 });
  }

  const deduped = [];
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.work_mode)) continue;
    seen.add(row.work_mode);
    deduped.push(row);
  }
  if (deduped.length && deduped.every((row) => row.is_primary === 0)) deduped[0].is_primary = 1;
  let primarySeen = false;
  for (const row of deduped) {
    if (row.is_primary && !primarySeen) primarySeen = true;
    else if (row.is_primary) row.is_primary = 0;
  }
  return deduped;
}

function normalizeCountryCode(value) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  if (!text) return null;
  if (/^[A-Za-z]{2}$/.test(text)) return text.toUpperCase();
  const mapped = COUNTRY_CODES.get(text.toLowerCase());
  return mapped || null;
}

function normalizeLinks(job, fallbackUrl) {
  const links = uniqStrings(coerceArray(job.applicationLinks ?? job.application_links ?? []));
  if (links.length) return links;
  return fallbackUrl ? [fallbackUrl] : [];
}

function classifyNormalizedRole({ title, descriptionText, jobFunction, industries }) {
  const classification = classifyRole({
    title,
    descriptionText,
    jobFunction,
    industries,
    provisional: !String(descriptionText || '').trim(),
  });
  return assertRoleClassification(classification);
}

function normalizeJob(job, index) {
  const source = normalizeSource(job.source);
  const jobId = normalizeJobId(job);
  if (!jobId) {
    throw new Error(`Job at index ${index} is missing job_id/jobId/id and no LinkedIn job id could be extracted from url`);
  }

  const url = defaultUrlFor(source, jobId, job.url);
  const descriptionRaw = firstNonBlank(
    job.descriptionRaw,
    job.description_raw,
    job.descriptionHtml,
    job.description_html,
    job.description,
  );
  const descriptionTextValue = firstNonBlank(
    job.descriptionText,
    job.description_text,
    stripHtml(descriptionRaw),
  );
  const descriptionText = stripHtml(descriptionTextValue);
  const applicantsRawValue = firstNonBlank(job.applicantsRaw, job.applicants_raw, job.applicants);
  const applicantsRaw = applicantsRawValue === null ? null : String(applicantsRawValue);
  const applicantsCount = normalizeApplicantCount(firstNonBlank(job.applicantsCount, job.applicants_count, applicantsRawValue));
  const links = normalizeLinks(job, url);
  const title = firstNonBlank(job.title);
  const jobFunction = firstNonBlank(job.jobFunction, job.job_function);
  const industries = firstNonBlank(job.industries, job.industry);
  const role = classifyNormalizedRole({ title, descriptionText, jobFunction, industries });

  return {
    row: {
      source,
      jobId,
      url,
      title,
      company: firstNonBlank(job.company),
      descriptionRaw,
      descriptionText,
      locationRaw: firstNonBlank(job.locationRaw, job.location_raw, job.location),
      countryCode: normalizeCountryCode(firstNonBlank(job.countryCode, job.country_code, job.country)),
      region: firstNonBlank(job.region),
      city: firstNonBlank(job.city),
      jobPostingDate: firstNonBlank(job.jobPostingDate, job.job_posting_date),
      applicantsRaw,
      applicantsCount,
      applicationLinksJson: JSON.stringify(links),
      recruiter: firstNonBlank(job.recruiter),
      recruiterEmail: firstNonBlank(job.recruiterEmail, job.recruiter_email),
      recruiterProfileLink: firstNonBlank(job.recruiterProfileLink, job.recruiter_profile_link),
      roleFamilyInferred: role.label,
      roleFamilyConfidence: role.confidence,
      roleFamilyReason: role.reason.summary,
      roleTaxonomyVersion: firstNonBlank(job.roleTaxonomyVersion, job.role_taxonomy_version) ?? ROLE_TAXONOMY_VERSION,
      languageFilterReason: firstNonBlank(job.languageFilterReason, job.language_filter_reason),
      workModeReason: firstNonBlank(job.workModeReason, job.work_mode_reason),
      searchedKeywords: firstNonBlank(job.searchedKeywords, job.searched_keywords),
      searchedLocation: firstNonBlank(job.searchedLocation, job.searched_location),
    },
    languages: normalizeLanguageRows(job),
    workModes: normalizeWorkModeRows(job),
  };
}

function ensureSchemaCompatible(db, schemaPath) {
  const requiredJobColumns = [
    'source', 'job_id', 'url', 'title', 'company', 'description_raw', 'description_text',
    'location_raw', 'country_code', 'region', 'city', 'job_posting_date', 'applicants_raw',
    'applicants_count', 'application_links_json', 'recruiter', 'recruiter_email',
    'recruiter_profile_link', 'role_family_inferred', 'role_family_confidence',
    'role_family_reason', 'language_filter_reason', 'work_mode_reason',
    'searched_keywords', 'searched_location', 'application_status', 'applied_at',
    'created_at', 'updated_at',
  ];

  const jobsInfo = db.prepare(`PRAGMA table_info(jobs)`).all();
  const existingJobColumns = new Set(jobsInfo.map((col) => col.name));
  const missing = requiredJobColumns.filter((col) => !existingJobColumns.has(col));
  if (missing.length) {
    throw new Error(
      `Existing jobs table is incompatible with the normalized schema. Missing columns: ${missing.join(', ')}. `
      + `Recreate the database from ${schemaPath}.`
    );
  }

  const pkColumns = jobsInfo.filter((col) => col.pk > 0).sort((a, b) => a.pk - b.pk).map((col) => col.name);
  if (pkColumns.join(',') !== 'source,job_id') {
    throw new Error(
      `Existing jobs table has incompatible primary key (${pkColumns.join(',') || 'none'}). `
      + `Expected PRIMARY KEY (source, job_id).`
    );
  }

  for (const table of ['job_languages', 'job_work_modes']) {
    const row = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table);
    if (!row) {
      throw new Error(`Missing required table ${table}. Recreate the database from ${schemaPath}.`);
    }
  }
}

async function main() {
  const { dbPath, schemaPath, dataInput } = parseCliArgs(process.argv.slice(2));
  if (!dataInput) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const raw = await loadInput(dataInput);
  let jobs;
  try {
    jobs = JSON.parse(raw);
    if (!Array.isArray(jobs)) jobs = [jobs];
  } catch (e) {
    console.error(`\n❌ Invalid JSON: ${e.message}\n`);
    process.exit(1);
  }

  const normalizedJobs = jobs.map(normalizeJob);

  if (dbPath !== ':memory:') {
    const dbDir = dirname(dbPath);
    if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });
  }

  if (!existsSync(schemaPath)) {
    throw new Error(`Schema file not found: ${schemaPath}`);
  }

  
  const db = new Database(dbPath);
  if (dbPath !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // Guard against SQLITE_BUSY from concurrent writers: retry internally for up to 5 s
  db.pragma('busy_timeout = 5000');

  const jobsTableExists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'jobs'`).get();
  if (!jobsTableExists) {
    db.exec(readFileSync(schemaPath, 'utf8'));
  }
  ensureSchemaCompatible(db, schemaPath);

  const jobsCols = db.prepare(`PRAGMA table_info(jobs)`).all().map((c) => c.name);
  if (!jobsCols.includes('role_taxonomy_version')) {
    db.exec(`ALTER TABLE jobs ADD COLUMN role_taxonomy_version TEXT`);
  }

  const existsStmt = db.prepare(`SELECT 1 FROM jobs WHERE source = ? AND job_id = ?`);
  const upsertJobStmt = db.prepare(`
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
  `);

  const deleteLanguagesStmt = db.prepare(`DELETE FROM job_languages WHERE source = ? AND job_id = ?`);
  const insertLanguageStmt = db.prepare(`
    INSERT INTO job_languages (source, job_id, language, importance)
    VALUES (?, ?, ?, ?)
  `);

  const deleteWorkModesStmt = db.prepare(`DELETE FROM job_work_modes WHERE source = ? AND job_id = ?`);
  const insertWorkModeStmt = db.prepare(`
    INSERT INTO job_work_modes (source, job_id, work_mode, is_primary)
    VALUES (?, ?, ?, ?)
  `);

  let inserted = 0;
  let updated = 0;
  let languageRows = 0;
  let workModeRows = 0;

  const saveMany = db.transaction((records) => {
    for (const record of records) {
      const existed = Boolean(existsStmt.get(record.row.source, record.row.jobId));
      upsertJobStmt.run(record.row);

      deleteLanguagesStmt.run(record.row.source, record.row.jobId);
      for (const language of record.languages) {
        insertLanguageStmt.run(record.row.source, record.row.jobId, language.language, language.importance);
        languageRows++;
      }

      deleteWorkModesStmt.run(record.row.source, record.row.jobId);
      for (const workMode of record.workModes) {
        insertWorkModeStmt.run(record.row.source, record.row.jobId, workMode.work_mode, workMode.is_primary);
        workModeRows++;
      }

      if (existed) updated++;
      else inserted++;
    }
  });

  saveMany(normalizedJobs);
  db.close();

  console.log(`\n✅ SQLite save complete`);
  console.log(`   Database: ${dbPath}`);
  console.log(`   Schema: ${schemaPath}`);
  console.log(`   Jobs inserted: ${inserted}, updated: ${updated}, total: ${normalizedJobs.length}`);
  console.log(`   Language rows written: ${languageRows}`);
  console.log(`   Work-mode rows written: ${workModeRows}`);
  console.log(`   Deduplication key: PRIMARY KEY (source, job_id)`);
  console.log(`\n`);
}

export {
  classifyNormalizedRole,
  normalizeJob,
  normalizeConfidence,
  normalizeSource,
  parseCliArgs,
};

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => {
    console.error(`\n❌ SQLite save failed: ${err.message}\n`);
    process.exit(1);
  });
}
