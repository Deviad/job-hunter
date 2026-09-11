import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { run } from '../scripts/check-local-profile-leaks.mjs';

const created = [];
afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'jh-public-'));
  const home = await mkdtemp(join(tmpdir(), 'jh-private-'));
  created.push(root, home);
  await mkdir(join(root, 'skills', 'example'), { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(join(home, 'personal-info-cache.json'), JSON.stringify({
    profile: { fullName: 'Private Candidate Name' },
    workHistory: [{ company: 'Private Employer Name' }],
    rolePreferences: { preferredPrimaryRoles: ['Private Preferred Role'] },
    notes: 'Hidden Out Of Root Note',
  }));
  return { root, home };
}

function writeMinimalCv(home, identity) {
  const script = String.raw`
import sys, zipfile
identity, output = sys.argv[1], sys.argv[2]
xml = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>{identity}</w:t></w:r></w:p></w:body></w:document>'''
with zipfile.ZipFile(output, 'w') as archive:
    archive.writestr('word/document.xml', xml)
`;
  const result = spawnSync('python3', ['-c', script, identity, join(home, 'CV.docx')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

const gitAvailable = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;

function git(root, ...args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

async function writePrivateEvidence(root) {
  await writeFile(join(root, '.gitignore'), 'agent-output/\n');
  await mkdir(join(root, 'agent-output'));
  await writeFile(join(root, 'agent-output', 'evidence.md'), 'Private Employer Name');
}

describe('local profile leak gate', () => {
  it('ignores untracked Git-ignored evidence but rejects publishable leaks', { skip: !gitAvailable }, async () => {
    const { root, home } = await fixture();
    git(root, 'init', '--quiet');
    git(root, 'config', 'core.excludesFile', '/dev/null');
    await writePrivateEvidence(root);
    await writeFile(join(root, 'skills', 'example', 'SKILL.md'), '# Skill\nExample Candidate');
    const clean = await run(root, home);
    assert.equal(clean.exitCode, 0);
    assert.equal(clean.skipped, false);

    await writeFile(join(root, 'skills', 'example', 'SKILL.md'), '# Skill\nPrivate Employer Name');
    const leaked = await run(root, home);
    assert.equal(leaked.exitCode, 1);
    assert.deepEqual(leaked.findings.map((finding) => finding.path), ['skills/example/SKILL.md']);
  });

  it('rejects profile leaks in tracked ignored files', { skip: !gitAvailable }, async () => {
    const { root, home } = await fixture();
    git(root, 'init', '--quiet');
    await writePrivateEvidence(root);
    git(root, 'add', '--force', 'agent-output/evidence.md');
    const result = await run(root, home);
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.findings.map((finding) => finding.path), ['agent-output/evidence.md']);
  });

  it('scans complete non-Git export directories', async () => {
    const { root, home } = await fixture();
    await writePrivateEvidence(root);
    const result = await run(root, home);
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.findings.map((finding) => finding.path), ['agent-output/evidence.md']);
  });

  it('falls back to full scanning when Git enumeration fails', { skip: !gitAvailable }, async () => {
    const { root, home } = await fixture();
    git(root, 'init', '--quiet');
    await writePrivateEvidence(root);
    await writeFile(join(root, '.git', 'index'), 'invalid Git index');
    const result = await run(root, home);
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.findings.map((finding) => finding.path), ['agent-output/evidence.md']);
  });
  it('reports matched field names without printing private values', async () => {
    const { root, home } = await fixture();
    await writeFile(join(root, 'skills', 'example', 'SKILL.md'), '# Skill\nPrivate Employer Name');
    const result = await run(root, home);
    assert.equal(result.exitCode, 1);
    assert.equal(result.findings[0].path, 'skills/example/SKILL.md');
    assert.match(result.output[0], /workHistory\[0\]\.company/);
    assert.doesNotMatch(result.output.join('\n'), /Private Employer Name/);
  });

  it('detects sensitive strings outside the legacy profile roots', async () => {
    const { root, home } = await fixture();
    await writeFile(join(root, 'skills', 'example', 'SKILL.md'), '# Skill\nHidden Out Of Root Note');
    const result = await run(root, home);
    assert.equal(result.exitCode, 1);
    assert.match(result.output[0], /notes/);
  });

  it('detects identity variants extracted from the local CV', async () => {
    const { root, home } = await fixture();
    writeMinimalCv(home, 'Hidden Cv Identity');
    await writeFile(join(root, 'skills', 'example', 'SKILL.md'), '# Skill\nHidden_Cv_Identity');
    const result = await run(root, home);
    assert.equal(result.exitCode, 1);
    assert.match(result.output[0], /cv\.header\[0\]/);
    assert.doesNotMatch(result.output.join('\n'), /Hidden Cv Identity/);
  });

  it('passes synthetic publication content', async () => {
    const { root, home } = await fixture();
    await writeFile(join(root, 'skills', 'example', 'SKILL.md'), '# Skill\nExample Candidate');
    const result = await run(root, home);
    assert.equal(result.exitCode, 0);
    assert.equal(result.skipped, false);
  });

  it('skips when the maintainer cache is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jh-public-'));
    const home = await mkdtemp(join(tmpdir(), 'jh-no-cache-'));
    created.push(root, home);
    const result = await run(root, home);
    assert.equal(result.exitCode, 0);
    assert.equal(result.skipped, true);
  });
});
