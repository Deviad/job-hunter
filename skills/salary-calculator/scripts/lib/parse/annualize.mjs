/**
 * Annualization module with ROADMAP-locked multipliers.
 *
 * Applies fixed multipliers to salary amounts based on period.
 * Every annualized candidate carries an annualization_note for traceability.
 */

/**
 * Frozen annualization multipliers (ROADMAP-locked, no per-job overrides).
 * Maps period to factor (numeric).
 */
export const ANNUALIZATION_MULTIPLIERS = Object.freeze({
  hour: 1820,
  day: 220,
  week: 52,
  month: 12,
  year: 1
});

/**
 * Annualization notes map (internal, not exported).
 */
const ANNUALIZATION_NOTES = {
  hour: 'hour × 1820 working hours',
  day: 'day × 220 working days',
  week: 'week × 52 weeks',
  month: 'month × 12 months',
  year: 'year × 1'
};

/**
 * Annualize a salary candidate.
 *
 * Resolves the period, applies the locked multiplier, and adds annualization_note.
 * Returns a new candidate object (no mutation of input).
 *
 * @param {object} candidate - Candidate with amount_min, amount_max, period
 * @returns {object} New candidate with annualized_min, annualized_max, annualization_note added
 */
export function annualizeCandidate(candidate) {
  const period = candidate.period ?? 'year';
  const factor = ANNUALIZATION_MULTIPLIERS[period];

  if (factor === undefined) {
    // Unknown period — defensive fallback (shouldn't happen if upstream is correct)
    return {
      ...candidate,
      annualized_min: null,
      annualized_max: null,
      annualization_note: 'unknown period; not annualized'
    };
  }

  // Apply multiplier
  const annualized_min = candidate.amount_min != null ? candidate.amount_min * factor : null;
  const annualized_max = candidate.amount_max != null ? candidate.amount_max * factor : null;

  return {
    ...candidate,
    annualized_min: annualized_min,
    annualized_max: annualized_max,
    annualization_note: ANNUALIZATION_NOTES[period]
  };
}
