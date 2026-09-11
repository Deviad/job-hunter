// jh-common.mjs — shared workspace resolution for the job-hunter skill.
// Canonical home: $JOBHUNTER_HOME, default ~/.job-hunter
import path from 'node:path';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';

export const JOBHUNTER_HOME =
  process.env.JOBHUNTER_HOME || path.join(process.env.HOME || homedir(), '.job-hunter');
export const DB_PATH =
  process.env.JOBHUNTER_DB || path.join(JOBHUNTER_HOME, 'jobhunter.sqlite');
export const CACHE_PATH = path.join(JOBHUNTER_HOME, 'personal-info-cache.json');
export const CV_PATH = path.join(JOBHUNTER_HOME, 'CV.docx');
// Machine-derived profile (skills, languages, titles extracted from CV.docx by
// jh-profile-extract.mjs; refreshed when the CV hash changes). Private.
export const PROFILE_DERIVED_PATH = path.join(JOBHUNTER_HOME, 'profile-derived.json');
export const SEARCH_CONFIG_PATH = path.join(JOBHUNTER_HOME, 'search-config.json');
export const BACKUPS_DIR = path.join(JOBHUNTER_HOME, 'backups');
export const LOGS_DIR = path.join(JOBHUNTER_HOME, 'logs');

export function requireDb() {
  if (!existsSync(DB_PATH)) {
    console.error(`ERROR: DB not found at ${DB_PATH}. Run: node scripts/jh-init.mjs`);
    process.exit(2);
  }
  return DB_PATH;
}

// better-sqlite3 is installed in JOBHUNTER_HOME/node_modules; load from there
// so this skill works regardless of the launch directory.
export async function openDb() {
  requireDb();
  const { createRequire } = await import('node:module');
  const req = createRequire(path.join(JOBHUNTER_HOME, 'package.json'));
  const Database = req('better-sqlite3');
  return new Database(DB_PATH);
}
