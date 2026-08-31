#!/usr/bin/env node
import { Database } from '../../job-hunter/scripts/workspace-dependencies.mjs';
// Phase v1.0-09 Plan 05 + Phase v1.0-10 Plan 04 — CLI entry point for salary enrichment.
//
// Two modes:
//   1. Single-job mode (v1.0-09): --source X --job-id Y → runs enrichOneJob once.
//   2. Batch mode (v1.0-10):      --all-unsalaried [--limit N] → iterates candidates.
//
// Glue layer. Opens the SQLite DB, acquires the writer lock ONCE (fail-fast),
// builds the adapter registry + httpClient, dispatches to runSingle or runBatch,
// releases the lock and closes the DB in a try/finally.
//
// =====================================================================
// EXIT CODE MATRIX (CLI-10) — MIRRORED FROM Plan 04 deriveExitCode
// =====================================================================
// The CLI consumes envelope.state.exitCode VERBATIM. The pipeline's
// deriveExitCode function (scripts/lib/enrich-pipeline.mjs) is the
// SINGLE SOURCE OF TRUTH. This comment block exists so reviewers can
// verify rule-table agreement at a grep level.
//
// | Condition                                                          | Exit |
// |--------------------------------------------------------------------|------|
// | event.kind === 'unrecoverable_error' (exact OR benchmark)          | 5    |
// | event.kind === 'transient_error' AND nextRetryAtIso === null       | 6    |
// | selectedBest !== null                                              | 0    |
// | selectedBest === null AND stateExact.status === 'not_found'        | 0    |
// | event.kind === 'transient_error' AND nextRetryAtIso !== null       | 0    |
// |                                                                    |      |
// | CLI-only exit codes (set BEFORE/AROUND enrichOneJob):              |      |
// | precondition failure (missing arg, unknown source, DB open fails,  | 2    |
// |   job row missing, invalid --limit, mutual-exclusion violation)    |      |
// | lock contention (handle.acquired === false)                        | 4    |
// | uncaught exception in main() try/catch                             | 1    |
// | per-job pipeline exception (batch-mode CLI try/catch)              | 7    |
//
// Batch exit-code aggregation rules (worst-case, never short-circuits):
//   5 if any per-job envelope.state.exitCode === 5  (unrecoverable from pipeline)
//   7 else if any per-job envelope.state.exitCode === 7  (per-job synthetic envelope: CLI try/catch around enrichOneJob)
//   6 else if any per-job envelope.state.exitCode === 6  (transient exhaustion)
//   0 otherwise (every job either succeeded or scheduled a future retry)
// CLI-level codes that short-circuit BEFORE the aggregator:
//   2 (preflight: argv validation), 4 (lock contention), 1 (CLI-level uncaught exception at top of main)
// Per-job exitCode is consumed VERBATIM from the envelope — no message-string parsing here
// (status routing already done by deriveExitCode in enrich-pipeline.mjs).
//
// CRITICAL: 'unrecoverable' (per locked CONTEXT decision) means
// 401/403/transient-exhaustion ONLY — NOT every failed attempt.
//
// EXPLICITLY FORBIDDEN at CLI layer (opencode improvement #5):
//   - String(err) substring tests against HTTP status digits (the literal three-digit forbidden strings)
//   - regex tests on err.message for status-code digits
//   - Any logic that overrides envelope.state.exitCode based on error message content
// =====================================================================

import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

import {
  acquire,
  makeIdentity,
  formatContentionMessage,
  installSignalHandlers,
} from './lib/writer-lock.mjs';
import { createHttpClient } from './http-client.mjs';
import { enrichOneJob } from './lib/enrich-pipeline.mjs';
import {
  selectBatchCandidates,
  selectBatchCandidatesForceRetry,
  countBatchCandidates,
  countBatchCandidatesForceRetry,
  getCurrent30DayHitRates,
  getPrior30DayHitRates,
} from './lib/salary-db.mjs';
import { forceResetAxis } from './lib/enrichment-state.mjs';
import { evaluateHealth } from './lib/health-metrics.mjs';
import * as linkedin from './sources/linkedin.mjs';
import * as itjobswatch from './sources/itjobswatch.mjs';
import * as indeed from './sources/indeed.mjs';
import * as levelsFyi from './sources/levels_fyi.mjs';
import * as robertHalf from './sources/robert_half.mjs';
import * as salaryexpert from './sources/salaryexpert.mjs';

const ADAPTERS = {
  linkedin,
  itjobswatch,
  indeed,
  levels_fyi: levelsFyi,
  robert_half: robertHalf,
  salaryexpert,
};

/**
 * Build the options object passed to createHttpClient. Exported so tests can
 * import the production source-of-truth for per-host limits wiring without
 * spawning the CLI.
 *
 * Host keys must be the literal URL host strings (URL(url).host returns the
 * full host including the www. prefix). Adapter `.limits` objects supply
 * per-host overrides; unlisted hosts inherit the top-level perHostRps default
 * via the merge semantics in http-client.mjs createHttpClient().
 *
 * @returns {object} Options ready for createHttpClient()
 */
export function buildHttpClientOptions() {
  return {
    perHostRps: 0.5,
    maxConcurrent: 1,
    maxRetries: 3,
    limits: {
      'www.linkedin.com':      linkedin.limits,
      'www.itjobswatch.co.uk': itjobswatch.limits,
      'ie.indeed.com':         indeed.limits,
      'uk.indeed.com':         indeed.limits,
      'www.indeed.com':        indeed.limits,
      'ca.indeed.com':         indeed.limits,
      'au.indeed.com':         indeed.limits,
      'ch.indeed.com':         indeed.limits,
      'ae.indeed.com':         indeed.limits,
      'de.indeed.com':         indeed.limits,
      'fr.indeed.com':         indeed.limits,
      'nl.indeed.com':         indeed.limits,
      'es.indeed.com':         indeed.limits,
      'it.indeed.com':         indeed.limits,
      'www.levels.fyi':        levelsFyi.limits,
      'www.roberthalf.com':    robertHalf.limits,
      'www.salaryexpert.com':  salaryexpert.limits,
    },
  };
}

// Canonical source list for KNOWN_SOURCES backfill in the --health report.
// SQL aggregates GROUP BY job_source so zero-observation sources are absent
// from raw SQL output; the CLI layer backfills with no_data rows so the
// operator always sees a row per supported adapter (HEALTH-03 contract).
const KNOWN_SOURCES = ['linkedin', 'itjobswatch', 'indeed', 'levels_fyi', 'robert_half', 'salaryexpert'];

// =====================================================================
// FAKE BENCHMARK ADAPTER (test-only)
// =====================================================================
// When ENRICH_FAKE_BENCHMARK is set, the CLI overlays a stub benchmark
// adapter onto the registry that returns a canned benchmark payload
// WITHOUT a network call. Used by CLI-03 / CLI-06 integration tests so
// the salary_benchmarks cache can be observed end-to-end without
// depending on the live ITJobsWatch endpoint. Production runs leave it
// unset and use the real adapter.
function buildFakeBenchmarkOverlay(baseAdapters) {
  if (!process.env.ENRICH_FAKE_BENCHMARK) return baseAdapters;
  const fakeItjobswatch = {
    ...itjobswatch,
    supports: { exactSalary: false, benchmark: true },
    async fetchBenchmark(query, _ctx) {
      return {
        normalizedTitle: query.normalizedTitle || query.title || 'software_engineer',
        seniority: query.seniority || 'unknown',
        industry: query.industry || 'unknown',
        countryCode: query.countryCode || 'GB',
        region: query.region || '',
        city: query.city || '',
        currency: 'GBP',
        period: 'year',
        compensationType: 'base_salary',
        dataSource: 'itjobswatch',
        dataSourceUrl: 'https://fake.test/benchmark',
        rawTitle: query.title || 'Software Engineer',
        amountMin: 50000,
        amountMax: 80000,
        amountMedian: 65000,
        amountP10: 45000,
        amountP90: 90000,
        sampleSize: 100,
        confidenceScore: null,
        rawPayloadJson: JSON.stringify({ fake: true, query }),
        fetchedAt: new Date().toISOString(),
        normalizerVersion: 'fake-1',
      };
    },
  };
  return { ...baseAdapters, itjobswatch: fakeItjobswatch };
}
// =====================================================================

const USAGE = `Usage:
  Single-job mode:
    node scripts/enrich-job-salary.mjs --db <path> --source <s> --job-id <id> [flags]
  Batch mode:
    node scripts/enrich-job-salary.mjs --db <path> --all-unsalaried [--limit N] [flags]

Required (one mode):
  --db <path>               Path to jobhunter.sqlite
  --source <s>              Adapter name (linkedin, itjobswatch, indeed, levels_fyi, robert_half, salaryexpert) — single-job mode
  --job-id <id>             jobs.job_id value — single-job mode
  --all-unsalaried          Batch mode: iterate unsalaried candidates

Operational flags (Phase v1.0-10):
  --limit N                 Batch size (default 50, max 100); ignored in single-job mode
  --benchmark-only          Skip exact pass entirely; only fetch/refresh benchmark
  --refresh-benchmarks      Force benchmark cache refresh (bypass isBenchmarkStale)
  --force-exact-retry       Reset exact axis to pending per-job before run
  --force-benchmark-retry   Reset benchmark axis to pending per-job + force refresh

Other:
  --dry-run                 Acquire lock + fetch + parse + select but skip DB writes
  --verbose                 Multi-line text output (single-job mode)
  --json                    Emit JSON envelope(s) on stdout; NDJSON in batch mode
  --help                    Show this help and exit
`;

function buildErrorEnvelope({ exitCode, error, dryRun = false }) {
  return {
    job: null,
    observations: [],
    selectedBest: null,
    benchmarkUsed: null,
    state: {
      exact: null,
      benchmark: null,
      dryRun: !!dryRun,
      exitCode,
      error,
    },
  };
}

function retryClause(nextRetryAtIso) {
  return nextRetryAtIso
    ? `next retry ${String(nextRetryAtIso).slice(0, 10)}`
    : 'no further retries (manual)';
}

function formatRange(obs) {
  if (!obs) return '';
  const cur = obs.currency ?? '';
  if (obs.amount_min != null && obs.amount_max != null) {
    return `${cur} ${obs.amount_min}–${obs.amount_max}`.trim();
  }
  if (obs.amount_single != null) {
    return `${cur} ${obs.amount_single}`.trim();
  }
  if (obs.amount_median != null) {
    return `${cur} ~${obs.amount_median}`.trim();
  }
  if (obs.annualized_value != null) {
    return `${cur} ~${obs.annualized_value}`.trim();
  }
  return cur;
}

function renderSingleLine(envelope) {
  const job = envelope.job ?? {};
  const source = job.source ?? '?';
  const jobId = job.job_id ?? '?';
  const sb = envelope.selectedBest;

  if (sb === null || sb === undefined) {
    const exact = envelope.state?.exact;
    if (exact?.status === 'not_found') {
      return `No salary found (${source} ${jobId}) — ${retryClause(exact.next_retry_at)}`;
    }
    if (exact?.status === 'error') {
      return `Error fetching ${source} ${jobId}: ${exact.error || 'unknown'} — ${retryClause(exact.next_retry_at)}`;
    }
    return `No salary found (${source} ${jobId})`;
  }

  if (sb.is_posted_salary === 1) {
    return `Posted salary ${formatRange(sb)} (${source} ${jobId})`;
  }
  const benchmark = envelope.benchmarkUsed || sb.benchmark_id || 'unknown';
  return `Best estimate ${formatRange(sb)} (${source} ${jobId} benchmark=${benchmark})`;
}

function renderVerbose(envelope) {
  const lines = [];
  const job = envelope.job ?? {};
  lines.push(`Job: ${job.source ?? '?'} ${job.job_id ?? '?'} — ${job.title ?? ''} @ ${job.company ?? ''}`);
  if (job.url) lines.push(`URL: ${job.url}`);

  const exact = envelope.state?.exact;
  if (exact) {
    lines.push(`Exact: status=${exact.status} attempts=${exact.attempt_count} ${retryClause(exact.next_retry_at)}`);
    if (exact.error) lines.push(`  error: ${exact.error}`);
  }
  const benchmark = envelope.state?.benchmark;
  if (benchmark) {
    lines.push(`Benchmark: status=${benchmark.status} attempts=${benchmark.attempt_count} ${retryClause(benchmark.next_retry_at)}`);
    if (benchmark.error) lines.push(`  error: ${benchmark.error}`);
  }

  const sb = envelope.selectedBest;
  if (sb === null || sb === undefined) {
    if (exact?.status === 'not_found') {
      lines.push(`Selected: No salary found`);
    } else if (exact?.status === 'error') {
      lines.push(`Selected: Error fetching: ${exact.error || 'unknown'}`);
    } else {
      lines.push(`Selected: No salary found`);
    }
  } else if (sb.is_posted_salary === 1) {
    lines.push(`Selected: Posted salary ${formatRange(sb)}`);
  } else {
    const bm = envelope.benchmarkUsed || sb.benchmark_id || 'unknown';
    lines.push(`Selected: Best estimate ${formatRange(sb)} benchmark=${bm}`);
  }

  lines.push(`Observations: ${envelope.observations?.length ?? 0}`);
  lines.push(`Dry-run: ${envelope.state?.dryRun ? 'yes' : 'no'}`);
  lines.push(`Exit code: ${envelope.state?.exitCode ?? 0}`);
  return lines.join('\n');
}

// =====================================================================
// FAKE OUTCOMES INJECTION (test-only)
// =====================================================================
// When ENRICH_FAKE_OUTCOMES is set (csv list, one outcome per candidate),
// the CLI synthesizes per-job envelopes WITHOUT calling enrichOneJob —
// used by integration tests to deterministically exercise exit-code
// aggregation paths (5/6/7 priorities). Production runs leave it unset.
//
// Supported outcomes: success, not_found, unrecoverable, transient_exhausted,
//                     transient_scheduled, pipeline_throw
function getFakeOutcomes() {
  const raw = process.env.ENRICH_FAKE_OUTCOMES;
  if (!raw) return null;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function fakeEnvelopeFor(outcome, candidate) {
  const job = {
    source: candidate.source,
    job_id: candidate.job_id,
    title: candidate.title,
    company: candidate.company,
  };
  const base = {
    job,
    observations: [],
    selectedBest: null,
    benchmarkUsed: null,
    state: {
      exact: { status: 'pending', attempt_count: 0, next_retry_at: null, error: null, last_attempt_at: null },
      benchmark: null,
      dryRun: false,
      exitCode: 0,
    },
  };
  switch (outcome) {
    case 'success':
      base.selectedBest = { is_posted_salary: 1, currency: 'GBP', amount_median: 50000 };
      base.state.exact.status = 'found';
      base.state.exitCode = 0;
      return base;
    case 'not_found':
      base.state.exact.status = 'not_found';
      base.state.exitCode = 0;
      return base;
    case 'unrecoverable':
      base.state.exact.status = 'error';
      base.state.exact.error = 'unrecoverable (fake)';
      base.state.exitCode = 5;
      return base;
    case 'transient_exhausted':
      base.state.exact.status = 'error';
      base.state.exact.error = 'transient exhausted (fake)';
      base.state.exitCode = 6;
      return base;
    case 'transient_scheduled':
      base.state.exact.status = 'error';
      base.state.exact.error = 'transient scheduled (fake)';
      base.state.exact.next_retry_at = '2099-01-01T00:00:00.000Z';
      base.state.exitCode = 0;
      return base;
    case 'pipeline_throw':
      // Simulate the CLI try/catch around enrichOneJob synthesising a 7-envelope.
      throw new Error('pipeline throw (fake)');
    default:
      base.state.exact.status = 'error';
      base.state.exact.error = `unknown fake outcome '${outcome}'`;
      base.state.exitCode = 5;
      return base;
  }
}
// =====================================================================

// =====================================================================
// HEALTH REPORT (Phase v1.0-11 — HEALTH-02 / HEALTH-03)
// =====================================================================
// Read-only parser hit-rate report per job_source over the trailing 30
// complete days (today excluded). Read-only path — dispatched BEFORE
// writer-lock acquisition. Two concurrent --health invocations both
// succeed (proof: cli-health-flag.test.mjs subtest 4 via async spawn +
// Promise.all).
//
// Locked 4-state taxonomy: ok / warning / no_data / insufficient_baseline.
// No degradation-state literal anywhere in the envelope vocabulary.

function formatPct(rate) {
  if (rate === null || rate === undefined) return '-';
  return `${(rate * 100).toFixed(1)}%`;
}

function formatDeltaPct(delta) {
  if (delta === null || delta === undefined) return '-';
  const sign = delta >= 0 ? '+' : '';
  return `${sign}${delta.toFixed(1)}%`;
}

function renderHealthText(envelope) {
  const lines = [];
  lines.push('Source         Obs(30d)  Current  Prior   Delta   State');
  lines.push('-------------  --------  -------  ------  ------  ----------------------');
  for (const row of envelope.sources) {
    const src = String(row.source).padEnd(13, ' ');
    const obs = String(row.observations_last_30d).padStart(8, ' ');
    const cur = formatPct(row.hit_rate_current).padStart(7, ' ');
    const prior = formatPct(row.hit_rate_prior).padStart(6, ' ');
    const delta = formatDeltaPct(row.delta_pct).padStart(6, ' ');
    const stateSuffix = row.warning ? ' ⚠' : '';
    lines.push(`${src}  ${obs}  ${cur}  ${prior}  ${delta}  ${row.state}${stateSuffix}`);
  }
  lines.push(`Generated: ${envelope.generated_at}`);
  return lines.join('\n');
}

async function runHealth({ db, json }) {
  const currentRows = getCurrent30DayHitRates({ db });
  const priorRows = getPrior30DayHitRates({ db });

  const currentBySource = new Map(currentRows.map((r) => [r.job_source, r]));
  const priorBySource = new Map(priorRows.map((r) => [r.job_source, r]));

  // KNOWN_SOURCES backfill: every supported adapter gets a row even when
  // the raw SQL output is empty for that source. Deterministic sort.
  const sortedSources = [...KNOWN_SOURCES].sort();
  const rows = sortedSources.map((src) => {
    const current = currentBySource.get(src) || { job_source: src, total: 0, hits: 0 };
    const prior = priorBySource.get(src) || { job_source: src, total: 0, hits: 0 };
    const health = evaluateHealth({
      current: { total: current.total, hits: current.hits },
      prior: { total: prior.total, hits: prior.hits },
    });
    return {
      source: src,
      observations_last_30d: current.total,
      hit_rate_current: health.hit_rate_current,
      hit_rate_prior: health.hit_rate_prior,
      delta_pct: health.delta_pct,
      warning: health.warning,
      state: health.state,
    };
  });

  const envelope = {
    type: 'health',
    generated_at: new Date().toISOString(),
    sources: rows,
  };

  if (json) {
    process.stdout.write(`${JSON.stringify(envelope)}\n`);
  } else {
    process.stdout.write(`${renderHealthText(envelope)}\n`);
  }
  // Locked CONTEXT: --health always exits 0; warning state surfaces via
  // the warning flag + state literal in the envelope, not the exit code.
  return 0;
}
// =====================================================================

function parseAndValidateArgs() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        db:                       { type: 'string' },
        source:                   { type: 'string' },
        'job-id':                 { type: 'string' },
        'dry-run':                { type: 'boolean', default: false },
        verbose:                  { type: 'boolean', default: false },
        json:                     { type: 'boolean', default: false },
        help:                     { type: 'boolean', default: false },
        // v1.0-10 batch + operational flags
        'all-unsalaried':         { type: 'boolean', default: false },
        limit:                    { type: 'string',  default: '50' },
        'benchmark-only':         { type: 'boolean', default: false },
        'refresh-benchmarks':     { type: 'boolean', default: false },
        'force-exact-retry':      { type: 'boolean', default: false },
        'force-benchmark-retry':  { type: 'boolean', default: false },
        // v1.0-11 health-metrics flag. Read-only report path; does NOT
        // acquire the writer-lock. NOTE: a `--days N` override was
        // explicitly deferred (locked CONTEXT discretion) — the SQL
        // queries are hardcoded 30/60-day literals. Registering `days`
        // here under strict:true would silently accept the flag without
        // effect AND mask unknown-flag typo errors. Keep this block
        // minimal: only `health` is added in this phase.
        health:                   { type: 'boolean', default: false },
      },
      strict: true,
    }));
  } catch (err) {
    return { error: err.message, values: null };
  }
  return { error: null, values };
}

function preconditionFail(msg, values) {
  process.stderr.write(`${msg}\n`);
  if (values?.json) {
    process.stdout.write(
      JSON.stringify(buildErrorEnvelope({ exitCode: 2, error: msg, dryRun: values['dry-run'] })) + '\n',
    );
  }
  process.exit(2);
}

async function runSingle({ db, values, adapters, httpClient, handle }) {
  const source = values.source;
  const jobId = values['job-id'];

  // Operational flags: per-axis pre-run reset (single-job variant — mirrors batch path).
  if (values['force-exact-retry'])     forceResetAxis(db, source, jobId, 'exact');
  if (values['force-benchmark-retry']) forceResetAxis(db, source, jobId, 'benchmark');

  const skipExact             = values['benchmark-only'];
  // IMPROVEMENT 1: include --force-benchmark-retry in the forceBenchmarkRefresh derivation
  // so forceResetAxis('benchmark') isn't a no-op for fresh cached entries.
  const forceBenchmarkRefresh = values['benchmark-only'] || values['refresh-benchmarks'] || values['force-benchmark-retry'];
  const progress = (msg) => process.stderr.write(`${msg}\n`);

  const envelope = await enrichOneJob({
    db,
    source,
    jobId,
    adapterRegistry: adapters,
    dryRun: values['dry-run'],
    nowIso: new Date().toISOString(),
    httpClient,
    enableBenchmark: true,
    skipExact,
    forceBenchmarkRefresh,
    progress,
  });

  if (values.json) {
    process.stdout.write(JSON.stringify(envelope) + '\n');
  } else {
    const text = values.verbose ? renderVerbose(envelope) : renderSingleLine(envelope);
    process.stdout.write(`${text}\n`);
  }

  return envelope.state?.exitCode ?? 0;
}

async function runBatch({ db, values, adapters, httpClient }) {
  const limit = Number.parseInt(values.limit, 10);
  const forceExactRetry      = values['force-exact-retry'];
  const forceBenchmarkRetry  = values['force-benchmark-retry'];
  const skipExact            = values['benchmark-only'];
  // IMPROVEMENT 1: include --force-benchmark-retry. Mirrors runSingle.
  const forceBenchmarkRefresh = values['benchmark-only'] || values['refresh-benchmarks'] || values['force-benchmark-retry'];

  // Step 2: pick query + capture pre-batch total for more_eligible math.
  // Snapshotting the count BEFORE the batch is necessary because --dry-run does not
  // mutate retry state, so a post-batch count would equal the pre-batch count and
  // give the wrong more_eligible (60 instead of 10 for a 60-jobs / limit-50 dry run).
  const totalEligibleBefore = forceExactRetry
    ? countBatchCandidatesForceRetry({ db })
    : countBatchCandidates({ db });
  const candidates = forceExactRetry
    ? selectBatchCandidatesForceRetry({ db, limit })
    : selectBatchCandidates({ db, limit });

  // Step 5: per-job loop
  const results = [];
  const fakeOutcomes = getFakeOutcomes(); // test-only synthesis path

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];

    if (forceExactRetry)     forceResetAxis(db, c.source, c.job_id, 'exact');
    if (forceBenchmarkRetry) forceResetAxis(db, c.source, c.job_id, 'benchmark');

    let envelope;
    try {
      if (fakeOutcomes) {
        const outcome = fakeOutcomes[i] ?? 'success';
        envelope = fakeEnvelopeFor(outcome, c);
      } else {
        envelope = await enrichOneJob({
          db,
          source: c.source,
          jobId: c.job_id,
          adapterRegistry: adapters,
          dryRun: values['dry-run'],
          nowIso: new Date().toISOString(),
          httpClient,
          enableBenchmark: true,
          skipExact,
          forceBenchmarkRefresh,
          progress: (msg) => process.stderr.write(`  ${msg}\n`),
        });
      }
    } catch (err) {
      // IMPROVEMENT 4: per-job CLI-level try/catch around enrichOneJob.
      // Use a DEDICATED exit code 7 (NOT 1) to distinguish this synthesised
      // failure from a CLI-level uncaught exception (which would never reach
      // this aggregator — it terminates the process at the top level).
      envelope = buildErrorEnvelope({ exitCode: 7, error: err.message, dryRun: values['dry-run'] });
      envelope.job = { source: c.source, job_id: c.job_id };
    }

    results.push(envelope);

    // Per-job emission
    if (values.json) {
      process.stdout.write(JSON.stringify(envelope) + '\n');
    }
    // stderr post-line with terminal status
    const status = envelope.state?.exact?.status
      ?? (envelope.state?.exitCode === 5 ? 'unrecoverable'
        : envelope.state?.exitCode === 7 ? 'pipeline_exception'
        : '?');
    process.stderr.write(`[${i + 1}/${candidates.length}] ${c.source}/${c.job_id} ${status}\n`);
  }

  // Step 6: aggregate exit code (worst-case, NEVER short-circuits).
  // IMPROVEMENT 4: priority 5 > 7 > 6 > 0.
  const anyUnrecoverable     = results.some(e => e.state?.exitCode === 5);
  const anyPipelineException = results.some(e => e.state?.exitCode === 7);
  const anyTransientExhaust  = results.some(e => e.state?.exitCode === 6);
  const batchExitCode = anyUnrecoverable     ? 5
                      : anyPipelineException ? 7
                      : anyTransientExhaust  ? 6
                      : 0;

  // Step 7: more_eligible — `totalEligibleBefore - results.length` (RESEARCH `count - selected`).
  // IMPROVEMENT 2: BATCH-01 vs BATCH-03 semantics.
  //   BATCH-01 (default --all-unsalaried): processed rows advance state and drop out of
  //     the eligible set, so this count equals "what the NEXT run would pick up".
  //   BATCH-03 (--force-exact-retry): per-job pre-run reset puts each row back to 'pending'.
  //     A transient/recoverable job that fails THIS run is reset to pending again on the
  //     next run, so it remains in the count. Documented divergence from `count - selected`.
  //   Implementation uses PRE-batch count minus selected to correctly handle --dry-run
  //   (where state isn't mutated and a post-batch count would equal the pre-batch count).
  //   This matches the contract from cli-batch-mode "60 jobs / limit 50 / dry-run → 10".
  const moreEligible = Math.max(0, totalEligibleBefore - results.length);

  // Step 8: summary
  const summary = {
    total: results.length,
    found:               results.filter(e => e.state?.exact?.status === 'found').length,
    not_found:           results.filter(e => e.state?.exact?.status === 'not_found').length,
    error:               results.filter(e => e.state?.exact?.status === 'error' && e.state?.exitCode !== 5 && e.state?.exitCode !== 6 && e.state?.exitCode !== 7).length,
    unrecoverable:       results.filter(e => e.state?.exitCode === 5).length,
    transient_exhausted: results.filter(e => e.state?.exitCode === 6).length,
    pipeline_exception:  results.filter(e => e.state?.exitCode === 7).length,
    more_eligible:       moreEligible,
  };

  if (values.json) {
    process.stdout.write(JSON.stringify({ summary }) + '\n');
  } else {
    process.stderr.write(
      `Summary: total=${summary.total} found=${summary.found} not_found=${summary.not_found} ` +
      `error=${summary.error} unrecoverable=${summary.unrecoverable} ` +
      `transient_exhausted=${summary.transient_exhausted} pipeline_exception=${summary.pipeline_exception} ` +
      `more_eligible=${summary.more_eligible}\n`,
    );
  }

  return batchExitCode;
}

async function main() {
  // 1. parseArgs
  const parsed = parseAndValidateArgs();
  if (parsed.error) {
    process.stderr.write(`Error: ${parsed.error}\n`);
    process.stderr.write(USAGE);
    process.exit(2);
  }
  const values = parsed.values;

  if (values.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  // ==== Preflight validation (exit 2 — BEFORE writer-lock acquisition) ====

  if (!values.db) {
    const jh = process.env.JOBHUNTER_HOME || `${process.env.HOME}/.job-hunter`;
    values.db = process.env.JOBHUNTER_DB || `${jh}/jobhunter.sqlite`;
  }

  // --health early dispatch — BEFORE the single/batch precondition gates and
  // BEFORE the writer-lock acquire. Read-only path. The early process.exit
  // pattern STRUCTURALLY guarantees no lock acquisition for --health.
  if (values.health) {
    if (values.source || values['job-id'] || values['all-unsalaried']) {
      const msg = 'Error: --health is mutually exclusive with --source/--job-id/--all-unsalaried';
      process.stderr.write(`${msg}\n`);
      if (values.json) {
        process.stdout.write(`${JSON.stringify({ error: msg })}\n`);
      }
      process.exit(2);
    }
    // Use the existing `Database` import from 'better-sqlite3' (line 55) per
    // the precedent at line 583 (writer-lock path). No wrapper helper
    // exists in scripts/lib/salary-db.mjs — do not invent one.
    let dbForHealth;
    try {
      dbForHealth = new Database(values.db);
      dbForHealth.pragma('foreign_keys = ON');
    } catch (err) {
      const msg = `Error: cannot open database ${values.db}: ${err.message}`;
      process.stderr.write(`${msg}\n`);
      if (values.json) {
        process.stdout.write(`${JSON.stringify({ error: msg })}\n`);
      }
      process.exit(2);
    }
    try {
      const exit = await runHealth({ db: dbForHealth, json: values.json });
      process.exit(exit);
    } finally {
      try { dbForHealth.close(); } catch { /* best-effort */ }
    }
  }

  const batchMode = values['all-unsalaried'];
  const singleSpec = !!(values.source || values['job-id']);

  // Mode mutual exclusivity
  if (batchMode && singleSpec) {
    preconditionFail('Error: --all-unsalaried is mutually exclusive with --source/--job-id', values);
  }
  if (!batchMode && !singleSpec) {
    preconditionFail('Error: specify either --all-unsalaried or both --source and --job-id', values);
  }
  if (!batchMode) {
    if (!values.source) preconditionFail('Error: --source is required', values);
    if (!values['job-id']) preconditionFail('Error: --job-id is required', values);
    if (!ADAPTERS[values.source]) {
      preconditionFail(`Error: unknown source: ${values.source} (known: linkedin, itjobswatch)`, values);
    }
  }

  // --limit numeric validation (Pitfall 7): always validated regardless of mode;
  // silently no-op in single-job mode rather than reject — explicit-vs-default detection
  // isn't reliable across --limit 50 and --limit=50 forms.
  const limitInt = Number.parseInt(values.limit, 10);
  if (
    !Number.isInteger(limitInt) ||
    String(limitInt) !== String(values.limit) ||
    limitInt < 1 ||
    limitInt > 100
  ) {
    preconditionFail(
      `Error: --limit must be a positive integer between 1 and 100; got '${values.limit}'`,
      values,
    );
  }

  // Flag combination contradictions
  if (values['benchmark-only'] && values['force-exact-retry']) {
    preconditionFail(
      'Error: --benchmark-only cannot be combined with --force-exact-retry (skipping exact while forcing exact retry is incoherent)',
      values,
    );
  }

  // 2. open DB
  let db;
  try {
    db = new Database(values.db);
    db.pragma('foreign_keys = ON');
  } catch (err) {
    const msg = `Error: cannot open database ${values.db}: ${err.message}`;
    process.stderr.write(`${msg}\n`);
    if (values.json) {
      process.stdout.write(
        JSON.stringify(buildErrorEnvelope({ exitCode: 2, error: err.message, dryRun: values['dry-run'] })) + '\n',
      );
    }
    process.exit(2);
  }

  // Single-job mode: verify the job row exists BEFORE acquiring the lock
  // (precondition exit 2 takes precedence over exit 4 contention).
  if (!batchMode) {
    let jobExists;
    try {
      jobExists = db
        .prepare('SELECT 1 FROM jobs WHERE source = ? AND job_id = ?')
        .get(values.source, values['job-id']);
    } catch (err) {
      const msg = `Error: cannot query jobs table: ${err.message}`;
      process.stderr.write(`${msg}\n`);
      if (values.json) {
        process.stdout.write(
          JSON.stringify(buildErrorEnvelope({ exitCode: 2, error: err.message, dryRun: values['dry-run'] })) + '\n',
        );
      }
      try { db.close(); } catch { /* best-effort */ }
      process.exit(2);
    }
    if (!jobExists) {
      const msg = `Error: job not found: source=${values.source} job_id=${values['job-id']}`;
      process.stderr.write(`${msg}\n`);
      if (values.json) {
        process.stdout.write(
          JSON.stringify(buildErrorEnvelope({ exitCode: 2, error: 'job not found', dryRun: values['dry-run'] })) + '\n',
        );
      }
      try { db.close(); } catch { /* best-effort */ }
      process.exit(2);
    }
  }

  // 3. acquire lock ONCE (fail-fast — no polling, no --wait). Held across the
  // entire batch in batch mode; released in try/finally below.
  const identity = makeIdentity();
  const handle = acquire(db, identity);
  if (!handle.acquired) {
    const msg = formatContentionMessage(handle.holder);
    process.stderr.write(`${msg}\n`);
    if (values.json) {
      process.stdout.write(
        JSON.stringify(buildErrorEnvelope({ exitCode: 4, error: msg, dryRun: values['dry-run'] })) + '\n',
      );
    }
    try { db.close(); } catch { /* best-effort */ }
    process.exit(4);
  }
  const uninstall = installSignalHandlers(handle);
  handle.startHeartbeat();

  let exitCode = 0;
  try {
    // 4. build httpClient
    const httpClient = createHttpClient(buildHttpClientOptions());

    // 5. dispatch — branch on --all-unsalaried AFTER lock acquisition
    const adapters = buildFakeBenchmarkOverlay(ADAPTERS);
    if (batchMode) {
      exitCode = await runBatch({ db, values, adapters, httpClient });
    } else {
      exitCode = await runSingle({ db, values, adapters, httpClient, handle });
    }
  } catch (err) {
    process.stderr.write(`Unexpected error: ${err.stack || err.message}\n`);
    if (values.json) {
      process.stdout.write(
        JSON.stringify(buildErrorEnvelope({ exitCode: 1, error: err.message, dryRun: values['dry-run'] })) + '\n',
      );
    }
    exitCode = 1;
  } finally {
    try { handle.release(); } catch { /* best-effort */ }
    try { uninstall(); } catch { /* best-effort */ }
    try { db.close(); } catch { /* best-effort */ }
  }

  process.exit(exitCode);
}

// Run main() only when this file is executed as a CLI script, not when imported.
// This lets tests import buildHttpClientOptions() (and other helpers) without
// spawning the CLI, which would open SQLite, parse argv, install signal handlers, etc.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
