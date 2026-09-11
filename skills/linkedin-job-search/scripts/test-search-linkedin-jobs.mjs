#!/usr/bin/env node
/**
 * Focused tests for the LinkedIn search slice: shared query expansion,
 * --refresh-job-ids parsing/validation, query-family provenance, and
 * existing-ID suppression bypass for refresh IDs.
 *
 * No live CDP calls — all fixture-based.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  passesLanguage,
  buildQueryPlan,
  buildQueries,
  bypassRefreshIds,
  mergeExplicitRefreshIds,
  getQueryFamily,
  parseRefreshJobIds,
  toDbRecord,
} from './search-linkedin-jobs.mjs';
import * as roleTaxonomy from '../../job-hunter/scripts/role-taxonomy.mjs';

let passed = 0;
let failed = 0;

const fixtureHome = mkdtempSync(path.join(tmpdir(), 'linkedin-search-profile-'));
const taxonomy = JSON.parse(readExampleTaxonomy());
writeFileSync(path.join(fixtureHome, 'personal-info-cache.json'), JSON.stringify({
  schemaVersion: 2,
  languages: { English: 'fluent' },
  rolePreferences: {
    preferredPrimaryRoles: ['AI Architect'],
    adjacentRoles: {
      adjacentTechnicalLeadership: ['AI Platform Lead'],
      leadershipProgression: ['Head of AI Engineering'],
    },
    taxonomy,
  },
}, null, 2));
writeFileSync(path.join(fixtureHome, 'profile-derived.json'), JSON.stringify({
  schemaVersion: 1,
  extractorVersion: 'cv-v1',
  cvPath: path.join(fixtureHome, 'CV.docx'),
  cvSha256: 'fixture-cv-sha',
  referenceDataSha256: null,
  generatedAt: '2026-09-11T00:00:00.000Z',
  skills: [],
  certifications: [],
  languages: [{ name: 'English', level: 'fluent', evidence: 'fixture' }],
  titles: { values: ['AI Architect'] },
  counts: { skills: 0, certifications: 0, languages: 1, titles: 1 },
}, null, 2));
process.env.JOBHUNTER_HOME = fixtureHome;

function readExampleTaxonomy() {
  return JSON.stringify({
    schemaVersion: 1,
    name: 'ai-architect-fixture',
    domainTokens: ['ai', 'artificial intelligence', 'genai', 'generative ai', 'llm', 'machine learning', 'mlops'],
    disciplineTokens: ['architect', 'architecture', 'technical direction', 'system design', 'production architecture'],
    adjacentTitles: ['principal ai engineer', 'ai platform lead', 'mlops architect'],
    leadershipTitles: ['head of ai engineering', 'engineering manager ai platform'],
    gapSkills: [{ name: 'Databricks', pattern: '\\bdatabricks\\b' }],
    gapRoleTitlePattern: '\\bdata and ai architect\\b',
    conditionalTerms: ['pre-sales', 'ai governance'],
    queryExpansions: [
      'AI Architect',
      'Generative AI Architect',
      'GenAI Architect',
      'Enterprise AI Architect',
      'AI Platform Architect',
      'AI Solutions Architect',
      'Applied AI Architect',
      'Forward Deployed Architect',
      'Forward Deployed Engineer',
      'Principal AI Engineer',
      'MLOps Architect',
      'Head of AI Engineering',
      'AI Security Specialist',
      'Data & AI Architect',
    ],
    queryExclusionTerms: ['software engineer', 'data scientist'],
    excludedTitleFamilies: ['building-architecture'],
  });
}

test('language filtering distinguishes unknown from an explicitly excluded language', () => {
  const requirements = { required: ['Dutch'], niceToHave: [] };
  const unknown = passesLanguage(requirements, { speaks: ['English'], excludeLanguages: [] });
  assert.equal(unknown.pass, true);
  assert.deepEqual(unknown.unknown, ['Dutch']);
  assert.equal(passesLanguage(requirements, { speaks: ['English'], excludeLanguages: ['Dutch'] }).pass, false);
});

test('collector does not reintroduce a query removed by user preferences', () => {
  const profile = { roles: { primary: ['Civil Engineer'], adjacent: ['Project Manager'], leadership: [] }, taxonomy: { queryExclusionTerms: ['Project Manager'] } };
  assert.deepEqual(buildQueryPlan({ role: 'Civil Engineer' }, profile).queries, ['Civil Engineer']);
});

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

// ── buildQueries: consumes shared taxonomy expansion ──────────────────

const taxonomyQueries = roleTaxonomy.expandRoleQueries({
  targetRole: 'AI Architect',
  similarRoles: [],
  maxQueries: 32,
  taxonomy,
});

test('buildQueries returns taxonomy-expanded queries for AI Architect role', () => {
  const queries = buildQueries({
    role: 'AI Architect',
    similarRoles: [],
    roleVariants: true,
  }, { roles: { primary: ['AI Architect'], adjacent: [], leadership: [] }, taxonomy });
  assert.ok(queries.length > 5, 'should produce more than the old 5-title list');
  for (const tq of taxonomyQueries) {
    assert.ok(queries.includes(tq), `taxonomy query "${tq}" missing from buildQueries output`);
  }
});

test('buildQueries no longer maintains a private five-title list', () => {
  const queries = buildQueries({
    role: 'AI Architect',
    similarRoles: [],
    roleVariants: true,
  }, { roles: { primary: ['AI Architect'], adjacent: [], leadership: [] }, taxonomy });
  // Old private list: Artificial Intelligence Architect, AI Solution Architect,
  // Enterprise AI Architect, GenAI Architect, Data AI Architect.
  // These must now come from the taxonomy expansion, not a private list.
  assert.ok(queries.includes('Enterprise AI Architect'), 'Enterprise AI Architect from taxonomy');
  assert.ok(queries.includes('GenAI Architect'), 'GenAI Architect from taxonomy');
});

test('buildQueries respects 32-query hard cap', () => {
  const queries = buildQueries({
    role: 'AI Architect',
    similarRoles: [],
    roleVariants: true,
  }, { roles: { primary: ['AI Architect'], adjacent: [], leadership: [] }, taxonomy });
  assert.ok(queries.length <= 32, `got ${queries.length}, expected <= 32`);
});

test('buildQueries includes supplementary families not in taxonomy', () => {
  const queries = buildQueries({
    role: 'AI Architect',
    similarRoles: [],
    roleVariants: true,
  }, { roles: { primary: ['AI Architect'], adjacent: [], leadership: [] }, taxonomy });
  assert.ok(queries.includes('Applied AI Architect'), 'Applied AI Architect supplementary');
  assert.ok(queries.includes('Forward Deployed Architect'), 'Forward Deployed Architect supplementary');
  assert.ok(queries.includes('Forward Deployed Engineer'), 'Forward Deployed Engineer supplementary');
});

test('buildQueries with --no-role-variants returns only user-supplied', () => {
  const queries = buildQueries({
    role: 'AI Architect',
    similarRoles: ['AI Platform Lead'],
    roleVariants: false,
  });
  assert.deepEqual(queries, ['AI Architect', 'AI Platform Lead']);
});

test('buildQueries with explicit queries bypasses expansion', () => {
  const queries = buildQueries({
    role: 'AI Architect',
    similarRoles: [],
    roleVariants: true,
    queries: ['Custom Query', 'Another Query'],
  });
  assert.deepEqual(queries, ['Custom Query', 'Another Query']);
});

// ── getQueryFamily: query-family provenance ────────────────────────────

test('getQueryFamily returns profile-relative families with a query context', () => {
  const plan = buildQueryPlan({
    role: 'AI Architect',
    similarRoles: ['AI Platform Lead'],
    roleVariants: true,
  }, {
    roles: {
      primary: ['AI Architect'],
      adjacent: ['AI Platform Lead'],
      leadership: ['Head of AI Engineering'],
    },
    taxonomy,
  });
  assert.equal(getQueryFamily('AI Architect', plan.context), 'primary');
  assert.equal(getQueryFamily('AI Platform Lead', plan.context), 'adjacent');
  assert.equal(getQueryFamily('Head of AI Engineering', plan.context), 'leadership');
  assert.equal(getQueryFamily('Forward Deployed Architect', plan.context), 'expansion');
});

test('getQueryFamily returns user-supplied for unrecognized queries', () => {
  assert.equal(getQueryFamily('Some Random Title'), 'user-supplied');
  assert.equal(getQueryFamily(''), 'user-supplied');
});

// ── parseRefreshJobIds: parsing, validation, dedup, cap ────────────────

test('parseRefreshJobIds parses comma-separated numeric IDs', () => {
  const ids = parseRefreshJobIds('9000000002,9000000003');
  assert.deepEqual(ids, ['9000000002', '9000000003']);
});

test('parseRefreshJobIds handles whitespace around IDs', () => {
  const ids = parseRefreshJobIds(' 9000000002 , 9000000003 ');
  assert.deepEqual(ids, ['9000000002', '9000000003']);
});

test('parseRefreshJobIds deduplicates', () => {
  const ids = parseRefreshJobIds('9000000002,9000000002,9000000003');
  assert.deepEqual(ids, ['9000000002', '9000000003']);
});

test('parseRefreshJobIds rejects non-numeric IDs', () => {
  assert.throws(
    () => parseRefreshJobIds('9000000002,abc'),
    /must be numeric/,
  );
});

test('parseRefreshJobIds enforces 50-ID cap', () => {
  const many = Array.from({ length: 51 }, (_, i) => String(9000001001 + i)).join(',');
  assert.throws(
    () => parseRefreshJobIds(many),
    /max 50/,
  );
});

test('parseRefreshJobIds accepts exactly 50 IDs', () => {
  const fifty = Array.from({ length: 50 }, (_, i) => String(9000001001 + i)).join(',');
  const ids = parseRefreshJobIds(fifty);
  assert.equal(ids.length, 50);
});

test('parseRefreshJobIds returns empty array for empty/null input', () => {
  assert.deepEqual(parseRefreshJobIds(''), []);
  assert.deepEqual(parseRefreshJobIds(null), []);
  assert.deepEqual(parseRefreshJobIds(undefined), []);
});

// ── bypassRefreshIds: existing-ID suppression bypass ──────────────────

test('bypassRefreshIds removes refresh IDs from existing set', () => {
  const existing = new Set(['9000000002', '9000001005', '9999999999']);
  const result = bypassRefreshIds(existing, new Set(['9000000002']));
  assert.ok(!result.has('9000000002'), 'refresh ID must be removed from existing set');
  assert.ok(result.has('9000001005'), 'non-refresh ID must remain');
  assert.ok(result.has('9999999999'), 'non-refresh ID must remain');
});

test('bypassRefreshIds does not alter normal deduplication for other jobs', () => {
  const existing = new Set(['111', '222', '333']);
  const result = bypassRefreshIds(existing, new Set(['222']));
  assert.equal(result.size, 2);
  assert.ok(result.has('111'));
  assert.ok(result.has('333'));
  assert.ok(!result.has('222'));
});

test('bypassRefreshIds returns original set when no refresh IDs', () => {
  const existing = new Set(['111', '222']);
  const result = bypassRefreshIds(existing, null);
  assert.equal(result.size, 2);
  assert.ok(result.has('111'));
  assert.ok(result.has('222'));
});

test('mergeExplicitRefreshIds schedules and prioritizes every requested ID', () => {
  const results = mergeExplicitRefreshIds([
    { query: 'AI Architect', ids: ['111', '9000000002'], pages: [], status: 'healthy' },
  ], ['9000000002', '9000000003']);
  assert.equal(results.length, 2);
  assert.deepEqual(results[0], {
    query: 'Explicit LinkedIn ID refresh',
    ids: ['9000000002', '9000000003'],
    pages: [],
    status: 'healthy',
  });
  assert.deepEqual(results[1].ids, ['111']);
  assert.equal(getQueryFamily(results[0].query), 'explicit-refresh');
});

test('mergeExplicitRefreshIds is a no-op when no IDs are requested', () => {
  const source = [{ query: 'AI Architect', ids: ['9000000002'], pages: [], status: 'healthy' }];
  const results = mergeExplicitRefreshIds(source, []);
  assert.deepEqual(results, source);
});

// ── toDbRecord: includes roleTaxonomyVersion ───────────────────────────

test('toDbRecord includes roleTaxonomyVersion in output', () => {
  const record = toDbRecord({
    source: 'linkedin',
    job_id: '123',
    url: 'https://www.linkedin.com/jobs/view/123',
    title: 'AI Architect',
    descriptionText: 'AI architecture for production systems',
    searchedKeywords: 'AI Architect',
  });
  assert.ok('roleTaxonomyVersion' in record, 'roleTaxonomyVersion field must exist');
  // Value is SHARED_TAXONOMY_VERSION — null if taxonomy worker hasn't exported it yet,
  // otherwise a non-empty string.
  if (record.roleTaxonomyVersion !== null) {
    assert.equal(typeof record.roleTaxonomyVersion, 'string');
    assert.ok(record.roleTaxonomyVersion.length > 0);
  }
});

// ── Summary structure: queryFamilies and refresh counters ─────────────

test('queryFamilies array maps each query to a family', () => {
  const queries = buildQueries({
    role: 'AI Architect',
    similarRoles: [],
    roleVariants: true,
  }, { roles: { primary: ['AI Architect'], adjacent: [], leadership: [] }, taxonomy });
  const plan = buildQueryPlan({
    role: 'AI Architect',
    similarRoles: [],
    roleVariants: true,
  }, { roles: { primary: ['AI Architect'], adjacent: [], leadership: [] }, taxonomy });
  const queryFamilies = queries.map((q) => ({ query: q, family: getQueryFamily(q, plan.context) }));
  assert.equal(queryFamilies.length, queries.length);
  for (const entry of queryFamilies) {
    assert.ok(entry.query, 'query must be non-empty');
    assert.ok(entry.family, 'family must be non-empty');
    assert.equal(typeof entry.family, 'string');
  }
});

test('refresh counters structure has requested/found/refreshed/missing', () => {
  const refreshJobIds = ['9000000002', '9000000003'];
  const ids = ['9000000002', '9999999999'];
  const scrapedRecords = [
    { job_id: '9000000002', descriptionText: 'refreshed description' },
  ];
  const refresh = {
    requested: refreshJobIds.length,
    found: refreshJobIds.filter((id) => ids.includes(id)).length,
    refreshed: refreshJobIds.filter((id) => scrapedRecords.some((r) => r.job_id === id && r.descriptionText)).length,
    missing: refreshJobIds.filter((id) => !scrapedRecords.some((r) => r.job_id === id)).length,
  };
  assert.equal(refresh.requested, 2);
  assert.equal(refresh.found, 1);
  assert.equal(refresh.refreshed, 1);
  assert.equal(refresh.missing, 1);
});

// ── Run ───────────────────────────────────────────────────────────────

console.log('\n── test-search-linkedin-jobs.mjs ──');
console.log(`  Passed: ${passed}, Failed: ${failed}\n`);
if (failed > 0) process.exit(1);
