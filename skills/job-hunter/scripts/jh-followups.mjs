#!/usr/bin/env node
// jh-followups.mjs — applications needing a nudge.
// A job needs follow-up when its LATEST stage event is 'applied' or 'screening'
// and is older than --days (default 7). Terminal stages (offer/rejected/withdrawn/ghosted)
// and recent activity are excluded.
// Usage: node jh-followups.mjs [--days N] [--json]
import { openDb, DB_PATH } from './jh-common.mjs';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
let days = 7;
const di = args.indexOf('--days');
if (di !== -1) days = Number(args[di + 1]) || 7;

const db = await openDb();

// Ensure migration ran
const hasTable = db.prepare(`SELECT 1 FROM sqlite_master WHERE name='application_stage_events'`).get();
if (!hasTable) {
  console.error('application_stage_events missing — run: node jh-migrate.mjs');
  process.exit(2);
}

const rows = db.prepare(`
  WITH latest AS (
    SELECT e.job_source, e.job_id, e.stage, e.occurred_at, e.note,
           ROW_NUMBER() OVER (PARTITION BY e.job_source, e.job_id ORDER BY e.occurred_at DESC, e.id DESC) rn
    FROM application_stage_events e
  )
  SELECT l.job_source, l.job_id, l.stage, l.occurred_at,
         CAST(julianday('now') - julianday(l.occurred_at) AS INTEGER) AS days_ago,
         j.title, j.company, j.url, j.recruiter, j.recruiter_email, j.recruiter_profile_link
  FROM latest l
  JOIN jobs j ON j.source = l.job_source AND j.job_id = l.job_id
  WHERE l.rn = 1
    AND l.stage IN ('applied','screening')
    AND julianday('now') - julianday(l.occurred_at) >= ?
  ORDER BY days_ago DESC
`).all(days);

if (asJson) { console.log(JSON.stringify(rows, null, 2)); db.close(); process.exit(0); }

console.log(`Follow-ups needed — latest stage 'applied'/'screening' older than ${days} days (${rows.length})\n`);
if (!rows.length) console.log('Nothing needs a nudge. 🎉');
for (const r of rows) {
  const who = r.recruiter ? ` | recruiter: ${r.recruiter}${r.recruiter_email ? ' <' + r.recruiter_email + '>' : ''}` : '';
  console.log(`[${String(r.days_ago).padStart(3)}d] (${r.stage}) ${r.title ?? '?'} @ ${r.company ?? '?'} (${r.job_source}:${r.job_id})${who}`);
  if (r.url) console.log(`       ${r.url}`);
}
console.log(`\nDB: ${DB_PATH}`);
console.log(`Tip: mark progress with jh-stage.mjs; mark dead ends 'ghosted' to silence them.`);
db.close();
