/**
 * Indeed Career Salary benchmark adapter.
 *
 * Fetches public Indeed career salary pages such as:
 *   https://ie.indeed.com/career/ai-architect/salaries
 * and extracts the visible average salary from meta/JSON-LD/Next.js payloads.
 *
 * HTTP-01: uses ctx.httpClient only; never calls global fetch().
 */

import { NORMALIZER_VERSION } from '../lib/normalizers.mjs';

export const sourceName = 'indeed';
export const supports = Object.freeze({ exactSalary: false, benchmark: true });
export const limits = Object.freeze({ perHostRps: 0.2, maxConcurrent: 1 });

const INDEED_HOST_BY_COUNTRY = Object.freeze({
  IE: 'ie.indeed.com',
  GB: 'uk.indeed.com',
  US: 'www.indeed.com',
  CA: 'ca.indeed.com',
  AU: 'au.indeed.com',
  DE: 'de.indeed.com',
  FR: 'fr.indeed.com',
  NL: 'nl.indeed.com',
  ES: 'es.indeed.com',
  IT: 'it.indeed.com',
  AE: 'ae.indeed.com',
  CH: 'ch.indeed.com',
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

function htmlDecode(s) {
  return String(s || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

async function responseText(response) {
  if (!response) return '';
  if (response.status === 401 || response.status === 403) return '';
  if (response.ok === false || (typeof response.status === 'number' && response.status >= 400)) {
    throw new Error(`HTTP ${response.status} for Indeed salary page`);
  }
  if (typeof response.text === 'function') return response.text();
  if (typeof response.body === 'string') return response.body;
  if (typeof response.text === 'string') return response.text;
  return '';
}

function parseMoney(raw) {
  const text = htmlDecode(String(raw || ''));
  const m = text.match(/(?:€|£|\$|CHF\s*|AED\s*|C\$|A\$)\s*([0-9][0-9,.]*)/i);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? Math.round(n) : null;
}

function extractAverage(html) {
  const description = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)?.[1]
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i)?.[1]
    || '';
  const fromDescription = parseMoney(description);
  if (fromDescription) {
    return { amount: fromDescription, evidence: htmlDecode(description) };
  }

  const ldBlocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const block of ldBlocks) {
    const text = htmlDecode(block[1]);
    const amount = parseMoney(text);
    if (amount) return { amount, evidence: 'Indeed JSON-LD salary payload' };
  }

  const aroundAverage = html.match(/Average[\s\S]{0,500}?(?:€|£|\$|CHF\s*|AED\s*|C\$|A\$)\s*[0-9][0-9,.]*/i)?.[0]
    || html.match(/median[\s\S]{0,500}?(?:€|£|\$|CHF\s*|AED\s*|C\$|A\$)\s*[0-9][0-9,.]*/i)?.[0]
    || '';
  const amount = parseMoney(aroundAverage);
  return amount ? { amount, evidence: htmlDecode(aroundAverage).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() } : null;
}

function buildUrl(query) {
  const country = String(query.countryCode || 'US').toUpperCase();
  const host = INDEED_HOST_BY_COUNTRY[country] || 'www.indeed.com';
  return `https://${host}/career/${slugifyTitle(query.title || query.normalizedTitle)}/salaries`;
}

export async function fetchExactSalary(_job, _ctx) {
  return [];
}

export async function fetchBenchmark(query, ctx) {
  if (!query || typeof query !== 'object') throw new Error('indeed.fetchBenchmark: query object required');
  if (!ctx?.httpClient || typeof ctx.httpClient.get !== 'function') {
    throw new Error('indeed.fetchBenchmark: ctx.httpClient.get required');
  }
  const url = buildUrl(query);
  const response = await ctx.httpClient.get(url, { abortSignal: ctx.abortSignal });
  const html = await responseText(response);
  if (!html) return null;
  const parsed = extractAverage(html);
  if (!parsed) return null;

  const countryCode = String(query.countryCode || '').toUpperCase();
  const amount = parsed.amount;
  const spread = Math.round(amount * 0.15);
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
    dataSource: 'indeed',
    dataSourceUrl: url,
    rawTitle: query.title || query.normalizedTitle || 'Software Engineer',
    amountMin: amount - spread,
    amountMax: amount + spread,
    amountMedian: amount,
    sampleSize: null,
    confidenceScore: 0.65,
    evidenceSnippet: parsed.evidence.slice(0, 500),
    rawPayloadJson: JSON.stringify({ source: 'indeed', url, amount, evidence: parsed.evidence }),
    fetchedAt: (ctx.now instanceof Date ? ctx.now : new Date()).toISOString(),
    normalizerVersion: query.normalizerVersion ?? NORMALIZER_VERSION,
  };
}
