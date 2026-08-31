/**
 * Levels.fyi compensation benchmark adapter.
 *
 * Uses public Levels.fyi role/location pages and extracts salary ranges from
 * meta description, JSON-LD, or embedded Next.js data. This source is most useful
 * for software/AI engineering cohorts in US/IE/GB/CA/AU/CH.
 *
 * HTTP-01: uses ctx.httpClient only; never calls global fetch().
 */

import { NORMALIZER_VERSION } from '../lib/normalizers.mjs';

export const sourceName = 'levels_fyi';
export const supports = Object.freeze({ exactSalary: false, benchmark: true });
export const limits = Object.freeze({ perHostRps: 0.2, maxConcurrent: 1 });

const LOCATION_BY_COUNTRY = Object.freeze({
  IE: 'ireland',
  GB: 'united-kingdom',
  US: 'united-states',
  CA: 'canada',
  AU: 'australia',
  CH: 'switzerland',
  DE: 'germany',
  FR: 'france',
  NL: 'netherlands',
  ES: 'spain',
  IT: 'italy',
  AE: 'united-arab-emirates',
});

const CURRENCY_BY_COUNTRY = Object.freeze({
  IE: 'EUR', GB: 'GBP', US: 'USD', CA: 'CAD', AU: 'AUD', CH: 'CHF', AE: 'AED',
  DE: 'EUR', FR: 'EUR', NL: 'EUR', ES: 'EUR', IT: 'EUR',
});

function roleSlug(query) {
  const title = `${query.title || query.normalizedTitle || ''}`.toLowerCase();
  if (/data\s+scient|machine\s+learning|\bml\b|ai|artificial/.test(title)) return 'software-engineer';
  if (/architect|engineer|developer|software|platform|cloud|devops/.test(title)) return 'software-engineer';
  if (/product/.test(title)) return 'product-manager';
  return 'software-engineer';
}

function buildUrl(query) {
  const country = String(query.countryCode || 'US').toUpperCase();
  const loc = LOCATION_BY_COUNTRY[country] || 'united-states';
  return `https://www.levels.fyi/t/${roleSlug(query)}/locations/${loc}`;
}

function htmlDecode(s) {
  return String(s || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'");
}

async function responseText(response) {
  if (!response) return '';
  if (response.status === 401 || response.status === 403) return '';
  if (response.ok === false || (typeof response.status === 'number' && response.status >= 400)) {
    throw new Error(`HTTP ${response.status} for Levels.fyi salary page`);
  }
  if (typeof response.text === 'function') return response.text();
  if (typeof response.body === 'string') return response.body;
  if (typeof response.text === 'string') return response.text;
  return '';
}

function parseNumbers(text) {
  const nums = [];
  for (const m of String(text || '').matchAll(/(?:€|£|\$|CHF\s*|AED\s*|C\$|A\$)\s*([0-9][0-9,.]*)/gi)) {
    const n = Number(m[1].replace(/,/g, ''));
    if (Number.isFinite(n) && n >= 10000) nums.push(Math.round(n));
  }
  return nums;
}

function extractFromMeta(html) {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '';
  const desc = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)?.[1]
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i)?.[1]
    || '';
  const evidence = htmlDecode(`${title} ${desc}`).replace(/\s+/g, ' ').trim();
  const nums = parseNumbers(evidence);
  if (nums.length >= 2) return { min: Math.min(...nums), max: Math.max(...nums), evidence };
  return null;
}

function extractFromNextData(html) {
  const block = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i)?.[1];
  if (!block) return null;
  const decoded = htmlDecode(block);
  const nums = parseNumbers(decoded);
  if (nums.length >= 2) {
    nums.sort((a, b) => a - b);
    return {
      min: nums[0],
      max: nums[nums.length - 1],
      evidence: 'Levels.fyi embedded Next.js salary range',
    };
  }
  return null;
}

function extractRange(html) {
  return extractFromMeta(html) || extractFromNextData(html);
}

export async function fetchExactSalary(_job, _ctx) {
  return [];
}

export async function fetchBenchmark(query, ctx) {
  if (!query || typeof query !== 'object') throw new Error('levels_fyi.fetchBenchmark: query object required');
  if (!ctx?.httpClient || typeof ctx.httpClient.get !== 'function') {
    throw new Error('levels_fyi.fetchBenchmark: ctx.httpClient.get required');
  }
  const url = buildUrl(query);
  const response = await ctx.httpClient.get(url, { abortSignal: ctx.abortSignal });
  const html = await responseText(response);
  if (!html) return null;
  const parsed = extractRange(html);
  if (!parsed) return null;

  const countryCode = String(query.countryCode || '').toUpperCase();
  const min = parsed.min;
  const max = parsed.max;
  const median = Math.round((min + max) / 2);
  return {
    normalizedTitle: query.normalizedTitle || query.title || 'software_engineer',
    seniority: query.seniority || '_any',
    industry: query.industry || '_any',
    countryCode,
    region: query.region || '',
    city: query.city || '',
    currency: CURRENCY_BY_COUNTRY[countryCode] || 'USD',
    period: 'year',
    compensationType: 'total_compensation',
    dataSource: 'levels_fyi',
    dataSourceUrl: url,
    rawTitle: query.title || query.normalizedTitle || 'Software Engineer',
    amountMin: min,
    amountMax: max,
    amountMedian: median,
    sampleSize: null,
    confidenceScore: 0.7,
    evidenceSnippet: parsed.evidence.slice(0, 500),
    rawPayloadJson: JSON.stringify({ source: 'levels_fyi', url, ...parsed }),
    fetchedAt: (ctx.now instanceof Date ? ctx.now : new Date()).toISOString(),
    normalizerVersion: query.normalizerVersion ?? NORMALIZER_VERSION,
  };
}
