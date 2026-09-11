import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyForIndeed, expandRoleQueries, normalizeJob, parseArgs } from '../scripts/search-indeed-jobs.mjs';
const taxonomy = { primaryTitles: ['Civil Engineer'], adjacentTitles: ['Structural Engineer'], leadershipTitles: ['Project Manager'], queryExclusionTerms: ['Sales Engineer'], queryExpansions: ['Structural Engineer', 'Project Manager'] };
const opts = { domain: 'https://uk.indeed.com', query: 'Civil Engineer', location: 'London', speaks: [], excludeLanguages: [], taxonomy };
test('query and q remain compatible', () => {
  assert.equal(parseArgs(['--query', 'Civil Engineer', '--location', 'London']).query, 'Civil Engineer');
  assert.equal(parseArgs(['--q', 'Civil Engineer', '--location', 'London']).query, 'Civil Engineer');
});
test('only configured expansions are used and bounds apply', () => {
  assert.deepEqual(expandRoleQueries({ targetRole: opts.query, taxonomy, maxQueries: 2 }), ['Civil Engineer', 'Structural Engineer']);
  assert.deepEqual(expandRoleQueries({ targetRole: opts.query }), ['Civil Engineer']);
});
test('detail extraction reclassifies the final title using the same preferences', () => {
  const result = normalizeJob({ jobId: '1', title: 'Civil Engineer' }, { title: 'Structural Engineer', descriptionText: 'Design structures.', descriptionExtracted: true }, opts);
  assert.equal(result.roleFamilyInferred, 'Adjacent role');
  assert.equal(result.roleClassificationProvisional, false);
});
test('listing title remains evidence when detail omits it', () => {
  const result = normalizeJob({ jobId: '2', title: 'Sales Engineer' }, { descriptionText: 'Sales.', descriptionExtracted: true }, opts);
  assert.equal(result.roleFamilyInferred, 'Out of scope');
  assert.equal(result.title, 'Sales Engineer');
});
test('provisional confidence is capped and queries never change classification', () => {
  const input = { title: 'Civil Engineer', provisional: true };
  const a = classifyForIndeed(input, taxonomy).classification;
  assert.ok(a.confidence <= 0.65);
  assert.deepEqual(classifyForIndeed({ ...input, query: 'Sales Engineer' }, taxonomy).classification, a);
  assert.equal(classifyForIndeed({ title: 'Civil Engineer', taxonomy }).classification.label, 'Unclassified');
});
test('accepted leadership does not depend on software responsibilities', () => {
  assert.equal(classifyForIndeed({ title: 'Project Manager', descriptionText: 'Coordinate construction contractors.' }, taxonomy).classification.label, 'Leadership progression');
});
