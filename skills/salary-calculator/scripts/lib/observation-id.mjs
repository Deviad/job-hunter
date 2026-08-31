// Identity hash for salary observations.
// SHA-256 truncated to 64 bits (16 hex chars).
//
// Field order is part of the contract — changing order or adding/removing fields
// requires a `normalizer_version`-style migration. The hash represents "same numeric
// evidence at the same URL/location" regardless of how the parser classifies or
// annualizes it (DB-07 contract).
//
// Excludes: evidence_snippet (parser-text variability must not fragment identity),
// raw_payload_json, observed_at, created_at, annualized_*, fx_*, is_posted_salary,
// is_predicted, confidence_label, matched_by, compensation_type, benchmark_id.
// These fields may vary for the same underlying evidence; identity is determined by
// numeric evidence + source + location only.

import { createHash } from 'node:crypto';

/**
 * Calculate a deterministic identity hash for a salary observation.
 *
 * Same numeric evidence + same URL + same location → same observation_id,
 * regardless of evidence_snippet text or how the parser classifies the observation.
 *
 * @param {object} observation - Observation object (at minimum with numeric/location fields)
 * @returns {string} - 16-character lowercase hex string (64-bit SHA-256 truncation)
 */
export function calculateObservationId(observation) {
  // Canonical field order (critical for determinism; see contract above)
  const fields = [
    (observation.currency || '').toUpperCase(),
    String(observation.amount_min ?? ''),
    String(observation.amount_max ?? ''),
    String(observation.amount_median ?? ''),
    (observation.period || '').toLowerCase(),
    (observation.data_source || '').toLowerCase(),
    observation.data_source_url ?? '',
    (observation.country_code || '').toUpperCase(),
    (observation.region || '').toLowerCase(),
    (observation.city || '').toLowerCase(),
  ];

  const canonical = fields.join('|');
  const hash = createHash('sha256').update(canonical).digest('hex');
  return hash.slice(0, 16); // 64-bit truncation (16 hex chars)
}
