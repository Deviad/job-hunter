#!/usr/bin/env node
// Compare deterministic role labels with local embedding prototypes in shadow mode.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ROLE_TAXONOMY_VERSION, classifyRole } from './role-taxonomy.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIXTURE = path.resolve(SCRIPT_DIR, '../fixtures/role-classification-gold-v1.json');
const DEFAULT_ENDPOINT = 'http://localhost:1234/v1/embeddings';
const DEFAULT_MODEL = 'text-embedding-qwen3-embedding-4b';
const REQUIRED_CATEGORIES = new Set([
  'exact-architecture',
  'adjacent-technical',
  'leadership',
  'customer-facing',
  'data-stretch',
  'generic-engineering-negative',
  'quota-sales-negative',
  'building-bim-negative',
]);
const ELIGIBLE_CATEGORIES = new Set([
  'exact-architecture',
  'adjacent-technical',
  'leadership',
  'customer-facing',
  'data-stretch',
]);

function parseArgs(argv) {
  const options = {
    fixture: DEFAULT_FIXTURE,
    endpoint: DEFAULT_ENDPOINT,
    model: DEFAULT_MODEL,
    threshold: 0,
    margin: 0,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      if (index + 1 >= argv.length) throw new Error(`missing value for ${arg}`);
      return argv[++index];
    };
    if (arg === '--fixture') options.fixture = next();
    else if (arg === '--endpoint') options.endpoint = next();
    else if (arg === '--model') options.model = next();
    else if (arg === '--out') options.out = next();
    else if (arg === '--threshold') options.threshold = Number(next());
    else if (arg === '--margin') options.margin = Number(next());
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.help && !options.out) throw new Error('--out is required');
  for (const [name, value] of [['threshold', options.threshold], ['margin', options.margin]]) {
    if (!Number.isFinite(value)) throw new Error(`${name} must be finite`);
  }
  return options;
}

function fixtureText(item) {
  return `${item.title}\n${item.descriptionText}`;
}

function validateFixture(fixture) {
  if (fixture?.schemaVersion !== 1 || fixture.reviewed !== true || !Array.isArray(fixture.cases)) {
    throw new Error('fixture must be reviewed schemaVersion 1 with cases');
  }
  const ids = new Set();
  const prototypeCategories = new Set();
  for (const item of fixture.cases) {
    if (!item.id || ids.has(item.id)) throw new Error(`fixture case id is missing or duplicated: ${item.id}`);
    ids.add(item.id);
    if (!REQUIRED_CATEGORIES.has(item.expectedCategory)) throw new Error(`unknown fixture category: ${item.expectedCategory}`);
    if (!['prototype', 'evaluation'].includes(item.split)) throw new Error(`invalid split for ${item.id}`);
    if (typeof item.expectedEligible !== 'boolean' || !item.title || !item.descriptionText || !item.reviewReason) {
      throw new Error(`fixture case ${item.id} is incomplete`);
    }
    if (item.split === 'prototype') prototypeCategories.add(item.expectedCategory);
  }
  for (const category of REQUIRED_CATEGORIES) {
    if (!prototypeCategories.has(category)) throw new Error(`missing prototype for ${category}`);
  }
  return fixture;
}

function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length || left.length === 0) {
    throw new Error('embedding vectors must have the same non-zero dimension');
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = Number(left[index]);
    const b = Number(right[index]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error('embedding vector contains a non-finite value');
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) throw new Error('embedding vector has zero norm');
  return dot / Math.sqrt(leftNorm * rightNorm);
}

function meanVector(vectors) {
  if (!vectors.length) throw new Error('prototype vectors cannot be empty');
  const result = Array(vectors[0].length).fill(0);
  for (const vector of vectors) {
    if (vector.length !== result.length) throw new Error('prototype dimensions differ');
    vector.forEach((value, index) => { result[index] += Number(value); });
  }
  return result.map((value) => value / vectors.length);
}

async function embedTexts(texts, options, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(options.endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: options.model, input: texts }),
  });
  if (!response.ok) throw new Error(`embedding request failed: HTTP ${response.status}`);
  const payload = await response.json();
  if (!Array.isArray(payload.data) || payload.data.length !== texts.length) {
    throw new Error('embedding response count does not match fixture cases');
  }
  return payload.data
    .slice()
    .sort((left, right) => Number(left.index) - Number(right.index))
    .map((item) => item.embedding);
}

function classifyEmbedding(vector, prototypes, options) {
  const scores = Object.fromEntries(Object.entries(prototypes).map(([category, prototype]) => [category, cosineSimilarity(vector, prototype)]));
  const ranked = Object.entries(scores).sort((left, right) => right[1] - left[1]);
  const positiveBest = ranked.find(([category]) => ELIGIBLE_CATEGORIES.has(category));
  const negativeBest = ranked.find(([category]) => !ELIGIBLE_CATEGORIES.has(category));
  const eligible = Boolean(
    positiveBest
    && positiveBest[1] >= options.threshold
    && positiveBest[1] - (negativeBest?.[1] ?? -1) >= options.margin,
  );
  return {
    category: eligible ? positiveBest[0] : (negativeBest?.[0] ?? ranked[0][0]),
    eligible,
    scores,
    positiveSimilarity: positiveBest?.[1] ?? null,
    negativeSimilarity: negativeBest?.[1] ?? null,
    margin: positiveBest ? positiveBest[1] - (negativeBest?.[1] ?? -1) : null,
  };
}

async function runShadow(options, fetchImpl = globalThis.fetch) {
  const fixtureRaw = readFileSync(options.fixture, 'utf8');
  const fixture = validateFixture(JSON.parse(fixtureRaw));
  const vectors = await embedTexts(fixture.cases.map(fixtureText), options, fetchImpl);
  const prototypes = {};
  for (const category of REQUIRED_CATEGORIES) {
    prototypes[category] = meanVector(fixture.cases
      .map((item, index) => ({ item, vector: vectors[index] }))
      .filter(({ item }) => item.split === 'prototype' && item.expectedCategory === category)
      .map(({ vector }) => vector));
  }

  const evaluations = fixture.cases
    .map((item, index) => ({ item, vector: vectors[index] }))
    .filter(({ item }) => item.split === 'evaluation')
    .map(({ item, vector }) => {
      const semantic = classifyEmbedding(vector, prototypes, options);
      const deterministic = classifyRole({ title: item.title, descriptionText: item.descriptionText });
      const deterministicEligible = deterministic.label !== 'Out of scope';
      return {
        id: item.id,
        title: item.title,
        expectedCategory: item.expectedCategory,
        expectedEligible: item.expectedEligible,
        unknownTitle: item.unknownTitle === true,
        semantic,
        deterministic: { label: deterministic.label, eligible: deterministicEligible },
        disagreement: semantic.eligible !== deterministicEligible,
      };
    });

  const confusionMatrix = { truePositive: 0, trueNegative: 0, falsePositive: 0, falseNegative: 0 };
  for (const item of evaluations) {
    if (item.expectedEligible && item.semantic.eligible) confusionMatrix.truePositive += 1;
    else if (!item.expectedEligible && !item.semantic.eligible) confusionMatrix.trueNegative += 1;
    else if (!item.expectedEligible && item.semantic.eligible) confusionMatrix.falsePositive += 1;
    else confusionMatrix.falseNegative += 1;
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: 'shadow',
    modelId: options.model,
    endpoint: options.endpoint,
    taxonomyVersion: ROLE_TAXONOMY_VERSION,
    fixture: {
      name: fixture.name,
      sha256: createHash('sha256').update(fixtureRaw).digest('hex'),
      cases: fixture.cases.length,
      evaluationCases: evaluations.length,
    },
    thresholds: { similarity: options.threshold, margin: options.margin },
    embeddingDimensions: vectors[0]?.length ?? 0,
    confusionMatrix,
    unknownTitleRecovery: {
      total: evaluations.filter((item) => item.unknownTitle && item.expectedEligible).length,
      recovered: evaluations.filter((item) => item.unknownTitle && item.expectedEligible && item.semantic.eligible).length,
    },
    disagreementCount: evaluations.filter((item) => item.disagreement).length,
    evaluations,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: jh-semantic-shadow.mjs --out <report.json> [--fixture <gold.json>] [--endpoint <url>] [--model <id>] [--threshold <n>] [--margin <n>]');
    return;
  }
  const report = await runShadow(options);
  mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true });
  writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`, { flag: 'w' });
  console.log(`semantic shadow report: ${path.resolve(options.out)}`);
}

export {
  DEFAULT_ENDPOINT,
  DEFAULT_FIXTURE,
  DEFAULT_MODEL,
  ELIGIBLE_CATEGORIES,
  REQUIRED_CATEGORIES,
  parseArgs,
  validateFixture,
  cosineSimilarity,
  meanVector,
  classifyEmbedding,
  runShadow,
};

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
