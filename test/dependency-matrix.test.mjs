import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, REQUIRED_CATEGORIES, REQUIRED_SERVICES } from '../scripts/verify-dependency-matrix.mjs';

let tmp;
let counter = 0;
before(async () => { tmp = await mkdtemp(join(tmpdir(), 'jh-dm-')); });
after(async () => { await rm(tmp, { recursive: true, force: true }); });

function fresh() { return join(tmp, `t${++counter}`); }

const VALID_MATRIX = `# Dependency Matrix

## Skills

| Skill | Core Deps |
|-------|----------|
| job-hunter | node |
| linkedin-job-search | node |
| indeed-job-search | node |
| job-match-scorer | node |
| salary-calculator | node |
| auto-job-application | node |
| captcha-resolution | node, python |
| qwen-screenshot-debug | node |
| selenium-container-visual-click-recovery | node, docker |
| obscura-mcp-repair | node |
| pi-mcp-repair | node, bash |
| brave-obscura-session | node |
| docx | python, uv |
| pdf | python, uv |

## Packages

| Package | Used By |
|---------|----------|
| better-sqlite3 | job-hunter, salary-calculator |

## Executables

| Executable | Purpose |
|------------|---------|
| node | runtime |
| uv | python deps |

## Services

| Service | Provider | Stage |
|---------|----------|-------|
| Selenium Chromium | Docker | search, apply |
| SearXNG | Docker | search |

## MCP Integrations

| MCP Server | Required | Stage |
|------------|----------|-------|
| obscura | optional | search |
| apple-mail | optional | apply |
| searxng | optional | search |

## Workflow-Stage

| Stage | Skills | Services |
|-------|--------|----------|
| search | linkedin-job-search, indeed-job-search | SearXNG |
| score | job-match-scorer | |
| salary | salary-calculator | |
| apply | auto-job-application | Selenium Chromium |
`;

async function writeMatrix(root, content = VALID_MATRIX) {
  await mkdir(join(root, 'docs'), { recursive: true });
  await writeFile(join(root, 'docs', 'dependency-matrix.md'), content);
}

async function writeAllSkills(root) {
  const { REQUIRED_SKILLS } = await import('../scripts/verify-skill-closure.mjs');
  for (const name of REQUIRED_SKILLS) {
    const dir = join(root, 'skills', name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), `# ${name}\n${name} for the user.`);
  }
}

describe('verify-dependency-matrix', () => {
  it('passes on a valid matrix with all categories, services, and skills', async () => {
    const dir = fresh();
    await writeMatrix(dir);
    await writeAllSkills(dir);
    const r = await run(dir);
    assert.equal(r.exitCode, 0);
    assert.equal(r.findings.length, 0);
  });

  it('fails when dependency-matrix.md is missing', async () => {
    const dir = fresh();
    await mkdir(join(dir, 'docs'), { recursive: true });
    const r = await run(dir);
    assert.equal(r.exitCode, 1);
    assert.ok(r.findings.some(f => f.type === 'missing-matrix'));
  });

  it('fails when a required category is absent', async () => {
    const dir = fresh();
    const missing = VALID_MATRIX.replace('## Executables', '## Runtime');
    await writeMatrix(dir, missing);
    await writeAllSkills(dir);
    const r = await run(dir);
    assert.equal(r.exitCode, 1);
    assert.ok(r.findings.some(f => f.type === 'missing-category' && f.detail.includes('executables')));
  });

  it('fails when a required service is not mentioned', async () => {
    const dir = fresh();
    const noSearxng = VALID_MATRIX.replace(/SearXNG/gi, 'SomeSearch');
    await writeMatrix(dir, noSearxng);
    await writeAllSkills(dir);
    const r = await run(dir);
    assert.equal(r.exitCode, 1);
    assert.ok(r.findings.some(f => f.type === 'missing-service' && f.detail.includes('searxng')));
  });

  it('fails when a bundled skill is not listed in the matrix', async () => {
    const dir = fresh();
    const noDocx = VALID_MATRIX.replace(/\| docx \|/g, '| (removed) |');
    await writeMatrix(dir, noDocx);
    await writeAllSkills(dir);
    const r = await run(dir);
    assert.equal(r.exitCode, 1);
    assert.ok(r.findings.some(f => f.type === 'missing-skill-entry' && f.detail.includes('docx')));
  });

  it('exports the correct required categories and services', () => {
    assert.ok(REQUIRED_CATEGORIES.includes('skills'));
    assert.ok(REQUIRED_CATEGORIES.includes('mcp'));
    assert.ok(REQUIRED_CATEGORIES.includes('workflow-stage'));
    assert.ok(REQUIRED_SERVICES.includes('selenium'));
    assert.ok(REQUIRED_SERVICES.includes('searxng'));
  });
});
