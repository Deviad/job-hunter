/**
 * Confidence-rank merge for salary candidates.
 *
 * Implements the CONTEXT.md decision: **JSON-LD always wins** when both extractors yield results.
 * This is a trust-based design choice (structured data is curated; body text includes ads/editorials).
 *
 * Merge rule:
 * 1. If jsonLdCandidate is not null (valid extraction): return [jsonLdCandidate] — suppress regex results
 * 2. If jsonLdCandidate is null AND regexCandidates.length > 0: return regexCandidates
 * 3. If both are empty/null: return [] — caller's responsibility to emit no-extraction marker
 *
 * Pure function. No I/O, no side effects.
 */

/**
 * Merge candidates with JSON-LD precedence.
 *
 * @param {Array} regexCandidates - Candidates from body-text regex extraction
 * @param {Object|null} jsonLdCandidate - Candidate from JSON-LD extraction (or null if not found/invalid)
 * @returns {Array} Merged candidates following confidence-rank rule (JSON-LD always wins)
 */
export function mergeCandidates(regexCandidates, jsonLdCandidate) {
  // JSON-LD always wins when present
  if (jsonLdCandidate !== null) {
    return [jsonLdCandidate];
  }

  // Fall back to regex results if JSON-LD is absent/invalid
  if (regexCandidates.length > 0) {
    return regexCandidates;
  }

  // Both empty — return empty array (caller emits marker)
  return [];
}
