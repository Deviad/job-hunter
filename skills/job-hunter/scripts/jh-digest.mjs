#!/usr/bin/env node
// jh-digest.mjs — what's new since the last digest.
// Shows: new jobs saved, newly scored fit>=60, stage changes. Watermark stored in jh_meta.
// Usage: node jh-digest.mjs [--json] [--dry-run]   (--dry-run: don't advance watermark)
import { openDb, DB_PATH } from './jh-common.mjs';
import { ROLE_LABELS } from './role-taxonomy.mjs';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const dryRun = args.includes('--dry-run');
const db = await openDb();
const ROLE_LABEL_SET = new Set(ROLE_LABELS);
const UNCLASSIFIED_ROLE_LABEL = 'Unclassified';
const ROLE_LABEL_ALIASES = new Map([
  ['exact architecture', 'Exact architecture'],
  ['adjacent technical', 'Adjacent technical'],
  ['leadership progression', 'Leadership progression'],
  ['leadership lateral', 'Leadership lateral'],
  ['conditional', 'Conditional'],
  ['data domain stretch', 'Data-domain stretch'],
  ['out of scope', 'Out of scope'],
  ['core architecture', 'Exact architecture'],
  ['ai architecture', 'Exact architecture'],
  ['ai architect', 'Exact architecture'],
  ['ai architect agentic systems', 'Exact architecture'],
  ['genai lead architect', 'Exact architecture'],
  ['ai ml data architect', 'Data-domain stretch'],
  ['data ai architect', 'Data-domain stretch'],
  ['ai security architect', 'Exact architecture'],
  ['ai software architect', 'Exact architecture'],
  ['ai solution architect', 'Exact architecture'],
  ['data architect', 'Out of scope'],
  ['non it architecture', 'Out of scope'],
  ['not matching ai architect scope', 'Out of scope'],
  ['out scope', 'Out of scope'],
  ['out-of-scope', 'Out of scope'],
]);
const NO_REASON = 'No role classification reason recorded.';

function labelKey(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[_/]+/g, ' ')
    .replace(/[–—-]+/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function rawRoleLabel(value) {
  if (value == null) return '';
  return String(value).trim();
}

function canonicalRoleLabel(value) {
  const raw = rawRoleLabel(value);
  if (ROLE_LABEL_SET.has(raw)) return raw;
  return ROLE_LABEL_ALIASES.get(labelKey(raw)) || UNCLASSIFIED_ROLE_LABEL;
}

function boolValue(value) {
  if (typeof value === 'string') return /^(?:1|true|yes)$/i.test(value.trim());
  return value === true || value === 1;
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

const hasMeta = db.prepare(`SELECT 1 FROM sqlite_master WHERE name='jh_meta'`).get();
if (!hasMeta) { console.error('jh_meta missing — run: node jh-migrate.mjs'); process.exit(2); }

const since = db.prepare(`SELECT value FROM jh_meta WHERE key='digest_last_run'`).get()?.value
  ?? db.prepare(`SELECT datetime('now','-7 days') v`).get().v; // first run: last 7 days

const newJobs = db.prepare(`
  SELECT source, job_id, title, company, city, country_code, created_at,
         role_family_inferred, role_family_confidence, role_family_reason,
         CASE WHEN description_text IS NULL OR TRIM(description_text) = '' THEN 0 ELSE 1 END AS role_has_full_jd
  FROM jobs WHERE created_at > ? ORDER BY created_at DESC`).all(since).map(withRoleReport);

const newHits = db.prepare(`
  SELECT m.fit_score, m.cta, m.created_at, j.source, j.job_id, j.title, j.company,
         j.role_family_inferred, j.role_family_confidence, j.role_family_reason,
         CASE WHEN j.description_text IS NULL OR TRIM(j.description_text) = '' THEN 0 ELSE 1 END AS role_has_full_jd
  FROM match_results m JOIN jobs j ON j.source=m.source AND j.job_id=m.job_id
  WHERE m.created_at > ? AND m.fit_score >= 60
  ORDER BY m.fit_score DESC, m.created_at DESC`).all(since).map(withRoleReport);

let stageChanges = [];
if (db.prepare(`SELECT 1 FROM sqlite_master WHERE name='application_stage_events'`).get()) {
  stageChanges = db.prepare(`
    SELECT e.stage, e.occurred_at, e.note, j.title, j.company, e.job_source, e.job_id,
           j.role_family_inferred, j.role_family_confidence, j.role_family_reason,
           CASE WHEN j.description_text IS NULL OR TRIM(j.description_text) = '' THEN 0 ELSE 1 END AS role_has_full_jd
    FROM application_stage_events e JOIN jobs j ON j.source=e.job_source AND j.job_id=e.job_id
    WHERE e.occurred_at > ? AND (e.note IS NULL OR e.note NOT LIKE 'backfilled%')
    ORDER BY e.occurred_at DESC`).all(since).map(withRoleReport);
}

const out = {
  since,
  now: new Date().toISOString(),
  newJobs,
  newHits,
  stageChanges,
  roleFamilyAudit: {
    newJobs: roleFamilyCounts(newJobs),
    newHits: roleFamilyCounts(newHits),
    stageChanges: roleFamilyCounts(stageChanges),
  },
};

if (!dryRun) {
  db.prepare(`INSERT INTO jh_meta (key, value, updated_at) VALUES ('digest_last_run', datetime('now'), datetime('now'))
              ON CONFLICT(key) DO UPDATE SET value=datetime('now'), updated_at=datetime('now')`).run();
}

if (asJson) { console.log(JSON.stringify(out, null, 2)); db.close(); process.exit(0); }

console.log(`Digest since ${since} — ${DB_PATH}${dryRun ? '  (dry-run, watermark not advanced)' : ''}\n`);
console.log(`New jobs saved: ${newJobs.length}`);
for (const j of newJobs.slice(0, 20)) console.log(`  [${String(j.created_at ?? '').slice(0, 10)}] ${roleLine(j)} — ${j.title ?? '?'} @ ${j.company ?? '?'} — ${j.city ?? ''} ${j.country_code ?? ''} (${j.source}:${j.job_id})`);
if (newJobs.length > 20) console.log(`  ... and ${newJobs.length - 20} more`);

console.log('\nRole-family audit (includes Out of scope):');
for (const group of out.roleFamilyAudit.newJobs) {
  console.log(`  ${group.role_family_label}: ${group.n} (full-JD ${group.fullJd}, provisional ${group.provisional})`);
}

console.log(`\nNewly scored fit>=60: ${newHits.length}`);
for (const h of newHits.slice(0, 20)) console.log(`  [${h.fit_score}] ${h.cta} — ${roleLine(h)} — ${h.title ?? '?'} @ ${h.company ?? '?'} (${h.source}:${h.job_id})`);
if (newHits.length > 20) console.log(`  ... and ${newHits.length - 20} more`);

console.log('\nNewly scored role-family audit (includes Out of scope):');
for (const group of out.roleFamilyAudit.newHits) {
  console.log(`  ${group.role_family_label}: ${group.n} (full-JD ${group.fullJd}, provisional ${group.provisional})`);
}

console.log(`\nStage changes: ${stageChanges.length}`);
for (const s of stageChanges) console.log(`  [${String(s.occurred_at ?? '').slice(0, 10)}] ${s.stage} — ${roleLine(s)} — ${s.title ?? '?'} @ ${s.company ?? '?'}${s.note ? ' — ' + s.note : ''}`);
db.close();
