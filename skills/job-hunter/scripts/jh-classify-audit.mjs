#!/usr/bin/env node
// Report deterministic role-label provenance without modifying the database.
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROLE_LABELS, ROLE_TAXONOMY_VERSION } from './role-taxonomy.mjs';

const JOBHUNTER_HOME = process.env.JOBHUNTER_HOME || path.join(process.env.HOME, '.job-hunter');
const DEFAULT_DB = process.env.JOBHUNTER_DB || path.join(JOBHUNTER_HOME, 'jobhunter.sqlite');

function parseArgs(argv) {
  const options = { db: DEFAULT_DB, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--db') {
      if (index + 1 >= argv.length) throw new Error('missing value for --db');
      options.db = argv[++index];
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function openReadOnly(dbPath) {
  const req = createRequire(path.join(JOBHUNTER_HOME, 'package.json'));
  const Database = req('better-sqlite3');
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

function auditClassifications(dbPath = DEFAULT_DB) {
  const db = openReadOnly(dbPath);
  try {
    const columns = new Set(db.prepare('PRAGMA table_info(jobs)').all().map((column) => column.name));
    const versionExpression = columns.has('role_taxonomy_version') ? 'role_taxonomy_version' : 'NULL';
    const rows = db.prepare(`
      SELECT role_family_inferred AS label, ${versionExpression} AS version, COUNT(*) AS count
      FROM jobs
      GROUP BY role_family_inferred, ${versionExpression}
    `).all();
    const known = new Set(ROLE_LABELS);
    const report = {
      schemaVersion: 1,
      taxonomyVersion: ROLE_TAXONOMY_VERSION,
      database: path.resolve(dbPath),
      counts: {
        total: 0,
        classified: 0,
        currentVersion: 0,
        unversioned: 0,
        staleVersion: 0,
        unknownLabel: 0,
      },
      unknownLabels: {},
      staleVersions: {},
    };
    for (const row of rows) {
      const count = Number(row.count);
      const label = String(row.label || '').trim();
      const version = String(row.version || '').trim();
      report.counts.total += count;
      if (!label) continue;
      report.counts.classified += count;
      if (!version) report.counts.unversioned += count;
      else if (version === ROLE_TAXONOMY_VERSION) report.counts.currentVersion += count;
      else {
        report.counts.staleVersion += count;
        report.staleVersions[version] = (report.staleVersions[version] || 0) + count;
      }
      if (!known.has(label)) {
        report.counts.unknownLabel += count;
        report.unknownLabels[label] = (report.unknownLabels[label] || 0) + count;
      }
    }
    return report;
  } finally {
    db.close();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: jh-classify-audit.mjs [--db /path/to/jobhunter.sqlite] [--json]');
    return;
  }
  const report = auditClassifications(options.db);
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`taxonomy version: ${report.taxonomyVersion}`);
    for (const [name, value] of Object.entries(report.counts)) console.log(`${name}: ${value}`);
  }
}

export { DEFAULT_DB, parseArgs, auditClassifications };

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
