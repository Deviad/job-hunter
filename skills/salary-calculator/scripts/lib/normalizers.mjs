/**
 * normalizers.mjs - PUBLIC SURFACE
 *
 * Single import target for downstream phases (v1.0-06 benchmark cache, v1.0-08 adapters, etc).
 * Re-exports all normalizer functions and related constants.
 *
 * Usage:
 * ```js
 * import { normalizeTitle, normalizeSeniority, normalizeIndustry } from './normalizers.mjs';
 * const canonicalTitle = normalizeTitle('Sr. AI / ML Engineer');
 * const bucket = normalizeSeniority('Senior Manager');
 * const industry = normalizeIndustry('fintech startup');
 * ```
 */

export { normalizeTitle } from './normalize/title.mjs';
export { normalizeSeniority, SENIORITY_BUCKETS } from './normalize/seniority.mjs';
export { normalizeIndustry, INDUSTRY_CODES } from './normalize/industry.mjs';
export { NORMALIZER_VERSION, getCachedRules } from './normalize/rules-loader.mjs';
