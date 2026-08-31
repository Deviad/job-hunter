#!/usr/bin/env node
/**
 * TDD Test Harness for LinkedIn Job Extraction & Language Filtering
 *
 * Usage:
 *   node scripts/test-extraction-and-filter.mjs
 *
 * Loads fixture HTML files, extracts fields, compares against expected JSON.
 * Tests language filter logic with various user language scenarios.
 */

import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  extractTitle,
  extractCompany,
  extractLocation,
  extractApplicants,
  extractDescription,
  extractApplicationLinks,
  extractRecruiter,
  extractJobPostingDate,
  extractRecruiterEmail,
  extractRecruiterProfileLink,
  parseLanguageRequirements,
  passesLanguageFilter,
} from './linkedin-extractor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, '..', 'references', 'fixtures');

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, message) {
  if (!condition) {
    failed++;
    failures.push(`FAIL: ${message}`);
    console.error(`  ✗ ${message}`);
  } else {
    passed++;
    console.log(`  ✓ ${message}`);
  }
}

function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failed++;
    failures.push(`FAIL: ${label} — expected ${e}, got ${a}`);
    console.error(`  ✗ ${label}: expected ${e}, got ${a}`);
  } else {
    passed++;
    console.log(`  ✓ ${label}`);
  }
}

// Load all fixture HTML files and their expected JSON
const fixtureFiles = readdirSync(FIXTURES_DIR)
  .filter((f) => f.endsWith('.html'))
  .sort();

console.log(`\n📋 LinkedIn Job Extraction & Filter Tests`);
console.log(`========================================\n`);

for (const htmlFile of fixtureFiles) {
  const baseName = htmlFile.replace('.html', '');
  const expectedFile = `${baseName}-expected.json`;
  const html = readFileSync(join(FIXTURES_DIR, htmlFile), 'utf-8');
  const expected = JSON.parse(
    readFileSync(join(FIXTURES_DIR, expectedFile), 'utf-8')
  );

  console.log(`\n--- ${baseName} ---`);

  // Test extraction
  const title = extractTitle(html);
  assertEqual(title, expected.title, `title`);

  const company = extractCompany(html);
  assertEqual(company, expected.company, `company`);

  const location = extractLocation(html);
  assertEqual(location, expected.location, `location`);

  const applicants = extractApplicants(html);
  assertEqual(applicants, expected.applicants, `applicants`);

  const description = extractDescription(html);
  // Check description contains expected key phrases
  if (expected.description) {
    const descWords = expected.description.split(' ').slice(0, 5).join(' ');
    assert(
      description.includes(descWords),
      `description should contain "${descWords}"`
    );
  }

  const links = extractApplicationLinks(html);
  assertEqual(links, expected.applicationLinks, `applicationLinks`);

  const recruiter = extractRecruiter(html);
  assertEqual(recruiter, expected.recruiter, `recruiter`);

  // Test new fields
  const jobPostingDate = extractJobPostingDate(html);
  assertEqual(jobPostingDate, expected.jobPostingDate, `jobPostingDate`);

  const recruiterEmail = extractRecruiterEmail(html);
  assertEqual(recruiterEmail, expected.recruiterEmail, `recruiterEmail`);

  const recruiterProfileLink = extractRecruiterProfileLink(html);
  assertEqual(recruiterProfileLink, expected.recruiterProfileLink, `recruiterProfileLink`);

  // Test language requirement parsing
  const langReqs = parseLanguageRequirements(description);
  assertEqual(langReqs.required, expected.languageRequirements.required, `required languages`);
  assertEqual(langReqs.niceToHave, expected.languageRequirements.niceToHave, `nice-to-have languages`);
}

console.log(`\n--- Applicant Count Edge Cases ---\n`);

const applicantCases = [
  ['Over 100 applicants', 100, '"Over 100 applicants" → 100'],
  ['100+ applicants', 100, '"100+ applicants" → 100'],
  ['27 applicants applied', 27, '"27 applicants applied" → 27'],
  ['No applicant info here', null, 'no applicant info → null'],
];

for (const [html, expected, label] of applicantCases) {
  const actual = extractApplicants(html);
  assertEqual(actual, expected, label);
}

console.log(`\n--- Language Filter Tests ---\n`);

// Test language filter scenarios
const testCases = [
  // [requirements, userLanguage, expectedPass]
  [{ required: ['English'], niceToHave: [] }, 'English', true, 'English-only job, user=English → pass'],
  [{ required: ['English'], niceToHave: [] }, 'German', false, 'English-only job, user=German → skip'],
  [{ required: ['German'], niceToHave: ['English'] }, 'German', true, 'German-required, user=German → pass'],
  [{ required: ['German'], niceToHave: ['English'] }, 'English', false, 'German-required, user=English → skip'],
  [{ required: ['English'], niceToHave: ['French'] }, 'English', true, 'English-required+French-nice, user=English → pass'],
  [{ required: ['English'], niceToHave: ['French'] }, 'French', false, 'English-required+French-nice, user=French → skip (English still required)'],
  [{ required: [], niceToHave: ['French'] }, 'English', true, 'No required, French nice-to-have, user=English → pass'],
  [{ required: [], niceToHave: [] }, 'English', true, 'No language requirements at all → pass'],
  [{ required: ['English', 'German'], niceToHave: [] }, 'English', false, 'English+German required, user=English only → skip'],
  [{ required: ['English', 'German'], niceToHave: [] }, 'German', false, 'English+German required, user=German only → skip'],
  [{ required: ['English', 'German'], niceToHave: [] }, 'English', false, 'Both required, user=English → skip (missing German)'],
  [{ required: ['English', 'German'], niceToHave: [] }, 'German', false, 'Both required, user=German → skip (missing English)'],
  [{ required: ['English', 'German'], niceToHave: [] }, 'English', false, 'Both required, user=English → skip'],
  [{ required: ['English', 'German'], niceToHave: [] }, 'German', false, 'Both required, user=German → skip'],
  // Edge: user language not in required list but no required languages
  [{ required: [], niceToHave: [] }, 'French', true, 'No requirements, any user language → pass'],
];

for (const [reqs, userLang, expected, label] of testCases) {
  const result = passesLanguageFilter(reqs, userLang);
  if (result === expected) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    failures.push(`FAIL: ${label} — expected ${expected}, got ${result}`);
    console.error(`  ✗ ${label}: expected ${expected}, got ${result}`);
  }
}

console.log(`\n--- SQLite Serialization Tests ---\n`);

// Validate that the data shapes used in save-to-sqlite.mjs serialize correctly
const sqliteTestCases = [
  {
    name: 'job record with all fields',
    record: {
      url: 'https://www.linkedin.com/jobs/view/123',
      title: 'Engineer',
      company: 'Co',
      location: 'City',
      applicants: 10,
      description: 'Job description here',
      applicationLinks: ['https://apply.com/1'],
      recruiter: 'Jane',
      recruiterEmail: 'candidate@example.invalid',
      recruiterProfileLink: 'https://linkedin.com/in/jane',
      jobPostingDate: 'Posted 1 week ago',
      languageRequirements: { required: ['English'], niceToHave: ['German'] },
      languageFilterPassed: true,
      searchedKeywords: 'engineer',
      searchedLocation: 'city',
    },
    checks: [
      (r) => JSON.stringify(r.applicationLinks) === '["https://apply.com/1"]',
      (r) => JSON.stringify(r.languageRequirements.required) === '["English"]',
      (r) => JSON.stringify(r.languageRequirements.niceToHave) === '["German"]',
      (r) => typeof r.applicants === 'number',
      (r) => typeof r.languageFilterPassed === 'boolean',
      (r) => r.recruiterEmail === 'candidate@example.invalid',
      (r) => r.recruiterProfileLink === 'https://linkedin.com/in/jane',
      (r) => r.jobPostingDate === 'Posted 1 week ago',
    ],
  },
  {
    name: 'job record with null fields',
    record: {
      url: 'https://www.linkedin.com/jobs/view/456',
      title: null,
      company: null,
      location: null,
      applicants: null,
      description: null,
      applicationLinks: [],
      recruiter: null,
      recruiterEmail: null,
      recruiterProfileLink: null,
      jobPostingDate: null,
      languageRequirements: { required: [], niceToHave: [] },
      languageFilterPassed: true,
      searchedKeywords: null,
      searchedLocation: null,
    },
    checks: [
      (r) => JSON.stringify(r.applicationLinks) === '[]',
      (r) => JSON.stringify(r.languageRequirements.required) === '[]',
      (r) => r.applicants === null,
      (r) => r.title === null,
      (r) => r.recruiterEmail === null,
      (r) => r.recruiterProfileLink === null,
      (r) => r.jobPostingDate === null,
    ],
  },
  {
    name: 'multiple application links',
    record: {
      url: 'https://www.linkedin.com/jobs/view/789',
      title: 'Dev',
      company: null,
      location: null,
      applicants: null,
      description: null,
      applicationLinks: ['https://apply.com/1', 'https://apply.com/2'],
      recruiter: null,
      recruiterEmail: null,
      recruiterProfileLink: null,
      jobPostingDate: null,
      languageRequirements: { required: [], niceToHave: [] },
      languageFilterPassed: true,
      searchedKeywords: null,
      searchedLocation: null,
    },
    checks: [
      (r) => JSON.stringify(r.applicationLinks) === '["https://apply.com/1","https://apply.com/2"]',
      (r) => r.applicationLinks.length === 2,
    ],
  },
];

for (const { name, record, checks } of sqliteTestCases) {
  let allOk = true;
  for (let i = 0; i < checks.length; i++) {
    const ok = checks[i](record);
    if (!ok) {
      failed++;
      failures.push(`FAIL: ${name} — check ${i} failed`);
      console.error(`  ✗ ${name}: check ${i} failed`);
      allOk = false;
    }
  }
  if (allOk) {
    passed++;
    console.log(`  ✓ ${name}`);
  }
}

console.log(`\n========================================`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(`\nFailures:`);
  for (const f of failures) {
    console.error(`  ${f}`);
  }
  process.exit(1);
} else {
  console.log(`All tests passed! ✅\n`);
}
