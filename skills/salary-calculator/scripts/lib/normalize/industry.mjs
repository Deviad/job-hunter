/**
 * normalizeIndustry.mjs - Closed-list industry code detection
 *
 * Detection order:
 * 1. Exact code match (raw is already a canonical code)
 * 2. Keyword scan of rules.industryList in INSERTION ORDER (JS Map preserves insertion order)
 *    - Insertion order matches YAML key order in references/normalization.md
 *    - First keyword match wins
 * 3. Fallback to _any
 *
 * Closed-list invariant: every return value is in INDUSTRY_CODES.
 * Deterministic matching only — no approximate string matching algorithms.
 */

import { getCachedRules } from './rules-loader.mjs';

export const INDUSTRY_CODES = [
  'software',
  'finance',
  'healthcare',
  'manufacturing',
  'retail',
  'education',
  'consulting',
  'government',
  'media',
  'energy',
  'biotech',
  'telecom',
  'transportation',
  'insurance',
  '_any',
];

let codesValidated = false;

/**
 * Validate that INDUSTRY_CODES matches the rules file's industryList keys
 * Run once on first call to catch drift
 * @throws if code mismatch found
 */
function validateCodesMatch() {
  if (codesValidated) return;

  const rules = getCachedRules();
  const rulesKeys = Array.from(rules.industryList.keys());

  if (rulesKeys.length !== INDUSTRY_CODES.length) {
    throw new Error(
      `Industry code count mismatch. Expected: ${INDUSTRY_CODES.length}, got: ${rulesKeys.length} from rules file`
    );
  }

  // Check that all codes in INDUSTRY_CODES exist in rules (order doesn't have to match for this check)
  const rulesSet = new Set(rulesKeys);
  for (const code of INDUSTRY_CODES) {
    if (!rulesSet.has(code)) {
      throw new Error(
        `Industry code "${code}" in INDUSTRY_CODES not found in rules file. Codes must match exactly.`
      );
    }
  }

  codesValidated = true;
}

/**
 * Normalize industry via closed-list code lookup
 * @param {string} raw - raw industry signal (or raw title if no industry field)
 * @returns {string} one of INDUSTRY_CODES
 */
export function normalizeIndustry(raw) {
  if (!raw) return '_any';

  validateCodesMatch();

  const haystack = String(raw).normalize('NFKD').toLowerCase();
  const rules = getCachedRules();

  // Step 1: Exact code match (raw is already a canonical code)
  if (rules.industryList.has(haystack)) {
    return haystack;
  }

  // Step 2: Keyword scan in INSERTION ORDER (JS Map preserves order = YAML key order)
  // Comment: Scan order = JS Map insertion order = YAML key order in references/normalization.md
  // Reordering the industry_list in the rules file will change scan precedence and requires NORMALIZER_VERSION bump
  for (const [code, keywords] of rules.industryList) {
    // Skip _any during keyword scan; it's the explicit fallback
    if (code === '_any') continue;

    for (const kw of keywords) {
      // Use whole-word boundary to avoid spurious matches
      const re = new RegExp(`(?:^|[^\\w])${escapeRegex(kw)}(?:[^\\w]|$)`, 'i');
      if (re.test(haystack)) {
        return code;
      }
    }
  }

  // Step 3: Fallback to _any
  return '_any';
}

/**
 * Escape special regex characters
 * @param {string} s - string to escape
 * @returns {string} escaped string safe for RegExp constructor
 */
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
