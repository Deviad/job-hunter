import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, REQUIRED_SKILLS } from '../scripts/verify-skill-closure.mjs';

const MINIMAL_SKILL_MD = `# Test Skill\n\nDescription and instructions for the user.`;

let tmp;
let counter = 0;

before(async () => { tmp = await mkdtemp(join(tmpdir(), 'jh-sc-')); });
after(async () => { await rm(tmp, { recursive: true, force: true }); });

function freshDir() {
  const d = join(tmp, `t${++counter}`);
  return d;
}

async function writeSkill(root, name, content = MINIMAL_SKILL_MD) {
  const dir = join(root, 'skills', name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), content);
}

async function writeAllSkills(root, contentFn) {
  for (const name of REQUIRED_SKILLS) {
    await writeSkill(root, name, contentFn ? contentFn(name) : MINIMAL_SKILL_MD);
  }
}

describe('verify-skill-closure', () => {
  it('passes when all 14 skills exist with valid SKILL.md', async () => {
    const dir = freshDir();
    await writeAllSkills(dir);
    const r = await run(dir);
    assert.equal(r.exitCode, 0);
    assert.equal(r.findings.length, 0);
  });

  it('fails when a required skill is missing', async () => {
    const dir = freshDir();
    const subset = REQUIRED_SKILLS.filter(n => n !== 'captcha-resolution');
    for (const name of subset) await writeSkill(dir, name);
    const r = await run(dir);
    assert.equal(r.exitCode, 1);
    assert.ok(r.findings.some(f => f.type === 'missing-skill' && f.path.includes('captcha-resolution')));
  });

  it('fails when SKILL.md is missing for a skill', async () => {
    const dir = freshDir();
    for (const name of REQUIRED_SKILLS) {
      const skillDir = join(dir, 'skills', name);
      await mkdir(skillDir, { recursive: true });
      if (name !== 'docx') {
        await writeFile(join(skillDir, 'SKILL.md'), MINIMAL_SKILL_MD);
      }
    }
    const r = await run(dir);
    assert.equal(r.exitCode, 1);
    assert.ok(r.findings.some(f => f.type === 'missing-skill-md' && f.path.includes('docx')));
  });

  it('fails when SKILL.md is empty', async () => {
    const dir = freshDir();
    await writeAllSkills(dir, name => name === 'pdf' ? '' : MINIMAL_SKILL_MD);
    const r = await run(dir);
    assert.equal(r.exitCode, 1);
    assert.ok(r.findings.some(f => f.type === 'empty-skill-md' && f.path.includes('pdf')));
  });

  it('passes on cross-references to bundled skills', async () => {
    const dir = freshDir();
    await writeAllSkills(dir, name => {
      if (name === 'qwen-screenshot-debug') {
        return `# Qwen Screenshot Debug\n\nIf CAPTCHA visible → captcha-resolution skill.`;
      }
      return MINIMAL_SKILL_MD;
    });
    const r = await run(dir);
    assert.equal(r.exitCode, 0);
  });

  it('passes on cross-references to platform integrations', async () => {
    const dir = freshDir();
    await writeAllSkills(dir, name => {
      if (name === 'auto-job-application') {
        return `# Auto Job Application\n\nUse Chromium CDP. The browser skill handles auth.`;
      }
      return MINIMAL_SKILL_MD;
    });
    const r = await run(dir);
    assert.equal(r.exitCode, 0);
  });

  it('fails on unresolved cross-reference to unbundled skill', async () => {
    const dir = freshDir();
    await writeAllSkills(dir, name => {
      if (name === 'job-hunter') {
        return `# Job Hunter\n\nSee skills/nonexistent-helper/ for setup details.`;
      }
      return MINIMAL_SKILL_MD;
    });
    const r = await run(dir);
    assert.equal(r.exitCode, 1);
    assert.ok(r.findings.some(f =>
      f.type === 'unresolved-skill-ref' && f.detail.includes('nonexistent-helper')
    ));
  });

  it('lists all 14 required skill names in the export', () => {
    assert.equal(REQUIRED_SKILLS.length, 14);
    assert.ok(REQUIRED_SKILLS.includes('job-hunter'));
    assert.ok(REQUIRED_SKILLS.includes('pdf'));
  });
});
