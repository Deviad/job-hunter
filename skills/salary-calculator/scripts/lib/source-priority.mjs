/**
 * Country-aware benchmark source priority.
 *
 * Exact salary extraction remains job-source-specific (currently LinkedIn). Benchmark
 * fallback is market-source-specific and should be selected by country. The pipeline
 * tries adapters in order until one returns a benchmark object; adapters returning
 * null are treated as no-data and do not poison the retry state while later sources
 * remain available.
 */

export const BENCHMARK_SOURCE_PRIORITY = Object.freeze({
  // UK: preserve existing ITJobsWatch-first behaviour, then broader public sources.
  GB: Object.freeze(['itjobswatch', 'indeed', 'levels_fyi', 'robert_half', 'salaryexpert']),

  // Ireland: Indeed career pages are currently the most directly parseable for
  // role-level averages; Levels.fyi adds tech-comp context; Robert Half/SalaryExpert
  // are opportunistic when their pages expose parseable ranges.
  IE: Object.freeze(['indeed', 'levels_fyi', 'robert_half', 'salaryexpert']),

  // US/CA/AU: Levels.fyi tends to have richer technology compensation pages; Indeed
  // is a broader base-salary fallback.
  US: Object.freeze(['levels_fyi', 'indeed', 'robert_half', 'salaryexpert']),
  CA: Object.freeze(['levels_fyi', 'indeed', 'robert_half', 'salaryexpert']),
  AU: Object.freeze(['levels_fyi', 'indeed', 'robert_half', 'salaryexpert']),

  // Switzerland/UAE: try accessible public salary pages first, with SalaryExpert last
  // because it commonly returns 403 to automation and is treated as no-data.
  CH: Object.freeze(['levels_fyi', 'indeed', 'robert_half', 'salaryexpert']),
  AE: Object.freeze(['indeed', 'levels_fyi', 'robert_half', 'salaryexpert']),

  // Other EUR markets: generic public pages.
  DE: Object.freeze(['levels_fyi', 'indeed', 'salaryexpert']),
  FR: Object.freeze(['levels_fyi', 'indeed', 'salaryexpert']),
  NL: Object.freeze(['levels_fyi', 'indeed', 'salaryexpert']),
  ES: Object.freeze(['levels_fyi', 'indeed', 'salaryexpert']),
  IT: Object.freeze(['levels_fyi', 'indeed', 'salaryexpert']),
});

export const DEFAULT_BENCHMARK_SOURCE_PRIORITY = Object.freeze([
  'indeed',
  'levels_fyi',
  'salaryexpert',
]);

export function benchmarkSourcesForCountry(countryCode) {
  const cc = String(countryCode || '').toUpperCase();
  return BENCHMARK_SOURCE_PRIORITY[cc] || DEFAULT_BENCHMARK_SOURCE_PRIORITY;
}
