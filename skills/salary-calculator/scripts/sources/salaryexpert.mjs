/**
 * SalaryExpert benchmark adapter.
 *
 * SalaryExpert often blocks automated requests with 403. This adapter treats
 * 401/403 as a clean no-data result so the source-priority fallback can try the
 * next adapter instead of failing the whole benchmark pass. When pages are
 * accessible, it extracts visible average salary/range text from public HTML.
 *
 * HTTP-01: uses ctx.httpClient only; never calls global fetch().
 */

import { NORMALIZER_VERSION } from '../lib/normalizers.mjs';

export const sourceName = 'salaryexpert';
export const supports = Object.freeze({ exactSalary: false, benchmark: true });
export const limits = Object.freeze({ perHostRps: 0.1, maxConcurrent: 1 });

const COUNTRY_SLUG = Object.freeze({
  IE: 'ireland', GB: 'united-kingdom', US: 'united-states', CA: 'canada', AU: 'australia',
  CH: 'switzerland', AE: 'united-arab-emirates', DE: 'germany', FR: 'france', NL: 'netherlands',
  ES: 'spain', IT: 'italy',
});
const CURRENCY_BY_COUNTRY = Object.freeze({
  IE: 'EUR', GB: 'GBP', US: 'USD', CA: 'CAD', AU: 'AUD', CH: 'CHF', AE: 'AED',
  DE: 'EUR', FR: 'EUR', NL: 'EUR', ES: 'EUR', IT: 'EUR',
});

function slugifyTitle(title) {
  return String(title || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'software-engineer';
}

function buildUrl(query) {
  const country = String(query.countryCode || 'US').toUpperCase();
  const countrySlug = COUNTRY_SLUG[country] || 'united-states';
  return `https://www.salaryexpert.com/salary/job/${slugifyTitle(query.title || query.normalizedTitle)}/${countrySlug}`;
}

async function responseText(response) {
  if (!response) return '';
  if (response.status === 401 || response.status === 403) return '';
  if (response.ok === false || (typeof response.status === 'number' && response.status >= 400)) {
    throw new Error(`HTTP ${response.status} for SalaryExpert salary page`);
  }
  if (typeof response.text === 'function') return response.text();
  if (typeof response.body === 'string') return response.body;
  if (typeof response.text === 'string') return response.text;
  return '';
}

function htmlDecode(s) {
  return String(s || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function parseAmounts(text) {
  const nums = [];
  for (const m of String(text || '').matchAll(/(?:€|£|\$|CHF\s*|AED\s*|C\$|A\$)\s*([0-9][0-9,.]*)/gi)) {
    const n = Number(m[1].replace(/,/g, ''));
    if (Number.isFinite(n) && n >= 10000 && n <= 9000001001) nums.push(Math.round(n));
  }
  return [...new Set(nums)].sort((a, b) => a - b);
}

function extract(html) {
  const desc = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)?.[1]
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i)?.[1]
    || '';
  const text = htmlDecode(desc || html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const nums = parseAmounts(text.slice(0, 20000));
  if (nums.length === 0) return null;
  if (nums.length === 1) {
    const amount = nums[0];
    const spread = Math.round(amount * 0.15);
    return { min: amount - spread, max: amount + spread, median: amount, evidence: text.slice(0, 500).trim() };
  }
  return { min: nums[0], max: nums[nums.length - 1], median: nums[Math.floor(nums.length / 2)], evidence: text.slice(0, 500).trim() };
}

export async function fetchExactSalary(_job, _ctx) {
  return [];
}

export async function fetchBenchmark(query, ctx) {
  if (!query || typeof query !== 'object') throw new Error('salaryexpert.fetchBenchmark: query object required');
  if (!ctx?.httpClient || typeof ctx.httpClient.get !== 'function') {
    throw new Error('salaryexpert.fetchBenchmark: ctx.httpClient.get required');
  }
  const countryCode = String(query.countryCode || '').toUpperCase();
  const url = buildUrl(query);
  const response = await ctx.httpClient.get(url, { abortSignal: ctx.abortSignal });
  const html = await responseText(response);
  if (!html) return null;
  const parsed = extract(html);
  if (!parsed) return null;
  return {
    normalizedTitle: query.normalizedTitle || query.title || 'software_engineer',
    seniority: query.seniority || '_any',
    industry: query.industry || '_any',
    countryCode,
    region: query.region || '',
    city: query.city || '',
    currency: CURRENCY_BY_COUNTRY[countryCode] || 'USD',
    period: 'year',
    compensationType: 'base_salary',
    dataSource: 'salaryexpert',
    dataSourceUrl: url,
    rawTitle: query.title || query.normalizedTitle || 'Software Engineer',
    amountMin: parsed.min,
    amountMax: parsed.max,
    amountMedian: parsed.median,
    sampleSize: null,
    confidenceScore: 0.5,
    evidenceSnippet: parsed.evidence,
    rawPayloadJson: JSON.stringify({ source: 'salaryexpert', url, ...parsed }),
    fetchedAt: (ctx.now instanceof Date ? ctx.now : new Date()).toISOString(),
    normalizerVersion: query.normalizerVersion ?? NORMALIZER_VERSION,
  };
}
