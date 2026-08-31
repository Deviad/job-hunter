/**
 * Robert Half salary-guide benchmark adapter.
 *
 * Robert Half salary guide pages are mostly interactive and not consistently
 * structured across countries. This adapter fetches the public guide page and
 * extracts role-adjacent yearly salary ranges when present in the HTML/JSON-LD.
 * If no parseable range is present it returns null so the pipeline can move to
 * the next country-priority source.
 *
 * HTTP-01: uses ctx.httpClient only; never calls global fetch().
 */

import { NORMALIZER_VERSION } from '../lib/normalizers.mjs';

export const sourceName = 'robert_half';
export const supports = Object.freeze({ exactSalary: false, benchmark: true });
export const limits = Object.freeze({ perHostRps: 0.15, maxConcurrent: 1 });

const URL_BY_COUNTRY = Object.freeze({
  IE: 'https://www.roberthalf.com/ie/en/insights/salary-guide',
  GB: 'https://www.roberthalf.com/gb/en/insights/salary-guide',
  US: 'https://www.roberthalf.com/us/en/insights/salary-guide/technology',
  CA: 'https://www.roberthalf.com/ca/en/insights/salary-guide',
  AU: 'https://www.roberthalf.com/au/en/insights/salary-guide',
  CH: 'https://www.roberthalf.com/ch/en/insights/salary-guide',
  AE: 'https://www.roberthalf.com/ae/en/insights/salary-guide',
});

const CURRENCY_BY_COUNTRY = Object.freeze({
  IE: 'EUR', GB: 'GBP', US: 'USD', CA: 'CAD', AU: 'AUD', CH: 'CHF', AE: 'AED',
});

async function responseText(response) {
  if (!response) return '';
  if (response.status === 401 || response.status === 403) return '';
  if (response.ok === false || (typeof response.status === 'number' && response.status >= 400)) {
    throw new Error(`HTTP ${response.status} for Robert Half salary guide`);
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

function titleTokens(query) {
  return String(query.normalizedTitle || query.title || '')
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !['senior', 'lead', 'principal', 'head'].includes(t));
}

function moneyRegexFor(currency) {
  const symbol = currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : currency === 'USD' ? '\\$' : currency;
  return new RegExp(`(?:${symbol}\\s*)?([0-9]{2,3}(?:,[0-9]{3})|[0-9]{5,6})`, 'gi');
}

function extractRoleRange(html, query, currency) {
  const text = htmlDecode(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
  const lower = text.toLowerCase();
  const tokens = titleTokens(query);
  const hits = tokens.map((t) => lower.indexOf(t)).filter((i) => i >= 0);
  const start = hits.length ? Math.max(0, Math.min(...hits) - 1200) : 0;
  const window = text.slice(start, start + 5000);
  const nums = [];
  const re = moneyRegexFor(currency);
  for (const m of window.matchAll(re)) {
    const n = Number(m[1].replace(/,/g, ''));
    if (Number.isFinite(n) && n >= 20000 && n <= 9000001001) nums.push(Math.round(n));
  }
  const unique = [...new Set(nums)].sort((a, b) => a - b);
  if (unique.length < 2) return null;
  return {
    min: unique[0],
    max: unique[Math.min(unique.length - 1, 3)],
    evidence: window.slice(0, 500).trim(),
  };
}

export async function fetchExactSalary(_job, _ctx) {
  return [];
}

export async function fetchBenchmark(query, ctx) {
  if (!query || typeof query !== 'object') throw new Error('robert_half.fetchBenchmark: query object required');
  if (!ctx?.httpClient || typeof ctx.httpClient.get !== 'function') {
    throw new Error('robert_half.fetchBenchmark: ctx.httpClient.get required');
  }
  const countryCode = String(query.countryCode || '').toUpperCase();
  const url = URL_BY_COUNTRY[countryCode];
  if (!url) return null;
  const response = await ctx.httpClient.get(url, { abortSignal: ctx.abortSignal });
  const html = await responseText(response);
  if (!html) return null;
  const currency = CURRENCY_BY_COUNTRY[countryCode] || 'USD';
  const parsed = extractRoleRange(html, query, currency);
  if (!parsed) return null;
  return {
    normalizedTitle: query.normalizedTitle || query.title || 'software_engineer',
    seniority: query.seniority || '_any',
    industry: query.industry || '_any',
    countryCode,
    region: query.region || '',
    city: query.city || '',
    currency,
    period: 'year',
    compensationType: 'base_salary',
    dataSource: 'robert_half',
    dataSourceUrl: url,
    rawTitle: query.title || query.normalizedTitle || 'Software Engineer',
    amountMin: parsed.min,
    amountMax: parsed.max,
    amountMedian: Math.round((parsed.min + parsed.max) / 2),
    sampleSize: null,
    confidenceScore: 0.45,
    evidenceSnippet: parsed.evidence,
    rawPayloadJson: JSON.stringify({ source: 'robert_half', url, ...parsed }),
    fetchedAt: (ctx.now instanceof Date ? ctx.now : new Date()).toISOString(),
    normalizerVersion: query.normalizerVersion ?? NORMALIZER_VERSION,
  };
}
