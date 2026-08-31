#!/usr/bin/env node
// jh-report-gate.mjs — remediation R6: a report may only be labeled "final"
// once every attempted source is status=ok and every Apply-row has salary
// provenance. See references/search-safety-contract.md.
//
// Three checks:
//   1. Source status — every --run <run-id> checkpoint (written by
//      jh-search.mjs) must be status "ok". Any other status (blocked,
//      preflight-failed, budget-exhausted, fatal, cancelled) degrades the gate.
//   2. Salary provenance — every match_results row with cta='Apply' for
//      --search-id must have a job_salary_observations row that is either
//      posted (is_posted_salary=1) or a labeled estimate (is_posted_salary=0
//      AND benchmark_id IS NOT NULL).
//   3. Posting freshness (user policy 2026-07-21) — every Apply row with a
//      real posting-date signal older than --max-age-days (default 30) is
//      treated as very likely stale/zombie and degrades the gate; see
//      jh-freshness.mjs for the age-resolution rules this reuses.
//
// On failure, the report file (if --report is given) is renamed to
// "<name>.PARTIAL.md" (inserted before the final .md) with a "Degraded
// sources / missing provenance" section appended. This script is the only
// thing that removes the PARTIAL marker once the gate later passes.
//
// Exit codes: 0 = gate passed, 1 = gate failed (degraded/partial), 2 = usage error.
import { existsSync, readFileSync, renameSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { JOBHUNTER_HOME, DB_PATH as DEFAULT_DB_PATH } from './jh-common.mjs';
import { classifyFreshness } from './jh-freshness.mjs';

// jh-common.mjs's openDb() always opens the canonical DB_PATH; this gate
// must honor an explicit --db (used by tests and any non-default workspace),
// so it loads better-sqlite3 from JOBHUNTER_HOME/node_modules directly.
function openDbAt(dbPath) {
  if (!existsSync(dbPath)) {
    throw new Error(`DB not found at ${dbPath}. Run: node jh-init.mjs`);
  }
  const req = createRequire(path.join(JOBHUNTER_HOME, 'package.json'));
  const Database = req('better-sqlite3');
  return new Database(dbPath);
}

const RUNS_DIR = path.join(JOBHUNTER_HOME, 'runs');

function usage(code = 0) {
  const out = code === 0 ? process.stdout : process.stderr;
  out.write(`Usage:
  jh-report-gate.mjs --search-id <id> [--run <run-id> ...] [--report <path>] [--db <path>] [--json]

--search-id <id>   match_results.search_id to check Apply-row salary provenance for
--run <run-id>     jh-search.mjs run-id whose runs/<run-id>/checkpoint.json must be status "ok"
                    (repeatable; omit to skip the source-status check)
--report <path>    report file to gate. On failure, renamed to <stem>.PARTIAL.md with
                    a degraded-findings section appended. On a later pass, PARTIAL is
                    stripped back off if the file still has that suffix.
--max-age-days <n> posting-age cutoff in days, default 30 (see jh-freshness.mjs)
--db <path>        SQLite DB (default ${DEFAULT_DB_PATH})
--json             machine-readable result on stdout
`);
  process.exit(code);
}

function parseArgs(argv) {
  const o = { searchId: null, runs: [], report: null, maxAgeDays: 30, db: process.env.JOBHUNTER_DB || DEFAULT_DB_PATH, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} requires a value`);
      return argv[++i];
    };
    if (a === '--help' || a === '-h') usage(0);
    else if (a === '--search-id') o.searchId = next();
    else if (a === '--run') o.runs.push(next());
    else if (a === '--report') o.report = next();
    else if (a === '--max-age-days') o.maxAgeDays = Number(next());
    else if (a === '--db') o.db = next();
    else if (a === '--json') o.json = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!o.searchId) usage(2);
  return o;
}

function checkSourceStatus(runs) {
  const results = [];
  for (const runIdValue of runs) {
    const cpPath = path.join(RUNS_DIR, runIdValue, 'checkpoint.json');
    if (!existsSync(cpPath)) {
      results.push({ runId: runIdValue, ok: false, status: 'missing', detail: `no checkpoint at ${cpPath}` });
      continue;
    }
    let cp;
    try { cp = JSON.parse(readFileSync(cpPath, 'utf8')); } catch (e) {
      results.push({ runId: runIdValue, ok: false, status: 'unreadable', detail: e.message });
      continue;
    }
    results.push({ runId: runIdValue, ok: cp.status === 'ok', status: cp.status, source: cp.source, country: cp.country });
  }
  return results;
}

async function checkSalaryProvenance(db, searchId) {
  const applyRows = db.prepare(`
    SELECT m.source, m.job_id, j.title, j.company
    FROM match_results m
    JOIN jobs j ON j.source = m.source AND j.job_id = m.job_id
    WHERE m.search_id = ? AND m.cta = 'Apply'
  `).all(searchId);

  const provenanceStmt = db.prepare(`
    SELECT is_posted_salary, benchmark_id
    FROM job_salary_observations
    WHERE job_source = ? AND job_id = ?
    ORDER BY observed_at DESC
    LIMIT 1
  `);

  const missing = [];
  for (const row of applyRows) {
    const obs = provenanceStmt.get(row.source, row.job_id);
    const hasProvenance = obs && (
      (obs.is_posted_salary === 1) ||
      (obs.is_posted_salary === 0 && obs.benchmark_id != null)
    );
    if (!hasProvenance) {
      missing.push({ source: row.source, job_id: row.job_id, title: row.title, company: row.company });
    }
  }
  return { totalApply: applyRows.length, missing };
}

async function checkPostingFreshness(db, searchId, maxAgeDays) {
  const applyRows = db.prepare(`
    SELECT m.source, m.job_id, j.title, j.company, j.job_posting_date, j.created_at
    FROM match_results m
    JOIN jobs j ON j.source = m.source AND j.job_id = m.job_id
    WHERE m.search_id = ? AND m.cta = 'Apply'
  `).all(searchId);

  const stale = [];
  for (const row of applyRows) {
    const c = classifyFreshness(row, maxAgeDays);
    if (c.verdict === 'stale') {
      stale.push({ source: row.source, job_id: row.job_id, title: row.title, company: row.company, ageDays: c.ageDays, method: c.method });
    }
  }
  return { totalApply: applyRows.length, stale };
}

function stripPartialSuffix(reportPath) {
  if (reportPath.endsWith('.PARTIAL.md')) return reportPath.slice(0, -'.PARTIAL.md'.length) + '.md';
  return reportPath;
}

function partialSuffixPath(reportPath) {
  if (reportPath.endsWith('.PARTIAL.md')) return reportPath;
  if (reportPath.endsWith('.md')) return reportPath.slice(0, -'.md'.length) + '.PARTIAL.md';
  return `${reportPath}.PARTIAL.md`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const sourceResults = checkSourceStatus(opts.runs);
  const degradedSources = sourceResults.filter((r) => !r.ok);

  const db = openDbAt(opts.db);
  const { totalApply, missing } = await checkSalaryProvenance(db, opts.searchId);
  const { stale: stalePostings } = await checkPostingFreshness(db, opts.searchId, opts.maxAgeDays);
  db.close();

  const passed = degradedSources.length === 0 && missing.length === 0 && stalePostings.length === 0;

  const result = {
    searchId: opts.searchId,
    passed,
    sourceResults,
    degradedSources,
    totalApplyRows: totalApply,
    missingProvenance: missing,
    maxAgeDays: opts.maxAgeDays,
    stalePostings,
  };

  if (opts.report && existsSync(opts.report)) {
    if (passed) {
      const finalPath = stripPartialSuffix(opts.report);
      if (finalPath !== opts.report) {
        renameSync(opts.report, finalPath);
        result.reportPath = finalPath;
        result.reportRenamed = `${opts.report} -> ${finalPath}`;
      } else {
        result.reportPath = opts.report;
      }
    } else {
      const partialPath = partialSuffixPath(opts.report);
      if (partialPath !== opts.report) {
        renameSync(opts.report, partialPath);
        result.reportRenamed = `${opts.report} -> ${partialPath}`;
      }
      result.reportPath = partialPath;
      const lines = ['', '## Degraded sources / missing provenance', ''];
      if (degradedSources.length) {
        lines.push('Degraded sources (report gate R6):');
        for (const s of degradedSources) lines.push(`- ${s.source ?? '?'}/${s.country ?? '?'} (run ${s.runId}): status=${s.status}${s.detail ? ` — ${s.detail}` : ''}`);
      }
      if (missing.length) {
        lines.push('', 'Apply rows missing salary provenance (report gate R6):');
        for (const m of missing) lines.push(`- ${m.source}:${m.job_id} — ${m.title} @ ${m.company}`);
      }
      if (stalePostings.length) {
        lines.push('', `Apply rows older than ${opts.maxAgeDays} days (likely stale/zombie postings):`);
        for (const s of stalePostings) lines.push(`- ${s.source}:${s.job_id} — ${s.title} @ ${s.company} (${s.ageDays ?? '>' + opts.maxAgeDays}d, ${s.method})`);
      }
      lines.push('');
      appendFileSync(partialPath, lines.join('\n'));
    }
  }

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Report gate for search_id=${opts.searchId}: ${passed ? 'PASS' : 'PARTIAL'}`);
    for (const s of sourceResults) console.log(`  source ${s.source ?? '?'}/${s.country ?? '?'} (${s.runId}): ${s.status}${s.ok ? '' : '  <-- degraded'}`);
    console.log(`  Apply rows: ${totalApply} total, ${missing.length} missing salary provenance, ${stalePostings.length} older than ${opts.maxAgeDays}d`);
    for (const m of missing) console.log(`    missing salary: ${m.source}:${m.job_id} — ${m.title} @ ${m.company}`);
    for (const s of stalePostings) console.log(`    stale posting: ${s.source}:${s.job_id} — ${s.title} @ ${s.company} (${s.ageDays ?? '>' + opts.maxAgeDays}d)`);
    if (result.reportRenamed) console.log(`  report: ${result.reportRenamed}`);
    else if (result.reportPath) console.log(`  report: ${result.reportPath}`);
  }

  process.exitCode = passed ? 0 : 1;
}

export { checkSourceStatus, checkSalaryProvenance, checkPostingFreshness, stripPartialSuffix, partialSuffixPath };

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(`[fatal] ${err.stack || err}`);
    process.exitCode = 2;
  });
}
