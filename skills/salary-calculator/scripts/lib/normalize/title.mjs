/**
 * normalizeTitle.mjs - Deterministic 8-step title normalization pipeline
 *
 * Pipeline order (EXACT per NORM-01 + NORM-02 locked contract):
 * 1. NFKD normalize
 * 2. Lowercase
 * 3. Compound-phrase expansion (order-preserving, longest-first to avoid prefix shadowing)
 * 4. Punctuation strip (keep word chars, whitespace, hyphen, underscore)
 * 5. Tokenize on whitespace
 * 6. Filter (stopwords, filler adjectives, remote markers, location tokens)
 * 7. Single-token synonym expansion
 * 8. Join on whitespace
 *
 * Key invariant: Array used throughout to preserve token order per NORM-02.
 * No Set, no sort on tokens.
 */

import { getCachedRules } from './rules-loader.mjs';

/**
 * Normalize a job title to canonical form via 8-step deterministic pipeline
 * @param {string} raw - raw title input
 * @returns {string} canonical title
 */
export function normalizeTitle(raw) {
  if (!raw) return '';

  const rules = getCachedRules();
  let s = String(raw);

  // Step 1: NFKD normalize (decomposes characters like é → e + combining accent)
  s = s.normalize('NFKD');
  // Remove combining marks (accents, diacritics) that remain after NFKD decomposition
  // Unicode combining marks are in the range \u0300-\u036F
  s = s.replace(/[\u0300-\u036F]/g, '');

  // Step 2: Lowercase
  s = s.toLowerCase();

  // Step 3: Compound-phrase expansion (before punctuation strip)
  // Sort compound phrases by length descending (longest first) to avoid prefix-shadowing
  // E.g., must match "machine learning engineer" before "machine learning"
  const sortedPhrases = Array.from(rules.compoundPhrases.entries())
    .sort((a, b) => b[0].length - a[0].length);

  for (const [raw, canonical] of sortedPhrases) {
    // Use word boundary matching to ensure we match whole phrases
    // For non-symbolic phrases, use \b; for symbolic phrases (c++, c#), use negative lookbehind/lookahead
    let pattern;
    if (/^[a-z0-9_]+$/.test(raw)) {
      // Non-symbolic phrase: use word boundary
      pattern = new RegExp(`\\b${escapeRegex(raw)}\\b`, 'g');
    } else {
      // Symbolic phrase (c++, c#, .net): use lookahead/lookbehind
      pattern = new RegExp(`(?<!\\w)${escapeRegex(raw)}(?!\\w)`, 'g');
    }
    s = s.replace(pattern, ` ${canonical} `);
  }

  // Step 4: Punctuation strip (keep word chars, whitespace, hyphen, underscore)
  s = s.replace(/[^\w\s\-_]/g, ' ');

  // Step 5: Tokenize on whitespace (Array to preserve order)
  const tokens = s.split(/\s+/).filter((t) => t.length > 0);

  // Step 6: Filter (stopwords, filler adjectives, remote markers, location tokens)
  const filtered = tokens.filter((t) => {
    const lower = t.toLowerCase();
    return (
      !rules.stopwords.has(lower) &&
      !rules.fillerAdjectives.has(lower) &&
      !rules.remoteMarkers.has(lower) &&
      !rules.locationTokens.has(lower)
    );
  });

  // Step 7: Single-token synonym expansion (Array.map preserves order)
  const canonical = filtered.map((t) => {
    const lower = t.toLowerCase();
    return rules.synonymMap.get(lower) ?? lower;
  });

  // Step 8: Emit (join on whitespace)
  return canonical.join(' ');
}

/**
 * Escape special regex characters
 * @param {string} s - string to escape
 * @returns {string} escaped string safe for RegExp constructor
 */
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
