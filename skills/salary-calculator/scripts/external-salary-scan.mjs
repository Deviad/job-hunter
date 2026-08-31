#!/usr/bin/env node
// external-salary-scan.mjs — read-only advertiser/ATS salary scan for saved jobs.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { insertObservation } from './lib/salary-db.mjs';
import { applyRetryTransition, getEnrichmentState } from './lib/enrichment-state.mjs';
import { computeNextRetry } from './lib/retry-state-machine.mjs';
import { acquire, formatContentionMessage, installSignalHandlers } from './lib/writer-lock.mjs';

const JH = process.env.JOBHUNTER_HOME || path.join(process.env.HOME, '.job-hunter');
const DEFAULT_DB = process.env.JOBHUNTER_DB || path.join(JH, 'jobhunter.sqlite');
const LOGS_DIR = path.join(JH, 'logs');

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
}

function usage(exitCode = 0) {
  const out = exitCode === 0 ? process.stdout : process.stderr;
  out.write(`Usage:\n`);
  out.write(`  external-salary-scan.mjs --search-id <id> [options]\n`);
  out.write(`  external-salary-scan.mjs --queue <curated-queue.json> [options]\n\n`);
  out.write(`Options:\n`);
  out.write(`  --db <path>          SQLite DB, default ${DEFAULT_DB}\n`);
  out.write(`  --out <path>         NDJSON output, default ~/.job-hunter/logs/external-salary-scan-*.ndjson\n`);
  out.write(`  --limit <n>          max jobs to inspect\n`);
  out.write(`  --cdp-port <n>       Chromium CDP port, default 9225\n`);
  out.write(`  --dry-run            scan and write output but do not insert observations\n`);
  out.write(`  --help               show this help\n`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const opts = {
    db: DEFAULT_DB,
    queue: null,
    searchId: null,
    out: path.join(LOGS_DIR, `external-salary-scan-${stamp()}.ndjson`),
    limit: 0,
    cdpPort: Number(process.env.CDP_PORT || process.env.BROWSER_CDP_PORT || 9225),
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
    else if (a === '--queue') opts.queue = next();
    else if (a === '--search-id') opts.searchId = next();
    else if (a === '--out') opts.out = next();
    else if (a === '--limit') opts.limit = Number(next());
    else if (a === '--cdp-port' || a === '--port') opts.cdpPort = Number(next());
    else if (a === '--dry-run') opts.dryRun = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!opts.searchId && opts.queue) {
    const q = JSON.parse(fs.readFileSync(opts.queue, 'utf8'));
    opts.searchId = q.search_id || q.searchId || null;
    opts.queueJobs = Array.isArray(q.jobs) ? q.jobs : (Array.isArray(q) ? q : []);
  }
  if (!opts.searchId && !opts.queueJobs?.length) throw new Error('provide --search-id or --queue');
  return opts;
}

function requireFromWorkspace(id) {
  return createRequire(path.join(JH, 'package.json'))(id);
}
const WebSocket = requireFromWorkspace('ws');
const Database = requireFromWorkspace('better-sqlite3');

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function makeCdpHttp(cdpPort) {
  return function httpJson(method, reqPath) {
    return new Promise((resolve, reject) => {
      const req = http.request({ method, host: '127.0.0.1', port: cdpPort, path: reqPath, timeout: 10000 }, (res) => {
        let d = '';
        res.on('data', (c) => { d += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(d)); } catch { reject(new Error(`bad JSON from CDP: ${d.slice(0, 200)}`)); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('CDP HTTP timeout')); });
      req.end();
    });
  };
}

class Cdp {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 1; this.pending = new Map(); }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('ws timeout')), 10000);
      this.ws.on('open', () => { clearTimeout(t); resolve(); });
      this.ws.on('error', (e) => { clearTimeout(t); reject(e); });
    });
    this.ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (!m.id) return;
      const p = this.pending.get(m.id);
      if (!p) return;
      clearTimeout(p.t);
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message || 'CDP error'));
      else p.resolve(m.result);
    });
  }
  send(method, params = {}, timeout = 20000) {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, timeout);
      this.pending.set(id, { resolve, reject, t });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression, timeout = 20000) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeout);
    if (r?.exceptionDetails) throw new Error(`JS exception ${JSON.stringify(r.exceptionDetails).slice(0, 300)}`);
    return r?.result?.value;
  }
  close() { try { this.ws.close(); } catch {} }
}

async function newTab(httpJson, url) {
  const tab = await httpJson('PUT', `/json/new?url=${encodeURIComponent(url)}`);
  const c = new Cdp(tab.webSocketDebuggerUrl);
  await c.connect();
  await c.send('Page.enable');
  await c.send('Runtime.enable');
  await c.send('Page.navigate', { url });
  return { tab, c };
}
async function closeTab(httpJson, tabId) { try { await httpJson('GET', `/json/close/${tabId}`); } catch {} }

function salaryCandidates(text) {
  if (!text) return [];
  const clean = text.replace(/\s+/g, ' ');
  const patterns = [
    /(?:salary|base pay range|pay range|compensation|range|remuneration)?[^£€$A-Z]{0,30}((?:GBP|EUR|USD|DKK|CHF|£|€|\$)\s?[0-9][0-9.,]*(?:\s?[kK])?\s*(?:-|–|—|to)\s*(?:(?:GBP|EUR|USD|DKK|CHF|£|€|\$)\s?)?[0-9][0-9.,]*(?:\s?[kK])?(?:\s*(?:per year|\/yr|year|annually|annual|p\.a\.))?)/gi,
    /((?:GBP|EUR|USD|DKK|CHF|£|€|\$)\s?[0-9][0-9.,]*(?:\s?[kK])?\s*(?:per year|\/yr|year|annually|annual|p\.a\.))/gi,
  ];
  const out = [];
  const seen = new Set();
  for (const re of patterns) {
    for (const m of clean.matchAll(re)) {
      const start = Math.max(0, m.index - 180);
      const end = Math.min(clean.length, m.index + m[0].length + 220);
      const snippet = clean.slice(start, end).trim();
      const key = `${m[1]}|${snippet.slice(0, 80)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ match: m[1].trim(), snippet });
      if (out.length >= 8) return out;
    }
  }
  return out;
}

function parseRange(match) {
  if (!match) return null;
  let currency = '';
  if (/£|GBP/i.test(match)) currency = 'GBP';
  else if (/€|EUR/i.test(match)) currency = 'EUR';
  else if (/\$|USD/i.test(match)) currency = 'USD';
  else if (/DKK/i.test(match)) currency = 'DKK';
  else if (/CHF/i.test(match)) currency = 'CHF';
  const nums = [...match.matchAll(/(?:GBP|EUR|USD|DKK|CHF|£|€|\$)?\s*([0-9][0-9.,]*)\s*([kK])?/g)].map((x) => {
    let n = x[1].replace(/,/g, '');
    if (/^\d+\.\d+$/.test(n) && Number(n) < 1000 && !x[2]) n = String(Number(n) * 1000);
    let v = Number(n);
    if (x[2]) v *= 1000;
    return v;
  }).filter((n) => Number.isFinite(n));
  if (!currency || nums.length === 0) return null;
  const min = nums[0];
  const max = nums[1] || nums[0];
  return { currency, min, max, median: (min + max) / 2 };
}

function isLikelyExactCandidate(c, source) {
  const s = (c.snippet || '').toLowerCase();
  if (/base pay range|provided pay range|salary\s*:|salary range|pay range/.test(s)) return true;
  if (source === 'external' && /salary|compensation|remuneration|base/.test(s)) return true;
  return false;
}

async function pageText(c) {
  return await c.eval(`(() => ({url: location.href, title: document.title, text: document.body ? document.body.innerText : ''}))()`);
}

async function findExternal(c) {
  return await c.eval(`(() => {
    const linkObjs = Array.from(document.querySelectorAll('a')).map(a => ({text:(a.innerText||a.textContent||'').trim().slice(0,80), href:a.href||'', tracking:a.getAttribute('data-tracking-control-name')||'', aria:a.getAttribute('aria-label')||''}));
    function isExternal(h){ try { const u=new URL(h, location.href); return !/(^|\\.)linkedin\\.com$/i.test(u.hostname); } catch { return false; } }
    const explicit = linkObjs.find(x => /apply-link-offsite|offsite|external/i.test(x.tracking) && x.href);
    const nonLiApply = linkObjs.find(x => /apply/i.test(x.text+' '+x.aria+' '+x.tracking) && x.href && (isExternal(x.href) || String(x.href).toLowerCase().includes('safety/go')));
    const buttons = Array.from(document.querySelectorAll('button, a')).map((b,idx)=>({idx, tag:b.tagName, text:(b.innerText||b.textContent||'').trim().replace(/\s+/g,' ').slice(0,80), cls:b.className||'', aria:b.getAttribute('aria-label')||''})).filter(x=>/apply/i.test(x.text+' '+x.aria+' '+x.cls));
    return {explicit: explicit||null, nonLiApply: nonLiApply||null, buttons: buttons.slice(0,10), allExternal: linkObjs.filter(x=>x.href && isExternal(x.href)).slice(0,20)};
  })()`);
}

async function clickApplyAndDetect(c, beforeIds, httpJson) {
  const clicked = await c.eval(`(() => {
    const els=Array.from(document.querySelectorAll('button, a'));
    const el=els.find(b => /^(apply|apply now)$/i.test((b.innerText||b.textContent||b.getAttribute('aria-label')||'').trim()) && !/easy apply/i.test((b.innerText||b.textContent||'')));
    if (!el) return {clicked:false, reason:'no non-easy apply button'};
    el.click(); return {clicked:true, text:(el.innerText||el.textContent||el.getAttribute('aria-label')||'').trim()};
  })()`);
  let current = null;
  let tabs = [];
  for (let i = 0; i < 14; i += 1) {
    await delay(1000);
    current = await c.eval(`(() => location.href)()`).catch(() => null);
    tabs = await httpJson('GET', '/json/list').catch(() => []);
    const newTabs = tabs.filter((t) => !beforeIds.has(t.id));
    const usefulNew = newTabs.find((t) => t.url && !/^about:blank$/i.test(t.url) && !/^chrome:\/\//i.test(t.url));
    const currentUseful = current && !/^about:blank$/i.test(current) && !/^chrome:\/\//i.test(current);
    if (usefulNew || (currentUseful && !/linkedin\.com\/jobs\/view/i.test(current))) break;
  }
  const newTabs = tabs.filter((t) => !beforeIds.has(t.id));
  return { clicked, current, newTabs: newTabs.map((t) => ({ id: t.id, url: t.url, title: t.title, ws: t.webSocketDebuggerUrl })) };
}

function decodeLinkedinSafety(h) {
  try {
    const u = new URL(h);
    const target = u.searchParams.get('url');
    if (target) return decodeURIComponent(target);
  } catch {}
  return h;
}

function chooseExact(candidates, source) {
  for (const c of candidates) {
    const parsed = parseRange(c.match);
    if (!parsed) continue;
    if (isLikelyExactCandidate(c, source)) return { ...c, ...parsed, source };
  }
  return null;
}

function shapeObservation(row, exactCandidate, nowIso) {
  const dataSource = exactCandidate.source === 'external' ? 'advertiser_ats' : 'linkedin';
  return {
    job_source: row.source,
    job_id: row.job_id,
    data_source: dataSource,
    data_source_url: exactCandidate.sourceUrl || row.url,
    benchmark_id: null,
    confidence_label: dataSource === 'advertiser_ats' ? 'external_exact' : 'posted_exact',
    matched_by: 'exact_job',
    is_posted_salary: 1,
    is_predicted: 0,
    currency: exactCandidate.currency,
    amount_min: exactCandidate.min,
    amount_max: exactCandidate.max,
    amount_median: exactCandidate.median,
    period: 'year',
    compensation_type: 'base_salary',
    annualized_min: exactCandidate.min,
    annualized_max: exactCandidate.max,
    annualized_median: exactCandidate.median,
    annualization_note: 'posted annual salary range parsed from job page',
    location_raw: row.location_raw ?? null,
    country_code: row.country_code ?? null,
    region: row.region ?? null,
    city: row.city ?? null,
    evidence_snippet: exactCandidate.evidence || exactCandidate.snippet || exactCandidate.match,
    raw_payload_json: { exactCandidate, job: { source: row.source, job_id: row.job_id, title: row.title, company: row.company } },
    observed_at: nowIso,
  };
}

function rowsForScan(db, opts) {
  if (opts.searchId) {
    return db.prepare(`
      WITH latest_obs AS (
        SELECT o.*, ROW_NUMBER() OVER (PARTITION BY o.job_source,o.job_id ORDER BY o.is_posted_salary DESC,o.observed_at DESC,o.created_at DESC) rn
        FROM job_salary_observations o
      )
      SELECT j.source,j.job_id,j.title,j.company,j.country_code,j.region,j.city,j.location_raw,j.url,lo.is_posted_salary,lo.data_source
      FROM jobs j JOIN match_results mr ON mr.source=j.source AND mr.job_id=j.job_id
      LEFT JOIN latest_obs lo ON lo.job_source=j.source AND lo.job_id=j.job_id AND lo.rn=1
      WHERE mr.search_id=? AND mr.cta='Apply' AND COALESCE(lo.is_posted_salary,0)=0
      ORDER BY CASE j.country_code WHEN 'GB' THEN 0 WHEN 'IE' THEN 1 WHEN 'NL' THEN 2 WHEN 'DK' THEN 3 ELSE 9 END, j.company, j.title
    `).all(opts.searchId);
  }
  const queueJobs = opts.queueJobs || [];
  const stmt = db.prepare(`
    SELECT j.source,j.job_id,j.title,j.company,j.country_code,j.region,j.city,j.location_raw,j.url
    FROM jobs j
    WHERE j.source = COALESCE(@source, j.source) AND j.job_id=@job_id
  `);
  return queueJobs.map((j) => stmt.get({ source: j.source || null, job_id: String(j.job_id) })).filter(Boolean);
}

function isLinkedinJob(url) {
  try { return /(^|\.)linkedin\.com$/i.test(new URL(url).hostname) && /\/jobs\/view/i.test(new URL(url).pathname); } catch { return false; }
}

async function scanRow(row, httpJson) {
  const rec = {
    at: new Date().toISOString(),
    job: row,
    linkedinSalaryCandidates: [],
    externalUrl: null,
    externalTitle: null,
    externalSalaryCandidates: [],
    exactCandidate: null,
    insertedObservation: null,
    errors: [],
  };
  let tab;
  let c;
  try {
    const before = new Set((await httpJson('GET', '/json/list')).map((t) => t.id));
    ({ tab, c } = await newTab(httpJson, row.url));
    await delay(5500);
    const first = await pageText(c);
    if (isLinkedinJob(row.url)) {
      rec.linkedinUrl = first.url;
      rec.linkedinTitle = first.title;
      rec.linkedinSalaryCandidates = salaryCandidates((first.text || '').split(/Show more jobs like this|Similar jobs|People also viewed/i)[0]);
      const liExact = chooseExact(rec.linkedinSalaryCandidates, 'linkedin');
      if (liExact) rec.exactCandidate = { ...liExact, sourceUrl: first.url, evidence: liExact.snippet };
      const found = await findExternal(c);
      rec.applyInspection = found;
      let externalHref = found?.explicit?.href || found?.nonLiApply?.href || null;
      if (externalHref) externalHref = decodeLinkedinSafety(externalHref);
      if (!externalHref && !rec.exactCandidate) {
        const det = await clickApplyAndDetect(c, before, httpJson);
        rec.clickDetect = det;
        const current = det.current || '';
        if (/^https?:\/\//i.test(current) && !/linkedin\.com/i.test(new URL(current).hostname)) externalHref = current;
        if (!externalHref && det.newTabs?.length) {
          const nt = det.newTabs.find((t) => t.url && /^https?:\/\//i.test(t.url) && !/linkedin\.com/i.test(new URL(t.url).hostname));
          if (nt) { externalHref = nt.url; rec.externalTabId = nt.id; }
        }
      }
      if (externalHref && !/linkedin\.com\/signup|linkedin\.com\/login/i.test(externalHref)) {
        rec.externalUrl = externalHref;
        let extC = c;
        let extTabId = tab.id;
        const tabs = await httpJson('GET', '/json/list').catch(() => []);
        const opened = tabs.find((t) => t.url === externalHref || (rec.externalTabId && t.id === rec.externalTabId));
        if (opened && opened.webSocketDebuggerUrl && opened.id !== tab.id) {
          extC = new Cdp(opened.webSocketDebuggerUrl);
          await extC.connect(); await extC.send('Page.enable'); await extC.send('Runtime.enable'); extTabId = opened.id;
        } else {
          await c.send('Page.navigate', { url: externalHref }); await delay(6500);
        }
        const ext = await pageText(extC);
        rec.externalUrl = ext.url || externalHref; rec.externalTitle = ext.title;
        rec.externalSalaryCandidates = salaryCandidates((ext.text || '').slice(0, 250000));
        const extExact = chooseExact(rec.externalSalaryCandidates, 'external');
        if (extExact) rec.exactCandidate = { ...extExact, sourceUrl: ext.url || externalHref, evidence: extExact.snippet };
        if (extC !== c) extC.close();
        if (extTabId !== tab.id) await closeTab(httpJson, extTabId);
      }
    } else {
      rec.externalUrl = first.url || row.url;
      rec.externalTitle = first.title;
      rec.externalSalaryCandidates = salaryCandidates((first.text || '').slice(0, 250000));
      const extExact = chooseExact(rec.externalSalaryCandidates, 'external');
      if (extExact) rec.exactCandidate = { ...extExact, sourceUrl: first.url || row.url, evidence: extExact.snippet };
    }
  } catch (e) {
    rec.errors.push(String(e?.stack || e));
  } finally {
    try { c?.close(); } catch {}
    if (tab?.id) await closeTab(httpJson, tab.id);
  }
  return rec;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  fs.mkdirSync(path.dirname(opts.out), { recursive: true });
  fs.writeFileSync(opts.out, '');
  const db = new Database(opts.db);
  const rows = rowsForScan(db, opts);
  console.log(`scan start ${rows.length} jobs; out=${opts.out}; dry_run=${opts.dryRun}`);
  const httpJson = makeCdpHttp(opts.cdpPort);
  let lock = null;
  let uninstall = null;
  if (!opts.dryRun) {
    lock = acquire(db);
    if (!lock.acquired) {
      console.error(formatContentionMessage(lock.holder));
      process.exit(4);
    }
    uninstall = installSignalHandlers(lock);
    lock.startHeartbeat();
  }
  let count = 0;
  let inserted = 0;
  try {
    for (const row of rows) {
      if (opts.limit && count >= opts.limit) break;
      count += 1;
      console.log(`[${count}/${rows.length}] ${row.source}:${row.job_id} ${row.title} — ${row.company}`);
      const rec = await scanRow(row, httpJson);
      if (rec.exactCandidate) {
        const obs = shapeObservation(row, rec.exactCandidate, new Date().toISOString());
        if (!opts.dryRun) {
          try {
            const res = insertObservation(db, obs);
            const prior = getEnrichmentState(db, row.source, row.job_id) || { exact_status: 'pending', exact_attempt_count: 0 };
            const transition = computeNextRetry({
              axis: 'exact',
              prevStatus: prior.exact_status,
              prevAttemptCount: Number(prior.exact_attempt_count || 0),
              event: { kind: 'success' },
              nowIso: obs.observed_at,
            });
            applyRetryTransition(db, row.source, row.job_id, 'exact', transition, obs.observed_at);
            rec.insertedObservation = res;
            rec.enrichmentState = { exact: transition.status, attemptCount: transition.attemptCount };
            if (res.inserted) inserted += 1;
          } catch (err) {
            rec.errors.push(`insert failed: ${String(err?.message || err)}`);
          }
        }
        console.log(`  exact ${rec.exactCandidate.currency} ${rec.exactCandidate.min}-${rec.exactCandidate.max} from ${rec.exactCandidate.sourceUrl}`);
      } else if (rec.externalUrl) console.log(`  external no exact: ${rec.externalUrl.slice(0, 120)}`);
      else console.log('  no external/exact found');
      fs.appendFileSync(opts.out, `${JSON.stringify(rec)}\n`);
      await delay(800);
    }
  } finally {
    if (lock) lock.release();
    if (uninstall) uninstall();
    db.close();
  }
  const done = `${opts.out}.done`;
  fs.writeFileSync(done, `${new Date().toISOString()}\n`);
  console.log(`scan done inspected=${count} inserted=${inserted} done=${done}`);
}

main().catch((err) => {
  console.error(`[fatal] ${err.stack || err}`);
  process.exit(2);
});
