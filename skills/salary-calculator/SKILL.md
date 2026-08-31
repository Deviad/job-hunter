---
name: salary-calculator
description: Enriches saved jobs in jobhunter.sqlite with either a verified posted salary or a clearly-labeled market-rate estimate, never confusing the two. Uses LinkedIn for posted salaries and ITJobsWatch for UK benchmarks. Preserves provenance from estimate to benchmark snapshot across cache refreshes. Single-writer concurrency via salary_writer_lock. Use for one-shot enrichment, batch passes over unsalaried jobs, or extraction-rate health checks.
allowed-tools: read bash write
---
## Workspace

All paths in this skill are written against `${WORKSPACE}` — the canonical job-hunter home `$JOBHUNTER_HOME`, default `~/.job-hunter` (NOT the launch directory; contract updated 2026-07-06). Resolve to `process.env.JOBHUNTER_HOME || path.join(process.env.HOME, '.job-hunter')` in Node and `"${JOBHUNTER_HOME:-$HOME/.job-hunter}"` in bash. The SQLite DB is at `~/.job-hunter/jobhunter.sqlite`. Pass `--db "$HOME/.job-hunter/jobhunter.sqlite"` to helper scripts (their built-in default may still resolve from cwd). Do NOT hardcode `$JOBHUNTER_HOME`.

# Salary Calculator

## Purpose

For every saved job in `jobhunter.sqlite`, the salary-calculator skill surfaces either a verified posted salary or a market-rate estimate — and **never confuses the two**. Provenance from every estimate back to the source benchmark snapshot is preserved across cache refreshes; historical observations are never rewritten when the benchmark cache is refreshed.

The skill operates a two-class observation model enforced at the SQL level (CHECK partition on `job_salary_observations`). Every row is either an **exact** observation (`is_posted_salary=1`, `benchmark_id IS NULL`) sourced from a job page or ATS API, or an **estimate** (`is_posted_salary=0`, `benchmark_id NOT NULL`) derived from an immutable cohort snapshot in `salary_benchmarks`. This is the core correctness property of the skill: an estimated salary is never presented as posted, and the lineage from estimate to benchmark is always queryable.

The skill is invoked by Pi (or directly via `npm run` / `node scripts/...`) to enrich one job at a time, batch over all unsalaried jobs, refresh benchmarks without inserting estimates, or run an extraction-rate health check.

## Golden Rule

Never present an estimated salary as posted. Every observation belongs to exactly one of two classes — `is_posted_salary=1` with `benchmark_id IS NULL` (exact), or `is_posted_salary=0` with a real `benchmark_id` (estimate). The CHECK partition in SQLite enforces this at the database level; no application code path can bypass it.

The database is the source of truth for salary presentation. Do not cache salary amounts in skill Markdown, prompt examples, or static report templates; they change. Templates may define columns only. At render time, fetch salary values from `job_salary_observations` / `salary_benchmarks` or run fresh enrichment, then display the current value with posted-vs-estimated provenance. If a generated Markdown/CSV artifact includes salary, treat it as a timestamped snapshot, not a reusable source.

## Workspace resolution rule

`${WORKSPACE}` in every example, bash/SQL snippet, and `DEFAULT_DB` constant in this skill means the canonical job-hunter home `$JOBHUNTER_HOME`, default `~/.job-hunter` — not the launch directory (contract updated 2026-07-06). Resolve to `process.env.JOBHUNTER_HOME || path.join(process.env.HOME, '.job-hunter')` in Node and `"${JOBHUNTER_HOME:-$HOME/.job-hunter}"` in bash. If you find a hardcoded `WORKSPACE/` or any other project-specific path anywhere in this skill (including references and scripts), replace it with `${WORKSPACE}/...` and `path.join(process.cwd(), '...')` respectively. Canonical reference: `auto-job-application` skill → Core Rule 17 + Workspace section.

## Workflow

1. Acquire the writer lock (`salary_writer_lock`) via `BEGIN IMMEDIATE` — fail fast if another writer holds it (exit 4).
2. Fetch the job page via the chosen adapter (`scripts/sources/linkedin.mjs` or `scripts/sources/itjobswatch.mjs`).
3. Parse salary candidates from the response (regex + JSON-LD), with explicit boundary exclusion for LinkedIn's "Similar jobs" / "People also viewed" / "More searches" / "Explore top content" / "Show more jobs like this" sections (PARSE-08).
4. If the LinkedIn/job-board page has no posted salary and exposes an external advertiser/ATS apply URL, follow that URL in read-only mode before falling back to market benchmarks. Do **not** submit or fill an application; only load the advertiser/ATS job detail page and parse a salary range that is clearly tied to the same job. Persist it as `is_posted_salary=1` with `data_source_url` pointing to the advertiser/ATS page. Do not mark a job as applied merely because the external apply link was opened.
5. Select the best observation via the deterministic 8-level comparator in `scripts/lib/salary-selector.mjs` (confidence > exactness > predicted > observed_at > location > currency > source > observation_id).
6. Persist via `INSERT OR IGNORE` against `job_salary_observations`; for estimates, look up or store the cohort snapshot in `salary_benchmarks` first.
7. Apply per-axis retry state via `applyRetryTransition` on `job_enrichment_state` (RETRY-04 axis independence — exact and benchmark axes never share counters).
8. Release the writer lock; emit a stdout envelope (canonical text or `--json`).

## Commands

Use the active Pi skill path (`../salary-calculator/...`) for these commands unless the user gives a different active profile path.

| Goal | Command |
|------|---------|
| Enrich one LinkedIn job | `node scripts/enrich-job-salary.mjs --db jobhunter.sqlite --source linkedin --job-id 12345` |
| Advertiser/ATS exact salary scan for a scored queue | `node scripts/external-salary-scan.mjs --search-id score-YYYYMMDD --limit 10` |
| Batch salary research for an Apply queue | `node scripts/batch-salary-research.mjs --search-id score-YYYYMMDD` |
| Batch pass over unsalaried | `node scripts/enrich-job-salary.mjs --db jobhunter.sqlite --all-unsalaried --limit 50` |
| Refresh benchmark cache without inserting estimates | `node scripts/enrich-job-salary.mjs --db jobhunter.sqlite --all-unsalaried --refresh-benchmarks` |
| Benchmark-only (skip exact pass entirely) | `node scripts/enrich-job-salary.mjs --db jobhunter.sqlite --all-unsalaried --benchmark-only` |
| Force exact retry on stuck jobs | `node scripts/enrich-job-salary.mjs --db jobhunter.sqlite --all-unsalaried --force-exact-retry` |
| Force benchmark retry | `node scripts/enrich-job-salary.mjs --db jobhunter.sqlite --all-unsalaried --force-benchmark-retry` |
| Check extraction-rate health | `node scripts/enrich-job-salary.mjs --db jobhunter.sqlite --health` |
| JSON envelope (single job) | `node scripts/enrich-job-salary.mjs --source linkedin --job-id 12345 --json` |
| Health report (JSON) | `node scripts/enrich-job-salary.mjs --db jobhunter.sqlite --health --json` |
| Dry-run (no DB writes) | `node scripts/enrich-job-salary.mjs --source linkedin --job-id 12345 --dry-run` |

`batch-salary-research.mjs` routes `source='external'` jobs through `external-salary-scan.mjs`; `enrich-job-salary.mjs` remains the adapter pipeline for board/benchmark sources.

## Source Priority

| Source | Exact salary? | Benchmark? | Regions | Notes |
|--------|---------------|------------|---------|-------|
| linkedin | yes | no | GB, IE, US, CA, AU, EU, CH, AE | Excludes 'Similar jobs' / 'People also viewed' / 'More searches' / 'Explore top content' / 'Show more jobs like this' sections (PARSE-08) |
| advertiser_ats | yes | no | Any | Use `scripts/external-salary-scan.mjs` to follow the LinkedIn/job-board external apply URL in read-only mode and parse salary from the advertiser/ATS job detail page before using market estimates. Do not submit/fill forms; exact only when the salary is clearly tied to the same job. |
| itjobswatch | no | yes | GB primarily | UK technology-role benchmarks; normalizer-stamped (`normalizer_version` column on every persisted row) |
| indeed | no | yes | IE, GB, US, CA, AU, CH, AE, major EU | Public Indeed Career salary pages; 401/403/no parse returns no-data so fallback sources can run. |
| levels_fyi | no | yes | IE, GB, US, CA, AU, CH, major EU, AE opportunistic | Tech compensation range pages; generally total compensation. |
| robert_half | no | yes | IE, GB, US, CA, AU, CH, AE opportunistic | Public salary-guide HTML; role-adjacent extraction when ranges are exposed. |
| salaryexpert | no | yes | IE, GB, US, CA, AU, CH, AE, major EU opportunistic | Public SalaryExpert pages when accessible; frequent 403 is treated as no-data fallback, not a hard failure. |

Benchmark sources are tried in country-code order; the routing table is encoded in `scripts/lib/source-priority.mjs`. Each source advertises `supports.exactSalary` / `supports.benchmark` flags and per-source rate limits (`limits.perHostRps`, `limits.maxConcurrent`).

## Supported Regions

| Country | Currency | Sample sources |
|---------|----------|----------------|
| GB | GBP | linkedin, itjobswatch |
| IE | EUR | linkedin, indeed, levels_fyi, robert_half, salaryexpert |
| US | USD | linkedin, levels_fyi, indeed, robert_half, salaryexpert |
| CA | CAD | linkedin, levels_fyi, indeed, robert_half, salaryexpert |
| AU | AUD | linkedin, levels_fyi, indeed, robert_half, salaryexpert |
| CH | CHF | linkedin, levels_fyi, indeed, robert_half, salaryexpert |
| AE | AED | linkedin, indeed, levels_fyi, robert_half, salaryexpert |
| EU (other) | EUR | linkedin, levels_fyi, indeed, salaryexpert |

Cross-currency numeric comparison is intentionally NOT performed in v1 — FX columns (`amount_*`, `annualized_*`, `fx_*`) are display-only and the selector cannot rank across currencies. This is a deliberate v2 boundary.

## SQLite Tables

| Table | Purpose |
|-------|---------|
| `jobs` | Read-only source of saved jobs (managed by the `linkedin-job-search` skill). The salary-calculator never mutates this table. |
| `job_salary_observations` | Insert-only observation log; CHECK partition separates exact (`is_posted_salary=1`, `benchmark_id IS NULL`) from estimate (`is_posted_salary=0`, `benchmark_id NOT NULL`). `INSERT OR IGNORE` conflict policy. |
| `salary_benchmarks` | Immutable benchmark snapshots; `normalizer_version` column is a schema-migration trigger (see Normalizer Version subsection below). UNIQUE(`benchmark_series_id`, `payload_hash`) deduplication. |
| `job_enrichment_state` | Per-job retry/backoff state for exact + benchmark axes (RETRY-04 axis independence). `trg_state_updated` trigger maintains `updated_at`. |
| `salary_writer_lock` | Advisory single-writer lock acquired via `BEGIN IMMEDIATE`; 10-min stale-window recovery via `acquired_at` heartbeat. |

### Normalizer Version

The salary normalization layer (titles, seniority, industry) is rule-driven by [references/normalization.md](references/normalization.md). Benchmark source behavior, fallback semantics, and verification patterns are documented in [references/benchmark-adapters.md](references/benchmark-adapters.md). The integer `NORMALIZER_VERSION` exported from `scripts/lib/normalize/rules-loader.mjs` is a **schema-migration trigger**: every row inserted into `salary_benchmarks` carries this stamp in the `normalizer_version` column.

**Current value:** `1`

**Bump policy:** Any semantic edit to `references/normalization.md` (adding/removing/changing a synonym, reordering the seniority table, adding/renaming an industry code, expanding the location list) MUST be paired with an increment of the integer constant in `scripts/lib/normalize/rules-loader.mjs` in the SAME commit. Whitespace-only or comment-only edits do not bump.

**Downstream invalidation:** Benchmarks stamped with an older `normalizer_version` are NOT retroactively re-normalized. They remain valid identity within their version cohort. The benchmark cache (Phase v1.0-06) treats `(benchmark_series_id, normalizer_version)` as the cohort key — cross-version matches are explicit, not silent.

**Schema migration:** Adding the `normalizer_version` column to an existing v1.0-01 database is handled idempotently by `ensureNormalizerVersionColumn()` in `scripts/lib/normalize/benchmark-stamp.mjs`, called from the schema installer. Backfilled rows default to version 1.

## Retry Semantics

- **Exact axis:** `next_exact_retry_at = now + min(2^(attempt_count-1), 7)` days (capped at 7); after attempt 5 → `NULL` (manual reset via `--force-exact-retry`).
- **Benchmark axis:** independent columns (`benchmark_status`, `benchmark_attempt_count`, `next_benchmark_retry_at`) — same math, independent counter (RETRY-04).
- **`not_found` floor:** exact = 14 days, benchmark = 30 days. Prevents thrash on jobs that genuinely have no posted salary.
- **Reproducibility:** behaviour is reproducible from persisted state alone (RETRY-03 — no in-memory counters, no module-scope mutable state, `nowIso` injected into pure functions).
- **Mixed-status arrays:** when `classifyError` receives a non-empty array with no `markerNotFound` token and at least one failure, the result is `not_found` (opencode improvement #2 / Branch C), not `unrecoverable_error`.

## Concurrency

Single-writer model. Each writer acquires `salary_writer_lock` via `BEGIN IMMEDIATE` before any insert; contention exits non-zero (exit 4) with "Another writer holds the lock; try again in <N> minutes". A crashed writer's lock is reclaimable after 10 minutes (`acquired_at` heartbeat).

Reads (`--health`, batch-count queries) do NOT acquire the writer lock — health checks can run concurrently with an in-flight enrichment. The CLI verifies job-existence BEFORE acquiring the writer lock so that exit 2 (precondition) takes precedence over exit 4 (contention).

## Manual benchmark updates

When the automated benchmark pass returns `not_found` but the user asks for salary updates across countries or main locations, perform a manual market-benchmark update rather than leaving jobs unsalaried. Keep the core partition strict: manual market numbers are estimates (`is_posted_salary=0`, `is_predicted=1`) and must first be persisted as `salary_benchmarks`, then linked from `job_salary_observations`. See `references/manual-market-benchmark-updates.md` for the researched-source hierarchy, SQLite insert pattern, migrated-DB compatibility cautions, and verification queries.

## Lessons / Guardrails

### Do not replace source-backed salary scraping with manual curated estimates

When asked to update salary information, run the salary-calculator workflow and source adapters first. Do not manually insert a batch of ad-hoc estimates from search snippets as if that satisfied the skill. The current pipeline supports LinkedIn exact salary extraction and ITJobsWatch UK benchmarks; non-UK market benchmarks need explicit source adapters (for example Indeed salary pages, Levels.fyi, Example Location 013.ai/Robert Half, SalaryExpert if accessible) or a clearly documented fallback. If a region lacks an adapter, say that directly, add/patch the adapter or store any fallback as `estimated_market` with full provenance, and update this skill so the gap is not rediscovered.

### Schema side-effects must be explicit and fixed properly

If inserts fail because a legacy trigger/view/table is broken (for example a trigger references a missing `match_results_old` table), do not silently create compatibility tables as the final fix. Call out the schema bug, prefer a proper migration/trigger fix, and only use a compatibility shim as a temporary unblocker with clear reporting.

## Troubleshooting

| Symptom | Likely cause | Remedy |
|---------|--------------|--------|
| Exit 4 + "Another writer holds the lock" | Concurrent CLI invocation | Wait the printed minutes, or rerun later. `--force-exact-retry` does NOT bypass the lock — it only resets retry state once the lock is acquired. |
| Parser returns 0 candidates on a known-salaried page | LinkedIn DOM drift or HTML→text gap | Run `--health` — if hit-rate dropped, see HEALTH-03 warning. Inspect `evidence_snippet` in `job_salary_observations` for the last successful row, then compare to the failing page. |
| Exit 5 + "401/403" | LinkedIn auth expired | Re-run the `brave-obscura-session` skill to refresh cookies; rerun with `--force-exact-retry` once auth is back. |
| Exit 6 + "transient exhausted" | 5xx retry budget exhausted (5 attempts) | Wait for `next_exact_retry_at` (printed in stderr); rerun with `--force-exact-retry` to reset the counter. Check `references/benchmark-adapters.md` for supported source behavior. |
| Exit 7 + per-job synthetic envelope in batch | Unhandled exception in pipeline for a single job | Inspect the offending job via single-job CLI (`--job-id`); 7-dominates-6 priority means the batch may still surface this even if other jobs schedule transient retries. |
| `ensureNormalizerVersionColumn` errors | Schema drift between repo and DB | Run `npm run ensure-schema -- --db <path>` to install the migration. Backfill defaults to version 1; cross-version matches in the cache are explicit. |
| `.pi/agents/` (plural) in install path | Typo (canonical path is singular `.pi/agent/`) | `install-skill.mjs` refuses with exit 2 + stderr "plural". Re-run with the correct path: `../salary-calculator/`. |

Base directory for this skill: this directory
