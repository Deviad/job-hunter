#!/usr/bin/env node
// batch-salary-research.mjs — queue/search-id driver for enrich-job-salary.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JH = process.env.JOBHUNTER_HOME || path.join(process.env.HOME, '.job-hunter');
const DEFAULT_DB = process.env.JOBHUNTER_DB || path.join(JH, 'jobhunter.sqlite');
const LOGS_DIR = path.join(JH, 'logs');
const ENRICH = path.join(__dirname, 'enrich-job-salary.mjs');
const EXTERNAL_SCAN = path.join(__dirname, 'external-salary-scan.mjs');

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
}

function usage(exitCode = 0) {
  const out = exitCode === 0 ? process.stdout : process.stderr;
  out.write(`Usage:\n`);
  out.write(`  batch-salary-research.mjs --search-id <id> [options]\n`);
  out.write(`  batch-salary-research.mjs --queue <curated-queue.json> [options]\n\n`);
  out.write(`Options:\n`);
  out.write(`  --db <path>       SQLite DB, default ${DEFAULT_DB}\n`);
  out.write(`  --out <path>      progress NDJSON, default ~/.job-hunter/logs/batch-salary-research-*.ndjson\n`);
  out.write(`  --done <path>     done marker, default <out>.done\n`);
  out.write(`  --limit <n>       max jobs\n`);
  out.write(`  --dry-run         pass --dry-run through to enrich-job-salary\n`);
  out.write(`  --help            show this help\n`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const opts = {
    db: DEFAULT_DB,
    searchId: null,
    queue: null,
    out: path.join(LOGS_DIR, `batch-salary-research-${stamp()}.ndjson`),
    done: null,
    limit: 0,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} requires a value`);
      return argv[++i];
    };
    if (a === '--help' || a === '-h') usage(0);
    else if (a === '--db') opts.db = next();
    else if (a === '--search-id') opts.searchId = next();
    else if (a === '--queue') opts.queue = next();
    else if (a === '--out') opts.out = next();
    else if (a === '--done') opts.done = next();
    else if (a === '--limit') opts.limit = Number(next());
    else if (a === '--dry-run') opts.dryRun = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!opts.done) opts.done = `${opts.out}.done`;
  if (!opts.searchId && opts.queue) {
    const q = JSON.parse(fs.readFileSync(opts.queue, 'utf8'));
    opts.searchId = q.search_id || q.searchId || null;
    opts.queueJobs = Array.isArray(q.jobs) ? q.jobs : (Array.isArray(q) ? q : []);
  }
  if (!opts.searchId && !opts.queueJobs?.length) throw new Error('provide --search-id or --queue');
  return opts;
}

function openDb(dbPath) {
  const req = createRequire(path.join(JH, 'package.json'));
  const Database = req('better-sqlite3');
  return new Database(dbPath, { readonly: true });
}

function jobsForQueue(db, opts) {
  if (opts.searchId) {
    return db.prepare(`
      SELECT j.source, j.job_id, j.title, j.company, j.country_code, mr.fit_score, mr.stretch_label
      FROM jobs j
      JOIN match_results mr ON mr.source = j.source AND mr.job_id = j.job_id
      WHERE mr.search_id = ? AND mr.cta = 'Apply'
      ORDER BY CASE mr.stretch_label WHEN 'Core fit' THEN 0 WHEN 'Stretch' THEN 1 ELSE 2 END,
               mr.fit_score DESC, j.title COLLATE NOCASE
    `).all(opts.searchId);
  }
  const stmt = db.prepare(`SELECT source, job_id, title, company, country_code FROM jobs WHERE source=COALESCE(@source, source) AND job_id=@job_id`);
  return (opts.queueJobs || []).map((j) => stmt.get({ source: j.source || null, job_id: String(j.job_id) })).filter(Boolean);
}

function appendJsonLine(file, obj) {
  fs.appendFileSync(file, `${JSON.stringify(obj)}\n`);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  fs.mkdirSync(path.dirname(opts.out), { recursive: true });
  fs.writeFileSync(opts.out, '');
  const db = openDb(opts.db);
  let jobs = jobsForQueue(db, opts);
  db.close();
  if (opts.limit > 0) jobs = jobs.slice(0, opts.limit);
  const totalJobs = jobs.length;
  console.log(`salary research start jobs=${totalJobs} out=${opts.out} dry_run=${opts.dryRun}`);
  let ok = 0;
  let failed = 0;

  const externalJobs = jobs.filter((j) => j.source === 'external');
  if (externalJobs.length) {
    const queuePath = path.join(path.dirname(opts.out), `batch-salary-external-${Date.now()}.json`);
    const externalOut = opts.out.replace(/\.ndjson$/i, '') + '-external-salary-scan.ndjson';
    fs.writeFileSync(queuePath, JSON.stringify({ jobs: externalJobs.map((j) => ({ source: j.source, job_id: j.job_id })) }, null, 2));
    const extArgs = ['node', EXTERNAL_SCAN, '--queue', queuePath, '--db', opts.db, '--out', externalOut, '--limit', String(externalJobs.length)];
    if (opts.dryRun) extArgs.push('--dry-run');
    const p = spawnSync(extArgs[0], extArgs.slice(1), { cwd: JH, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
    appendJsonLine(opts.out, {
      at: new Date().toISOString(),
      kind: 'external_salary_scan',
      jobs: externalJobs.length,
      returncode: p.status,
      ok: p.status === 0,
      out: externalOut,
      stdout: p.stdout.slice(-4000),
      stderr: p.stderr.slice(-4000),
    });
    if (p.status === 0) ok += externalJobs.length;
    else failed += externalJobs.length;
    jobs = jobs.filter((j) => j.source !== 'external');
  }

  for (let i = 0; i < jobs.length; i += 1) {
    const job = jobs[i];
    console.log(`[${i + 1}/${jobs.length}] ${job.source}:${job.job_id} ${job.title} — ${job.company}`);
    const args = ['node', ENRICH, '--db', opts.db, '--source', job.source, '--job-id', job.job_id, '--json'];
    if (opts.dryRun) args.push('--dry-run');
    const startedAt = new Date().toISOString();
    const p = spawnSync(args[0], args.slice(1), { cwd: JH, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
    let parsed = null;
    try { parsed = JSON.parse(p.stdout); } catch {}
    const rec = {
      at: new Date().toISOString(),
      started_at: startedAt,
      job,
      returncode: p.status,
      ok: p.status === 0,
      stdout: parsed || p.stdout.slice(-4000),
      stderr: p.stderr.slice(-4000),
    };
    if (rec.ok) ok += 1;
    else failed += 1;
    appendJsonLine(opts.out, rec);
  }
  fs.writeFileSync(opts.done, JSON.stringify({ done_at: new Date().toISOString(), jobs: totalJobs, ok, failed }, null, 2));
  console.log(`salary research done jobs=${totalJobs} ok=${ok} failed=${failed} done=${opts.done}`);
  process.exitCode = failed ? 1 : 0;
}

try { main(); }
catch (err) {
  console.error(`[fatal] ${err.stack || err}`);
  process.exit(2);
}
