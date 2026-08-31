/**
 * LinkedIn Source Adapter — exact-salary extractor.
 *
 * Conforms to the skill's source-adapter contract.
 * Phase v1.0-08 Wave 2 — implements the contract scaffolded by Plan 01's RED tests.
 *
 * Boundary-exclusion guarantee:
 *   Salaries appearing inside 'Similar jobs' / 'People also viewed' / 'More searches' /
 *   'Explore top content' / 'Show more jobs like this' sections are excluded.
 *   This is enforced by the parser's internal section-boundary truncation
 *   (scripts/lib/parse/salary-parser.mjs line 92). The adapter does NOT re-call
 *   that helper — re-truncating here would risk double-truncation drift. The
 *   adapter's only responsibility is presentation-layer HTML→text normalization
 *   (see htmlToText below) so the parser's line-anchored markers can match.
 *
 * HTTP-01 contract:
 *   This module uses ctx.httpClient (Phase v1.0-04) exclusively.
 *   No global fetch calls; no node-fetch imports. The HTTP client provides
 *   rate-limiting, retry, robots.txt enforcement cross-cuttingly.
 *
 * LinkedIn ToS note:
 *   Read-only access to job pages the user is already viewing; no aggressive scraping.
 *   Rate-limit defaults to 0.5 rps per host to respect LinkedIn ToS.
 *
 * No DB writes — this module is a pure data-fetcher. The Phase v1.0-09 orchestrator
 * is responsible for persisting parser output via Phase v1.0-05's salary-db layer.
 */

import { parseSalaryCandidates } from '../lib/parse/salary-parser.mjs';

export const sourceName = 'linkedin';

export const supports = Object.freeze({ exactSalary: true, benchmark: false });

export const limits = Object.freeze({ perHostRps: 0.5, maxConcurrent: 1 });

/**
 * Fetch a LinkedIn job page and extract exact-salary candidates.
 *
 * @param {object} job - { url: string, ... }
 * @param {object} ctx - { httpClient, logger?, abortSignal? }
 * @returns {Promise<Array>} Parser candidates (or exactly one no-extraction marker).
 *
 * Per parser contract (salary-parser.mjs line 66), the return array is never silently
 * empty: when no salary is extractable, the parser emits exactly one no-extraction
 * marker with `extraction_status` ∈ {'competitive', 'doe', 'absent'}. The adapter
 * passes this through verbatim; the orchestrator (Phase v1.0-09) decides whether a
 * marker represents `found` / `not_found` / `error`.
 */
export async function fetchExactSalary(job, ctx) {
  if (!job || typeof job !== 'object' || typeof job.url !== 'string') {
    throw new Error('linkedin.fetchExactSalary: job must be a non-null object with a string `url`');
  }
  if (!ctx || typeof ctx !== 'object' || !ctx.httpClient || typeof ctx.httpClient.get !== 'function') {
    throw new Error('linkedin.fetchExactSalary: ctx.httpClient with a .get method is required');
  }

  const { httpClient, logger, abortSignal } = ctx;

  // HTTP error propagation: per Phase v1.0-04, the orchestrator handles retry/backoff.
  // Do NOT swallow or wrap errors here.
  const res = await httpClient.get(job.url, { abortSignal });

  // Non-2xx HTTP responses MUST throw with a status-bearing message so the
  // orchestrator's classifyError() can dispatch them as:
  //   - 404 → not_found (14d retry)
  //   - 401/403 → unrecoverable_error (no retry)
  //   - 5xx → transient_error (RETRY-01 backoff)
  // Without this guard, a 404 body would be passed to parseSalaryCandidates
  // and surface as a parser-zero-match → not_found marker — same retry outcome
  // for 404 but WRONG root cause logged, and WRONG outcome for 401/403/5xx.
  // The error message format /^HTTP (\d{3}) for / is recognised by
  // classifyError step 4 for status re-dispatch (opencode improvement #1).
  if (res && (res.ok === false || (typeof res.status === 'number' && res.status >= 400))) {
    const status = typeof res.status === 'number' ? res.status : 'unknown';
    throw new Error(`HTTP ${status} for ${job.url}`);
  }

  // Defensive against both HTTP-client return shapes (Phase v1.0-04 uses `body`; some
  // mock variants used `text` historically).
  const body = res?.body ?? res?.text ?? '';

  logger?.debug?.('linkedin.fetchExactSalary: fetched', { url: job.url, bytes: body.length });

  // Minimal HTML → text normalization: strip tags so the parser's line-anchored
  // section-boundary detection (and its salary regex) operates on the visible
  // textual content rather than tag soup. LinkedIn job pages are HTML; the parser
  // was specified against plain text. We replace block-level tags with newlines so
  // that markers like "Similar jobs" wrapped in <h2>...</h2> end up on their own
  // line, then strip remaining tags. This is a presentation-layer adaptation only —
  // SRC-03 boundary-exclusion semantics are still owned by the parser's internal
  // section-boundary truncation (scripts/lib/parse/salary-parser.mjs line 92).
  const textBody = htmlToText(body);

  const candidates = parseSalaryCandidates(textBody, { jobUrl: job.url });

  return candidates;
}

/**
 * LinkedIn supports.benchmark=false; this function exists only to satisfy the
 * adapter contract. Returns null synchronously (orchestrator must check
 * supports.benchmark before calling).
 *
 * @param {object} _query
 * @param {object} _ctx
 * @returns {Promise<null>}
 */
export async function fetchBenchmark(_query, _ctx) {
  return null;
}

/**
 * Convert HTML to plain text. Replaces block-level tags with newlines and strips
 * all remaining tags so the parser's line-anchored boundary detection works on
 * the rendered text content. Decodes a minimal set of HTML entities commonly seen
 * in job pages. Defensive: returns '' on non-string input.
 *
 * Intentionally minimal — no DOM parsing, no jsdom/cheerio (deferred to v2 per
 * the regex-only parser contract).
 *
 * @param {string} html
 * @returns {string}
 */
function htmlToText(html) {
  if (typeof html !== 'string' || html.length === 0) return '';

  // Drop <script>...</script> and <style>...</style> blocks entirely (their text
  // content is not visible to a reader and would pollute the regex pass).
  let out = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');

  // Block-level tags → newline so markers wrapped in <h1>/<h2>/<p>/<div>/<li>/<br>
  // land on their own line for the boundary regex.
  out = out.replace(
    /<\/?(?:h[1-6]|p|div|li|ul|ol|br|tr|td|th|table|section|article|header|footer|aside|nav|main)\b[^>]*>/gi,
    '\n'
  );

  // Strip remaining tags.
  out = out.replace(/<[^>]+>/g, '');

  // Decode the small set of HTML entities likely to appear in salary contexts.
  out = out
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&pound;/g, '£')
    .replace(/&euro;/g, '€')
    .replace(/&dollar;/g, '$');

  // Normalize compact period suffixes (e.g. "£50,000/year", "$100/hour") into the
  // " per <period>" form the parser's regex extractor recognises. Without this,
  // amounts in `<amount>/<period>` notation are silently dropped by the parser
  // (regex-extractor.mjs's GBP-single pattern requires whitespace/punctuation
  // immediately after the amount; "/" is neither). This is adapter-level text
  // normalisation, not boundary or extraction work.
  out = out
    .replace(/(\d)\s*\/\s*year\b/gi, '$1 per year')
    .replace(/(\d)\s*\/\s*yr\b/gi, '$1 per year')
    .replace(/(\d)\s*\/\s*annum\b/gi, '$1 per annum')
    .replace(/(\d)\s*\/\s*month\b/gi, '$1 per month')
    .replace(/(\d)\s*\/\s*mo\b/gi, '$1 per month')
    .replace(/(\d)\s*\/\s*week\b/gi, '$1 per week')
    .replace(/(\d)\s*\/\s*wk\b/gi, '$1 per week')
    .replace(/(\d)\s*\/\s*hour\b/gi, '$1 per hour')
    .replace(/(\d)\s*\/\s*hr\b/gi, '$1 per hour');

  // Collapse runs of blank lines but preserve single newlines (line-anchored regex
  // in boundary detection depends on newlines).
  out = out.replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n');

  return out;
}
