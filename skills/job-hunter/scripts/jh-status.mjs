#!/usr/bin/env node
// jh-status.mjs — pipeline dashboard over the canonical jobhunter.sqlite.
// Usage: node jh-status.mjs [--json]
import { openDb, DB_PATH } from './jh-common.mjs';
import { ROLE_LABEL_SET, UNCLASSIFIED_ROLE_LABEL, canonicalRoleLabel, rawRoleLabel } from './role-labels.mjs';
import { configuredFitThreshold } from './jh-profile.mjs';
const fitThreshold = configuredFitThreshold();

const asJson = process.argv.includes('--json');
const db = await openDb();
const NO_REASON = 'No role classification reason recorded.';

function boolValue(value) {
  if (typeof value === 'string') return /^(?:1|true|yes)$/i.test(value.trim());
  return value === true || value === 1;
}

function rows(sql, ...params) {
  try { return db.prepare(sql).all(...params); } catch { return null; }
}
function one(sql, ...params) {
  try { return db.prepare(sql).get(...params); } catch { return null; }
}

function reasonText(value) {
  if (value && typeof value === 'object') {
    const summary = typeof value.summary === 'string' ? value.summary.trim() : '';
    const reason = typeof value.reason === 'string' ? value.reason.trim() : '';
    const message = typeof value.message === 'string' ? value.message.trim() : '';
    const evidence = Array.isArray(value.evidence) ? value.evidence.filter(Boolean).join(', ') : '';
    const gaps = Array.isArray(value.gaps) ? value.gaps.filter(Boolean).join(', ') : '';
    return [summary || reason || message, evidence ? `Evidence: ${evidence}.` : '', gaps ? `Gaps: ${gaps}.` : '']
      .filter(Boolean).join(' ') || NO_REASON;
  }
  if (typeof value !== 'string' || !value.trim()) return NO_REASON;
  try {
    return reasonText(JSON.parse(value));
  } catch {
    return value.trim();
  }
}

function roleReport(row) {
  const rawLabel = rawRoleLabel(row.role_family_inferred);
  const canonicalLabel = canonicalRoleLabel(rawLabel);
  const valid = ROLE_LABEL_SET.has(rawLabel);
  const hasFullJd = row.role_has_full_jd !== undefined
    ? boolValue(row.role_has_full_jd)
    : typeof row.description_text === 'string' && row.description_text.trim().length > 0;
  const stage = hasFullJd ? 'full-JD' : 'provisional';
  const baseReason = reasonText(row.role_family_reason);
  let roleReason = baseReason;
  if (baseReason === NO_REASON) {
    if (!rawLabel) roleReason = 'Unclassified because no role label was recorded. No role classification reason recorded; reclassification is required.';
    else if (canonicalLabel === UNCLASSIFIED_ROLE_LABEL) roleReason = `Unclassified because stored role label "${rawLabel}" is not recognized by the adjacent-role taxonomy; reclassification is required.`;
    else if (canonicalLabel !== rawLabel) roleReason = `Legacy role label "${rawLabel}" normalized to "${canonicalLabel}"; detailed JD reason unavailable, so reclassification is recommended.`;
    else roleReason = `${canonicalLabel} classification has no detailed JD reason recorded; verify the full JD before applying.`;
  }
  return {
    role_family_label: canonicalLabel,
    role_family_raw_label: rawLabel || null,
    role_family_valid: valid,
    role_family_canonicalized: Boolean(rawLabel && !valid && canonicalLabel !== UNCLASSIFIED_ROLE_LABEL),
    role_family_reason_text: roleReason,
    role_classification_stage: stage,
    role_classification_status: stage,
  };
}

function withRoleReport(row) {
  return { ...row, ...roleReport(row) };
}

function roleFamilyCounts(records) {
  const grouped = new Map();
  for (const record of records || []) {
    const report = record.role_family_label ? record : roleReport(record);
    const weight = Number(record.n ?? 1);
    const current = grouped.get(report.role_family_label) || {
      role_family_label: report.role_family_label,
      n: 0,
      fullJd: 0,
      provisional: 0,
      raw_labels: new Set(),
    };
    current.n += weight;
    if (record.fullJd !== undefined || record.provisional !== undefined) {
      current.fullJd += Number(record.fullJd ?? 0);
      current.provisional += Number(record.provisional ?? 0);
    } else if (report.role_classification_stage === 'full-JD') {
      current.fullJd += weight;
    } else {
      current.provisional += weight;
    }
    if (report.role_family_raw_label) current.raw_labels.add(report.role_family_raw_label);
    grouped.set(report.role_family_label, current);
  }
  return [...grouped.values()]
    .map((entry) => ({ ...entry, raw_labels: [...entry.raw_labels] }))
    .sort((a, b) => b.n - a.n || a.role_family_label.localeCompare(b.role_family_label));
}

function roleLine(row) {
  const confidenceValue = row.role_family_confidence == null || String(row.role_family_confidence).trim() === ''
    ? null
    : Number(row.role_family_confidence);
  const confidence = Number.isFinite(confidenceValue)
    ? `, confidence ${confidenceValue.toFixed(3)}`
    : '';
  return `${row.role_family_label} [${row.role_classification_stage}${confidence}] — ${row.role_family_reason_text}`;
}

const out = { db: DB_PATH };

out.jobsBySource = rows(`SELECT source, COUNT(*) n FROM jobs GROUP BY source ORDER BY n DESC`);
out.jobsTotal = one(`SELECT COUNT(*) n FROM jobs`)?.n;
out.jdMissing = one(`SELECT COUNT(*) n FROM jobs WHERE description_text IS NULL OR TRIM(description_text) = ''`)?.n;
out.roleFamilyCounts = roleFamilyCounts(rows(`
  SELECT role_family_inferred, COUNT(*) n,
         SUM(CASE WHEN description_text IS NOT NULL AND TRIM(description_text) <> '' THEN 1 ELSE 0 END) fullJd,
         SUM(CASE WHEN description_text IS NULL OR TRIM(description_text) = '' THEN 1 ELSE 0 END) provisional
  FROM jobs GROUP BY role_family_inferred
`) || []);
out.roleClassificationCoverage = {
  provisional: one(`SELECT COUNT(*) n FROM jobs WHERE description_text IS NULL OR TRIM(description_text) = ''`)?.n ?? 0,
  fullJd: one(`SELECT COUNT(*) n FROM jobs WHERE description_text IS NOT NULL AND TRIM(description_text) <> ''`)?.n ?? 0,
};

out.scored = one(`SELECT COUNT(*) n FROM match_results`)?.n;
out.unscored = one(`SELECT COUNT(*) n FROM jobs j WHERE NOT EXISTS (SELECT 1 FROM match_results m WHERE m.source = j.source AND m.job_id = j.job_id)`)?.n;
out.applyQueue = (rows(`
  SELECT m.fit_score, j.title, j.company, j.source, j.job_id,
         j.role_family_inferred, j.role_family_confidence, j.role_family_reason,
         CASE WHEN j.description_text IS NULL OR TRIM(j.description_text) = '' THEN 0 ELSE 1 END AS role_has_full_jd
  FROM match_results m JOIN jobs j ON j.source = m.source AND j.job_id = m.job_id
  WHERE m.fit_score >= ? AND m.cta = 'Apply'
    AND NOT EXISTS (SELECT 1 FROM application_runs a WHERE a.job_source = j.source AND a.job_id = j.job_id AND a.status IN ('submitted','success','completed'))
  ORDER BY m.fit_score DESC`, fitThreshold) || [])
  .map(withRoleReport)
  .filter((row) => !['Out of scope', 'Unclassified'].includes(row.role_family_label))
  .slice(0, 15);

out.applications = rows(`SELECT status, COUNT(*) n FROM application_runs GROUP BY status ORDER BY n DESC`);

const sal = one(`SELECT COUNT(DISTINCT job_id) n FROM job_salary_observations`);
out.salaryCoverage = sal && out.jobsTotal
  ? `${sal.n}/${out.jobsTotal} (${Math.round((100 * sal.n) / out.jobsTotal)}%)`
  : null;

if (asJson) { console.log(JSON.stringify(out, null, 2)); db.close(); process.exit(0); }

console.log(`Job Hunter Status — ${DB_PATH}\n`);
console.log(`Jobs: ${out.jobsTotal} total, ${out.jdMissing} missing JD`);
for (const r of out.jobsBySource || []) console.log(`  ${r.source ?? 'unknown'}: ${r.n}`);
console.log(`\nRole classification (audit counts):`);
for (const r of out.roleFamilyCounts) console.log(`  ${r.role_family_label}: ${r.n} (full-JD ${r.fullJd}, provisional ${r.provisional})`);
console.log(`  Evidence: ${out.roleClassificationCoverage.fullJd} full-JD, ${out.roleClassificationCoverage.provisional} provisional`);
console.log(`\nScoring: ${out.scored} scored, ${out.unscored} unscored`);
console.log(`Salary coverage: ${out.salaryCoverage ?? 'n/a'}`);
console.log(`\nApplications by status:`);
for (const r of out.applications || []) console.log(`  ${r.status ?? 'unknown'}: ${r.n}`);
console.log(`\nApply queue (fit>=${fitThreshold}, not yet applied; reviewed roles only) — top ${out.applyQueue?.length ?? 0}:`);
for (const r of out.applyQueue || []) console.log(`  [${r.fit_score}] ${roleLine(r)} — ${r.title} @ ${r.company} (${r.source}:${r.job_id})`);
db.close();
