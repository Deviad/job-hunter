// LinkedIn similar-jobs section boundary detector.
// Detects the start of the "Similar jobs" or related section markers and returns the index.
//
// Caller pattern: const boundary = findSimilarJobsBoundary(text);
//                 const body = text.slice(0, boundary);
//                 extractSalaryRegex(body, ctx);
//
// Boundary detection precedes extraction to truncate the input before salary parsing.
// This prevents false positives from "Related jobs" sections with unrelated salary data.

// Exact markers per PARSE-08 (closed set, 5 variants)
export const SIMILAR_JOBS_MARKERS = Object.freeze([
  'Similar jobs',
  'People also viewed',
  'More searches',
  'Explore top content',
  'Show more jobs like this',
]);

/**
 * Find the index of the LinkedIn similar-jobs section boundary.
 *
 * @param {string} text - The full page text
 * @returns {number} The index where the boundary marker starts, or text.length if not found
 *
 * - Matches markers case-insensitively and line-anchored (whole line only)
 * - Returns the index of the first match
 * - Returns text.length if no marker found (NOT -1; allows unconditional text.slice(0, idx))
 * - Pure function, idempotent
 */
export function findSimilarJobsBoundary(text) {
  if (typeof text !== 'string') {
    return 0;
  }

  // Build a single regex from all markers
  // Escape special regex characters in each marker and create alternation
  const escapedMarkers = SIMILAR_JOBS_MARKERS.map((marker) => {
    // Escape regex special characters
    return marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  });

  // Pattern: line-anchored, case-insensitive, markers with flexible whitespace
  // ^\s* = start of line with optional leading whitespace
  // (marker1|marker2|...) = one of the markers
  // \s*$ = optional trailing whitespace, end of line
  const pattern = new RegExp(`^\\s*(${escapedMarkers.join('|')})\\s*$`, 'igm');

  const match = pattern.exec(text);
  if (match) {
    return match.index;
  }

  return text.length;
}
