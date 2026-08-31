import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';

const PROJECT_ROOT = new URL('..', import.meta.url).pathname;
const SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'install.mjs');

// Create a unique tmp dir per test run as fake HOME.
function makeTmpHome() {
  const dir = path.join(os.tmpdir(), `jh-test-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Set up a complete synthetic source tree without mutating the repository.
function seedSource(tmpHome) {
  const sourceRoot = path.join(tmpHome, 'source');
  const testSkillDir = path.join(sourceRoot, 'skills', 'test-skill');
  const commonDir = path.join(sourceRoot, 'skills', '_document_common');
  const templateDir = path.join(sourceRoot, 'workspace-template');
  mkdirSync(testSkillDir, { recursive: true });
  mkdirSync(commonDir, { recursive: true });
  mkdirSync(templateDir, { recursive: true });
  writeFileSync(path.join(testSkillDir, 'SKILL.md'), '# Test Skill\nTest skill for install verification.\n');
  writeFileSync(path.join(testSkillDir, 'helper.mjs'), 'export const hello = () => "hello";\n');
  writeFileSync(path.join(commonDir, 'document_common.py'), 'def synthetic_helper(): return True\n');
  writeFileSync(path.join(templateDir, 'schema.sql'), 'CREATE TABLE IF NOT EXISTS jobs (source TEXT, job_id TEXT);\n');
  writeFileSync(path.join(templateDir, 'personal-info-cache.example.json'), JSON.stringify({ profile: {}, portalCredentials: {} }));
  writeFileSync(path.join(templateDir, 'package.json'), JSON.stringify({ name: 'job-hunter-test-runtime', private: true }));
  writeFileSync(path.join(templateDir, 'package-lock.json'), JSON.stringify({
    name: 'job-hunter-test-runtime',
    lockfileVersion: 3,
    requires: true,
    packages: { '': { name: 'job-hunter-test-runtime' } },
  }));
  return sourceRoot;
}

// --- Helpers ---

function useRealRuntimePackage(tmpHome) {
  const templateDir = path.join(tmpHome, 'source', 'workspace-template');
  copyFileSync(path.join(PROJECT_ROOT, 'workspace-template', 'package.json'), path.join(templateDir, 'package.json'));
  copyFileSync(path.join(PROJECT_ROOT, 'workspace-template', 'package-lock.json'), path.join(templateDir, 'package-lock.json'));
}

function runInstaller(tmpHome, extraArgs = [], extraEnv = {}) {
  const env = {
    ...process.env,
    HOME: tmpHome,
    PI_AGENT_HOME: path.join(tmpHome, '.pi', 'agent'),
    JOBHUNTER_HOME: path.join(tmpHome, '.job-hunter'),
    JOBHUNTER_SOURCE_ROOT: path.join(tmpHome, 'source'),
    ...extraEnv,
  };
  const result = spawnSync(process.execPath, [SCRIPT, ...extraArgs], {
    env,
    cwd: PROJECT_ROOT,
    encoding: 'utf-8',
    timeout: 30_000,
  });
  return result;
}

function fileHash(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16);
}

// --- Tests ---

describe('install.mjs', () => {
  let tmpHome;
  let piHome;
  let jhHome;

  beforeEach(() => {
    tmpHome = makeTmpHome();
    piHome = path.join(tmpHome, '.pi', 'agent', 'skills');
    jhHome = path.join(tmpHome, '.job-hunter');
    seedSource(tmpHome);
  });

  afterEach(() => {
    if (tmpHome && existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
  });

  it('installs skills into PI_AGENT_HOME', () => {
    const result = runInstaller(tmpHome);
    assert.equal(result.status, 0, `installer failed: ${result.stderr}`);
    assert.ok(existsSync(path.join(piHome, 'test-skill', 'SKILL.md')));
    assert.ok(existsSync(path.join(piHome, 'test-skill', 'helper.mjs')));
    assert.ok(existsSync(path.join(piHome, '_document_common', 'document_common.py')));
  });

  it('creates workspace directories', () => {
    const result = runInstaller(tmpHome);
    assert.equal(result.status, 0, `installer failed: ${result.stderr}`);
    for (const sub of ['backups', 'logs', 'apply_logs', 'optional_documents']) {
      assert.ok(existsSync(path.join(jhHome, sub)), `missing ${sub}`);
    }
  });

  it('copies synthetic workspace templates to canonical filenames', () => {
    const result = runInstaller(tmpHome);
    assert.equal(result.status, 0, `installer failed: ${result.stderr}`);
    assert.ok(existsSync(path.join(jhHome, 'schema.sql')));
    assert.ok(existsSync(path.join(jhHome, 'personal-info-cache.json')));
    const cache = JSON.parse(readFileSync(path.join(jhHome, 'personal-info-cache.json'), 'utf-8'));
    assert.deepEqual(cache.profile, {});
    assert.deepEqual(cache.portalCredentials, {});
    assert.ok(existsSync(path.join(jhHome, 'chromium-profile')));
    assert.ok(existsSync(path.join(jhHome, 'searxng')));
  });

  it('creates workspace package.json', () => {
    const result = runInstaller(tmpHome);
    assert.equal(result.status, 0, `installer failed: ${result.stderr}`);
    assert.ok(existsSync(path.join(jhHome, 'package.json')));
  });

  it('writes installation manifest', () => {
    const result = runInstaller(tmpHome);
    assert.equal(result.status, 0, `installer failed: ${result.stderr}`);
    const manifestPath = path.join(jhHome, '.install-manifest.json');
    assert.ok(existsSync(manifestPath), 'manifest missing');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    assert.equal(manifest.version, 1);
    assert.ok(Array.isArray(manifest.installedFiles));
    assert.ok(Array.isArray(manifest.installedDirs));
    assert.ok(manifest.timestamp);
    // Manifest entries have path and hash.
    for (const entry of manifest.installedFiles) {
      assert.ok(entry.path, 'manifest entry missing path');
      assert.ok(typeof entry.hash === 'string', 'manifest entry missing hash');
    }
  });

  it('is idempotent — re-run exits zero without overwriting user files', () => {
    // First install.
    const r1 = runInstaller(tmpHome);
    assert.equal(r1.status, 0, `first install failed: ${r1.stderr}`);

    // Plant preserved user files.
    const cvPath = path.join(jhHome, 'CV.docx');
    const cachePath = path.join(jhHome, 'personal-info-cache.json');
    const dbPath = path.join(jhHome, 'jobhunter.sqlite');
    writeFileSync(cvPath, 'fake-cv-content');
    writeFileSync(cachePath, JSON.stringify({ schemaVersion: 2, profile: { name: 'Test' } }));
    writeFileSync(dbPath, 'fake-db-content');
    const cvHashBefore = fileHash(cvPath);
    const cacheHashBefore = fileHash(cachePath);
    const dbHashBefore = fileHash(dbPath);

    // Second install.
    const r2 = runInstaller(tmpHome);
    assert.equal(r2.status, 0, `second install failed: ${r2.stderr}`);
    assert.equal(fileHash(cvPath), cvHashBefore, 'CV.docx was overwritten');
    assert.equal(fileHash(cachePath), cacheHashBefore, 'personal-info-cache.json was overwritten');
    assert.equal(fileHash(dbPath), dbHashBefore, 'jobhunter.sqlite was overwritten');
  });

  it('dry-run makes no filesystem changes', () => {
    const result = runInstaller(tmpHome, ['--dry-run']);
    assert.equal(result.status, 0, `dry-run failed: ${result.stderr}`);
    assert.ok(!existsSync(piHome), 'dry-run created PI_AGENT_HOME');
    assert.ok(!existsSync(jhHome), 'dry-run created JOBHUNTER_HOME');
  });

  it('uninstall removes only manifest-tracked files, preserves user data', () => {
    // Install.
    const r1 = runInstaller(tmpHome);
    assert.equal(r1.status, 0, `install failed: ${r1.stderr}`);

    // Plant user files after install.
    const cvPath = path.join(jhHome, 'CV.docx');
    const cachePath = path.join(jhHome, 'personal-info-cache.json');
    writeFileSync(cvPath, 'user-cv');
    writeFileSync(cachePath, '{"schemaVersion":2}');

    // Uninstall.
    const r2 = runInstaller(tmpHome, ['--uninstall']);
    assert.equal(r2.status, 0, `uninstall failed: ${r2.stderr}`);

    // Skills removed.
    assert.ok(!existsSync(path.join(piHome, 'test-skill', 'SKILL.md')));
    // User files preserved.
    assert.ok(existsSync(cvPath), 'CV.docx was removed by uninstall');
    assert.ok(existsSync(cachePath), 'personal-info-cache.json was removed by uninstall');
    // Manifest removed.
    assert.ok(!existsSync(path.join(jhHome, '.install-manifest.json')));
  });

  it('uninstall removes dependency directories created by the installer', () => {
    useRealRuntimePackage(tmpHome);
    const install = runInstaller(tmpHome);
    assert.equal(install.status, 0, `install failed: ${install.stderr}`);
    const nodeModules = path.join(jhHome, 'node_modules');
    assert.ok(existsSync(nodeModules));

    const uninstall = runInstaller(tmpHome, ['--uninstall']);
    assert.equal(uninstall.status, 0, `uninstall failed: ${uninstall.stderr}`);
    assert.ok(!existsSync(nodeModules), 'installer-owned node_modules remains');
  });

  it('rolls back dependencies when failure occurs after npm ci', () => {
    useRealRuntimePackage(tmpHome);
    const result = runInstaller(tmpHome, [], {
      NODE_ENV: 'test',
      JOBHUNTER_TEST_FAIL_AFTER_NPM_CI: '1',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /injected failure after workspace npm ci/);
    assert.ok(!existsSync(path.join(jhHome, 'node_modules')), 'partial node_modules remains');
    assert.ok(!existsSync(path.join(piHome, 'test-skill')), 'partial skill directory remains');
  });

  it('rolls back a failure after copying begins', () => {
    const env = {
      ...process.env,
      NODE_ENV: 'test',
      JOBHUNTER_TEST_FAIL_AFTER_COPIES: '2',
      HOME: tmpHome,
      PI_AGENT_HOME: path.join(tmpHome, '.pi', 'agent'),
      JOBHUNTER_HOME: jhHome,
      JOBHUNTER_SOURCE_ROOT: path.join(tmpHome, 'source'),
    };
    const result = spawnSync(process.execPath, [SCRIPT], {
      env,
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      timeout: 30_000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /injected copy failure/);
    assert.ok(!existsSync(path.join(piHome, 'test-skill')), 'partial skill directory remains');
    assert.ok(!existsSync(path.join(jhHome, '.install-manifest.json')), 'partial manifest remains');
  });
});
