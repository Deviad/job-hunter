import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../scripts/check-release-safety.mjs';

let tmp;
let counter = 0;
before(async () => { tmp = await mkdtemp(join(tmpdir(), 'jh-rs-')); });
after(async () => { await rm(tmp, { recursive: true, force: true }); });

function fresh() { return join(tmp, `t${++counter}`); }

describe('check-release-safety', () => {
  it('passes on a clean tree', async () => {
    const dir = fresh();
    await mkdir(join(dir, 'skills', 'docx'), { recursive: true });
    await writeFile(join(dir, 'skills', 'docx', 'SKILL.md'), '# docx\nDocx skill.');
    await writeFile(join(dir, 'README.md'), '# Job Hunter');
    await mkdir(join(dir, 'docs'), { recursive: true });
    await writeFile(join(dir, 'docs', 'prerequisites.md'), '# Prerequisites');
    const r = await run(dir);
    assert.equal(r.exitCode, 0);
    assert.equal(r.findings.length, 0);
  });

  it('fails on a forbidden filename (CV.docx)', async () => {
    const dir = fresh();
    await mkdir(join(dir, 'skills', 'x'), { recursive: true });
    await writeFile(join(dir, 'skills', 'x', 'CV.docx'), 'fake');
    const r = await run(dir);
    assert.equal(r.exitCode, 1);
    assert.ok(r.findings.some(f => f.type === 'forbidden-file' && f.detail.includes('CV.docx')));
  });

  it('fails on SQLite sidecar files', async () => {
    const dir = fresh();
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'jobhunter.sqlite-wal'), 'synthetic');
    const r = await run(dir);
    assert.equal(r.exitCode, 1);
    assert.ok(r.findings.some(f => f.type === 'forbidden-file' && f.path.endsWith('.sqlite-wal')));
  });

  it('fails on a forbidden filename (.env)', async () => {
    const dir = fresh();
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, '.env'), 'SECRET=foo');
    const r = await run(dir);
    assert.equal(r.exitCode, 1);
    assert.ok(r.findings.some(f => f.type === 'forbidden-file'));
  });

  it('fails on a forbidden filename (personal-info-cache.json)', async () => {
    const dir = fresh();
    await mkdir(join(dir, 'skills', 'x'), { recursive: true });
    await writeFile(join(dir, 'skills', 'x', 'personal-info-cache.json'), '{}');
    const r = await run(dir);
    assert.equal(r.exitCode, 1);
    assert.ok(r.findings.some(f => f.path.includes('personal-info-cache.json')));
  });

  it('fails on a forbidden directory (screenshots/)', async () => {
    const dir = fresh();
    await mkdir(join(dir, 'screenshots'), { recursive: true });
    const r = await run(dir);
    assert.equal(r.exitCode, 1);
    assert.ok(r.findings.some(f => f.type === 'forbidden-directory' && f.detail.includes('screenshots')));
  });

  it('fails on a forbidden directory (logs/)', async () => {
    const dir = fresh();
    await mkdir(join(dir, 'logs'), { recursive: true });
    const r = await run(dir);
    assert.equal(r.exitCode, 1);
    assert.ok(r.findings.some(f => f.type === 'forbidden-directory' && f.detail.includes('logs')));
  });

  it('fails on forbidden content (hardcoded user path) in skills/', async () => {
    const dir = fresh();
    await mkdir(join(dir, 'skills', 'x'), { recursive: true });
    await writeFile(join(dir, 'skills', 'x', 'SKILL.md'), 'See /Users/spotted/something.');
    const r = await run(dir);
    assert.equal(r.exitCode, 1);
    assert.ok(r.findings.some(f => f.type === 'forbidden-content' && f.detail.includes('hardcoded-user-path')));
  });

  it('fails on forbidden content (.hermes) in docs/', async () => {
    const dir = fresh();
    await mkdir(join(dir, 'docs'), { recursive: true });
    await writeFile(join(dir, 'docs', 'notes.md'), 'Config lives in .hermes directory.');
    const r = await run(dir);
    assert.equal(r.exitCode, 1);
    assert.ok(r.findings.some(f => f.type === 'forbidden-content' && f.detail.includes('hermes-path')));
  });

  it('fails on a non-example email address', async () => {
    const dir = fresh();
    await mkdir(join(dir, 'skills', 'x'), { recursive: true });
    await writeFile(join(dir, 'skills', 'x', 'SKILL.md'), 'Contact private-person@real-domain.test');
    const r = await run(dir);
    assert.equal(r.exitCode, 1);
    assert.ok(r.findings.some(f => f.type === 'forbidden-content' && f.detail.includes('non-example-email')));
  });

  it('rejects references to unpublished internal specs', async () => {
    const dir = fresh();
    const skill = join(dir, 'skills', 'example-skill');
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, 'SKILL.md'), 'See PRODUCT_V4.md and .planning/CONCERNS.md');
    const r = await run(dir);
    assert.equal(r.exitCode, 1);
    assert.ok(r.findings.some(f => f.type === 'forbidden-content' && f.detail.includes('internal-spec-reference')));
  });

  it('rejects dated application references', async () => {
    const dir = fresh();
    const refs = join(dir, 'skills', 'auto-job-application', 'references');
    await mkdir(refs, { recursive: true });
    await writeFile(join(refs, 'application-run-2026-01-01.md'), '# Private run');
    const r = await run(dir);
    assert.equal(r.exitCode, 1);
    assert.ok(r.findings.some(f => f.type === 'dated-application-reference'));
  });

  it('rejects dated application evidence in a generically named reference', async () => {
    const dir = fresh();
    const refs = join(dir, 'skills', 'example-skill', 'references');
    await mkdir(refs, { recursive: true });
    await writeFile(join(refs, 'lessons.md'), 'Application submitted on 2026-01-01.');
    const r = await run(dir);
    assert.equal(r.exitCode, 1);
    assert.ok(r.findings.some(f => f.type === 'dated-application-evidence'));
  });

  it('rejects dated application evidence in skill scripts', async () => {
    const dir = fresh();
    const scripts = join(dir, 'skills', 'example-skill', 'scripts');
    await mkdir(scripts, { recursive: true });
    await writeFile(join(scripts, 'helper.mjs'), '// Application submitted on 2026-01-01.');
    const r = await run(dir);
    assert.equal(r.exitCode, 1);
    assert.ok(r.findings.some(f => f.type === 'dated-application-evidence'));
  });

  it('rejects hardcoded sensitive application answers', async () => {
    const dir = fresh();
    const scripts = join(dir, 'skills', 'auto-job-application', 'scripts');
    await mkdir(scripts, { recursive: true });
    await writeFile(join(scripts, 'apply.mjs'), "const authorized = true; const want = 'yes';");
    const r = await run(dir);
    assert.equal(r.exitCode, 1);
    assert.ok(r.findings.some(f => f.type === 'hardcoded-sensitive-answer'));
  });

  it('rejects non-synthetic job identifiers and allows reserved synthetic identifiers', async () => {
    const dir = fresh();
    const scripts = join(dir, 'skills', 'example-skill', 'scripts');
    await mkdir(scripts, { recursive: true });
    const file = join(scripts, 'fixture.mjs');
    await writeFile(file, "const jobId = '4423991670';");
    const unsafe = await run(dir);
    assert.equal(unsafe.exitCode, 1);
    assert.ok(unsafe.findings.some(f => f.type === 'real-looking-job-identifier'));

    await writeFile(file, "const jobId = '9000001001';");
    const synthetic = await run(dir);
    assert.equal(synthetic.exitCode, 0);
  });

  it('rejects dangling explicit skill references', async () => {
    const dir = fresh();
    const skill = join(dir, 'skills', 'example-skill');
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, 'SKILL.md'), 'Run scripts/missing-helper.mjs and test/missing-helper.test.mjs');
    const r = await run(dir);
    assert.equal(r.exitCode, 1);
    assert.equal(r.findings.filter(f => f.type === 'dangling-skill-reference').length, 2);
  });

  it('passes on examples/ with only synthetic fixtures', async () => {
    const dir = fresh();
    await mkdir(join(dir, 'examples'), { recursive: true });
    await writeFile(join(dir, 'examples', 'config-template.json'), '{"key": "value"}');
    const r = await run(dir);
    assert.equal(r.exitCode, 0);
  });

  it('scans scripts and tests for leaked maintainer paths', async () => {
    const dir = fresh();
    await mkdir(join(dir, 'scripts'), { recursive: true });
    await mkdir(join(dir, 'test'), { recursive: true });
    await writeFile(join(dir, 'scripts', 'helper.mjs'), 'const p = "/Users/private-user/foo";');
    await writeFile(join(dir, 'test', 'helper.test.mjs'), 'const p = "/Users/private-user/foo";');
    const r = await run(dir);
    assert.equal(r.exitCode, 1);
    assert.equal(r.findings.filter((finding) => finding.type === 'forbidden-content').length, 2);
  });

  it('reports multiple findings at once', async () => {
    const dir = fresh();
    await mkdir(join(dir, 'skills', 'x', 'logs'), { recursive: true });
    await writeFile(join(dir, 'skills', 'x', 'CV.docx'), 'x');
    await writeFile(join(dir, 'skills', 'x', 'SKILL.md'), '/Users/spotted/path');
    const r = await run(dir);
    assert.equal(r.exitCode, 1);
    assert.ok(r.findings.length >= 3);
  });
});
