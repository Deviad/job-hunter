#!/usr/bin/env node
// jh-freshness.mjs — posting-age filter for the job-hunter pipeline.
// User policy (2026-07-21): a posting older than 30 days is treated as very
// likely stale/zombie/evergreen rather than a live opening, and is excluded
// from Apply-eligible lists by default. See
// references/search-safety-contract.md for the broader
// mechanism-over-prose principle this follows.
//
// Posting age is derived, in priority order, from:
//   1. jobs.job_posting_date when it parses as an ISO date (LinkedIn/Indeed
//      structured field).
//   2. jobs.job_posting_date when it is LinkedIn/Indeed relative text
//      ("3 days ago", "Reposted 4 days ago", "yesterday"), anchored to
//      jobs.created_at (the moment that text was scraped).
//   3. Otherwise: NO real signal exists. jobs.created_at is only a lower
//      bound on age (the job cannot be younger than when it was first
//      discovered) — it is never presented as the actual posting date.
//      A job whose created_at alone already exceeds the cutoff is dropped
//      as certainly stale; a job discovered within the cutoff but with no
//      further signal is kept and flagged "posting date unverified".
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DB_PATH as DEFAULT_DB_PATH } from './jh-common.mjs';

const DEFAULT_CUTOFF_DAYS = 30;

const RELATIVE_RE = /(?:reposted|posted)?\s*(\d+)\s*(minute|hour|day|week|month)s?\s*ago/i;
const MS_PER_UNIT = {
  minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 604_800_000, month: 2_592_000_000,
};

/**
 * Resolve posting age from the raw jobs.job_posting_date field and the row's
 * created_at (discovery) timestamp.
 * @param {string|null} rawPostingDate
 * @param {string} createdAt - SQLite CURRENT_TIMESTAMP text, "YYYY-MM-DD HH:MM:SS"
 * @param {Date} [now] - injectable for tests
 * @returns {{ ageDays: number|null, method: string, hasRealSignal: boolean, createdAgeDays: number }}
 */
export function resolvePostingAge(rawPostingDate, createdAt, now = new Date()) {
  const created = new Date(String(createdAt).replace(' ', 'T') + (String(createdAt).endsWith('Z') ? '' : 'Z'));
  const createdAgeDays = Math.round((now - created) / 86_400_000);

  if (rawPostingDate && /^\d{4}-\d{2}-\d{2}/.test(rawPostingDate)) {
    const d = new Date(rawPostingDate);
    if (!Number.isNaN(d.getTime())) {
      return { ageDays: Math.round((now - d) / 86_400_000), method: 'posting_date_iso', hasRealSignal: true, createdAgeDays };
    }
  }
  if (rawPostingDate) {
    const relMatch = rawPostingDate.match(RELATIVE_RE);
    if (relMatch) {
      const n = Number(relMatch[1]);
      const unit = relMatch[2].toLowerCase();
      const postedAt = new Date(created.getTime() - n * MS_PER_UNIT[unit]);
      return { ageDays: Math.round((now - postedAt) / 86_400_000), method: `relative_${unit}`, hasRealSignal: true, createdAgeDays };
    }
    if (/yesterday/i.test(rawPostingDate)) {
      const postedAt = new Date(created.getTime() - 86_400_000);
      return { ageDays: Math.round((now - postedAt) / 86_400_000), method: 'yesterday', hasRealSignal: true, createdAgeDays };
    }
  }
  return { ageDays: null, method: 'no_signal', hasRealSignal: false, createdAgeDays };
}

/**
 * Classify a single job row against the freshness cutoff.
 * @param {{ job_posting_date: string|null, created_at: string }} row
 * @param {number} cutoffDays
 * @param {Date} [now]
 * @returns {{ verdict: 'fresh'|'stale'|'unverified', ageDays: number|null, method: string }}
 */
export function classifyFreshness(row, cutoffDays = DEFAULT_CUTOFF_DAYS, now = new Date()) {
  const resolved = resolvePostingAge(row.job_posting_date, row.created_at, now);
  if (resolved.hasRealSignal) {
    return {
      verdict: resolved.ageDays <= cutoffDays ? 'fresh' : 'stale',
      ageDays: resolved.ageDays,
      method: resolved.method,
    };
  }
  // No real posting-date signal. The discovery date is a lower bound: if the
  // job is already older than the cutoff purely by discovery date, it cannot
  // possibly be fresher than that, so it is certainly stale.
  if (resolved.createdAgeDays > cutoffDays) {
    return { verdict: 'stale', ageDays: null, method: 'no_signal_but_discovery_exceeds_cutoff' };
  }
  return { verdict: 'unverified', ageDays: null, method: 'no_signal' };
}

/**
 * Filter a list of jobs (each with job_posting_date + created_at) by freshness.
 * @param {Array} jobs
 * @param {{ cutoffDays?: number, now?: Date, includeUnverified?: boolean }} [opts]
 * @returns {{ fresh: Array, stale: Array, unverified: Array }}
 */
export function filterByFreshness(jobs, opts = {}) {
  const cutoffDays = opts.cutoffDays ?? DEFAULT_CUTOFF_DAYS;
  const now = opts.now ?? new Date();
  const fresh = [];
  const stale = [];
  const unverified = [];
  for (const job of jobs) {
    const c = classifyFreshness(job, cutoffDays, now);
    const annotated = { ...job, freshness: c };
    if (c.verdict === 'fresh') fresh.push(annotated);
    else if (c.verdict === 'stale') stale.push(annotated);
    else unverified.push(annotated);
  }
  return { fresh, stale, unverified };
}

function usage(code = 0) {
  const out = code === 0 ? process.stdout : process.stderr;
  out.write(`Usage:
  jh-freshness.mjs --search-id <id> [--max-age-days 30] [--db path] [--json] [--include-unverified]

Filters an Apply-eligible job queue by posting age. Default cutoff is 30 days;
jobs older than that are treated as very likely stale/zombie postings and
excluded. Jobs with no posting-date signal at all are kept only if their
discovery date alone is within the cutoff, and are marked "unverified".

Options:
  --search-id <id>        match_results.search_id to filter (cta='Apply' rows only)
  --max-age-days <n>       cutoff in days, default 30
  --db <path>              SQLite DB (default ${DEFAULT_DB_PATH})
  --include-unverified     include jobs with no real posting-date signal (still labeled unverified)
  --json                   machine-readable output
`);
  process.exit(code);
}

function parseArgs(argv) {
  const o = { searchId: null, maxAgeDays: DEFAULT_CUTOFF_DAYS, db: process.env.JOBHUNTER_DB || DEFAULT_DB_PATH, includeUnverified: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} requires a value`);
      return argv[++i];
    };
    if (a === '--help' || a === '-h') usage(0);
    else if (a === '--search-id') o.searchId = next();
    else if (a === '--max-age-days') o.maxAgeDays = Number(next());
    else if (a === '--db') o.db = next();
    else if (a === '--include-unverified') o.includeUnverified = true;
    else if (a === '--json') o.json = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!o.searchId) usage(1);
  return o;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { createRequire } = await import('node:module');
  const { JOBHUNTER_HOME } = await import('./jh-common.mjs');
  const req = createRequire(path.join(JOBHUNTER_HOME, 'package.json'));
  const Database = req('better-sqlite3');
  const db = new Database(opts.db, { readonly: true });

  const rows = db.prepare(`
    SELECT j.source, j.job_id, j.title, j.company, j.country_code, j.job_posting_date, j.created_at, m.fit_score
    FROM jobs j
    JOIN match_results m ON m.source = j.source AND m.job_id = j.job_id
    WHERE m.search_id = ? AND m.cta = 'Apply'
    ORDER BY m.fit_score DESC
  `).all(opts.searchId);
  db.close();

  const { fresh, stale, unverified } = filterByFreshness(rows, { cutoffDays: opts.maxAgeDays });
  const kept = opts.includeUnverified ? [...fresh, ...unverified] : fresh;

  const result = {
    searchId: opts.searchId,
    cutoffDays: opts.maxAgeDays,
    total: rows.length,
    fresh: fresh.length,
    stale: stale.length,
    unverified: unverified.length,
    kept: kept.length,
    keptJobs: kept,
    staleJobs: stale,
  };

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Freshness filter for search_id=${opts.searchId} (cutoff=${opts.maxAgeDays}d): ${rows.length} total, ${fresh.length} fresh, ${stale.length} stale, ${unverified.length} unverified (no signal)`);
    console.log(`Kept: ${kept.length}${opts.includeUnverified ? ' (fresh + unverified)' : ' (fresh only)'}`);
    for (const j of stale) console.log(`  STALE (${j.freshness.ageDays ?? '>' + opts.maxAgeDays}d, ${j.freshness.method}): ${j.title} @ ${j.company}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(`[fatal] ${err.stack || err}`);
    process.exitCode = 2;
  });
}
