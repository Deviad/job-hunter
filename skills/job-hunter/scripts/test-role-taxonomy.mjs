#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  ROLE_LABELS,
  ROLE_TAXONOMY_VERSION,
  assertRoleClassification,
  classifyRole,
  expandRoleQueries,
} from './role-taxonomy.mjs';

assert.equal(typeof ROLE_TAXONOMY_VERSION, 'string');
assert.ok(ROLE_TAXONOMY_VERSION.length > 0, 'taxonomy version is non-empty');

assert.deepEqual(ROLE_LABELS, [
  'Exact architecture',
  'Adjacent technical',
  'Leadership progression',
  'Leadership lateral',
  'Conditional',
  'Data-domain stretch',
  'Out of scope',
]);

const cases = [
  {
    name: 'core AI Architect',
    input: { title: 'Senior AI Architect', descriptionText: 'Own the architecture and technical direction for production AI platforms.' },
    label: 'Exact architecture',
  },
  {
    name: 'core Generative AI Architect',
    input: { title: 'Generative AI / LLM Architect', descriptionText: 'Design enterprise generative AI and agentic system architecture.' },
    label: 'Exact architecture',
  },
  {
    name: 'Applied AI Architect software building is not construction',
    input: {
      title: 'Applied AI Architect, Digital Natives',
      descriptionText: 'Define AI architectural patterns, deploy OpenAI APIs, and build production prototypes, including building and presenting demos.',
    },
    label: 'Exact architecture',
  },
  {
    name: 'technical Forward Deployed Architect is eligible',
    input: { title: 'Forward Deployed Architect', descriptionText: 'Design and deliver production LLM systems while owning customer system architecture and implementation decisions.' },
    label: 'Exact architecture',
  },
  {
    name: 'sales-only Forward Deployed Architect is excluded',
    input: { title: 'Forward Deployed Architect', descriptionText: 'Own sales pipeline, customer presentations, revenue targets, and quota without implementation responsibility.' },
    label: 'Out of scope',
  },
  {
    name: 'strong technical Solutions Engineer is eligible',
    input: { title: 'Solutions Engineer — AI', descriptionText: 'Own production AI system architecture, implementation design, cloud integration, and technical decisions.' },
    label: 'Exact architecture',
  },
  {
    name: 'adjacent Principal AI Engineer with architecture evidence',
    input: { title: 'Principal AI Engineer', descriptionText: 'Lead system design, production architecture, and platform decisions for AI services.' },
    label: 'Adjacent technical',
  },
  {
    name: 'feature-only adjacent title rejected',
    input: { title: 'Staff AI Engineer', descriptionText: 'Implement product features and train models; no architecture or platform ownership.' },
    label: 'Out of scope',
  },
  {
    name: 'architect-named adjacent role still needs technical evidence',
    input: { title: 'AI Enablement Architect', descriptionText: 'Coordinate adoption workshops and stakeholder communications; no system design or platform ownership.' },
    label: 'Out of scope',
  },
  {
    name: 'small technical AI manager is lateral',
    input: { title: 'Engineering Manager — AI/ML', descriptionText: 'Manage a team of 4 engineers and own technical direction, architecture quality, and engineering standards.' },
    label: 'Leadership lateral',
  },
  {
    name: 'eight engineers is progression',
    input: { title: 'Engineering Manager — AI Platform', descriptionText: 'Lead 8 engineers across two teams. Own platform strategy, technical direction, hiring, and cross-team architecture.' },
    label: 'Leadership progression',
  },
  {
    name: 'written eight engineers is progression',
    input: { title: 'Engineering Manager — AI Platform', descriptionText: 'Own technical direction for eight engineers across two teams.' },
    label: 'Leadership progression',
  },
  {
    name: 'cross-team collaboration alone stays lateral',
    input: { title: 'Engineering Manager — AI/ML', descriptionText: 'Manage a team of 4 engineers, collaborate cross-team, and own technical direction.' },
    label: 'Leadership lateral',
  },
  {
    name: 'delivery manager without technical authority rejected',
    input: { title: 'Technical Delivery Manager — AI', descriptionText: 'Own milestones, status reporting, ceremonies, and headcount planning for an AI delivery team.' },
    label: 'Out of scope',
  },
  {
    name: 'AI leadership without technical direction rejected',
    input: { title: 'Head of AI Engineering', descriptionText: 'Own hiring, budgets, people development, and delivery roadmap; no architecture or technical decision authority.' },
    label: 'Out of scope',
  },
  {
    name: 'AI leadership needs technical authority evidence',
    input: { title: 'Head of AI Engineering', descriptionText: 'Own hiring, budgets, people development, and delivery roadmap for an AI team.' },
    label: 'Out of scope',
  },
  {
    name: 'hybrid AI engineering leadership',
    input: { title: 'Director of AI Engineering', descriptionText: 'Own architecture standards and technical direction for 12 engineers across multiple teams while remaining hands-on in system design.' },
    label: 'Leadership progression',
    check(result) {
      assert.equal(result.leadershipEvaluation.hybridArchitectureLeadership, true);
      assert.equal(result.leadershipEvaluation.teamScope.engineers, 12);
    },
  },
  {
    name: 'commercial role with authority is conditional',
    input: { title: 'AI Pre-Sales Solutions Architect', descriptionText: 'Lead customer AI system architecture, implementation design, and technical discovery. No quota.' },
    label: 'Conditional',
  },
  {
    name: 'commercial role without authority is excluded',
    input: { title: 'AI Pre-Sales Solutions Architect', descriptionText: 'Own pipeline, customer relationships, presentations, and revenue growth. No architecture or implementation responsibility.' },
    label: 'Out of scope',
  },
  {
    name: 'quota-led sales is excluded',
    input: { title: 'AI Solutions Architect — Quota Carrying', descriptionText: 'Own revenue quota and sales targets.' },
    label: 'Out of scope',
  },
  {
    name: 'policy-only governance is excluded',
    input: { title: 'AI Governance Lead', descriptionText: 'Write responsible AI policy, compliance frameworks, and ethics guidance.' },
    label: 'Out of scope',
  },
  {
    name: 'technical governance is conditional',
    input: { title: 'AI Governance Lead', descriptionText: 'Own implementation of AI governance controls, platform architecture, and technical risk decisions.' },
    label: 'Conditional',
  },
  {
    name: 'data and AI stretch',
    input: { title: 'Data & AI Architect', descriptionText: 'Design AI systems; data modelling and governance are secondary responsibilities.' },
    label: 'Data-domain stretch',
    check(result) {
      assert.ok(result.dataGap.missingSkills.includes('lakehouse'));
      assert.ok(result.dataGap.missingSkills.includes('Databricks'));
      assert.ok(result.reason.gaps.includes('lakehouse'));
    },
  },
  {
    name: 'data and AI present skills are normalized',
    input: { title: 'Data & AI Architect', descriptionText: 'Design AI architecture; data modelling and Databricks are secondary responsibilities.' },
    label: 'Data-domain stretch',
    check(result) {
      assert.deepEqual(result.dataGap.presentSkills, ['data modelling', 'Databricks']);
      assert.ok(!result.dataGap.missingSkills.includes('Databricks'));
    },
  },
  {
    name: 'ordinary AI architect with incidental warehouse integration stays exact',
    input: { title: 'AI Architect', descriptionText: 'Design production AI systems that integrate with a data warehouse.' },
    label: 'Exact architecture',
  },
  {
    name: 'data-dominated AI architect is not ordinary architecture',
    input: { title: 'AI Architect', descriptionText: 'Primarily own the data lakehouse, warehouse, Spark, Databricks, Snowflake, data modelling, and data governance platform.' },
    label: 'Out of scope',
  },
  {
    name: 'generic data architect is excluded',
    input: { title: 'Principal Data Architect', descriptionText: 'Own enterprise data architecture and warehouse strategy.' },
    label: 'Out of scope',
  },
  {
    name: 'software engineer title always excluded',
    input: { title: 'Lead Software Engineer — AI Platform', descriptionText: 'Own AI platform architecture and technical direction.' },
    label: 'Out of scope',
  },
  {
    name: 'scientist titles excluded',
    input: { title: 'Research Scientist — Generative AI', descriptionText: 'Research large language models.' },
    label: 'Out of scope',
  },
  {
    name: 'non-software architect excluded',
    input: { title: 'AI Building Architect', descriptionText: 'Design construction and BIM projects.' },
    label: 'Out of scope',
  },
  // L5 — construction exclusion requires qualified, built-environment evidence, and body
  // wording never vetoes a role with technical AI architecture evidence.
  {
    name: 'structural tests in software prose is not structural engineering',
    input: {
      title: 'Agentic AI Architect',
      descriptionText: 'Own the reference architecture for agentic AI platforms and define technical direction for production LLM systems. Enforce architecture mechanically (structural tests, linting rules, dependency-layer checks) rather than by manual review.',
    },
    label: 'Exact architecture',
  },
  {
    name: 'fast-evolving AI landscape is not landscape architecture',
    input: {
      title: 'AI Large Language Model (LLM) Technology Architect',
      descriptionText: 'Design patterns, frameworks and technologies across the fast-evolving AI landscape, balancing innovation with enterprise-grade reliability. You will own generative AI architecture and platform decisions for production systems.',
    },
    label: 'Exact architecture',
  },
  {
    name: 'pre-sales AI architect with delivery authority is not excluded',
    input: {
      title: 'AI Senior Solutions Architect, Global Advanced Services',
      descriptionText: 'As a catalyst on the Advanced Services Innovation team you will design, pilot, and scale the cutting-edge AI architecture that powers enterprise solutions. Cross-functional technical leadership: guiding product, sales, and delivery teams toward a unified technical strategy.',
    },
    label: 'Exact architecture',
  },
  {
    name: 'client-sector construction wording does not veto an AI architecture role',
    input: {
      title: 'AI Solution Architect',
      descriptionText: 'Own AI solution architecture for client engagements across the civil engineering and structural engineering sectors. Define technical direction and platform decisions for production generative AI systems.',
    },
    label: 'Exact architecture',
  },
  {
    name: 'qualified construction body evidence still excluded',
    input: {
      title: 'Solution Architect',
      descriptionText: 'Produce construction drawings and shop drawings, chair coordination with the structural engineering and civil engineering consultants, and review architectural design packages on live project sites.',
    },
    label: 'Out of scope',
  },
  {
    name: 'interior and landscape design body evidence still excluded',
    input: {
      title: 'Architect',
      descriptionText: 'Lead interior design and landscape architecture packages for mixed-use developments, coordinating Revit models with the construction team.',
    },
    label: 'Out of scope',
  },
  // L5c — a stated denial of architecture ownership still denies; governance prose that
  // merely puts "no" near "production"/"platform" does not.
  {
    name: 'governance rule about production is not a denial of architecture scope',
    input: {
      title: 'AI Architect, Trading Platform',
      descriptionText: 'We shape and articulate the enterprise AI strategy with CIOs and CTOs. You will run a certification model that mandates no uncertified agent reaches production. Define memory as a first-class abstracted platform service, and own the architecture roadmap.',
    },
    label: 'Conditional',
  },
  {
    name: 'stated denial of architecture ownership excludes',
    input: {
      title: 'AI Architect, Trading Platform',
      descriptionText: 'We shape and articulate the enterprise AI strategy with CIOs and CTOs. You will not own the architecture or the technical decisions, and a separate platform group holds that authority. Deliver roadmaps and reports.',
    },
    label: 'Out of scope',
  },
  {
    name: 'generic architect without AI central rejected',
    input: { title: 'Enterprise Architect', descriptionText: 'Own ERP, infrastructure, and business systems architecture.' },
    label: 'Out of scope',
  },
  {
    name: 'incidental AI mention is not central architecture evidence',
    input: { title: 'Enterprise Architect', descriptionText: 'Occasionally advise the AI team while owning ERP architecture.' },
    label: 'Out of scope',
  },
  {
    name: 'governance architect remains core architecture',
    input: { title: 'AI Governance Architect', descriptionText: 'Design responsible AI governance architecture and implementation controls.' },
    label: 'Exact architecture',
  },
  {
    name: 'core title family coverage',
    input: { title: 'Chief AI Architect', descriptionText: 'Own enterprise AI architecture and technical direction.' },
    label: 'Exact architecture',
  },
  {
    name: 'core AI ML title family coverage',
    input: { title: 'Principal Architect, AI/ML', descriptionText: 'Define production machine-learning architecture.' },
    label: 'Exact architecture',
  },
  {
    name: 'core enterprise title family coverage',
    input: { title: 'Enterprise AI Architect', descriptionText: 'Own enterprise AI system architecture.' },
    label: 'Exact architecture',
  },
  {
    name: 'core solutions title family coverage',
    input: { title: 'AI Solutions Architect', descriptionText: 'Design and govern production AI solution architecture.' },
    label: 'Exact architecture',
  },
  {
    name: 'core platform title family coverage',
    input: { title: 'AI Platform Architect', descriptionText: 'Own architecture for a production AI platform.' },
    label: 'Exact architecture',
  },
  {
    name: 'core infrastructure title family coverage',
    input: { title: 'AI Infrastructure Architect', descriptionText: 'Design cloud infrastructure architecture for AI workloads.' },
    label: 'Exact architecture',
  },
  {
    name: 'core integration title family coverage',
    input: { title: 'AI Integration Architect', descriptionText: 'Own integration architecture for enterprise AI systems.' },
    label: 'Exact architecture',
  },
  {
    name: 'core security architect title family coverage',
    input: { title: 'AI Security Architect', descriptionText: 'Design secure AI system architecture and implementation controls.' },
    label: 'Exact architecture',
  },
  {
    name: 'adjacent lead family coverage',
    input: { title: 'AI Engineering Lead', descriptionText: 'Lead technical direction, system design, and production AI delivery.' },
    label: 'Adjacent technical',
  },
  {
    name: 'lead with people scope becomes leadership progression',
    input: { title: 'AI Engineering Lead', descriptionText: 'Manage 10 engineers across two teams and own technical direction and architecture quality.' },
    label: 'Leadership progression',
  },
  {
    name: 'adjacent applied AI family coverage',
    input: { title: 'Lead Applied AI Engineer', descriptionText: 'Own production architecture and platform decisions for applied AI.' },
    label: 'Adjacent technical',
  },
  {
    name: 'adjacent platform engineer family coverage',
    input: { title: 'Staff AI Platform Engineer', descriptionText: 'Lead platform architecture and production system design.' },
    label: 'Adjacent technical',
  },
  {
    name: 'adjacent ML platform family coverage',
    input: { title: 'ML Platform Lead', descriptionText: 'Own ML platform decisions, system design, and production architecture.' },
    label: 'Adjacent technical',
  },
  {
    name: 'adjacent MLOps family coverage',
    input: { title: 'MLOps Architect', descriptionText: 'Design production ML operations architecture.' },
    label: 'Adjacent technical',
  },
  {
    name: 'adjacent enablement family coverage',
    input: { title: 'AI Enablement Architect', descriptionText: 'Define architecture and platform enablement for production AI.' },
    label: 'Adjacent technical',
  },
  {
    name: 'leadership senior manager family coverage',
    input: { title: 'Senior Engineering Manager — AI/ML', descriptionText: 'Own technical direction and architecture quality for 10 engineers.' },
    label: 'Leadership progression',
  },
  {
    name: 'leadership head platform family coverage',
    input: { title: 'Head of AI Platform', descriptionText: 'Own platform strategy and technical direction for a department.' },
    label: 'Leadership progression',
  },
  {
    name: 'leadership director family coverage',
    input: { title: 'AI Engineering Director', descriptionText: 'Own engineering standards, architecture quality, and organizational AI platform strategy.' },
    label: 'Leadership progression',
  },
  {
    name: 'leadership solutions architecture manager family coverage',
    input: { title: 'Solutions Architecture Manager — AI', descriptionText: 'Own AI architecture quality and technical direction for a small team.' },
    label: 'Leadership lateral',
  },
  {
    name: 'conditional security specialist family coverage',
    input: { title: 'Principal AI Security Specialist', descriptionText: 'Own secure AI system architecture and implementation governance.' },
    label: 'Conditional',
  },
  {
    name: 'conditional responsible AI family coverage',
    input: { title: 'Responsible AI Lead', descriptionText: 'Define technical controls, implementation governance, and architecture for responsible AI.' },
    label: 'Conditional',
  },
  {
    name: 'conditional strategy family coverage',
    input: { title: 'AI Strategy Lead', descriptionText: 'Own AI platform architecture, technical roadmap, and implementation decisions.' },
    label: 'Conditional',
  },
  {
    name: 'strategy leadership remit remains conditional',
    input: { title: 'AI Strategy Director', descriptionText: 'Own AI platform architecture and technical roadmap for the organization.' },
    label: 'Conditional',
  },
  {
    name: 'commercial solutions architecture manager uses conditional remit',
    input: { title: 'AI Solutions Architecture Manager — Pre-Sales', descriptionText: 'Own customer AI architecture and implementation design, without quota ownership.' },
    label: 'Conditional',
  },
  {
    name: 'generic data warehouse architect excluded',
    input: { title: 'Data Warehouse Architect', descriptionText: 'Own warehouse architecture and data pipelines.' },
    label: 'Out of scope',
  },
  {
    name: 'sales executive excluded',
    input: { title: 'AI Sales Executive', descriptionText: 'Own revenue targets and customer acquisition.' },
    label: 'Out of scope',
  },
  {
    name: 'policy-only strategy excluded',
    input: { title: 'AI Strategy Lead', descriptionText: 'Write policy and provide non-technical strategic advice.' },
    label: 'Out of scope',
  },
  {
    name: 'product manager without engineering ownership rejected',
    input: { title: 'AI Product Manager', descriptionText: 'Own product roadmap, launches, and stakeholder communications.' },
    label: 'Out of scope',
  },
];

for (const testCase of cases) {
  const result = assertRoleClassification(classifyRole(testCase.input));
  assert.equal(result.label, testCase.label, testCase.name);
  assert.ok(result.confidence >= 0 && result.confidence <= 1, `${testCase.name}: confidence bounds`);
  assert.equal(result.reason.queryUsedAsEvidence, false, `${testCase.name}: query excluded from evidence`);
  assert.equal(typeof JSON.stringify(result.reason), 'string', `${testCase.name}: reason serializes`);
  testCase.check?.(result);
}

const provisional = assertRoleClassification(classifyRole({ title: 'AI Architect', provisional: true }));
assert.equal(provisional.provisional, true, 'provisional flag is preserved');
assert.ok(provisional.confidence <= 0.65, 'provisional confidence is capped');

const withQuery = classifyRole({
  title: 'Enterprise Architect',
  descriptionText: 'Own ERP architecture.',
  query: 'AI Architect',
});
const withoutQuery = classifyRole({
  title: 'Enterprise Architect',
  descriptionText: 'Own ERP architecture.',
});
assert.deepEqual(withQuery, withoutQuery, 'query text never changes classification');

const expanded = expandRoleQueries({
  targetRole: 'AI Architect',
  similarRoles: ['AI Architect', 'Principal AI Engineer', 'ai architect'],
  maxQueries: 8,
});
assert.equal(expanded.length, 8, 'query expansion respects maxQueries');
assert.equal(new Set(expanded.map((query) => query.toLowerCase())).size, expanded.length, 'query expansion is deduplicated');
assert.equal(expanded[0], 'AI Architect', 'target query is first');
assert.ok(expanded.includes('Principal AI Engineer'), 'similar query is retained');
const fullExpansion = expandRoleQueries({ targetRole: 'AI Architect', maxQueries: 32 });
for (const query of [
  'Applied AI Architect',
  'Forward Deployed Architect',
  'Forward Deployed Engineer',
  'AI Customer Engineer',
  'AI Field Engineer',
]) {
  assert.ok(fullExpansion.includes(query), `query expansion includes ${query}`);
}
assert.deepEqual(expandRoleQueries({ targetRole: 'AI Architect', maxQueries: 0 }), [], 'zero query bound returns empty');
assert.deepEqual(expandRoleQueries({}), [], 'missing query seed returns empty');
assert.ok(!expandRoleQueries({ targetRole: 'AI Architect', similarRoles: ['Lead Software Engineer — AI', 'Principal Data Architect'], maxQueries: 32 }).some((query) => /software engineer|data architect/i.test(query)), 'forbidden query families are filtered');

assert.deepEqual(classifyRole(withQuery), classifyRole(withQuery), 'classification and reason are deterministic');

// L5: the overridden body wording stays visible as a signal instead of vanishing, and the
// rules version is bumped so rows classified by the previous rules read as stale.
const overridden = classifyRole({
  title: 'AI Solution Architect',
  descriptionText: 'Own AI solution architecture for client engagements across the civil engineering and structural engineering sectors. Define technical direction and platform decisions for production generative AI systems.',
});
assert.equal(overridden.label, 'Exact architecture');
assert.ok(
  overridden.signals.descriptionSignals.some((signal) => /construction-domain wording.*not decisive/.test(signal)),
  'non-decisive construction wording is recorded as a description signal',
);
assert.deepEqual(overridden.signals.exclusions, [], 'non-decisive construction wording is not an exclusion');
assert.equal(ROLE_TAXONOMY_VERSION, '2', 'taxonomy version bumped for the L5 rules');
// The two L5c cases must differ on exactly the signal that drives the branch.
const governanceProse = classifyRole(cases.find((item) => item.name.startsWith('governance rule')).input);
const statedDenial = classifyRole(cases.find((item) => item.name.startsWith('stated denial')).input);
assert.equal(governanceProse.signals.technicalArchitecture, true, 'governance prose must not clear technicalArchitecture');
assert.equal(statedDenial.signals.technicalArchitecture, false, 'a stated ownership denial must clear technicalArchitecture');
assert.throws(() => assertRoleClassification({ ...withQuery, confidence: 2 }), /confidence/);
assert.throws(() => assertRoleClassification({ ...withQuery, label: 'unknown' }), /Unknown/);
assert.throws(() => assertRoleClassification({ ...withQuery, reason: { ...withQuery.reason, evidence: 'not-an-array' } }), /evidence/);

console.log(`role-taxonomy tests: PASS (${cases.length} table cases)`);
