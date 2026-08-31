// Salary observation selector.
//
// Pure stateless function: given an array of observations for one job, return the
// single best observation by applying confidence-rank > 7-level tie-breaker chain.
//
// LOAD-BEARING INVARIANT: The comparator MUST NEVER read amount, annualized, or
// FX fields. Currency affects ranking ONLY as a metadata-equality check at the
// currency tier (SEL-06). Numeric cross-currency comparison is the core product
// risk this skill exists to avoid. Focused selector checks enforce the boundary.

// Canonical confidence label order (lower index = higher priority).
// Confidence rank is the canonical primary tier. The
// `is_posted_salary` (exactness) check is an intra-label tie-breaker ONLY — it
// applies when two observations share the same `confidence_label`, never across
// labels. Rationale: `unknown_exact` (rank 7) means the amount is exact but the
// source/confidence is unknown — a well-sourced estimate (rank 3-6) is more
// trustworthy than an unsourced "exact" number.
const CONFIDENCE_RANK = Object.freeze({
  'posted_exact': 0,
  'external_exact': 1,
  'api_exact_match': 2,
  'aggregated_exact_title': 3,
  'company_benchmark': 4,
  'estimated_market': 5,
  'official_baseline': 6,
  'unknown_exact': 7,
  'unknown_estimate': 8,
});

function getRankIndex(label) {
  const rank = CONFIDENCE_RANK[label];
  return rank === undefined ? Infinity : rank;
}

// Location specificity score: city > region > country.
// Treats null, undefined, empty string, and whitespace-only strings as country-level.
function getLocationScore(observation) {
  const city = observation.city;
  if (typeof city === 'string' && city.trim() !== '') return 2;
  const region = observation.region;
  if (typeof region === 'string' && region.trim() !== '') return 1;
  return 0;
}

function compareObservations(a, b, opts) {
  // 1. Confidence rank (lower index is better)
  const rankA = getRankIndex(a.confidence_label);
  const rankB = getRankIndex(b.confidence_label);
  if (rankA !== rankB) return rankA - rankB;

  // 2. Exactness: is_posted_salary (1 beats 0)
  const exactA = a.is_posted_salary === 1 ? 1 : 0;
  const exactB = b.is_posted_salary === 1 ? 1 : 0;
  if (exactA !== exactB) return exactB - exactA;

  // 3. Predicted state: is_predicted (0 beats 1)
  const predA = a.is_predicted === 1 ? 1 : 0;
  const predB = b.is_predicted === 1 ? 1 : 0;
  if (predA !== predB) return predA - predB;

  // 4. Observed time: newer is better (treat missing as epoch)
  const timeA = a.observed_at ? new Date(a.observed_at).getTime() : 0;
  const timeB = b.observed_at ? new Date(b.observed_at).getTime() : 0;
  if (!Number.isFinite(timeA) && !Number.isFinite(timeB)) {
    // both invalid — fall through to next tier
  } else if (!Number.isFinite(timeA)) {
    return 1; // a invalid, b wins
  } else if (!Number.isFinite(timeB)) {
    return -1; // b invalid, a wins
  } else if (timeA !== timeB) {
    return timeB - timeA;
  }

  // 5. Location specificity: city > region > country
  const locA = getLocationScore(a);
  const locB = getLocationScore(b);
  if (locA !== locB) return locB - locA;

  // 6. Currency match (only when caller supplies jobCountryCode + expectedCurrency)
  if (opts && opts.jobCountryCode && opts.expectedCurrency) {
    const matchA = a.currency === opts.expectedCurrency ? 1 : 0;
    const matchB = b.currency === opts.expectedCurrency ? 1 : 0;
    if (matchA !== matchB) return matchB - matchA;
  }

  // 7. Source priority (if provided)
  if (opts && Array.isArray(opts.sourcePriority)) {
    const idxA = opts.sourcePriority.indexOf(a.data_source);
    const idxB = opts.sourcePriority.indexOf(b.data_source);
    const priorityA = idxA >= 0 ? idxA : Infinity;
    const priorityB = idxB >= 0 ? idxB : Infinity;
    if (priorityA !== priorityB) return priorityA - priorityB;
  }

  // 8. Final deterministic tie-break: observation_id lexicographic order
  const idA = a.observation_id ?? '';
  const idB = b.observation_id ?? '';
  return idA.localeCompare(idB);
}

/**
 * Pick the best observation for a job.
 *
 * Pure function. Does not mutate input. Returns null on empty input.
 *
 * @param {Array<object>} observations - array of observations for ONE job
 * @param {object} [opts] - optional ranking hints
 * @param {string} [opts.jobCountryCode] - ISO country code of the job (e.g., 'GB')
 * @param {string} [opts.expectedCurrency] - 3-letter currency expected for jobCountryCode (e.g., 'GBP')
 * @param {Array<string>} [opts.sourcePriority] - ordered data_source names (earlier = preferred)
 * @returns {object|null} the single best observation, or null if observations is empty
 */
export function selectBestObservation(observations, opts = {}) {
  if (!Array.isArray(observations) || observations.length === 0) {
    return null;
  }
  if (observations.length === 1) {
    return observations[0];
  }
  // Sort a copy so the input is not mutated. Comparator is total-order deterministic.
  const sorted = observations.slice().sort((a, b) => compareObservations(a, b, opts));
  return sorted[0];
}
