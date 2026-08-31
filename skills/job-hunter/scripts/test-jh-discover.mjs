#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  backfillRows,
  classifyListing,
  extractBackfill,
  insertDiscoveredRows,
  rowFromResult,
} from './jh-discover.mjs';

const provisional = classifyListing({
  title: 'AI Architect',
  descriptionText: 'Design production AI systems and own platform architecture.',
  provisional: true,
});
assert.equal(provisional.label, 'Exact architecture');
assert.equal(provisional.provisional, true);
assert.ok(provisional.confidence <= 0.65);
assert.equal(provisional.reason.queryUsedAsEvidence, false);

const dataAndAi = classifyListing({
  title: 'Data & AI Architect',
  descriptionText: 'Design AI system architecture; data modelling and governance are secondary responsibilities.',
  provisional: false,
});
assert.equal(dataAndAi.label, 'Data-domain stretch');
assert.equal(dataAndAi.provisional, false);

assert.equal(classifyListing({
  title: 'Principal Data Architect',
  descriptionText: 'Own enterprise data architecture and warehouse strategy.',
}).label, 'Out of scope');
assert.equal(classifyListing({
  title: 'Lead Software Engineer — AI Platform',
  descriptionText: 'Own AI platform architecture and technical direction.',
}).label, 'Out of scope');

const validStub = rowFromResult({
  url: 'https://jobs.lever.co/example/ai-architect',
  title: 'AI Architect',
  content: 'Design production AI systems and own platform architecture.',
}, 'AI Architect', 'Ireland');
assert.ok(validStub);
assert.equal(validStub.role_family_inferred, 'Exact architecture');
assert.equal(validStub.role_family_confidence <= 0.65, true);
assert.equal(JSON.parse(validStub.role_family_reason).queryUsedAsEvidence, false);

assert.equal(rowFromResult({
  url: 'https://jobs.lever.co/example/data-architect',
  title: 'Principal Data Architect',
  content: 'Own enterprise data architecture and warehouse strategy.',
}, 'AI Architect', 'Ireland'), null);
assert.equal(rowFromResult({
  url: 'https://jobs.lever.co/example/software-engineer',
  title: 'Principal Software Engineer — AI',
  content: 'Own AI platform architecture and technical direction.',
}, 'AI Architect', 'Ireland'), null);
assert.equal(rowFromResult({
  url: 'https://jobs.lever.co/example/enterprise-architect',
  title: 'Enterprise Architect',
  content: 'Own ERP architecture.',
}, 'AI Architect', 'Ireland'), null, 'search query must not become classification evidence');
const queryTitleBackfill = extractBackfill(
  'https://jobs.lever.co/example/query-title',
  `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: 'AI Architect', description: 'Customer success and account coordination responsibilities.' })}</script><title>AI Architect</title>`,
  'AI Architect',
  'AI Architect',
);
assert.equal(queryTitleBackfill.title, '', 'backfill must not use the search query as the job title evidence');
assert.equal(classifyListing({ title: queryTitleBackfill.title, descriptionText: queryTitleBackfill.description_text, provisional: false }).label, 'Out of scope');

const provisionalLeadership = rowFromResult({
  url: 'https://jobs.lever.co/example/head-ai-engineering',
  title: 'Head of AI Engineering',
  content: 'Lead hiring, people management, and roadmap ownership for an AI engineering function.',
}, 'AI Architect', 'Ireland');
assert.ok(provisionalLeadership, 'AI-central provisional out-of-scope stubs must survive for JD backfill');
assert.equal(provisionalLeadership.role_family_inferred, 'Out of scope');
assert.equal(classifyListing({
  title: 'Head of AI Engineering',
  descriptionText: 'Own technical direction, architecture quality, engineering standards, and platform strategy for an AI platform. Manage 10 engineers across 2 teams.',
  provisional: false,
}).label, 'Leadership progression');

const provisionalData = rowFromResult({
  url: 'https://jobs.lever.co/example/data-ai-architect',
  title: 'Data & AI Architect',
  content: 'Own data modelling, governance, lakehouse, warehouse, Spark, Databricks, and Snowflake.',
}, 'AI Architect', 'Ireland');
assert.ok(provisionalData, 'Data & AI stubs must survive until the full JD distinguishes stretch from data-dominated scope');
assert.equal(provisionalData.role_family_inferred, 'Out of scope');
assert.equal(classifyListing({
  title: 'Data & AI Architect',
  descriptionText: 'Design AI system architecture; data governance and warehouse are secondary responsibilities.',
  provisional: false,
}).label, 'Data-domain stretch');

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
