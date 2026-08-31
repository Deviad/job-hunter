// Phase v1.0-11 Plan 02 — Pure health-metric classifier (HEALTH-02 / HEALTH-03).
//
// Single export: evaluateHealth({ current, prior }) → classifier output.
//
// Locked 4-state taxonomy (CONTEXT.md): exactly four state literals exist —
//   'ok', 'warning', 'no_data', 'insufficient_baseline'.
// There is NO degradation-state literal anywhere. When the threshold trips,
// the state literal is 'warning' (NOT a synonym).
//
// Boundary math (HEALTH-02): warning iff
//   rateCurrent < ratePrior * 0.8     (STRICT less-than; 0.8 boundary is 'ok')
//
// State precedence (matters when both windows are empty):
//   1. current.total === 0                              → no_data
//   2. prior.total === 0  (and current is non-empty)    → insufficient_baseline
//   3. dropped === true                                 → warning
//   4. otherwise                                        → ok
//
// Purity discipline (mirrors retry-state-machine.mjs):
//   - Zero imports.
//   - No wall-clock reads.
//   - No filesystem / sqlite / network I/O.
//   - No module-scope mutable state.
// All temporal information arrives via the {current, prior} aggregates the
// caller computed from SQL. The classifier is referentially transparent.

function assertWindow(name, w) {
  if (!w || typeof w !== 'object') {
    throw new TypeError(`evaluateHealth: ${name} must be an object with numeric total/hits`);
  }
  if (typeof w.total !== 'number' || !Number.isFinite(w.total)) {
    throw new TypeError(`evaluateHealth: ${name}.total must be a finite number`);
  }
  if (typeof w.hits !== 'number' || !Number.isFinite(w.hits)) {
    throw new TypeError(`evaluateHealth: ${name}.hits must be a finite number`);
  }
}

/**
 * Classify a source's parser hit-rate health.
 *
 * @param {{current: {total:number, hits:number}, prior: {total:number, hits:number}}} args
 * @returns {{
 *   hit_rate_current: number|null,
 *   hit_rate_prior:   number|null,
 *   delta_pct:        number|null,
 *   warning:          boolean,
 *   state:            'ok' | 'warning' | 'no_data' | 'insufficient_baseline'
 * }}
 */
export function evaluateHealth({ current, prior } = {}) {
  assertWindow('current', current);
  assertWindow('prior', prior);

  // Precedence step 1: no current data → no_data (wins over insufficient_baseline).
  if (current.total === 0) {
    return {
      hit_rate_current: null,
      hit_rate_prior: null,
      delta_pct: null,
      warning: false,
      state: 'no_data',
    };
  }

  const rateCurrent = current.hits / current.total;

  // Precedence step 2: prior baseline empty → insufficient_baseline.
  if (prior.total === 0) {
    return {
      hit_rate_current: rateCurrent,
      hit_rate_prior: null,
      delta_pct: null,
      warning: false,
      state: 'insufficient_baseline',
    };
  }

  const ratePrior = prior.hits / prior.total;

  // STRICT less-than: at rateCurrent === ratePrior * 0.8 the state is 'ok'.
  //
  // Float-safe boundary: the natural form `rateCurrent < ratePrior * 0.8`
  // misfires on the locked subtest 3 input (current=64/100, prior=80/100)
  // because `0.8 * 0.8` evaluates to 0.6400000000000001 in IEEE-754, so
  // `0.64 < 0.6400000000000001` is true and the state would flip from 'ok'
  // to 'warning' purely due to representation drift.
  //
  // Rewrite as an integer cross-multiplication using the 8/10 form of 0.8:
  //   rateCurrent < ratePrior * 0.8
  //   ↔ current.hits/current.total < (prior.hits/prior.total) * (8/10)
  //   ↔ current.hits * prior.total * 10 < prior.hits * current.total * 8
  // This evaluates entirely on integer operands when total/hits are integers
  // (the only shape SQL produces) and is therefore exact.
  const dropped = current.hits * prior.total * 10 < prior.hits * current.total * 8;
  const deltaPct = ratePrior === 0 ? null : ((rateCurrent - ratePrior) / ratePrior) * 100;

  return {
    hit_rate_current: rateCurrent,
    hit_rate_prior: ratePrior,
    delta_pct: deltaPct,
    warning: dropped,
    state: dropped ? 'warning' : 'ok',
  };
}
