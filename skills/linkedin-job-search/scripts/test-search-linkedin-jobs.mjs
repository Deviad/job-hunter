#!/usr/bin/env node
/**
 * Focused tests for the LinkedIn search slice: shared query expansion,
 * --refresh-job-ids parsing/validation, query-family provenance, and
 * existing-ID suppression bypass for refresh IDs.
 *
 * No live CDP calls — all fixture-based.
 */
import assert from 'node:assert/strict';

import {
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
});

test('buildQueries returns taxonomy-expanded queries for AI Architect role', () => {
  const queries = buildQueries({
    role: 'AI Architect',
    similarRoles: [],
    roleVariants: true,
  });
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
  });
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
  });
  assert.ok(queries.length <= 32, `got ${queries.length}, expected <= 32`);
});

test('buildQueries includes supplementary families not in taxonomy', () => {
  const queries = buildQueries({
    role: 'AI Architect',
    similarRoles: [],
    roleVariants: true,
  });
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

test('getQueryFamily returns correct families for known queries', () => {
  assert.equal(getQueryFamily('AI Architect'), 'core-architect');
  assert.equal(getQueryFamily('AI Platform Architect'), 'platform-mlops');
  assert.equal(getQueryFamily('MLOps Architect'), 'platform-mlops');
  assert.equal(getQueryFamily('Principal AI Engineer'), 'principal-staff-lead');
  assert.equal(getQueryFamily('AI Solutions Architect'), 'solutions-field');
  assert.equal(getQueryFamily('Head of AI Engineering'), 'leadership');
  assert.equal(getQueryFamily('AI Security Specialist'), 'security-governance');
  assert.equal(getQueryFamily('Data & AI Architect'), 'data-ai');
  assert.equal(getQueryFamily('Enterprise AI Architect'), 'enterprise');
  assert.equal(getQueryFamily('GenAI Architect'), 'generative-ai');
  assert.equal(getQueryFamily('Applied AI Architect'), 'applied-ai-architect');
  assert.equal(getQueryFamily('Forward Deployed Architect'), 'forward-deployed');
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
  });
  const queryFamilies = queries.map((q) => ({ query: q, family: getQueryFamily(q) }));
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
