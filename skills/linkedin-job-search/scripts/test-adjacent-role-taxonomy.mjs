#!/usr/bin/env node
import assert from 'node:assert/strict';
import { classifyLinkedInRole, toDbRecord } from './search-linkedin-jobs.mjs';
import { classifyNormalizedRole, normalizeJob } from './save-to-sqlite.mjs';

const listing = classifyLinkedInRole({
  title: 'AI Technical Lead',
  descriptionText: '',
  query: 'AI Architect',
}, true);
assert.equal(listing.provisional, true);
assert.ok(listing.confidence <= 0.65, 'listing-only confidence must be capped');
assert.equal(listing.signals.queryUsed, false);
assert.equal(listing.reason.queryUsedAsEvidence, false);

const fullDescription = classifyLinkedInRole({
  title: 'AI Technical Lead',
  descriptionText: 'Own technical direction and production architecture for machine-learning systems; lead platform decisions.',
  jobFunction: 'Engineering',
  industries: 'Software Development',
  query: 'unrelated search text',
}, false);
assert.equal(fullDescription.label, 'Adjacent technical');
assert.equal(fullDescription.provisional, false);
assert.ok(fullDescription.confidence > listing.confidence);
assert.deepEqual(fullDescription.reason, classifyLinkedInRole({
  title: 'AI Technical Lead',
  descriptionText: 'Own technical direction and production architecture for machine-learning systems; lead platform decisions.',
  jobFunction: 'Engineering',
  industries: 'Software Development',
}, false).reason);

const queryOnly = classifyLinkedInRole({
  title: 'Technical Lead',
  descriptionText: '',
  query: 'AI Architect technical direction production architecture',
}, true);
assert.equal(queryOnly.label, 'Out of scope', 'search query must not become JD evidence');

const dbRecord = toDbRecord({
  source: 'linkedin',
  job_id: '123',
  url: 'https://www.linkedin.com/jobs/view/123',
  title: 'AI Architect',
  descriptionText: '',
  searchedKeywords: 'AI Architect',
  roleType: 'legacy-invalid-label',
  roleConfidence: null,
  roleFilterReason: null,
});
assert.equal(dbRecord.roleFamilyInferred, 'Exact architecture');
assert.equal(dbRecord.roleFamilyReason, 'AI architecture is explicit in the title or in the technical responsibilities.');
assert.equal(typeof dbRecord.roleFamilyConfidence, 'number');

const normalized = normalizeJob({
  source: 'linkedin',
  jobId: '456',
  url: 'https://www.linkedin.com/jobs/view/456',
  title: 'Data Architect',
  descriptionText: 'Design data warehouses and lakehouse platforms.',
  roleFamilyInferred: 'Exact architecture',
  roleFamilyConfidence: 1,
  roleFamilyReason: 'legacy reason',
}, 0);
assert.equal(normalized.row.roleFamilyInferred, 'Out of scope');
assert.equal(normalized.row.roleFamilyReason, 'Excluded because generic data-architecture title.');
assert.ok(normalized.row.roleFamilyConfidence >= 0.85);

assert.equal(classifyNormalizedRole({
  title: 'AI Architect',
  descriptionText: '<p>Own technical direction for production AI systems.</p>',
}).label, 'Exact architecture');

console.log('adjacent-role taxonomy tests: PASS');
