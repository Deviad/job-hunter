# Benchmark adapter notes

This reference captures durable implementation details for the market-salary benchmark adapters in `scripts/sources/`.

## Adapter contract

Each benchmark adapter should export:

- `sourceName`
- `supports = { exactSalary: false, benchmark: true }`
- `limits = { perHostRps, maxConcurrent }`
- `fetchExactSalary()` returning `[]`
- `fetchBenchmark(query, ctx)` returning either:
  - a `storeBenchmarkSnapshot`-shaped benchmark object, or
  - `null` for clean no-data / inaccessible / no parseable public range.

Do not throw for common public-page no-data conditions such as 401/403 blocks from opportunistic fallback sources. Returning `null` lets the country-priority chain continue to later adapters.

## Current adapters

- `indeed.mjs`: public Indeed Career salary pages (`/career/<slug>/salaries`). Extracts average salary from meta description / JSON-LD / nearby page text. Treat 401/403/no parse as `null`.
- `levels_fyi.mjs`: public Levels.fyi role/location pages. Extracts ranges from meta description or embedded Next.js payload. These values are generally total compensation; set `compensationType: 'total_compensation'`.
- `robert_half.mjs`: public Robert Half salary guides. Opportunistic role-adjacent range extraction when static HTML exposes ranges. Return `null` if guide content is too interactive or unparseable.
- `salaryexpert.mjs`: public SalaryExpert pages when accessible. SalaryExpert commonly returns 403 to automation; treat as `null`, not a hard benchmark failure.
- `itjobswatch.mjs`: UK benchmark adapter; keep GB first to preserve existing UK behavior.

## Country priority

`source-priority.mjs` owns benchmark ordering. Current durable defaults:

- GB: `itjobswatch`, `indeed`, `levels_fyi`, `robert_half`, `salaryexpert`
- IE: `indeed`, `levels_fyi`, `robert_half`, `salaryexpert`
- US/CA/AU/CH: `levels_fyi`, `indeed`, `robert_half`, `salaryexpert`
- AE: `indeed`, `levels_fyi`, `robert_half`, `salaryexpert`
- major EU: `levels_fyi`, `indeed`, `salaryexpert`

The pipeline should try adapters in order until one returns a benchmark object. `null`/`undefined` means clean no-data and should not poison retry state while later priority sources remain available.

## When the benchmark-only pass returns 0 across a batch

A `--all-unsalaried --limit 30 --refresh-benchmarks` run that ends with
`found=0 not_found=0 error=0` is the common first-run outcome when:

- The benchmark cache is empty (no `salary_benchmarks` rows yet).
- Adapters are returning `null` for the cohort (e.g. the role/location
  combo has no public range pages, or all 4 fallback sources 401/403).
- The `cohort_id` normalizer has a synonym gap (e.g. "AI Architect" is
  not yet mapped to any benchmark cohort).

In all three cases, the right next step is **not** to keep looping the
`--all-unsalaried` pass — it will keep returning 0 until the cache
warms or the cohort is fixed. Instead:

1. **Inspect the benchmark cache** with
   `sqlite3 ${WORKSPACE}/jobhunter.sqlite "SELECT COUNT(*) FROM salary_benchmarks;"`.
   If 0 rows, the cache is cold — pre-warm by running `--refresh-benchmarks`
   against a small hand-picked set of representative jobs (1 per role
   family × 1 per country).
2. **Check the cohort extractor** for the failing role. The runner prints
   `fetching benchmark cohort: <slug>` per job; if the slug is gibberish
   (e.g. `chief_technology officer` instead of `ai-architect`), the
   `references/normalization.md` rules need a synonym. Edit and re-run.
3. **If cache is warm and cohorts are sane but adapters still return null**
   for a specific region, the region lacks a public benchmark source for
   that role. The right move is to skip the benchmark pass for that
   region and rely on posted-salary data only (run
   `--all-unsalaried --force-exact-retry` to push the LinkedIn exact
   path instead).

A 30-job pass with 0 found is a SIGNAL to switch strategy, not a
failure to retry.

## Verification pattern

Use `node --check` for every changed `.mjs` file, then run a dry-run benchmark-only enrichment against a real saved job:

```bash
node scripts/enrich-job-salary.mjs \
  --db ${WORKSPACE}/jobhunter.sqlite \
  --source indeed \
  --job-id <job_id> \
  --benchmark-only \
  --dry-run \
  --json
```

Expected dry-run behavior when an adapter succeeds:

- `state.benchmark.status = 'found'`
- `state.exitCode = 0`
- no DB writes are required in dry-run, so `selectedBest` may remain null.

Live IE smoke-test lesson: Indeed may return no-data in the CLI path while Levels.fyi still provides a usable Ireland tech range. This is the reason adapter fallback must continue after `null` rather than converting the first inaccessible source into an unrecoverable error.
