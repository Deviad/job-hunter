/**
 * JSON-LD schema.org JobPosting salary extractor.
 *
 * Extracts baseSalary from JSON-LD structured data, supporting both
 * nested-value and flat shapes, @graph wrappers, and ISO-8601 period normalization.
 *
 * Returns null (never throws) on malformed input or non-numeric amounts.
 */

/**
 * Parse JSON-LD and extract salary from schema.org JobPosting.baseSalary.
 *
 * @param {string} jsonLdString - JSON-LD string to parse
 * @param {object} ctx - Context object (reserved for future use)
 * @returns {object|null} Candidate object with amount_min, amount_max, currency, period, extractor, evidence_snippet
 */
export function parseJsonLdSalary(jsonLdString, ctx = {}) {
  // 1. JSON.parse with try/catch — never throw
  let parsed;
  try {
    parsed = JSON.parse(jsonLdString);
  } catch (e) {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  // 2. Navigate to JobPosting
  let posting = null;

  // Check for @graph array
  if (Array.isArray(parsed['@graph'])) {
    posting = parsed['@graph'].find((item) => {
      const type = item['@type'];
      if (Array.isArray(type)) {
        return type.includes('JobPosting');
      }
      return type === 'JobPosting';
    });
  }

  // If no @graph, check top-level
  if (!posting) {
    const type = parsed['@type'];
    const isJobPosting = Array.isArray(type)
      ? type.includes('JobPosting')
      : type === 'JobPosting';

    if (isJobPosting) {
      posting = parsed;
    }
  }

  if (!posting) {
    return null;
  }

  // 3. Extract baseSalary
  const baseSalary = posting.baseSalary;
  if (!baseSalary) {
    return null;
  }

  // 4. Branch on value-shape and extract min/max
  let minValue, maxValue, currency, unitText;

  // Branch 1: Flat Number at MonetaryAmount.value
  if (typeof baseSalary.value === 'number' && isFinite(baseSalary.value)) {
    minValue = baseSalary.value;
    maxValue = baseSalary.value;
    currency = baseSalary.currency;
    unitText = baseSalary.unitText ?? '';
  }
  // Branch 2: Nested object with flat Number at .value.value
  else if (baseSalary.value && typeof baseSalary.value === 'object' &&
           typeof baseSalary.value.value === 'number' && isFinite(baseSalary.value.value)) {
    minValue = baseSalary.value.value;
    maxValue = baseSalary.value.value;
    currency = baseSalary.currency ?? baseSalary.value.currency;
    unitText = (baseSalary.value.unitText ?? baseSalary.unitText ?? '');
  }
  // Branch 3: Nested object with QuantitativeValue range (minValue/maxValue)
  else if (baseSalary.value && typeof baseSalary.value === 'object') {
    const salaryValue = baseSalary.value;
    currency = baseSalary.currency ?? salaryValue.currency;
    unitText = (salaryValue.unitText ?? '').toUpperCase();

    // Extract and coerce minValue
    let min = salaryValue.minValue ?? null;
    if (min !== null) {
      if (typeof min === 'number') {
        if (!isFinite(min)) {
          return null;
        }
        minValue = min;
      } else if (typeof min === 'string') {
        const parsed = parseFloat(min);
        if (isNaN(parsed) || !isFinite(parsed)) {
          return null;
        }
        minValue = parsed;
      } else {
        return null;
      }
    } else {
      return null; // minValue is required in range form
    }

    // Extract and coerce maxValue
    let max = salaryValue.maxValue ?? null;
    if (max !== null) {
      if (typeof max === 'number') {
        if (!isFinite(max)) {
          return null;
        }
        maxValue = max;
      } else if (typeof max === 'string') {
        const parsed = parseFloat(max);
        if (isNaN(parsed) || !isFinite(parsed)) {
          return null;
        }
        maxValue = parsed;
      } else {
        return null;
      }
    }
  }
  // Branch 4: Flat top-level shape (baseSalary itself carries minValue/maxValue)
  else {
    const salaryValue = baseSalary;
    currency = baseSalary.currency;
    unitText = (baseSalary.unitText ?? '').toUpperCase();

    // Extract and coerce minValue
    let min = salaryValue.minValue ?? null;
    if (min !== null) {
      if (typeof min === 'number') {
        if (!isFinite(min)) {
          return null;
        }
        minValue = min;
      } else if (typeof min === 'string') {
        const parsed = parseFloat(min);
        if (isNaN(parsed) || !isFinite(parsed)) {
          return null;
        }
        minValue = parsed;
      } else {
        return null;
      }
    } else {
      return null; // minValue is required
    }

    // Extract and coerce maxValue
    let max = salaryValue.maxValue ?? null;
    if (max !== null) {
      if (typeof max === 'number') {
        if (!isFinite(max)) {
          return null;
        }
        maxValue = max;
      } else if (typeof max === 'string') {
        const parsed = parseFloat(max);
        if (isNaN(parsed) || !isFinite(parsed)) {
          return null;
        }
        maxValue = parsed;
      } else {
        return null;
      }
    }
  }

  // Validate currency (applies to all branches)
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
    return null;
  }

  // 5. Normalize period
  const period = normalizePeriod(unitText.toUpperCase());

  // 6. Build candidate
  const candidate = {
    amount_min: minValue,
    amount_max: maxValue,
    currency: currency,
    period: period,
    compensation_type: 'base',
    extractor: 'jsonld',
    evidence_snippet: 'JobPosting.baseSalary'
  };

  return candidate;
}

/**
 * Normalize period string to standard values.
 *
 * @param {string} unitText - Period text from JSON-LD
 * @returns {string} Normalized period: 'hour', 'day', 'week', 'month', or 'year' (default)
 */
function normalizePeriod(unitText) {
  if (!unitText) {
    return 'year';
  }

  // Year: YEAR, P1Y, ANNUAL
  if (/^(YEAR|P1Y|ANNUAL)$/.test(unitText)) {
    return 'year';
  }

  // Month: MONTH, P1M
  if (/^(MONTH|P1M)$/.test(unitText)) {
    return 'month';
  }

  // Week: WEEK, P1W
  if (/^(WEEK|P1W)$/.test(unitText)) {
    return 'week';
  }

  // Day: DAY, P1D
  if (/^(DAY|P1D)$/.test(unitText)) {
    return 'day';
  }

  // Hour: HOUR, PT1H
  if (/^(HOUR|PT1H)$/.test(unitText)) {
    return 'hour';
  }

  // Unrecognized → default to year
  return 'year';
}
