/**
 * Normalize a SQL DDL string for equivalence comparison.
 * - Convert CRLF/CR to LF, then all whitespace runs to single space
 * - Strip whitespace around (), and ;
 * - Lowercase the entire string (safe because we control all identifiers — no
 *   user-supplied strings; no quoted identifiers in our DDL)
 * - Trim
 * Idempotent: normalizeDdl(normalizeDdl(x)) === normalizeDdl(x)
 */
export function normalizeDdl(sql) {
  if (typeof sql !== 'string') return '';
  return sql
    .replace(/\r\n?/g, '\n')
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),;])\s*/g, '$1')
    .trim()
    .toLowerCase();
}
