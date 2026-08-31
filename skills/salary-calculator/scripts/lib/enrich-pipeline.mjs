// Phase v1.0-09 Plan 04 — Pipeline orchestrator.
//
// Single export: enrichOneJob({db, source, jobId, adapterRegistry, dryRun, nowIso, httpClient}).
// Pure in-process orchestrator. Caller (Plan 05 CLI) is responsible for the
// salary_writer_lock + argv parsing + exit-code → process.exit translation.
//
// Pipeline stages (in order):
//   0. Initialize envelope skeleton (RESEARCH Pitfall #6 — partial failures still parse).
//   1. Adapter lookup (unknown source → exit 2 via envelope).
//   2. LOAD job row (not found → exit 2 via envelope).
//   3. Read prior enrichment state (defaults if absent).
//   4. EXACT pass via adapter.fetchExactSalary → classifyError → computeNextRetry → applyRetryTransition.
//   5. SELECT best from observations.
//   6. BENCHMARK pass (only when selectedBest is null OR is an estimate already)
//        → findLatestBenchmark → isBenchmarkStale → benchmarkAdapter.fetchBenchmark
//        → storeBenchmarkSnapshot → insert estimate observation → applyRetryTransition.
//   7. Re-read + re-select after benchmark pass.
//   8. Build envelope.state from fresh row (or projected dryRun row) + deriveExitCode.
//
// HEALTH-01: both shapeObservationFromCandidate and shapeEstimateObservation
// populate evidence_snippet + raw_payload_json non-null.
//
// EXIT CODE DERIVATION (opencode improvement #5): deriveExitCode operates on
// STRUCTURED inputs only (event.kind, transition.nextRetryAtIso) — never parses
// error message strings for status substrings.
//
// PURITY: nowIso is INJECTED by the caller; this module performs no wall-clock reads.

import { insertObservation, getObservationsByJob } from './salary-db.mjs';
import { selectBestObservation } from './salary-selector.mjs';
import {
  findLatestBenchmark,
  storeBenchmarkSnapshot,
  isBenchmarkStale,
} from './benchmark-cache.mjs';
import {
  normalizeTitle,
  normalizeSeniority,
  normalizeIndustry,
  NORMALIZER_VERSION,
} from './normalizers.mjs';
import { benchmarkSourcesForCountry } from './source-priority.mjs';
import { applyRetryTransition, getEnrichmentState } from './enrichment-state.mjs';
import { computeNextRetry, classifyError } from './retry-state-machine.mjs';

const EXPECTED_CURRENCY_BY_COUNTRY = Object.freeze({
  GB: 'GBP',
  US: 'USD',
  CH: 'CHF',
  AE: 'AED',
  CA: 'CAD',
  AU: 'AUD',
  DE: 'EUR',
  FR: 'EUR',
  NL: 'EUR',
  IE: 'EUR',
  ES: 'EUR',
  IT: 'EUR',
});

const BENCHMARK_MAX_AGE_DAYS = 30;

export function expectedCurrencyFor(countryCode) {
  if (!countryCode) return undefined;
  return EXPECTED_CURRENCY_BY_COUNTRY[countryCode];
}

/**
 * Enrich one saved job by orchestrating exact + benchmark passes through the
 * retry state machine. Returns an envelope object regardless of outcome.
 *
 * @param {object} args
 * @param {import('better-sqlite3').Database} args.db
 * @param {string} args.source
 * @param {string} args.jobId
 * @param {object} args.adapterRegistry  - { linkedin: adapter, itjobswatch: adapter, ... }
 * @param {boolean} args.dryRun
 * @param {string} args.nowIso
 * @param {object} [args.httpClient]
 * @param {(msg:string)=>void} [args.progress]
 * @param {boolean} [args.skipExact=false] - CLI-04 (--benchmark-only): skip stage 4 entirely.
 *   When true, the pipeline does NOT call adapter.fetchExactSalary, does NOT insert any
 *   is_posted_salary=1 observation, and does NOT touch exact_status. The exact axis state
 *   remains at its prior persisted value.
 * @param {boolean} [args.forceBenchmarkRefresh=false] - CLI-03 (--refresh-benchmarks):
 *   bypass the isBenchmarkStale early-return; always re-fetch the benchmark and refresh
 *   the salary_benchmarks cache. INVARIANT: if an exact observation already exists for the
 *   job, the benchmark cache is refreshed BUT no estimate observation is inserted into
 *   job_salary_observations (enforced via the split of shouldFetchBenchmark vs
 *   shouldInsertEstimateObs). This invariant lives at the pipeline level so it holds
 *   regardless of which CLI invokes enrichOneJob.
 * @returns {Promise<object>} envelope
 */
export async function enrichOneJob({
  db,
  source,
  jobId,
  adapterRegistry,
  dryRun,
  nowIso,
  httpClient,
  enableBenchmark = false,
  progress = () => {},
  // v1.0-10 batch-mode operational flags:
  skipExact = false,             // CLI-04: --benchmark-only — skip stage 4 + exact insert entirely.
  forceBenchmarkRefresh = false, // CLI-03: --refresh-benchmarks — bypass isBenchmarkStale.
}) {
  // 0. Initialize envelope skeleton (assigned upfront — partial failures parse).
  const envelope = {
    job: null,
    observations: [],
    selectedBest: null,
    benchmarkUsed: null,
    state: {
      exact: null,
      benchmark: null,
      dryRun: !!dryRun,
      exitCode: 0,
    },
  };

  // 1. Adapter lookup
  const adapter = adapterRegistry?.[source];
  if (!adapter) {
    envelope.state.exitCode = 2;
    envelope.state.exact = {
      status: 'pending',
      attempt_count: 0,
      next_retry_at: null,
      error: `unknown source: ${source}`,
      last_attempt_at: null,
    };
    return envelope;
  }

  // 2. LOAD job
  const jobRow = db
    .prepare('SELECT * FROM jobs WHERE source = ? AND job_id = ?')
    .get(source, jobId);
  if (!jobRow) {
    envelope.state.exitCode = 2;
    envelope.state.exact = {
      status: 'pending',
      attempt_count: 0,
      next_retry_at: null,
      error: 'job not found',
      last_attempt_at: null,
    };
    return envelope;
  }
  envelope.job = pickJobFields(jobRow);

  // 3. Prior enrichment state (defaults if absent)
  const priorState = getEnrichmentState(db, source, jobId) ?? defaultEnrichmentState();

  // 4. EXACT pass (if adapter supports it).
  // CLI-04 invariant: when skipExact=true (--benchmark-only), this entire stage
  // is bypassed — no adapter.fetchExactSalary call, no is_posted_salary=1 insert,
  // no applyRetryTransition('exact', ...). exactEvent stays null; the persisted
  // exact_status row is untouched. Stage 5 (SELECT) still runs so prior exact
  // observations are read for downstream selectedBest computation.
  let exactEvent = null;
  let exactTransition = null;
  if (!skipExact && adapter.supports?.exactSalary) {
    progress(`fetching exact: ${jobRow.url}`);
    let result;
    try {
      result = await adapter.fetchExactSalary(jobRow, { httpClient });
    } catch (err) {
      result = err;
    }
    exactEvent = classifyError(result);

    if (exactEvent.kind === 'success' && Array.isArray(result)) {
      // Filter no-extraction markers — only real candidates persist.
      const realCandidates = result.filter(
        (c) => c && (c.extraction_status === null || c.extraction_status === undefined),
      );
      if (realCandidates.length === 0) {
        // Defensive — classifyError shouldn't have returned 'success' for marker-only arrays,
        // but keep a fallthrough for robustness.
        exactEvent = { kind: 'not_found' };
        exactTransition = computeNextRetry({
          axis: 'exact',
          prevStatus: priorState.exact_status,
          prevAttemptCount: priorState.exact_attempt_count,
          event: exactEvent,
          nowIso,
        });
      } else {
        for (const c of realCandidates) {
          const obs = shapeObservationFromCandidate(c, jobRow, nowIso);
          progress(`inserting observation: ${obs.confidence_label} ${obs.currency}`);
          if (!dryRun) insertObservation(db, obs);
        }
        exactTransition = computeNextRetry({
          axis: 'exact',
          prevStatus: priorState.exact_status,
          prevAttemptCount: priorState.exact_attempt_count,
          event: { kind: 'success' },
          nowIso,
        });
      }
    } else {
      exactTransition = computeNextRetry({
        axis: 'exact',
        prevStatus: priorState.exact_status,
        prevAttemptCount: priorState.exact_attempt_count,
        event: exactEvent,
        nowIso,
      });
    }

    if (!dryRun) {
      applyRetryTransition(db, source, jobId, 'exact', exactTransition, nowIso);
    }
  }

  // 5. SELECT best from current observations
  let observations = dryRun
    ? envelope.observations
    : getObservationsByJob(db, source, jobId) ?? [];
  let selectedBest = selectBestObservation(observations, {
    jobCountryCode: jobRow.country_code,
    expectedCurrency: expectedCurrencyFor(jobRow.country_code),
  });

  // 6. BENCHMARK pass — only when no exact selected OR selectedBest is itself an estimate.
  // SKIPPED when exact pass produced an error event (unrecoverable or transient): the
  // CLI should not consume another adapter call when the exact axis is already in
  // a non-not_found error state. Benchmark axis remains untouched (RETRY-04 axis
  // independence + locked CONTEXT: 'benchmark fallback after clean not_found only').
  let benchmarkEvent = null;
  let benchmarkTransition = null;
  const exactInError =
    exactEvent &&
    (exactEvent.kind === 'unrecoverable_error' || exactEvent.kind === 'transient_error');
  const exactObservationExists =
    selectedBest !== null && selectedBest !== undefined && selectedBest.is_posted_salary === 1;

  // v1.0-10 flag split (CLI-03 invariant lives here):
  //   shouldFetchBenchmark  — gates adapter.fetchBenchmark + storeBenchmarkSnapshot + retry transition.
  //   shouldInsertEstimateObs — gates the insertObservation(...) call that writes the is_posted_salary=0 row.
  // These diverge when forceBenchmarkRefresh=true AND an exact observation already exists:
  // the cache is refreshed (shouldFetchBenchmark=true) but NO estimate observation is inserted
  // (shouldInsertEstimateObs=false). This enforces CLI-03 at the pipeline level — independent of CLI.
  // CLI-03/CLI-06 (v1.0-10): when the operator explicitly asks for benchmark work
  // (--refresh-benchmarks / --force-benchmark-retry / --benchmark-only), the
  // benchmark pass must run regardless of whether the exact pass errored. The
  // exact-error short-circuit is only for the implicit-fallback path (no
  // selectedBest). RETRY-04 axis independence is preserved because the benchmark
  // transition uses its own classifyError result.
  const operatorRequestedBenchmark = forceBenchmarkRefresh || skipExact;
  const shouldFetchBenchmark =
    enableBenchmark &&
    (operatorRequestedBenchmark || !exactInError) &&
    (
      // Existing condition: no exact selected (or selected is itself an estimate) — need benchmark fallback.
      selectedBest === null ||
      (selectedBest && selectedBest.is_posted_salary === 0) ||
      // CLI-03: explicit refresh requested even when an exact observation exists.
      forceBenchmarkRefresh ||
      // CLI-04 defensive: benchmark-only mode (CLI will also set forceBenchmarkRefresh, but defend here).
      skipExact
    );
  const shouldInsertEstimateObs = shouldFetchBenchmark && !exactObservationExists;

  if (shouldFetchBenchmark) {
    const benchmarkAdapters = pickBenchmarkAdapters(adapterRegistry, jobRow.country_code);
    if (benchmarkAdapters.length > 0) {
      const query = buildBenchmarkQuery(jobRow);
      let latest = findLatestBenchmark(db, query);
      // CLI-03: forceBenchmarkRefresh bypasses the cache-fresh early-return.
      const stale =
        !latest || forceBenchmarkRefresh || isBenchmarkStale(latest, BENCHMARK_MAX_AGE_DAYS, nowIso);

      if (stale) {
        progress(`fetching benchmark cohort: ${query.normalizedTitle}`);
        let bmResult;
        const noDataEvents = [];
        for (const benchmarkAdapter of benchmarkAdapters) {
          try {
            // eslint-disable-next-line no-await-in-loop
            bmResult = await benchmarkAdapter.fetchBenchmark(query, { httpClient, now: new Date(nowIso) });
          } catch (err) {
            bmResult = err;
          }

          // A null/undefined result means the adapter had no parseable public benchmark
          // for this cohort. Try the next country-priority source before deciding the
          // benchmark axis outcome. This lets opportunistic sources such as SalaryExpert
          // fail closed without blocking Indeed/Levels.fyi fallbacks.
          if (bmResult === null || bmResult === undefined) {
            noDataEvents.push(benchmarkAdapter.sourceName || 'unknown');
            bmResult = null;
            continue;
          }
          break;
        }

        if (bmResult instanceof Error) {
          benchmarkEvent = classifyError(bmResult);
        } else if (
          bmResult &&
          typeof bmResult === 'object' &&
          typeof bmResult.status === 'number' &&
          bmResult.ok === false
        ) {
          benchmarkEvent = classifyError(bmResult);
        } else if (bmResult && typeof bmResult === 'object') {
          if (!dryRun) {
            // The pipeline is the authority on the cohort identity (cohort fields
            // come from buildBenchmarkQuery on the canonical jobRow). If the adapter
            // included a benchmarkSeriesId, drop it — storeBenchmarkSnapshot will
            // derive the canonical series_id from the cohort fields, avoiding
            // disagreement errors when adapters return symbolic ids.
            const { benchmarkSeriesId: _ignoredSeriesId, ...adapterPayload } = bmResult;
            const storeResult = storeBenchmarkSnapshot(db, adapterPayload);
            latest = storeResult.row;
          } else {
            latest = bmResult;
          }
          benchmarkEvent = { kind: 'success' };
        } else {
          benchmarkEvent = {
            kind: 'not_found',
            message: `no benchmark from adapters: ${noDataEvents.join(', ')}`,
          };
        }
      } else {
        // cache hit — fresh enough
        benchmarkEvent = { kind: 'success' };
      }

      benchmarkTransition = computeNextRetry({
        axis: 'benchmark',
        prevStatus: priorState.benchmark_status,
        prevAttemptCount: priorState.benchmark_attempt_count,
        event: benchmarkEvent,
        nowIso,
      });

      if (benchmarkEvent.kind === 'success' && latest && latest.benchmark_id) {
        // CLI-03 invariant: only insert the estimate observation when no exact
        // observation already exists for this job. When forceBenchmarkRefresh=true
        // AND exactObservationExists=true, we refreshed the cache above but MUST NOT
        // write an estimate row — selectedBest would still resolve to the exact.
        if (shouldInsertEstimateObs) {
          const estimateObs = shapeEstimateObservation(latest, jobRow, nowIso);
          if (!dryRun) insertObservation(db, estimateObs);
          envelope.benchmarkUsed = latest.benchmark_id;
        }
      }

      if (!dryRun) {
        applyRetryTransition(db, source, jobId, 'benchmark', benchmarkTransition, nowIso);
      }
    }
  }

  // 7. Re-read + re-select after benchmark pass
  observations = dryRun ? observations : getObservationsByJob(db, source, jobId) ?? [];
  selectedBest = selectBestObservation(observations, {
    jobCountryCode: jobRow.country_code,
    expectedCurrency: expectedCurrencyFor(jobRow.country_code),
  });

  // 8. Build state block: fresh row (live) OR projected (dryRun).
  const finalState = !dryRun
    ? getEnrichmentState(db, source, jobId) ?? defaultEnrichmentState()
    : projectDryRunState(priorState, exactTransition, benchmarkTransition, nowIso);

  envelope.observations = observations;
  envelope.selectedBest = selectedBest;
  envelope.state.exact = shapeStateForEnvelope(finalState, 'exact');
  envelope.state.benchmark = shapeStateForEnvelope(finalState, 'benchmark');
  envelope.state.exitCode = deriveExitCode({
    selectedBest,
    exactEvent,
    exactTransition,
    benchmarkEvent,
    benchmarkTransition,
    stateExact: envelope.state.exact,
  });

  return envelope;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pickJobFields(row) {
  return {
    source: row.source,
    job_id: row.job_id,
    title: row.title ?? null,
    company: row.company ?? null,
    url: row.url ?? null,
    country_code: row.country_code ?? null,
    region: row.region ?? null,
    city: row.city ?? null,
    location_raw: row.location_raw ?? null,
  };
}

function defaultEnrichmentState() {
  return {
    exact_status: 'pending',
    exact_attempt_count: 0,
    next_exact_retry_at: null,
    exact_last_attempt_at: null,
    exact_error: null,
    benchmark_status: 'pending',
    benchmark_attempt_count: 0,
    next_benchmark_retry_at: null,
    benchmark_last_attempt_at: null,
    benchmark_error: null,
  };
}

/**
 * Shape a parser candidate into an observation row for insertObservation.
 * HEALTH-01: evidence_snippet + raw_payload_json populated non-null.
 */
export function shapeObservationFromCandidate(candidate, job, nowIso) {
  const rawPayload =
    typeof candidate.raw_payload_json === 'string'
      ? candidate.raw_payload_json
      : JSON.stringify(candidate.raw_payload_json ?? candidate);
  const evidence =
    typeof candidate.evidence_snippet === 'string' && candidate.evidence_snippet.length > 0
      ? candidate.evidence_snippet
      : `${candidate.currency ?? ''} ${candidate.amount_min ?? ''}-${candidate.amount_max ?? ''}`.trim();

  return {
    job_source: job.source,
    job_id: job.job_id,
    data_source: job.source,
    data_source_url: job.url ?? null,
    benchmark_id: null,
    confidence_label: candidate.confidence_label ?? 'posted_exact',
    matched_by: candidate.matched_by ?? 'exact_job',
    is_posted_salary: 1,
    is_predicted: 0,
    currency: candidate.currency,
    amount_min: candidate.amount_min ?? null,
    amount_max: candidate.amount_max ?? null,
    amount_median: candidate.amount_median ?? null,
    period: candidate.period ?? 'year',
    compensation_type: candidate.compensation_type ?? 'base_salary',
    location_raw: job.location_raw ?? null,
    country_code: job.country_code ?? null,
    region: job.region ?? null,
    city: job.city ?? null,
    evidence_snippet: evidence,
    raw_payload_json: rawPayload,
    observed_at: nowIso,
  };
}

/**
 * Shape a stored benchmark row into an estimate observation tied to benchmark_id.
 * HEALTH-01: evidence_snippet + raw_payload_json populated non-null.
 */
export function shapeEstimateObservation(benchmarkRow, job, nowIso) {
  const rawPayload =
    typeof benchmarkRow.raw_payload_json === 'string'
      ? benchmarkRow.raw_payload_json
      : JSON.stringify(benchmarkRow.raw_payload_json ?? benchmarkRow);
  const evidence =
    typeof benchmarkRow.evidence_snippet === 'string' && benchmarkRow.evidence_snippet.length > 0
      ? benchmarkRow.evidence_snippet
      : `benchmark ${benchmarkRow.normalized_title ?? ''} median ${benchmarkRow.amount_median ?? '?'}`;

  return {
    job_source: job.source,
    job_id: job.job_id,
    data_source: benchmarkRow.data_source ?? 'benchmark',
    data_source_url: benchmarkRow.data_source_url ?? null,
    benchmark_id: benchmarkRow.benchmark_id,
    confidence_label: 'estimated_market',
    matched_by: 'role_location',
    is_posted_salary: 0,
    is_predicted: 1,
    currency: benchmarkRow.currency ?? 'USD',
    amount_min: benchmarkRow.amount_min ?? null,
    amount_max: benchmarkRow.amount_max ?? null,
    amount_median: benchmarkRow.amount_median ?? null,
    period: benchmarkRow.period ?? 'year',
    compensation_type: benchmarkRow.compensation_type ?? 'base_salary',
    location_raw: job.location_raw ?? null,
    country_code: job.country_code ?? null,
    region: job.region ?? null,
    city: job.city ?? null,
    evidence_snippet: evidence,
    raw_payload_json: rawPayload,
    observed_at: nowIso,
  };
}

/**
 * Build a benchmark query cohort from the saved job row. Applies normalizers
 * (title/seniority/industry) so the derived series_id is canonical across runs.
 */
export function buildBenchmarkQuery(job) {
  return {
    title: job.title ?? '',
    normalizedTitle: normalizeTitle(job.title ?? ''),
    seniority: normalizeSeniority(job.title ?? ''),
    industry: normalizeIndustry(''),
    countryCode: job.country_code ?? '',
    region: job.region ?? '',
    city: job.city ?? '',
    compensationType: 'base_salary',
    period: 'year',
    normalizerVersion: NORMALIZER_VERSION,
  };
}

/**
 * Pick benchmark-providing adapters for the given country in priority order.
 */
function pickBenchmarkAdapters(registry, countryCode) {
  const out = [];
  for (const source of benchmarkSourcesForCountry(countryCode)) {
    const candidate = registry?.[source];
    if (candidate && candidate.supports?.benchmark) out.push(candidate);
  }
  return out;
}

function shapeStateForEnvelope(row, axis) {
  if (axis === 'exact') {
    return {
      status: row.exact_status,
      attempt_count: row.exact_attempt_count,
      next_retry_at: row.next_exact_retry_at ?? null,
      last_attempt_at: row.exact_last_attempt_at ?? null,
      error: row.exact_error ?? null,
    };
  }
  return {
    status: row.benchmark_status,
    attempt_count: row.benchmark_attempt_count,
    next_retry_at: row.next_benchmark_retry_at ?? null,
    last_attempt_at: row.benchmark_last_attempt_at ?? null,
    error: row.benchmark_error ?? null,
  };
}

/**
 * Project the state row that WOULD exist after the run, without writing.
 * Mirrors CLI-07 dry-run preview semantics.
 */
function projectDryRunState(prior, exactTransition, benchmarkTransition, nowIso) {
  const out = { ...prior };
  if (exactTransition) {
    out.exact_status = exactTransition.status;
    out.exact_attempt_count = exactTransition.attemptCount;
    out.next_exact_retry_at = exactTransition.nextRetryAtIso ?? null;
    out.exact_last_attempt_at = nowIso;
    out.exact_error = exactTransition.errorMessage ?? null;
  }
  if (benchmarkTransition) {
    out.benchmark_status = benchmarkTransition.status;
    out.benchmark_attempt_count = benchmarkTransition.attemptCount;
    out.next_benchmark_retry_at = benchmarkTransition.nextRetryAtIso ?? null;
    out.benchmark_last_attempt_at = nowIso;
    out.benchmark_error = benchmarkTransition.errorMessage ?? null;
  }
  return out;
}

/**
 * Derive process exit code from STRUCTURED retry-state-machine outputs.
 *
 * INPUTS ARE STRUCTURED — this function MUST NOT parse error message strings
 * for substrings like '401', '403', or 'HTTP'. All routing happens on:
 *   - event.kind (closed-set: 'success'|'not_found'|'transient_error'|'unrecoverable_error')
 *   - transition.nextRetryAtIso (null === exhausted/unrecoverable)
 *   - selectedBest (null === no usable observation)
 *   - stateExact.status (string from persisted/projected row)
 *
 * Exit code matrix (CLI-10, locked CONTEXT decision):
 *   0 — success: selectedBest non-null OR clean not_found
 *       OR transient_error WITH a scheduled retry (recording succeeded)
 *   1 — uncaught exception (defensive fall-through)
 *   2 — precondition failure (handled by CLI, not here)
 *   4 — lock contention (handled by CLI, not here)
 *   5 — unrecoverable_error (HTTP 401/403, unknown unrecoverable)
 *   6 — transient_error exhaustion (nextRetryAtIso === null after >5 attempts)
 */
export function deriveExitCode({
  selectedBest,
  exactEvent,
  exactTransition,
  benchmarkEvent,
  benchmarkTransition,
  stateExact,
}) {
  // Rule 1: unrecoverable errors take precedence (401/403/unknown).
  if (exactEvent && exactEvent.kind === 'unrecoverable_error') return 5;
  if (benchmarkEvent && benchmarkEvent.kind === 'unrecoverable_error') return 5;

  // Rule 2: transient exhaustion (transition gave up — nextRetryAtIso === null).
  // The `nextRetryAtIso === null` guard MUST appear on the line immediately preceding
  // every `return 6` (verify gate: grep -B 1 'return 6' | grep 'nextRetryAtIso === null' >= 2).
  if (exactEvent && exactEvent.kind === 'transient_error' && exactTransition && exactTransition.nextRetryAtIso === null)
    return 6;
  if (benchmarkEvent && benchmarkEvent.kind === 'transient_error' && benchmarkTransition && benchmarkTransition.nextRetryAtIso === null)
    return 6;

  // Rule 3: success / "did the work" outcomes.
  if (selectedBest !== null && selectedBest !== undefined) return 0;
  if (stateExact && stateExact.status === 'not_found') return 0;
  // Clean exact 'found' even with no selectedBest in envelope (e.g. dryRun: writes
  // skipped, so observations array is empty but the run did the work).
  if (stateExact && stateExact.status === 'found') return 0;
  // Clean benchmark 'found' even with no selectedBest in envelope (e.g. dryRun:
  // benchmark cache/estimate writes are skipped, so there is no persisted
  // benchmark_id-backed observation to re-select, but the adapter work succeeded).
  if (benchmarkEvent && benchmarkEvent.kind === 'success') return 0;

  // Rule 4: transient_error WITH a scheduled retry — CLI recorded the failure
  // and scheduled the retry. Per locked CONTEXT + CLI-01, this is a SUCCESSFUL
  // run → exit 0.
  if (
    exactEvent &&
    exactEvent.kind === 'transient_error' &&
    exactTransition &&
    exactTransition.nextRetryAtIso !== null
  ) {
    return 0;
  }
  if (
    benchmarkEvent &&
    benchmarkEvent.kind === 'transient_error' &&
    benchmarkTransition &&
    benchmarkTransition.nextRetryAtIso !== null
  ) {
    return 0;
  }

  // Rule 5: defensive fall-through.
  return 1;
}
