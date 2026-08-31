// Drift detector — compares stored sqlite_master DDL against canonical strings
// from salary-schema.mjs. Returns Array<{name, type, expected, actual}>;
// empty array means no drift.
import { normalizeDdl } from './ddl-normalize.mjs';
import { TABLES, INDEXES, TRIGGERS, EXPECTED_NAMES } from './salary-schema.mjs';

// SQLite stores trigger/table DDL stripped of `IF NOT EXISTS`. Normalize that
// modifier away on BOTH sides so equivalence comparisons don't false-positive.
const stripIfNotExists = (s) =>
  s.replace(/create (table|index|trigger) if not exists /, 'create $1 ');

export function detectDrift(db) {
  const expected = new Map();
  for (const [name, sql] of Object.entries(TABLES)) expected.set(name, { type: 'table', sql });
  for (const [name, sql] of Object.entries(INDEXES)) expected.set(name, { type: 'index', sql });
  for (const [name, sql] of Object.entries(TRIGGERS)) expected.set(name, { type: 'trigger', sql });

  const placeholders = EXPECTED_NAMES.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT type, name, sql FROM sqlite_master WHERE name IN (${placeholders})`
  ).all(...EXPECTED_NAMES);
  const stored = new Map(rows.map(r => [r.name, r]));

  const diffs = [];
  for (const [name, exp] of expected) {
    const got = stored.get(name);
    if (!got) {
      diffs.push({ name, type: exp.type, expected: exp.sql, actual: null });
      continue;
    }
    const a = stripIfNotExists(normalizeDdl(got.sql));
    const b = stripIfNotExists(normalizeDdl(exp.sql));
    if (a !== b) {
      diffs.push({ name, type: exp.type, expected: exp.sql, actual: got.sql });
    }
  }
  return diffs;
}
