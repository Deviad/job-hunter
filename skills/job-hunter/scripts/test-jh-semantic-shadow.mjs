#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  REQUIRED_CATEGORIES,
  cosineSimilarity,
  validateFixture,
} from './jh-semantic-shadow.mjs';

const root = mkdtempSync(path.join(tmpdir(), 'jh-semantic-shadow-test-'));
const fixturePath = new URL('../fixtures/role-classification-gold-v1.json', import.meta.url).pathname;
const scriptPath = new URL('./jh-semantic-shadow.mjs', import.meta.url).pathname;
const outPath = path.join(root, 'shadow-report.json');
const copiedDb = path.join(root, 'jobhunter.sqlite');
const canonicalDb = path.join(process.env.JOBHUNTER_HOME || path.join(process.env.HOME, '.job-hunter'), 'jobhunter.sqlite');
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

function categoryVector(text) {
  const value = text.toLowerCase();
  let index;
  if (/bim|revit|construction|structural building/.test(value)) index = 7;
  else if (/quota|revenue target|sales pipeline|commercial deals/.test(value)) index = 6;
  else if (/backend software engineer|build web services|application features/.test(value)) index = 5;
  else if (/lakehouse|snowflake|databricks|data governance/.test(value)) index = 4;
  else if (/head of|director of|multiple ai engineering teams|manage three/.test(value)) index = 2;
  else if (/forward deployed|staff ai engineer/.test(value)) index = 1;
  else if (/customer engineer|solutions engineer/.test(value)) index = 3;
  else index = 0;
  return Array.from({ length: 8 }, (_, candidate) => candidate === index ? 1 : 0);
}

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`shadow CLI exited ${code}: ${stderr}`)));
  });
}

const server = http.createServer((request, response) => {
  let raw = '';
  request.setEncoding('utf8');
  request.on('data', (chunk) => { raw += chunk; });
  request.on('end', () => {
    try {
      const payload = JSON.parse(raw);
      const inputs = Array.isArray(payload.input) ? payload.input : [payload.input];
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        model: payload.model,
        data: inputs.map((text, index) => ({ index, embedding: categoryVector(String(text)) })),
      }));
    } catch (error) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: error.message }));
    }
  });
});

try {
  const fixture = validateFixture(JSON.parse(readFileSync(fixturePath, 'utf8')));
  assert.equal(fixture.reviewed, true);
  assert.deepEqual(new Set(fixture.cases.map((item) => item.expectedCategory)), REQUIRED_CATEGORIES);
  assert.ok(fixture.cases.every((item) => item.reviewReason));
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);

  if (existsSync(canonicalDb)) copyFileSync(canonicalDb, copiedDb);
  else writeFileSync(copiedDb, 'portable database sentinel');
  const dbBefore = sha256(copiedDb);

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const endpoint = `http://127.0.0.1:${address.port}/v1/embeddings`;
  await runCli([
    '--fixture', fixturePath,
    '--endpoint', endpoint,
    '--model', 'stub-role-embeddings',
    '--threshold', '0.5',
    '--margin', '0.1',
    '--out', outPath,
  ]);

  const report = JSON.parse(readFileSync(outPath, 'utf8'));
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.mode, 'shadow');
  assert.equal(report.modelId, 'stub-role-embeddings');
  assert.ok(report.taxonomyVersion);
  assert.match(report.fixture.sha256, /^[a-f0-9]{64}$/);
  assert.equal(report.embeddingDimensions, 8);
  // Counts derive from the gold set's prototype split so adding reviewed cases does not
  // require re-deriving literals; falsePositive/falseNegative stay 0 because that is the
  // behaviour under test — the stub embeddings must agree with the deterministic rules.
  const prototypes = fixture.cases.filter((item) => item.split === 'prototype');
  const expectedTruePositive = prototypes.filter((item) => item.expectedEligible).length;
  assert.deepEqual(report.confusionMatrix, {
    truePositive: expectedTruePositive,
    trueNegative: prototypes.length - expectedTruePositive,
    falsePositive: 0,
    falseNegative: 0,
  });
  assert.deepEqual(report.unknownTitleRecovery, { total: 3, recovered: 3 });
  assert.equal(report.evaluations.length, prototypes.length);
  assert.equal(sha256(copiedDb), dbBefore, 'semantic shadow run leaves copied DB byte-identical');
  console.log('jh-semantic-shadow tests: PASS');
} finally {
  await new Promise((resolve) => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
}
