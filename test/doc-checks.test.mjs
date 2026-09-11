import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { run as checkDocCommands } from '../scripts/check-doc-commands.mjs';
import { run as checkDocSections,
         README_SECTIONS, SECURITY_SECTIONS, PREREQUISITES_SECTIONS } from '../scripts/check-required-doc-sections.mjs';

let tmp;
let counter = 0;
before(async () => { tmp = await mkdtemp(join(tmpdir(), 'jh-dc-')); });
after(async () => { await rm(tmp, { recursive: true, force: true }); });

async function fresh() {
  const d = join(tmp, `t${++counter}`);
  await mkdir(d, { recursive: true });
  return d;
}

const VALID_README = `# Job Hunter

## Prerequisites

You need Node.js 20+.

## Installation

Run the installer.

## Initialization

Set up your workspace.

## Doctor

Run the doctor check.

## Search

Search for jobs.

## Score

Score jobs.

## Salary

Enrich salaries.

## Apply

Apply to jobs.

## Update

Update the tool.

## Uninstall

Remove the tool.

## Troubleshooting

Fix common issues.

## Usage

\`\`\`bash
node scripts/install.mjs
node scripts/verify-skill-closure.mjs
npm run test
\`\`\`
`;

const VALID_SECURITY = `# Security and Privacy

## Local Data

All data stored locally.

## Sensitive Files

Excluded from release.

## Credential Handling

Never ship credentials.

## Browser Boundaries

Authenticated browser sessions.

## CAPTCHA Policy

CAPTCHA requires user interaction.

## Backup Expectations

Users manage their own backups.

## Disclosure Implications

Job applications are user-initiated.
`;

const VALID_PREREQUISITES = `# Prerequisites

## Auto-Installed

Node.js dependencies are installed by the bootstrap command.

## Host Tools

You need Docker and a CDP-capable browser installed manually.

## Container Services

Selenium Chromium and SearXNG are defined in compose.yaml.

## Authenticated Services

LinkedIn and Indeed sessions must be provided by the user.
`;

// --- check-doc-commands tests ---

describe('check-doc-commands', () => {
  it('resolves complete namespaced npm script names', async () => {
    const dir = await fresh();
    await writeFile(join(dir, 'README.md'), '`npm run verify:research-baseline`');
    await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: {
      'verify:research-baseline': 'node --test scripts/check-research-baseline.mjs',
    } }));
    assert.equal((await checkDocCommands(dir)).exitCode, 0);

    await writeFile(join(dir, 'README.md'), '`npm run verify:missing`');
    await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { verify: 'node --test' } }));
    const result = await checkDocCommands(dir);
    assert.equal(result.exitCode, 1);
    assert.ok(result.findings.some(f => f.path === 'package.json#scripts.verify:missing'));
  });

  it('passes when all referenced scripts exist', async () => {
    const dir = await fresh();
    await writeFile(join(dir, 'README.md'), VALID_README);
    await mkdir(join(dir, 'scripts'), { recursive: true });
    await writeFile(join(dir, 'scripts', 'install.mjs'), '// install');
    await writeFile(join(dir, 'scripts', 'verify-skill-closure.mjs'), '// verify');
    await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
    const r = await checkDocCommands(dir);
    assert.equal(r.exitCode, 0);
  });

  it('fails when a referenced script does not exist', async () => {
    const dir = await fresh();
    await writeFile(join(dir, 'README.md'), VALID_README);
    const r = await checkDocCommands(dir);
    assert.equal(r.exitCode, 1);
    assert.ok(r.findings.some(f => f.type === 'missing-script' && f.path.includes('install.mjs')));
  });

  it('fails when README.md is missing', async () => {
    const dir = await fresh();
    const r = await checkDocCommands(dir);
    assert.equal(r.exitCode, 1);
    assert.ok(r.findings.some(f => f.type === 'missing-readme'));
  });

  it('fails when an npm run command is not in package.json', async () => {
    const dir = await fresh();
    await writeFile(join(dir, 'README.md'), '# Readme\n```\nnpm run lint\n```');
    await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'ok' } }));
    const r = await checkDocCommands(dir);
    assert.equal(r.exitCode, 1);
    assert.ok(r.findings.some(f => f.type === 'missing-npm-script'));
  });
});

// --- check-required-doc-sections tests ---

describe('check-required-doc-sections', () => {
  it('passes when all required sections exist', async () => {
    const dir = await fresh();
    await writeFile(join(dir, 'README.md'), VALID_README);
    await mkdir(join(dir, 'docs'), { recursive: true });
    await writeFile(join(dir, 'docs', 'security-and-privacy.md'), VALID_SECURITY);
    await writeFile(join(dir, 'docs', 'prerequisites.md'), VALID_PREREQUISITES);
    const r = await checkDocSections(dir);
    assert.equal(r.exitCode, 0);
  });

  it('fails when README is missing a required section', async () => {
    const dir = await fresh();
    const noTroubleshoot = VALID_README.replace('## Troubleshooting', '## FAQ');
    await writeFile(join(dir, 'README.md'), noTroubleshoot);
    await mkdir(join(dir, 'docs'), { recursive: true });
    await writeFile(join(dir, 'docs', 'security-and-privacy.md'), VALID_SECURITY);
    await writeFile(join(dir, 'docs', 'prerequisites.md'), VALID_PREREQUISITES);
    const r = await checkDocSections(dir);
    assert.equal(r.exitCode, 1);
    assert.ok(r.findings.some(f => f.type === 'missing-readme-section' && f.detail.includes('troubleshooting')));
  });

  it('fails when docs/security-and-privacy.md is missing', async () => {
    const dir = await fresh();
    await writeFile(join(dir, 'README.md'), VALID_README);
    await mkdir(join(dir, 'docs'), { recursive: true });
    await writeFile(join(dir, 'docs', 'prerequisites.md'), VALID_PREREQUISITES);
    const r = await checkDocSections(dir);
    assert.equal(r.exitCode, 1);
    assert.ok(r.findings.some(f => f.type === 'missing-security-doc'));
  });

  it('fails when security doc is missing a required section', async () => {
    const dir = await fresh();
    await writeFile(join(dir, 'README.md'), VALID_README);
    await mkdir(join(dir, 'docs'), { recursive: true });
    const noCaptcha = VALID_SECURITY.replaceAll('CAPTCHA', 'VERIFICATION');
    await writeFile(join(dir, 'docs', 'security-and-privacy.md'), noCaptcha);
    await writeFile(join(dir, 'docs', 'prerequisites.md'), VALID_PREREQUISITES);
    const r = await checkDocSections(dir);
    assert.equal(r.exitCode, 1);
    assert.ok(r.findings.some(f => f.type === 'missing-security-section' && f.detail.includes('captcha')));
  });

  it('fails when docs/prerequisites.md is missing', async () => {
    const dir = await fresh();
    await writeFile(join(dir, 'README.md'), VALID_README);
    await mkdir(join(dir, 'docs'), { recursive: true });
    await writeFile(join(dir, 'docs', 'security-and-privacy.md'), VALID_SECURITY);
    const r = await checkDocSections(dir);
    assert.equal(r.exitCode, 1);
    assert.ok(r.findings.some(f => f.type === 'missing-prerequisites-doc'));
  });

  it('fails when prerequisites doc is missing a required distinction', async () => {
    const dir = await fresh();
    await writeFile(join(dir, 'README.md'), VALID_README);
    await mkdir(join(dir, 'docs'), { recursive: true });
    await writeFile(join(dir, 'docs', 'security-and-privacy.md'), VALID_SECURITY);
    const noHost = VALID_PREREQUISITES.replace('Host Tools', 'Other');
    await writeFile(join(dir, 'docs', 'prerequisites.md'), noHost);
    const r = await checkDocSections(dir);
    assert.equal(r.exitCode, 1);
    assert.ok(r.findings.some(f => f.type === 'missing-prerequisites-section' && f.detail.includes('host')));
  });

  it('exports the correct section lists', () => {
    assert.equal(README_SECTIONS.length, 11);
    assert.ok(README_SECTIONS.includes('prerequisites'));
    assert.ok(README_SECTIONS.includes('troubleshooting'));
    assert.ok(SECURITY_SECTIONS.length >= 7);
    assert.ok(PREREQUISITES_SECTIONS.length >= 4);
  });
});
