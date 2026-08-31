// No-extraction marker emission for pages where salary parsing yields no results.
// Implements closed-set reason codes: 'competitive', 'doe', 'absent'.
//
// Policy: When a page yields no salary candidates, emit an explicit marker row
// rather than silently returning []. This allows downstream (Phase v1.0-09 retry
// state machine) to distinguish "tried and found nothing" from "never tried".

// Closed set of reasons — exactly these three, no others
export const NO_EXTRACTION_REASONS = Object.freeze([
  'competitive',
  'doe',
  'absent',
]);

/**
 * Determine the no-extraction reason code for a page of text.
 *
 * @param {string} text - The page text
 * @returns {string} One of 'competitive', 'doe', or 'absent'
 *
 * Precedence: 'competitive' > 'doe' > 'absent'
 * (a page with both "competitive" and "DOE" is classified as 'competitive'
 *  because that signal is stronger about pay positioning)
 */
export function determineNoExtractionReason(text) {
  if (typeof text !== 'string') {
    return 'absent';
  }

  // Pattern for "competitive" or similar value-judgement-only phrases
  const competitivePattern = /\b(competitive(\s+(salary|package|compensation))?|attractive\s+package|market[- ]leading)\b/i;

  // Pattern for "DOE" or deferral phrases
  const doePattern = /(\bDOE\b|depends\s+on\s+experience|negotiable|£\s*negotiable|£\s*TBD|to\s+be\s+discussed|\bTBD\b)/i;

  const hasCompetitive = competitivePattern.test(text);
  const hasDoe = doePattern.test(text);

  if (hasCompetitive) {
    return 'competitive';
  }
  if (hasDoe) {
    return 'doe';
  }
  return 'absent';
}

/**
 * Emit a no-extraction marker row.
 *
 * @param {string} reason - One of 'competitive', 'doe', or 'absent'
 * @param {string|null} evidence_snippet - The matched text fragment, or null for 'absent'
 * @returns {object} A marker row with null salary fields and extraction_status set
 *
 * Throws TypeError if reason is not in NO_EXTRACTION_REASONS (defensive).
 */
export function emitNoExtractionMarker(reason, evidence_snippet) {
  // Validate reason is in the closed set
  if (!NO_EXTRACTION_REASONS.includes(reason)) {
    throw new TypeError(`Invalid no-extraction reason: ${reason}. Must be one of: ${NO_EXTRACTION_REASONS.join(', ')}`);
  }

  return {
    amount_min: null,
    amount_max: null,
    currency: null,
    period: null,
    compensation_type: null,
    extractor: null, // no-extraction marker has no extractor
    annualized_min: null,
    annualized_max: null,
    annualization_note: null,
    is_predicted: 0,
    is_posted_salary: 0,
    extraction_status: reason,
    evidence_snippet,
  };
}
