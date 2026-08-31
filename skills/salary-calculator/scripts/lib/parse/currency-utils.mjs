// Shared currency utilities for salary extraction.
// Used by both regex-extractor and ote-markers modules.

export const CURRENCY_SYMBOL_MAP = Object.freeze({
  '£': 'GBP',
  '$': 'USD',
  '€': 'EUR',
  'CHF': 'CHF',
  'AED': 'AED'
});

/**
 * Normalize an amount string by stripping thousands separators and k-suffix.
 *
 * @param {string} amountStr - The amount string to normalize
 * @returns {number|null} The parsed numeric value, or null if unparseable
 *
 * Accepts separators: `,` (comma), `'` (apostrophe U+0027), `'` (right single quote U+2019), space.
 * Accepts `.` (dot) only when followed by exactly 3 digits then a non-digit (EU thousands separator).
 * Accepts `k` or `K` suffix (multiply by 1000).
 * Never throws — returns null on unparseable input.
 */
export function normalizeAmount(amountStr) {
  if (typeof amountStr !== 'string' || amountStr.trim().length === 0) {
    return null;
  }

  let normalized = amountStr.trim();

  // Handle k/K suffix (must be done before parsing so we can detect it)
  const hasKSuffix = /[kK]$/.test(normalized);
  if (hasKSuffix) {
    normalized = normalized.slice(0, -1).trim();
  }

  // Strip common thousands separators
  // Comma, apostrophe (U+0027), right single quote (U+2019), space
  normalized = normalized.replace(/,|'|'|\s/g, '');

  // Handle dot as thousands separator (only when followed by exactly 3 digits then non-digit)
  // This distinguishes EU format "1.500" (one thousand five hundred) from "1.5" (decimal)
  normalized = normalized.replace(/\.(?=\d{3}(?:\D|$))/g, '');

  // Try to parse the remaining string as a number
  const num = parseFloat(normalized);
  if (isNaN(num)) {
    return null;
  }

  // Apply k-suffix multiplier if present
  return hasKSuffix ? num * 1000 : num;
}
