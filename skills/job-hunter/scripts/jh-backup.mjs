#!/usr/bin/env node
// jh-backup.mjs — timestamped DB snapshot into ~/.job-hunter/backups, keeps last 10.
import { existsSync, readdirSync, unlinkSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DB_PATH, BACKUPS_DIR, requireDb } from './jh-common.mjs';

requireDb();
if (!existsSync(BACKUPS_DIR)) mkdirSync(BACKUPS_DIR, { recursive: true });

const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
const dest = path.join(BACKUPS_DIR, `jobhunter-${stamp}.sqlite`);
// Safe online backup via sqlite3 .backup (handles WAL correctly)
execFileSync('sqlite3', [DB_PATH, `.backup '${dest}'`]);
console.log(`backup written: ${dest}`);

const KEEP = 10;
const backups = readdirSync(BACKUPS_DIR).filter((f) => f.startsWith('jobhunter-') && f.endsWith('.sqlite')).sort();
for (const old of backups.slice(0, Math.max(0, backups.length - KEEP))) {
  unlinkSync(path.join(BACKUPS_DIR, old));
  console.log(`pruned: ${old}`);
}
