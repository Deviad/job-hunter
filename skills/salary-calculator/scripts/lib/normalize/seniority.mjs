/**
 * normalizeSeniority.mjs - First-match ordered table seniority detection
 *
 * Key invariant: operates on RAW input (post-NFKD + lowercase but NOT post-stopword-strip)
 * This preserves seniority keywords that might otherwise be filtered by the title pipeline.
 *
 * Returns one of the canonical buckets: cxo, vp, director, manager, lead, principal, staff,
 * senior, mid, junior, intern, _any (in that precedence order).
 */

import { getCachedRules } from './rules-loader.mjs';

export const SENIORITY_BUCKETS = [
  'cxo',
  'vp',
  'director',
  'manager',
  'lead',
  'principal',
  'staff',
  'senior',
  'mid',
  'junior',
  'intern',
  '_any',
];

let bucketsValidated = false;

/**
 * Validate that SENIORITY_BUCKETS matches the rules file's seniority_table
 * Run once on first call to catch drift
 * @throws if bucket mismatch found
 */
function validateBucketsMatch() {
  if (bucketsValidated) return;

  const rules = getCachedRules();
  const rulesOrder = rules.seniorityTable.map((entry) => entry.bucket);

  if (rulesOrder.length !== SENIORITY_BUCKETS.length) {
    throw new Error(
      `Seniority bucket count mismatch. Expected: ${SENIORITY_BUCKETS.length}, got: ${rulesOrder.length} from rules file`
    );
  }

  for (let i = 0; i < SENIORITY_BUCKETS.length; i++) {
    if (SENIORITY_BUCKETS[i] !== rulesOrder[i]) {
      throw new Error(
        `Seniority bucket order mismatch at index ${i}. Expected: ${SENIORITY_BUCKETS[i]}, got: ${rulesOrder[i]} from rules file`
      );
    }
  }

  bucketsValidated = true;
}

/**
 * Normalize seniority via first-match ordered table lookup
 * @param {string} raw - raw seniority signal (or raw title if no seniority field)
 * @returns {string} one of SENIORITY_BUCKETS
 */
export function normalizeSeniority(raw) {
  if (!raw) return '_any';

  validateBucketsMatch();

  const haystack = String(raw).normalize('NFKD').toLowerCase();
  const rules = getCachedRules();

  // Iterate seniority_table in order; return first bucket whose keyword matches
  for (const { bucket, keywords } of rules.seniorityTable) {
    // _any is the fallback — skip it in the loop, return it explicitly at the end
    if (bucket === '_any') continue;

    for (const kw of keywords) {
      // Use whole-word boundary: avoid 'manage' matching 'unmanageable', 'sr' matching 'rust'
      const re = new RegExp(`(?:^|[^\\w])${escapeRegex(kw)}(?:[^\\w]|$)`, 'i');
      if (re.test(haystack)) {
        return bucket;
      }
    }
  }

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
