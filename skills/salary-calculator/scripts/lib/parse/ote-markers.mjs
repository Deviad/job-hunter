/**
 * OTE (On-Target Earnings) marker detection and dual-candidate emission.
 *
 * Detects canonical OTE markers in text and extracts OTE amounts.
 * Emits dual candidates (base + ote_total) when an OTE amount is parseable.
 */

import { normalizeAmount, CURRENCY_SYMBOL_MAP } from './currency-utils.mjs';

/**
 * Canonical OTE keywords (closed set per CONTEXT.md).
 * Does NOT include scope-creep like 'bonus eligible', 'variable', 'incentive'.
 */
export const OTE_KEYWORDS = Object.freeze([
  'OTE',
  'on-target',
  'on target earnings',
  'including commission',
  'with bonus',
  'inc. commission'
]);

/**
 * Detect OTE marker in text.
 *
 * @param {string} text - Text to search
 * @returns {boolean} True if canonical OTE marker found
 */
export function detectOteMarker(text) {
  if (typeof text !== 'string') {
    return false;
  }

  // Build combined regex from OTE_KEYWORDS with word boundaries
  // inc. commission requires literal dot: inc\..*commission
  const pattern = /\b(OTE|on-target|on target earnings|including commission|with bonus|inc\.\s+commission)\b/i;
  return pattern.test(text);
}

/**
 * Extract OTE amount from text.
 *
 * Supports both leading-marker (OTE before amount) and trailing-marker (amount before OTE).
 * Looks for an OTE keyword followed/preceded within 30 chars by a currency symbol/code and amount.
 *
 * @param {string} text - Text to search
 * @returns {object|null} { amount: number, currency: 'GBP'|'USD'|'EUR'|'CHF'|'AED' } or null
 */
export function extractOteAmount(text) {
  if (typeof text !== 'string') {
    return null;
  }

  // Try pattern 1: LEADING marker with symbol (OTE £150,000)
  const pattern1 = /(?:OTE|on-target|on target earnings|including commission|with bonus|inc\.\s+commission)[^£$€\w]{0,30}([£$€])\s*([\d,'.]+k?)/i;
  let match = text.match(pattern1);

  if (match) {
    const currencySymbol = match[1];
    const amountStr = match[2];
    const currency = CURRENCY_SYMBOL_MAP[currencySymbol];
    const amount = normalizeAmount(amountStr);
    if (amount !== null && currency) {
      return { amount, currency };
    }
  }

  // Try pattern 2: LEADING marker with currency code (OTE 180000 CHF, OTE 180000 AED)
  const pattern2 = /(?:OTE|on-target|on target earnings|including commission|with bonus|inc\.\s+commission)[^£$€\w]{0,30}([\d,'.]+k?)\s+(CHF|AED)/i;
  match = text.match(pattern2);

  if (match) {
    const amountStr = match[1];
    const currencyCode = match[2].toUpperCase();
    const amount = normalizeAmount(amountStr);
    if (amount !== null && (currencyCode === 'CHF' || currencyCode === 'AED')) {
      return { amount, currency: currencyCode };
    }
  }

  // Try pattern 3: TRAILING marker with symbol (£150,000 OTE)
  const pattern3 = /([£$€])\s*([\d,'.]+k?)[^£$€\w]{0,30}(?:OTE|on-target|on target earnings|including commission|with bonus|inc\.\s+commission)\b/i;
  match = text.match(pattern3);

  if (match) {
    const currencySymbol = match[1];
    const amountStr = match[2];
    const currency = CURRENCY_SYMBOL_MAP[currencySymbol];
    const amount = normalizeAmount(amountStr);
    if (amount !== null && currency) {
      return { amount, currency };
    }
  }

  // Try pattern 4: TRAILING marker with currency code (180000 CHF OTE, 180000 AED OTE)
  const pattern4 = /([\d,'.]+k?)\s+(CHF|AED)[^£$€\w]{0,30}(?:OTE|on-target|on target earnings|including commission|with bonus|inc\.\s+commission)\b/i;
  match = text.match(pattern4);

  if (match) {
    const amountStr = match[1];
    const currencyCode = match[2].toUpperCase();
    const amount = normalizeAmount(amountStr);
    if (amount !== null && (currencyCode === 'CHF' || currencyCode === 'AED')) {
      return { amount, currency: currencyCode };
    }
  }

  return null;
}

/**
 * Emit dual candidates (base + ote_total) when OTE amount is provided.
 *
 * @param {object} baseCandidate - Base salary candidate from regex-extractor
 * @param {object|null} oteAmount - OTE amount { amount, currency } or null
 * @returns {array} [baseCandidate] or [baseCandidate, oteCandidate]
 */
export function emitDualCandidates(baseCandidate, oteAmount) {
  if (oteAmount === null) {
    // Only marker detected, no parseable OTE amount
    return [{ ...baseCandidate, compensation_type: 'base' }];
  }

  // OTE amount is available — emit two candidates
  const baseWithType = { ...baseCandidate, compensation_type: 'base' };
  const oteCandidate = {
    ...baseCandidate,
    amount_min: oteAmount.amount,
    amount_max: null,
    currency: oteAmount.currency,
    compensation_type: 'ote_total'
    // Inherit period, extractor from baseCandidate
  };

  return [baseWithType, oteCandidate];
}
