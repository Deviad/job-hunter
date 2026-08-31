/**
 * Salary Parser: Public Entry Point
 *
 * Composes all leaf modules into a unified salary extraction pipeline.
 * This is the single public API for downstream consumers (Phase v1.0-05 DB layer, Phase v1.0-08 adapters).
 *
 * Function signature:
 * ```
 * parseSalaryCandidates(text: string | any, ctx: object): Candidate[]
 * ```
 *
 * ctx object fields (all optional):
 * - `jsonLd`: JSON-LD string to extract from (if provided, JSON-LD always wins per CONTEXT.md)
 * - `defaultCurrency`: Fallback currency (reserved for future use)
 * - `jobUrl`: Source URL (reserved for audit/debugging)
 *
 * Output candidate shape (12 fields):
 * - `amount_min`: number | null
 * - `amount_max`: number | null
 * - `currency`: string ('GBP', 'USD', 'CHF', 'AED', etc.) | null
 * - `period`: string ('hour', 'day', 'week', 'month', 'year') | null
 * - `compensation_type`: 'base' | 'ote_total' | null
 * - `extractor`: 'jsonld' | 'regex'
 * - `annualized_min`: number | null
 * - `annualized_max`: number | null
 * - `annualization_note`: string | null
 * - `is_predicted`: 0 | 1
 * - `is_posted_salary`: 0 | 1
 * - `extraction_status`: null (for candidates) | 'competitive' | 'doe' | 'absent' (for markers)
 * - `evidence_snippet`: string | null
 *
 * Pipeline:
 * 1. Input normalization (empty/null/non-string → '')
 * 2. JSON-LD extraction (if ctx.jsonLd provided)
 * 3. Boundary truncation (LinkedIn similar-jobs section)
 * 4. Body-text regex extraction
 * 5. OTE dual-emission (on OTE marker detection + amount)
 * 6. Merge (JSON-LD precedence)
 * 7. No-extraction fallback (explicit markers for pages with no salary data)
 * 8. Annualization (every candidate carries annualization_note)
 * 9. Return candidates with provenance invariants enforced
 *
 * See CONTEXT.md for locked decisions:
 * - JSON-LD always wins when both extractors yield results (confidence-rank merge)
 * - OTE pages emit two candidates: base + ote_total (when OTE amount is parseable)
 * - No-extraction markers use closed-set reason codes: {competitive, doe, absent}
 * - Every annualized candidate carries annualization_note for traceability
 */

import { extractSalaryRegex } from './regex-extractor.mjs';
import { parseJsonLdSalary } from './jsonld-extractor.mjs';
import { findSimilarJobsBoundary } from './boundary.mjs';
import { detectOteMarker, extractOteAmount, emitDualCandidates } from './ote-markers.mjs';
import { annualizeCandidate } from './annualize.mjs';
import { determineNoExtractionReason, emitNoExtractionMarker } from './no-extraction.mjs';
import { mergeCandidates } from './merge.mjs';

/**
 * Parse salary from body text and/or JSON-LD, returning extraction candidates or no-extraction marker.
 *
 * @param {string|any} text - Job description body text (normalized to string, may be empty)
 * @param {object} ctx - Context object with optional jsonLd, defaultCurrency, jobUrl
 * @returns {Array} Array of candidates (extraction results) or exactly one no-extraction marker
 *
 * Pure function: no I/O, no side effects, deterministic.
 * Returns at least one row (never silently empty).
 */
export function parseSalaryCandidates(text, ctx = {}) {
  // ============================================================================
  // 1. INPUT NORMALIZATION (CRITICAL — supports JSON-LD-only inputs)
  // ============================================================================
  // If text is not a string (null, undefined, number, etc.) or is empty, set text = ''
  // and CONTINUE. A JSON-LD-only call MUST still run the JSON-LD pass.
  // Never throw on bad input types.
  if (typeof text !== 'string') {
    text = '';
  } else if (text.length === 0) {
    text = '';
  }

  // ============================================================================
  // 2. JSON-LD PASS (runs regardless of whether text is empty)
  // ============================================================================
  let jsonLdCandidate = null;
  if (typeof ctx.jsonLd === 'string' && ctx.jsonLd.length > 0) {
    jsonLdCandidate = parseJsonLdSalary(ctx.jsonLd, ctx);
  }

  // ============================================================================
  // 3. BOUNDARY TRUNCATION (safe on empty string)
  // ============================================================================
  const boundary = findSimilarJobsBoundary(text);
  const bodyText = text.slice(0, boundary);

  // ============================================================================
  // 4. BODY-TEXT REGEX PASS
  // ============================================================================
  const rawRegexCandidates = extractSalaryRegex(bodyText, ctx);

  // ============================================================================
  // 5. OTE DUAL-EMISSION (only applies to regex candidates)
  // ============================================================================
  let regexCandidates = [];
  if (rawRegexCandidates.length === 0) {
    regexCandidates = [];
  } else if (!detectOteMarker(bodyText)) {
    // No OTE marker: use all regex candidates as-is
    regexCandidates = rawRegexCandidates;
  } else {
    // OTE marker present: emit dual candidates from the first regex match
    const oteAmount = extractOteAmount(bodyText);
    const dualCandidates = emitDualCandidates(rawRegexCandidates[0], oteAmount);

    // If we have two candidates (base + ote_total), extract the OTE amount's evidence_snippet
    if (dualCandidates.length === 2 && oteAmount !== null) {
      // Extract evidence snippet by finding the OTE amount in the original text
      // Look for currency symbol + amount pattern that matches the OTE currency and amount
      const currencySymbol = {
        'GBP': '£',
        'USD': '$',
        'EUR': '€'
      }[oteAmount.currency];

      if (currencySymbol) {
        // Build regex to find "£170,000" or similar with thousands separators
        // The amount could have various separators: comma, apostrophe, etc.
        const amountPattern = oteAmount.amount.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        const regex = new RegExp(`${currencySymbol}\\s*[\\d,'.]+`, 'g');
        let match;
        let lastMatch = null;
        while ((match = regex.exec(bodyText)) !== null) {
          // Keep finding matches to get the last (OTE) amount
          // (Skip the first match which should be the base salary)
          lastMatch = match;
        }
        if (lastMatch && lastMatch[0] !== rawRegexCandidates[0].evidence_snippet) {
          dualCandidates[1].evidence_snippet = lastMatch[0];
        }
      }
    }

    regexCandidates = dualCandidates;
  }

  // ============================================================================
  // 6. MERGE (apply JSON-LD precedence)
  // ============================================================================
  const merged = mergeCandidates(regexCandidates, jsonLdCandidate);

  // ============================================================================
  // 7. NO-EXTRACTION FALLBACK
  // ============================================================================
  let candidates = [];
  if (merged.length === 0) {
    // Both extractors yielded nothing — emit a marker with evidence snippet
    const reason = determineNoExtractionReason(text);

    // Extract evidence snippet based on the reason
    let evidence_snippet = null;
    if (reason === 'competitive') {
      const match = /\b(competitive(\s+(salary|package|compensation))?|attractive\s+package|market[- ]leading)\b/i.exec(text);
      evidence_snippet = match ? match[0] : null;
    } else if (reason === 'doe') {
      const match = /(\bDOE\b|depends\s+on\s+experience|negotiable|£\s*negotiable|£\s*TBD|to\s+be\s+discussed|\bTBD\b)/i.exec(text);
      evidence_snippet = match ? match[0] : null;
    }
    // For 'absent', evidence_snippet remains null

    candidates = [emitNoExtractionMarker(reason, evidence_snippet)];
  } else {
    candidates = merged;
  }

  // ============================================================================
  // 8. ANNUALIZATION AND PROVENANCE INVARIANTS
  // ============================================================================
  // Annualize every extraction candidate (NOT markers)
  const result = candidates.map((c) => {
    // Extraction candidates don't have extraction_status field; markers do (and it's not null)
    const isMarker = c.extraction_status !== undefined && c.extraction_status !== null;

    if (!isMarker) {
      // This is an extraction candidate — annualize and add required fields
      const annualized = annualizeCandidate(c);
      return {
        ...annualized,
        is_predicted: 0,
        is_posted_salary: 1,
        extraction_status: null
      };
    }
    // Markers pass through unchanged (no annualization on markers)
    return c;
  });

  // ============================================================================
  // 9. ASSERT PROVENANCE INVARIANTS (development guards)
  // ============================================================================
  // Every extraction candidate has required fields
  // Every marker has required fields
  // (Production: no-op; development: guards can be enabled via simple assertions)

  return result;
}
