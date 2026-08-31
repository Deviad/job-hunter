// Body-text salary extraction via regex patterns for multiple currencies and periods.
// Imports shared utilities from currency-utils (Plan 01 Wave 0).
// Pure function: no I/O, no throws, no side effects.

import { CURRENCY_SYMBOL_MAP, normalizeAmount } from './currency-utils.mjs';

/**
 * Extract salary candidates from body text via regex patterns.
 *
 * @param {string} text - The body text to extract from
 * @param {object} ctx - Context object (unused in Plan 02, but reserved for future use)
 * @returns {object[]} Array of candidates, each with:
 *   - amount_min, amount_max (number | null)
 *   - currency (string, ISO 3-letter)
 *   - period ('hour'|'day'|'week'|'month'|'year')
 *   - compensation_type ('base')
 *   - extractor ('regex')
 *   - evidence_snippet (matched substring)
 */
export function extractSalaryRegex(text, ctx = {}) {
  if (typeof text !== 'string' || text.length === 0) {
    return [];
  }

  const candidates = [];
  const usedRanges = []; // Track [start, end) to avoid overlaps

  // Helper: check if a range overlaps with any already-used range
  const hasOverlap = (start, end) => {
    return usedRanges.some(([s, e]) => start < e && end > s);
  };

  // Helper: record a range as used
  const addUsedRange = (start, end) => {
    usedRanges.push([start, end]);
  };

  // Helper: detect if match position is inside an HTML tag
  const isInsideHtmlTag = (index) => {
    let openCount = 0;
    for (let i = 0; i < index; i++) {
      if (text[i] === '<') openCount++;
      if (text[i] === '>') openCount--;
    }
    return openCount > 0;
  };

  // Helper: check if match is preceded by :// (URL protocol)
  const isPrecededByUrl = (index) => {
    const start = Math.max(0, index - 30);
    const before = text.substring(start, index);
    return before.includes('://');
  };

  // Helper: extract period from regex match groups
  const extractPeriod = (match) => {
    const periodText = match.period || match.periodAfter || '';
    const lowerPeriod = periodText.toLowerCase();

    if (lowerPeriod.includes('day')) return 'day';
    if (lowerPeriod.includes('week')) return 'week';
    if (lowerPeriod.includes('month') || lowerPeriod.includes('monthly')) return 'month';
    if (lowerPeriod.includes('hour') || lowerPeriod.includes('hourly')) return 'hour';
    if (lowerPeriod.includes('year') || lowerPeriod.includes('annum') || lowerPeriod.includes('annually')) return 'year';

    return 'year'; // Default
  };

  // ===== GBP Patterns =====

  // Pattern 1: GBP yearly range with optional period specifier
  const gbpYearlyRegex = /£([\d,'.]+)\s*(-|to|–|—)\s*£([\d,'.]+)(?:\s*(per\s+annum|annually|per\s+year|\/year))?/gi;
  for (const match of text.matchAll(gbpYearlyRegex)) {
    if (hasOverlap(match.index, match.index + match[0].length)) continue;
    if (isInsideHtmlTag(match.index) || isPrecededByUrl(match.index)) continue;

    const minStr = match[1];
    const maxStr = match[3];
    const min = normalizeAmount(minStr);
    const max = normalizeAmount(maxStr);

    if (min !== null && max !== null) {
      candidates.push({
        amount_min: min,
        amount_max: max,
        currency: 'GBP',
        period: 'year',
        compensation_type: 'base',
        extractor: 'regex',
        evidence_snippet: match[0],
      });
      addUsedRange(match.index, match.index + match[0].length);
    }
  }

  // Pattern 2: GBP single yearly amount (no range, no period specifier, defaults to year)
  // Matches: "£120,000" in isolation (not part of a range like "£100 - £120")
  // This pattern looks for £ followed by amount, not followed by " - " or similar range markers
  const gbpSingleRegex = /£([\d,'.]+)(?=\s*[.;,!?\s]|$)/gi;
  for (const match of text.matchAll(gbpSingleRegex)) {
    // Skip if this is already part of a range (previous or next match within 10 chars is also £)
    const precedingText = text.substring(Math.max(0, match.index - 10), match.index);
    const followingText = text.substring(match.index + match[0].length, match.index + match[0].length + 20);

    // Skip if part of a range (has another £ nearby with - or dash)
    if (/£[\s\d,'.]*-|–|—|£[\s\d,'.]*to/.test(precedingText + match[0] + followingText)) {
      continue;
    }

    if (hasOverlap(match.index, match.index + match[0].length)) continue;
    if (isInsideHtmlTag(match.index) || isPrecededByUrl(match.index)) continue;

    const amountStr = match[1];
    const amount = normalizeAmount(amountStr);

    if (amount !== null && amount > 100) {
      // Only treat as yearly if amount is reasonable (> 100, to avoid typos like "£1")
      candidates.push({
        amount_min: amount,
        amount_max: null,
        currency: 'GBP',
        period: 'year',
        compensation_type: 'base',
        extractor: 'regex',
        evidence_snippet: match[0].trim(), // Use the actual matched text (without trailing whitespace/punctuation from lookahead)
      });
      addUsedRange(match.index, match.index + match[0].length);
    }
  }

  // Pattern 3: GBP day rate
  const gbpDayRateRegex = /£([\d,'.]+)(?:\s*\/day|\/day)/gi;
  for (const match of text.matchAll(gbpDayRateRegex)) {
    if (hasOverlap(match.index, match.index + match[0].length)) continue;
    if (isInsideHtmlTag(match.index) || isPrecededByUrl(match.index)) continue;

    const amountStr = match[1];
    const amount = normalizeAmount(amountStr);

    if (amount !== null) {
      candidates.push({
        amount_min: amount,
        amount_max: null,
        currency: 'GBP',
        period: 'day',
        compensation_type: 'base',
        extractor: 'regex',
        evidence_snippet: match[0],
      });
      addUsedRange(match.index, match.index + match[0].length);
    }
  }

  // ===== CHF Patterns =====

  const chfRegex = /CHF\s+([\d'.]+)\s*(-|to|–|—)\s*([\d'.]+)(?:\s*(per\s+year|per\s+annum|annually))?/gi;
  for (const match of text.matchAll(chfRegex)) {
    if (hasOverlap(match.index, match.index + match[0].length)) continue;
    if (isInsideHtmlTag(match.index) || isPrecededByUrl(match.index)) continue;

    const minStr = match[1];
    const maxStr = match[3];
    const min = normalizeAmount(minStr);
    const max = normalizeAmount(maxStr);

    if (min !== null && max !== null) {
      candidates.push({
        amount_min: min,
        amount_max: max,
        currency: 'CHF',
        period: 'year',
        compensation_type: 'base',
        extractor: 'regex',
        evidence_snippet: match[0],
      });
      addUsedRange(match.index, match.index + match[0].length);
    }
  }

  // ===== AED Patterns =====

  // AED single-value with period (most common: /month)
  const aedRegex = /AED\s+([\d,]+)(?:\s*\/\s*(month|year|week|day|hour))?(?:\s+[a-z]+)?/gi;
  for (const match of text.matchAll(aedRegex)) {
    if (hasOverlap(match.index, match.index + match[0].length)) continue;
    if (isInsideHtmlTag(match.index) || isPrecededByUrl(match.index)) continue;

    const amountStr = match[1];
    const amount = normalizeAmount(amountStr);
    const periodText = match[2] || 'month'; // Default to month for AED

    if (amount !== null) {
      let period = 'year';
      if (periodText) {
        const p = periodText.toLowerCase();
        if (p.includes('day')) period = 'day';
        else if (p.includes('week')) period = 'week';
        else if (p.includes('month')) period = 'month';
        else if (p.includes('hour')) period = 'hour';
        else period = 'year';
      }

      candidates.push({
        amount_min: amount,
        amount_max: null,
        currency: 'AED',
        period,
        compensation_type: 'base',
        extractor: 'regex',
        evidence_snippet: match[0],
      });
      addUsedRange(match.index, match.index + match[0].length);
    }
  }

  // ===== Currency-with-period patterns (GBP, USD, EUR, etc. with explicit period) =====

  // Pattern for any currency symbol with amount and period (£50/hour, $750/day, €2,500/week, etc.)
  const currencyPeriodRegex = /([£$€])([\d,'.]+)(?:\s*\/\s*(hour|day|week|month))/gi;
  for (const match of text.matchAll(currencyPeriodRegex)) {
    if (hasOverlap(match.index, match.index + match[0].length)) continue;
    if (isInsideHtmlTag(match.index) || isPrecededByUrl(match.index)) continue;

    const currencySymbol = match[1];
    const amountStr = match[2];
    const periodText = match[3];
    const currency = CURRENCY_SYMBOL_MAP[currencySymbol];
    const amount = normalizeAmount(amountStr);

    if (amount !== null && currency) {
      candidates.push({
        amount_min: amount,
        amount_max: null,
        currency: currency,
        period: periodText.toLowerCase(),
        compensation_type: 'base',
        extractor: 'regex',
        evidence_snippet: match[0],
      });
      addUsedRange(match.index, match.index + match[0].length);
    }
  }

  // ===== USD Patterns =====

  // USD range with optional k-shorthand
  const usdRegex = /\$([\d,]+)[kK]?\s*(-|to|–|—)\s*\$([\d,]+)[kK]?(?:\s*(per\s+year|per\s+annum|annually|\/year))?/gi;
  for (const match of text.matchAll(usdRegex)) {
    if (hasOverlap(match.index, match.index + match[0].length)) continue;
    if (isInsideHtmlTag(match.index) || isPrecededByUrl(match.index)) continue;

    const minStr = match[1];
    const maxStr = match[3];

    // Check if either min or max has k-suffix in the original match
    const minWithK = /\$([\d,]+)[kK]/.exec(text.substring(match.index, match.index + match[0].length).split('-')[0]);
    const maxWithK = /\$([\d,]+)[kK]/.exec(text.substring(match.index, match.index + match[0].length).split('-')[1] || '');

    // Try to parse both min and max
    let min = normalizeAmount(minStr);
    let max = normalizeAmount(maxStr);

    // If original had k-suffix and normalized lost it, reapply
    if (minWithK && /[kK]$/.test(minStr)) {
      min = normalizeAmount(minStr);
    }
    if (maxWithK && /[kK]$/.test(maxStr)) {
      max = normalizeAmount(maxStr);
    }

    // Apply k-suffix if the original match had it
    if (min !== null && /\$[\d,]+[kK]/.test(match[0].split('-')[0])) {
      min = parseFloat(minStr) * 1000;
    }
    if (max !== null && /[kK]\s*(-|to)/.test(match[0])) {
      // Check if the max part has k
      const maxPart = match[0].split(/-|to|–|—/)[1] || '';
      if (/[kK]/.test(maxPart)) {
        max = parseFloat(maxStr) * 1000;
      }
    }

    if (min !== null && max !== null) {
      candidates.push({
        amount_min: min,
        amount_max: max,
        currency: 'USD',
        period: 'year',
        compensation_type: 'base',
        extractor: 'regex',
        evidence_snippet: match[0],
      });
      addUsedRange(match.index, match.index + match[0].length);
    }
  }

  return candidates;
}
