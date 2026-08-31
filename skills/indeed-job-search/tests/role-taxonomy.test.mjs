import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyForIndeed,
  expandRoleQueries,
  normalizeJob,
  parseArgs,
} from '../scripts/search-indeed-jobs.mjs';

const opts = {
  domain: 'https://uk.indeed.com',
  query: 'AI Architect',
  location: 'London',
  speaks: [],
  excludeLanguages: [],
};

function label(input) {
  return classifyForIndeed(input).classification.label;
}

test('retains --query and --q compatibility', () => {
  assert.equal(parseArgs(['--query', 'AI Architect', '--location', 'London']).query, 'AI Architect');
  assert.equal(parseArgs(['--q', 'AI Architect', '--location', 'London']).query, 'AI Architect');
});

test('expands relevant queries within the CLI bound', () => {
  const queries = expandRoleQueries({ targetRole: 'AI Architect', maxQueries: 5 });
  assert.equal(queries.length, 5);
  assert.equal(queries[0], 'AI Architect');
  assert.ok(queries.includes('Generative AI Architect'));
  assert.equal(expandRoleQueries({ targetRole: 'Backend Engineer', maxQueries: 10 }).length, 1);
});

test('uses only JD evidence, not query text, for classification', () => {
  const withoutQuery = classifyForIndeed({
    title: 'Platform Architect',
    descriptionText: 'Own platform architecture and system design for production services.',
    query: 'AI Architect',
  });
  const withDifferentQuery = classifyForIndeed({
    title: 'Platform Architect',
    descriptionText: 'Own platform architecture and system design for production services.',
    query: 'Generative AI Architect',
  });
  assert.deepEqual(withDifferentQuery.classification, withoutQuery.classification);
  assert.equal(withoutQuery.classification.reason.queryUsedAsEvidence, false);
  assert.equal(withoutQuery.classification.signals.queryUsed, false);
});

test('reclassifies a result after detail extraction', () => {
  const result = normalizeJob(
    {
      jobId: '1',
      title: 'AI Architect',
      cardDescriptionText: 'AI platform role',
      url: 'https://uk.indeed.com/viewjob?jk=1',
    },
    {
      title: 'Software Engineer - AI',
      descriptionText: 'Implement AI services in production.',
      descriptionExtracted: true,
    },
    opts,
  );
  assert.equal(result.roleFamilyInferred, 'Out of scope');
  assert.equal(result.roleClassificationProvisional, false);
});

test('falls back to the listing title when detail omits it', () => {
  const result = normalizeJob(
    {
      jobId: '2',
      title: 'Software Engineer - AI',
      cardDescriptionText: 'Build AI services.',
    },
    { descriptionText: 'Build AI services in production.', descriptionExtracted: true },
    opts,
  );
  assert.equal(result.roleFamilyInferred, 'Out of scope');
  assert.equal(result.title, 'Software Engineer - AI');
});

test('caps card-only classifications as provisional', () => {
  const result = normalizeJob(
    { jobId: '3', title: 'AI Architect', cardDescriptionText: 'AI platform role.' },
    { descriptionExtracted: false },
    opts,
  );
  assert.equal(result.roleClassificationProvisional, true);
  assert.ok(result.roleFamilyConfidence <= 0.65);
});

test('applies canonical data and leadership labels', () => {
  assert.equal(label({ title: 'Data Architect', descriptionText: 'Design data warehouses and governance.' }), 'Out of scope');
  assert.equal(label({ title: 'Data & AI Architect', descriptionText: 'Lead AI architecture; data modelling is secondary.' }), 'Data-domain stretch');
  assert.equal(label({
    title: 'Engineering Manager, AI Platform',
    descriptionText: 'Own technical direction and architecture standards for 10 engineers across 2 teams.',
  }), 'Leadership progression');
  assert.equal(label({
    title: 'Engineering Manager, AI Platform',
    descriptionText: 'Manage five engineers and delivery ceremonies for an AI product.',
  }), 'Out of scope');
});
