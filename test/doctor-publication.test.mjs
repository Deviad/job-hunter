// doctor-publication.test.mjs — portability checks for jh-doctor.mjs (FR-12).
// Ensures doctor distinguishes required vs optional/degraded capabilities
// and resolves skill roots from the script's own location, not hardcoded host paths.
import assert from 'node:assert/strict';
import {
  existsSync, mkdtempSync, rmSync, renameSync,
  writeFileSync, mkdirSync, readFileSync,
} from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

// --- Setup temp tree once ---
const TMP = mkdtempSync(path.join(tmpdir(), 'jh-doctor-pub-'));
const SKILLS_ROOT = path.join(TMP, 'skills');
const FAKE_HOME = path.join(TMP, 'home');
for (const s of [
  'job-hunter/scripts',
  'linkedin-job-search',
  'indeed-job-search',
  'salary-calculator',
  'auto-job-application',
]) mkdirSync(path.join(SKILLS_ROOT, s), { recursive: true });
mkdirSync(FAKE_HOME, { recursive: true });

// Write a self-contained jh-common stub (no better-sqlite3 dependency).
const commonContent = `import path from 'node:path';
const H = process.env.JOBHUNTER_HOME || path.join(process.env.HOME, '.job-hunter');
export const JOBHUNTER_HOME = H;
export const DB_PATH = path.join(H, 'jobhunter.sqlite');
export const CACHE_PATH = path.join(H, 'personal-info-cache.json');
export const CV_PATH = path.join(H, 'CV.docx');
export const BACKUPS_DIR = path.join(H, 'backups');
export const LOGS_DIR = path.join(H, 'logs');
export function requireDb() { if (!existsSync(DB_PATH)) { console.error('ERROR: DB not found at ' + DB_PATH); process.exit(2); } return DB_PATH; }
export async function openDb() { requireDb(); const { createRequire } = await import('node:module'); const req = createRequire(import.meta.url); const Database = req('better-sqlite3'); return new Database(DB_PATH); }
`;
writeFileSync(
  path.join(SKILLS_ROOT, 'job-hunter', 'scripts', 'jh-common.mjs'),
  commonContent,
);
writeFileSync(
  path.join(SKILLS_ROOT, 'job-hunter', 'scripts', 'existsSync.mjs'),
  'export { existsSync } from "node:fs";',
);

// Copy the actual doctor script into the temp tree.
const DOCTOR_SRC = path.resolve('skills/job-hunter/scripts/jh-doctor.mjs');
const DOCTOR_DST = path.join(SKILLS_ROOT, 'job-hunter', 'scripts', 'jh-doctor.mjs');
assert(existsSync(DOCTOR_SRC), 'source doctor script must exist');
writeFileSync(DOCTOR_DST, readFileSync(DOCTOR_SRC, 'utf8'));

function runDoctor() {
  return spawnSync(process.execPath, [DOCTOR_DST], {
    env: { ...process.env, HOME: TMP, JOBHUNTER_HOME: FAKE_HOME },
    encoding: 'utf8',
    timeout: 15000,
    cwd: TMP,
  });
}

// --- Tests ---

// T1: no hardcoded maintainer home paths in code
{
  const src = readFileSync(DOCTOR_SRC, 'utf8');
  const hostPaths = src.match(/\/Users\/[^\s/'"]+/g);
  assert(
    !hostPaths || hostPaths.length === 0,
    `doctor must not contain hardcoded host paths, found: ${hostPaths?.join(', ')}`,
  );
}

// T2: no hardcoded ~/.pi/agent/skills for skill resolution
{
  const src = readFileSync(DOCTOR_SRC, 'utf8');
  assert(
    !src.includes('.pi/agent/skills'),
    'doctor must resolve skill roots from script location, not hardcoded ~/.pi path',
  );
}

// T3: skill-roots check passes when all dirs present
{
  const r = runDoctor();
  // Doctor may exit non-zero due to missing DB/home, but it must not crash.
  assert(r.status !== null, `doctor crashed: ${r.stderr.slice(-300)}`);
  assert(
    r.stdout.includes('[OK]') && r.stdout.includes('skill roots'),
    `expected [OK] skill roots, got: ${r.stdout.slice(-500)}`,
  );
}

// T4: skill-roots check fails when a pipeline dir is missing
{
  const dir = path.join(SKILLS_ROOT, 'linkedin-job-search');
  const bak = dir + '_bak';
  renameSync(dir, bak);
  try {
    const r = runDoctor();
    assert(
      r.stdout.includes('[FAIL]') && r.stdout.includes('skill roots'),
      `expected [FAIL] skill roots when dir missing, got: ${r.stdout.slice(-500)}`,
    );
  } finally {
    renameSync(bak, dir);
  }
}

// T5: optional checks (Selenium, noVNC, SearXNG, Qwen, container) use [WARN] not [FAIL]
{
  const r = runDoctor();
  const optionalLabels = [
    'Selenium 4444', 'noVNC 7900', 'SearXNG 8888', 'Qwen VLM 1234', 'container mount',
  ];
  for (const label of optionalLabels) {
    const line = r.stdout.split('\n').find((l) => l.includes(label));
    if (line) {
      assert(
        !line.startsWith('[FAIL]'),
        `optional check '${label}' must use [WARN] not [FAIL], got: ${line}`,
      );
    }
  }
}

// T6: no .hermes references
{
  const src = readFileSync(DOCTOR_SRC, 'utf8');
  assert(!src.includes('.hermes'), 'doctor must not reference .hermes paths');
}

// Cleanup
rmSync(TMP, { recursive: true, force: true });
