#!/usr/bin/env node
// jh-init.mjs — bootstrap the canonical ~/.job-hunter workspace.
// Idempotent: creates dirs, initializes the DB from schema.sql if missing,
// and reports anything the user still needs to provide (CV, cache).
import { mkdirSync, existsSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  JOBHUNTER_HOME, DB_PATH, CACHE_PATH, CV_PATH, BACKUPS_DIR, LOGS_DIR,
} from './jh-common.mjs';

const SKILL_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const report = [];

for (const d of [JOBHUNTER_HOME, BACKUPS_DIR, LOGS_DIR, path.join(JOBHUNTER_HOME, 'optional_documents'), path.join(JOBHUNTER_HOME, 'apply_logs')]) {
  if (!existsSync(d)) { mkdirSync(d, { recursive: true }); report.push(`created ${d}`); }
}

// Initialize DB from bundled schema if absent
if (!existsSync(DB_PATH)) {
  const schemaCandidates = [
    path.join(JOBHUNTER_HOME, 'schema.sql'),
    path.join(SKILL_DIR, 'schema.sql'),
    path.join(process.env.HOME, '.pi/agent/skills/linkedin-job-search/schema.sql'),
  ];
  const schema = schemaCandidates.find(existsSync);
  if (schema) {
    execFileSync('sqlite3', [DB_PATH], { input: `.read ${schema}\n` });
    report.push(`initialized DB ${DB_PATH} from ${schema}`);
  } else {
    report.push(`WARN: no schema.sql found; DB not created`);
  }
} else {
  report.push(`DB present: ${DB_PATH}`);
}

// Copy schema.sql into home for future re-init if we found one elsewhere
const homeSchema = path.join(JOBHUNTER_HOME, 'schema.sql');
if (!existsSync(homeSchema)) {
  const src = path.join(process.env.HOME, '.pi/agent/skills/linkedin-job-search/schema.sql');
  if (existsSync(src)) { copyFileSync(src, homeSchema); report.push(`copied schema.sql -> ${homeSchema}`); }
}

report.push(existsSync(CACHE_PATH) ? `cache present: ${CACHE_PATH}` : `TODO: add personal-info-cache.json to ${JOBHUNTER_HOME}`);
report.push(existsSync(CV_PATH) ? `CV present: ${CV_PATH}` : `TODO: add CV.docx to ${JOBHUNTER_HOME}`);
try {
  const { profileStatus } = await import('./jh-profile.mjs');
  const profile = profileStatus();
  report.push(profile.state === 'current'
    ? 'derived profile current (profile-derived.json matches CV.docx)'
    : `TODO: derived profile ${profile.state} — ${profile.reason}; run jh-profile.mjs refresh (automatic on the next search/score run)`);
} catch (error) {
  report.push(`derived profile: could not evaluate (${error.message})`);
}

console.log(report.join('\n'));
