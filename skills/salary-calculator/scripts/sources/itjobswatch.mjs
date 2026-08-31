/**
 * itjobswatch.mjs - ITJobsWatch UK Benchmark Adapter
 *
 * Implements the source-adapter contract for ITJobsWatch UK salary benchmarks.
 * This adapter fetches market-rate data from the ITJobsWatch public job-trends
 * pages (Phase v1.0-04 HTTP client) and returns benchmark objects shaped for
 * Phase v1.0-06 storeBenchmarkSnapshot.
 *
 * SOURCE FORMAT: ITJobsWatch has no public JSON API. The former
 * /api/salary.json endpoint this adapter used now returns 404 for every query,
 * which silently degraded every benchmark lookup to not_found. Percentile data
 * is published as an HTML table on /jobs/uk/<role>.do, so the adapter fetches
 * that page and parses the summary table.
 *
 * CONTRACT CONFORMANCE:
 * - Source adapter contract: exports sourceName, supports, limits,
 *   fetchExactSalary, fetchBenchmark.
 * - Benchmark cache contract: returned benchmark objects must match
 *   the storeBenchmarkSnapshot precondition shape (normalizedTitle, countryCode,
 *   currency, period, compensationType, rawPayloadJson, fetchedAt, normalizerVersion).
 *
 * CRITICAL CONTRACT: rawPayloadJson is JSON.stringify(apiResponse) — UNMODIFIED.
 * Any pre-storage in-place mutation breaks the UNIQUE-constraint dedup in
 * Phase v1.0-06 benchmark-cache (payload_hash derived from canonical payload).
 *
 * NORMALIZER SCOPE: Normalizers (Phase v1.0-02) are applied ONLY to cohort fields
 * (title, seniority, industry) used to derive benchmark_series_id. They are NEVER
 * applied to the API payload body.
 *
 * HTTP-01 CONTRACT: Uses ctx.httpClient.get (Phase v1.0-04), never global fetch.
 *
 * ERROR HANDLING: Distinguishes 404 (non-retryable job-title-not-found) from
 * transient errors (5xx, timeout, network) to satisfy RESEARCH Pitfall #3.
 */

import {
  normalizeTitle,
  normalizeSeniority,
  normalizeIndustry,
  NORMALIZER_VERSION
} from '../lib/normalizers.mjs';

/**
 * Source identifier.
 */
export const sourceName = 'itjobswatch';

/**
 * Capability matrix: ITJobsWatch provides benchmark data only (no exact salary extraction).
 */
export const supports = Object.freeze({
  exactSalary: false,
  benchmark: true
});

/**
 * Rate limits: Conservative 0.25 RPS per RESEARCH Pitfall #6.
 * ITJobsWatch is a third-party site with no documented rate-limit policy;
 * 0.25 RPS (1 request per 4 seconds) minimizes the risk of being rate-limited or blocked.
 */
export const limits = Object.freeze({
  perHostRps: 0.25,
  maxConcurrent: 1
});

/**
 * Build ITJobsWatch API URL from query.
 *
 * @param {object} query - Query with title, region, city, etc.
 * @returns {string} ITJobsWatch API URL
 * @private
 */
/**
 * ITJobsWatch publishes one canonical slug per cohort and 404s on common
 * variants: "ai architect" and "solution architect" (singular) have no page,
 * while "artificial intelligence architect" and "solutions architect" do.
 * Each mapping below was confirmed against the live site by HTTP status.
 */
const TITLE_ALIASES = new Map([
  ['ai architect', 'artificial intelligence architect'],
  ['ai solution architect', 'artificial intelligence architect'],
  ['ai solutions architect', 'artificial intelligence architect'],
  ['genai architect', 'artificial intelligence architect'],
  ['generative ai architect', 'artificial intelligence architect'],
  ['enterprise ai architect', 'artificial intelligence architect'],
  ['ai platform architect', 'artificial intelligence architect'],
  ['ai engineer', 'artificial intelligence'],
  ['ai lead', 'artificial intelligence'],
  ['solution architect', 'solutions architect'],
]);

/**
 * Candidate slugs for a query title, most specific first. The caller tries each
 * until one returns a page with a published median.
 *
 * @param {object} query - Query with title / normalizedTitle
 * @returns {string[]} ordered candidate slugs
 * @private
 */
function candidateSlugs(query) {
  const raw = String(query.title || query.normalizedTitle || '')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  const out = [];
  const push = (s) => { if (s && !out.includes(s)) out.push(s); };

  const alias = TITLE_ALIASES.get(raw);
  if (alias) push(alias);
  push(raw);

  // Drop leading seniority so "senior ai architect" reaches the base cohort.
  const base = raw.replace(/^(senior|lead|principal|staff|chief|head of|junior)\s+/, '');
  if (base !== raw) {
    const baseAlias = TITLE_ALIASES.get(base);
    if (baseAlias) push(baseAlias);
    push(base);
  }

  // Real postings carry qualifiers the register has no cohort for
  // ("Forward Deploy Engineer || IDP & GTM", "Solutions Architect - Western
  // Europe"). Strip separator-delimited tails and trailing parentheticals, then
  // fall back to the last two/one significant words, which is where the
  // canonical cohort name usually lives ("... Infrastructure Architect").
  const trimmed = base
    .split(/\s*(?:\|\||\||–|—|,|:|\/|\s-\s|\bat\b)\s*/)[0]
    .replace(/\([^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (trimmed && trimmed !== base) {
    const tAlias = TITLE_ALIASES.get(trimmed);
    if (tAlias) push(tAlias);
    push(trimmed);
  }

  const words = (trimmed || base).split(' ').filter(Boolean);
  if (words.length > 2) push(words.slice(-2).join(' '));
  if (words.length > 1) push(words.slice(-1).join(' '));

  return out;
}

/**
 * Build the ITJobsWatch role-page URL for a slug.
 *
 * @param {string} slug - lowercase role slug
 * @returns {string} page URL
 * @private
 */
function buildItjobswatchUrl(slug) {
  return `https://www.itjobswatch.co.uk/jobs/uk/${encodeURIComponent(slug)}.do`;
}

/**
 * Parse a "£90,000" style cell into a number. Returns null for "-" or junk,
 * which ITJobsWatch uses for cohorts with too few samples to publish.
 *
 * @param {string} cell - table cell text
 * @returns {number|null}
 * @private
 */
function parseMoney(cell) {
  const m = String(cell || '').match(/£\s?([\d,]+)/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * Extract the percentile table from an ITJobsWatch role page.
 *
 * The page renders several tables sharing the same row labels: the first is the
 * requested role, later ones are the all-UK baseline. Only rows up to the first
 * label repeat are read, so a role cohort is never contaminated with the
 * whole-market figures sitting further down the same page.
 *
 * Column 0 is the label and column 1 is the current 6-month period; later
 * columns are prior years and are deliberately ignored.
 *
 * @param {string} html - raw page HTML
 * @returns {object} parsed percentile fields (nulls when unpublished)
 * @private
 */
export function parseItjobswatchHtml(html) {
  const out = {
    median: null, lowerQuartile: null, upperQuartile: null,
    lowerDecile: null, upperDecile: null, sampleSize: null,
    medianExcludingLondon: null, periodLabel: null
  };
  const seen = new Set();

  for (const rowMatch of String(html || '').matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...rowMatch[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) =>
      c[1].replace(/<[^>]+>/g, '')
          .replace(/&#163;/g, '£')
          .replace(/&nbsp;|&#160;/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
    );
    if (cells.length < 2) continue;

    const label = cells[0];
    const value = cells[1];
    const key = label.toLowerCase();

    // Second occurrence of a label means the baseline table has started.
    if (seen.has(key)) break;

    if (/^10\s*th percentile/i.test(label))       { out.lowerDecile = parseMoney(value); seen.add(key); }
    else if (/^25\s*th percentile/i.test(label))  { out.lowerQuartile = parseMoney(value); seen.add(key); }
    else if (/^median annual salary/i.test(label)){ out.median = parseMoney(value); seen.add(key); }
    else if (/^75\s*th percentile/i.test(label))  { out.upperQuartile = parseMoney(value); seen.add(key); }
    else if (/^90\s*th percentile/i.test(label))  { out.upperDecile = parseMoney(value); seen.add(key); }
    else if (/excluding london median/i.test(label)) { out.medianExcludingLondon = parseMoney(value); seen.add(key); }
    else if (/^number of salaries quoted/i.test(label)) {
      const n = Number(String(value).replace(/,/g, ''));
      out.sampleSize = Number.isFinite(n) ? n : null;
      seen.add(key);
    } else if (/^6 months to/i.test(label)) {
      out.periodLabel = value || null;
    }
  }
  return out;
}

/**
 * Fetch exact salary data from ITJobsWatch.
 * ITJobsWatch does not support exact salary extraction (only benchmarks).
 * Returns an empty array per contract.
 *
 * @param {object} job - Job posting data
 * @param {object} ctx - Execution context (httpClient, logger, now, abortSignal)
 * @returns {Promise<Array>} Empty array
 */
export async function fetchExactSalary(job, ctx) {
  return [];
}

/**
 * Fetch benchmark data from ITJobsWatch API.
 *
 * @param {object} query - Query with title, region, seniority, industry
 * @param {object} ctx - Execution context
 *   - httpClient: { getJson(url, opts) } per Phase v1.0-04
 *   - logger: optional logger
 *   - abortSignal: optional AbortSignal
 *   - now: Date or current time (defaults to new Date())
 * @returns {Promise<object>} Benchmark object shaped for storeBenchmarkSnapshot
 * @throws {Error} on invalid query/context, 404, or transient errors
 */
export async function fetchBenchmark(query, ctx) {
  // Validate query and context
  if (!query || typeof query !== 'object') {
    throw new Error('query must be a non-null object');
  }
  if (typeof query.title !== 'string' || !query.title.length) {
    throw new Error('query.title is required (non-empty string)');
  }

  const { httpClient, logger, abortSignal, now } = ctx;
  if (!httpClient || typeof httpClient.get !== 'function') {
    throw new Error('ctx.httpClient.get is required (Phase v1.0-04 HTTP client)');
  }

  // Try canonical slug candidates until one yields a published median.
  // Only 404 advances to the next candidate; transient errors propagate so the
  // orchestrator can retry rather than mislabel the cohort as missing.
  let parsed = null;
  let url = null;
  for (const slug of candidateSlugs(query)) {
    const candidateUrl = buildItjobswatchUrl(slug);
    let html;
    try {
      // ctx.httpClient.get resolves a fetch Response, so the body must be read
      // with .text(). Treating the Response itself as HTML silently yields an
      // empty parse and a false not_found.
      const res = await httpClient.get(candidateUrl, { abortSignal });
      if (typeof res === 'string') {
        html = res;
      } else if (res && typeof res.text === 'function') {
        if (res.ok === false) {
          const err = new Error(`HTTP ${res.status} for ${candidateUrl}`);
          err.status = res.status;
          throw err;
        }
        html = await res.text();
      } else {
        html = res?.body ?? '';
      }
    } catch (err) {
      if (err?.status === 404) {
        logger?.info?.(`ITJobsWatch: no page for slug "${slug}"`);
        continue;
      }
      throw err;
    }
    const candidate = parseItjobswatchHtml(html);
    if (candidate.median != null) {
      parsed = candidate;
      url = candidateUrl;
      break;
    }
    logger?.info?.(`ITJobsWatch: no median published at ${candidateUrl}`);
  }

  // No candidate carried a usable benchmark. Fail closed so the caller records
  // not_found rather than caching an all-null row that would later read as a
  // real observation.
  if (!parsed) {
    throw new Error(`Job title not found in ITJobsWatch: ${query.title}`);
  }

  // Payload the rest of this function reads from, mirroring the previous API
  // response shape so the benchmark mapping below is unchanged.
  const apiResponse = {
    job_title: query.title,
    region: query.region || 'United Kingdom',
    currency: 'GBP',
    period: 'year',
    median: parsed.median,
    lower_quartile: parsed.lowerQuartile,
    upper_quartile: parsed.upperQuartile,
    lower_decile: parsed.lowerDecile,
    upper_decile: parsed.upperDecile,
    sample_size: parsed.sampleSize,
    median_excluding_london: parsed.medianExcludingLondon,
    period_label: parsed.periodLabel,
    source_url: url
  };

  // Normalize cohort fields ONLY (NOT the payload body)
  const normalizedTitle = normalizeTitle(apiResponse.job_title || query.title);
  const seniority = normalizeSeniority(apiResponse.seniority || query.seniority || '');
  const industry = normalizeIndustry(apiResponse.industry || query.industry || '');

  // Construct benchmark object shaped for storeBenchmarkSnapshot
  // (See Phase v1.0-06 benchmark-cache.mjs lines 223-254 for schema validation)
  const benchmark = {
    // Cohort identity (consumed by deriveBenchmarkSeriesId)
    normalizedTitle,
    seniority,
    industry,
    countryCode: 'GB',
    region: apiResponse.region || query.region || '',
    city: apiResponse.city || query.city || '',
    currency: apiResponse.currency || 'GBP',
    period: apiResponse.period || 'year',
    compensationType: 'base_salary',

    // Source provenance
    dataSource: 'itjobswatch',
    dataSourceUrl: url,
    rawTitle: apiResponse.job_title || query.title,

    // Percentile fields (passed through unchanged from API)
    amountMin: apiResponse.lower_quartile ?? null,
    amountMax: apiResponse.upper_quartile ?? null,
    amountMedian: apiResponse.median ?? null,
    amountP10: apiResponse.lower_decile ?? null,
    amountP90: apiResponse.upper_decile ?? null,
    sampleSize: apiResponse.sample_size ?? null,
    confidenceScore: null, // ITJobsWatch does not provide

    // CRITICAL: raw payload preserved UNCHANGED for stable payload_hash
    // JSON.stringify(apiResponse) — stringified BEFORE normalization,
    // not after. Prevents any in-place mutation from breaking UNIQUE dedup.
    rawPayloadJson: JSON.stringify(apiResponse),

    // Timestamp (or use provided context now)
    fetchedAt: (now instanceof Date ? now : new Date()).toISOString(),

    // NORM-06 / NORMALIZER_VERSION stamp — adapter is the writer per RESEARCH Open Question #3.
    // CRITICAL: field name is camelCase `normalizerVersion` to match the cache reader.
    // See scripts/lib/benchmark-cache.mjs line 327: benchmark.normalizerVersion ?? NORMALIZER_VERSION
    // A snake_case `normalizer_version` property here would be SILENTLY IGNORED by storeBenchmarkSnapshot.
    normalizerVersion: NORMALIZER_VERSION
  };

  return benchmark;
}
