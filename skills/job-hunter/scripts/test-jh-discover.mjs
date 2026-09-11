#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { backfillRows as rawBackfillRows, classifyListing as rawClassifyListing, extractBackfill, insertDiscoveredRows, rowFromResult as rawRowFromResult } from './jh-discover.mjs';
const taxonomy = { primaryTitles: ['Registered Nurse'], adjacentTitles: ['Clinical Educator'], leadershipTitles: ['Head of AI Engineering'], queryExclusionTerms: ['Veterinary Nurse'] };
const classifyListing = (input) => rawClassifyListing({ ...input, taxonomy });
const rowFromResult = (result, query, location) => rawRowFromResult(result, query, location, taxonomy);
const backfillRows = (db, opts, rows) => rawBackfillRows(db, { ...opts, taxonomy }, rows);
const provisional = classifyListing({ title: 'Registered Nurse', descriptionText: 'Patient care.', provisional: true });
assert.equal(provisional.label, 'Primary role');
assert.ok(provisional.confidence <= 0.65);
assert.equal(provisional.reason.queryUsedAsEvidence, false);
const validStub = rowFromResult({ url: 'https://jobs.lever.co/example/nurse', title: 'Registered Nurse', content: 'Patient care.' }, 'Registered Nurse', 'Ireland');
assert.equal(validStub.role_family_inferred, 'Primary role');
assert.equal(rowFromResult({ url: 'https://jobs.lever.co/example/vet', title: 'Veterinary Nurse', content: 'Animal care.' }, 'Registered Nurse', 'Ireland'), null);
const unknown = rowFromResult({ url: 'https://jobs.lever.co/example/other', title: 'Care Coordinator', content: 'Coordinate appointments.' }, 'Registered Nurse', 'Ireland');
assert.equal(unknown.role_family_inferred, 'Unclassified', 'unknown titles remain review candidates');
assert.equal(classifyListing({ title: '', descriptionText: 'Our team has registered nurses.', query: 'Registered Nurse' }).label, 'Unclassified');
const queryTitleBackfill = extractBackfill('https://jobs.lever.co/example/query-title', '<title>Registered Nurse</title>', 'Registered Nurse', 'Registered Nurse');
assert.equal(queryTitleBackfill.title, '', 'query must not supply missing title evidence');

const newRow = { source: 'external', job_id: 'new-job' };
const existingRow = { source: 'external', job_id: 'existing-job' };
const insertDb = {
  prepare(sql) {
    if (sql.includes('SELECT 1')) return { get: (_source, jobId) => jobId === 'existing-job' ? { 1: 1 } : undefined };
    if (sql.includes('INSERT OR IGNORE')) return { run: () => ({ changes: 1 }) };
    throw new Error(`Unexpected SQL in insert fixture: ${sql}`);
  },
  transaction(fn) { return fn; },
};
const insertResult = insertDiscoveredRows(insertDb, [existingRow, newRow], false);
assert.equal(insertResult.inserted, 1);
assert.deepEqual(insertResult.insertedRows, [newRow]);

const fullLeadershipDescription = 'Own technical direction, architecture quality, engineering standards, and platform strategy for an AI platform. Manage 10 engineers across 2 teams. Hire and mentor engineers while leading cross-team production delivery and the technical roadmap.';
const html = `<html><head><script type="application/ld+json">${JSON.stringify({
  '@type': 'JobPosting',
  title: 'Head of AI Engineering',
  description: fullLeadershipDescription,
  hiringOrganization: { name: 'Example Co' },
})}</script></head><body></body></html>`;
const server = createServer((req, res) => {
  if (req.url === '/fail') {
    res.writeHead(503);
    res.end('unavailable');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(html);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
try {
  const { port } = server.address();
  const updates = [];
  const backfillDb = {
    prepare(sql) {
      if (sql.includes('language_filter_reason = NULL')) return { run: (params) => updates.push({ type: 'success', ...params }) };
      if (sql.includes('language_filter_reason = @reason')) return { run: (params) => updates.push({ type: 'failure', ...params }) };
      throw new Error(`Unexpected SQL in backfill fixture: ${sql}`);
    },
  };
  const backfillResult = await backfillRows(backfillDb, { dryRun: false, json: true }, [{
    source: 'external',
    job_id: 'backfill-job',
    url: `http://127.0.0.1:${port}/head-ai-engineering`,
    title: 'Head of AI Engineering',
    company: 'Example Co',
    searched_keywords: 'AI Architect',
  }]);
  assert.equal(backfillResult[0].ok, true);
  assert.equal(backfillResult[0].role_family_inferred, 'Leadership progression');
  assert.equal(updates[0].type, 'success');
  assert.equal(updates[0].role_family_inferred, 'Leadership progression');
  assert.equal(updates[0].language_filter_reason, undefined);

  const failed = await backfillRows(backfillDb, { dryRun: false, json: true }, [{
    source: 'external',
    job_id: 'failed-job',
    url: `http://127.0.0.1:${port}/fail`,
    title: 'AI Architect',
    company: 'Example Co',
    searched_keywords: 'AI Architect',
  }]);
  assert.equal(failed[0].ok, false);
  assert.match(updates[1].reason, /^backfill-failed:/);
  assert.equal(updates[1].role_family_inferred, undefined, 'transport failures must not become role labels');
} finally {
  await new Promise((resolve) => server.close(resolve));
}

console.log('jh-discover tests: PASS');
