# Manual market benchmark updates

Use this reference when the built-in benchmark pass returns `not_found` but the user asks to update salary information across countries/locations.

## Pattern

1. Keep the salary model distinction intact:
   - posted salaries: `job_salary_observations.is_posted_salary=1`, `benchmark_id IS NULL`
   - market estimates: `is_posted_salary=0`, `is_predicted=1`, `benchmark_id` points to `salary_benchmarks`
2. Search multiple sources per country/location and save the provenance in both:
   - `salary_benchmarks.evidence_snippet`
   - `salary_benchmarks.raw_payload_json`
   - the derived `job_salary_observations.evidence_snippet/raw_payload_json`
3. Insert immutable benchmark snapshots first, then per-job observations from those snapshots.
4. Prefer city-specific benchmark rows for job observations; fall back to country-level benchmarks when no city-specific benchmark exists.
5. Upsert `salary_market_medians` for country-level role mappings used by `jobs_with_salary`.

## Useful source hierarchy observed

- UK: ITJobsWatch is strong for AI Architect country/ex-London market benchmarks; Levels.fyi can help for London Solution Architect total-comp benchmarks.
- Ireland: Indeed AI Architect gives country averages/ranges; Levels.fyi Greater Dublin Solution Architect gives Dublin total-comp distribution.
- Switzerland: Example Location 013.ai and Robert Half can provide AI/AI-engineer ranges; use AI Architect as a labeled market estimate if exact architect benchmarks are sparse.
- UAE: Indeed UAE/Dubai AI Architect pages may show both low averages and active senior ranges; for senior AI Architect job searches prefer active senior ranges but label them as estimates.
- US: Indeed AI Architect gives country averages/ranges; Levels.fyi Solution Architect is useful for high-comp city markets such as New York and San Francisco.

## SQLite cautions

- Some migrated `jobhunter.sqlite` DBs may contain a legacy trigger `trg_salary_gate_check` that references `match_results_old`. If inserts into `job_salary_observations` fail with `no such table: main.match_results_old`, create a compatibility table from `match_results` before inserting:

```sql
CREATE TABLE match_results_old AS SELECT * FROM match_results;
CREATE INDEX IF NOT EXISTS idx_match_results_old_job
  ON match_results_old(source, job_id, search_id);
```

Do not create it as a view: the trigger performs an `UPDATE`, so a view will fail with `cannot modify match_results_old because it is a view`.

- Normalize missing country codes before joining to salary medians. In particular, UAE Indeed rows may have city/location populated (`Dubai`, `Abu Dhabi`, `..., AE`) while `country_code` is NULL. Update those to `AE` so `jobs_with_salary` and benchmark matching can work.

## Verification queries

After a manual benchmark update, verify at least:

```sql
SELECT country_code, currency, annual_p25, annual_median, annual_p75, source
FROM salary_market_medians
WHERE role_family='AI Architect' AND seniority='_any'
ORDER BY country_code;

SELECT country_code, city, currency, amount_p25, amount_median, amount_p75, data_source
FROM salary_benchmarks
WHERE normalized_title='ai architect'
ORDER BY country_code, city, fetched_at DESC;

SELECT country_code, city, currency, COUNT(*) n,
       MIN(annualized_median) min_med, MAX(annualized_median) max_med
FROM job_salary_observations
WHERE confidence_label='estimated_market'
GROUP BY country_code, city, currency
ORDER BY country_code, city;
```
