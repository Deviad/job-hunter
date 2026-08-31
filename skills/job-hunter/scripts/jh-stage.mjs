#!/usr/bin/env node
// jh-stage.mjs — record or inspect interview-pipeline stages.
//
// Record : node jh-stage.mjs set <source> <job_id> <stage> [note...]
//          stages: applied screening interview offer rejected withdrawn ghosted
// History: node jh-stage.mjs log <source> <job_id>
// Board  : node jh-stage.mjs board [--json]   (latest stage per job, grouped)
import { openDb } from './jh-common.mjs';

const STAGES = ['applied', 'screening', 'interview', 'offer', 'rejected', 'withdrawn', 'ghosted'];
const [cmd, ...rest] = process.argv.slice(2);
const db = await openDb();

const hasTable = db.prepare(`SELECT 1 FROM sqlite_master WHERE name='application_stage_events'`).get();
if (!hasTable) { console.error('run jh-migrate.mjs first'); process.exit(2); }

if (cmd === 'set') {
  const [source, jobId, stage, ...noteParts] = rest;
  if (!source || !jobId || !STAGES.includes(stage)) {
    console.error(`Usage: jh-stage.mjs set <source> <job_id> <stage> [note]\nstages: ${STAGES.join(' ')}`);
    process.exit(1);
  }
  const job = db.prepare(`SELECT title, company FROM jobs WHERE source=? AND job_id=?`).get(source, jobId);
  if (!job) { console.error(`job not found: ${source}:${jobId}`); process.exit(1); }
  db.prepare(`INSERT INTO application_stage_events (job_source, job_id, stage, note) VALUES (?,?,?,?)`)
    .run(source, jobId, stage, noteParts.join(' ') || null);
  // Keep jobs.application_status coherent for the common transitions
  if (stage === 'applied') db.prepare(`UPDATE jobs SET application_status='applied', applied_at=COALESCE(applied_at, CURRENT_TIMESTAMP) WHERE source=? AND job_id=?`).run(source, jobId);
  if (stage === 'withdrawn') db.prepare(`UPDATE jobs SET application_status='withdrawn' WHERE source=? AND job_id=?`).run(source, jobId);
  console.log(`✓ ${stage} — ${job.title} @ ${job.company} (${source}:${jobId})`);
} else if (cmd === 'log') {
  const [source, jobId] = rest;
  if (!source || !jobId) { console.error('Usage: jh-stage.mjs log <source> <job_id>'); process.exit(1); }
  const events = db.prepare(`SELECT stage, note, occurred_at FROM application_stage_events WHERE job_source=? AND job_id=? ORDER BY occurred_at, id`).all(source, jobId);
  if (!events.length) console.log('no stage events');
  for (const e of events) console.log(`${e.occurred_at}  ${e.stage}${e.note ? '  — ' + e.note : ''}`);
} else if (cmd === 'board' || cmd === undefined) {
  const asJson = rest.includes('--json');
  const rows = db.prepare(`
    WITH latest AS (
      SELECT job_source, job_id, stage, occurred_at,
             ROW_NUMBER() OVER (PARTITION BY job_source, job_id ORDER BY occurred_at DESC, id DESC) rn
      FROM application_stage_events
    )
    SELECT l.stage, l.occurred_at, l.job_source, l.job_id, j.title, j.company
    FROM latest l JOIN jobs j ON j.source=l.job_source AND j.job_id=l.job_id
    WHERE l.rn=1 ORDER BY
      CASE l.stage WHEN 'offer' THEN 0 WHEN 'interview' THEN 1 WHEN 'screening' THEN 2
        WHEN 'applied' THEN 3 WHEN 'ghosted' THEN 4 WHEN 'rejected' THEN 5 ELSE 6 END,
      l.occurred_at DESC`).all();
  if (asJson) { console.log(JSON.stringify(rows, null, 2)); }
  else {
    let cur = null;
    if (!rows.length) console.log('board empty — record stages with: jh-stage.mjs set <source> <job_id> <stage>');
    for (const r of rows) {
      if (r.stage !== cur) { cur = r.stage; console.log(`\n== ${cur.toUpperCase()} ==`); }
      console.log(`  ${r.occurred_at.slice(0, 10)}  ${r.title ?? '?'} @ ${r.company ?? '?'} (${r.job_source}:${r.job_id})`);
    }
  }
} else {
  console.error(`Unknown command '${cmd}'. Use: set | log | board`);
  process.exit(1);
}
db.close();
