#!/usr/bin/env node
import assert from 'node:assert/strict';
import { classifyRole, expandRoleQueries, assertRoleClassification } from './role-taxonomy.mjs';
import { canonicalRoleLabel } from './role-labels.mjs';

for (const [primary, adjacent, leadership] of [
  ['Registered Nurse', 'Clinical Educator', 'Ward Manager'],
  ['Civil Engineer', 'Structural Engineer', 'Project Manager'],
  ['Software Engineer', 'Data Scientist', 'Engineering Manager'],
  ['Account Executive', 'Sales Consultant', 'Sales Director'],
]) {
  const taxonomy = { primaryTitles: [primary], adjacentTitles: [adjacent], leadershipTitles: [leadership], queryExclusionTerms: [] };
  for (const [title, label] of [[primary, 'Primary role'], [adjacent, 'Adjacent role'], [leadership, 'Leadership progression']]) {
    const input = { title, taxonomy, descriptionText: 'Saved description' };
    assert.equal(assertRoleClassification(classifyRole(input)).label, label);
    assert.deepEqual(classifyRole({ ...input, query: 'unrelated search' }), classifyRole(input));
    assert.ok(classifyRole({ ...input, provisional: true }).confidence <= 0.65);
  }
  assert.deepEqual(expandRoleQueries({ targetRole: primary, similarRoles: [adjacent, leadership], taxonomy }), [primary, adjacent, leadership]);
}
const taxonomy = { primaryTitles: ['Nurse'], queryExclusionTerms: ['Veterinary Nurse'], excludedResponsibilityTerms: ['night shifts required'] };
assert.equal(classifyRole({ title: 'Veterinary Nurse', taxonomy }).label, 'Out of scope');
assert.equal(classifyRole({ title: 'Nurse', descriptionText: 'Night shifts required.', taxonomy }).label, 'Out of scope');
assert.equal(classifyRole({ title: 'Nursery Assistant', taxonomy }).label, 'Unclassified');
assert.equal(classifyRole({ title: 'Nurse' }).label, 'Unclassified');
assert.equal(classifyRole({ title: 'Unrelated', descriptionText: 'Our team includes a nurse.', taxonomy }).label, 'Unclassified');
assert.deepEqual(expandRoleQueries({ targetRole: 'Civil Engineer', taxonomy: { queryExpansions: ['Project Manager'] } }), ['Civil Engineer', 'Project Manager']);
assert.deepEqual(expandRoleQueries({ targetRole: 'Nurse', maxQueries: 0 }), []);
assert.deepEqual(expandRoleQueries({ targetRole: 'Nurse', similarRoles: ['nurse', 'Educator'], maxQueries: 1 }), ['Nurse']);
assert.equal(classifyRole({ title: 'C++ Developer', taxonomy: { primaryTitles: ['C++ Developer'] } }).label, 'Primary role');
assert.equal(classifyRole({ title: '医師', taxonomy: { primaryTitles: ['医師'] } }).label, 'Primary role');
assert.equal(canonicalRoleLabel('PRIMARY ROLE'), 'Primary role');
assert.equal(canonicalRoleLabel('data architect'), 'Unclassified');
assert.throws(() => assertRoleClassification({}), /label/);
console.log('role-taxonomy tests: PASS (four sectors, exclusions, unknownness, bounds, provenance)');
