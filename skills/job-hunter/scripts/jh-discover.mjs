#!/usr/bin/env node
// jh-discover.mjs — discover external job postings beyond LinkedIn/Indeed via SearXNG.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  JOBHUNTER_HOME, DB_PATH as DEFAULT_DB_PATH, LOGS_DIR,
} from './jh-common.mjs';
import { assertRoleClassification, classifyRole } from './role-taxonomy.mjs';

const DEFAULT_LOCATIONS = ['United Kingdom', 'Ireland', 'Denmark', 'Netherlands'];
const DEFAULT_QUERIES = ['AI Architect', 'AI Solution Architect', 'Enterprise AI Architect', 'Generative AI Architect'];
const COUNTRY_BY_LOCATION = new Map([
  ['United Kingdom', 'GB'], ['UK', 'GB'], ['Great Britain', 'GB'],
  ['Ireland', 'IE'], ['Denmark', 'DK'], ['Netherlands', 'NL'], ['The Netherlands', 'NL'],
]);
const PORTAL_MARKERS = [
  'greenhouse', 'lever.co', 'workdayjobs', 'myworkdayjobs', 'ashbyhq', 'smartrecruiters',
  'otta.com', 'wellfound', 'cord.co', 'hackajob', 'reed.co.uk', 'totaljobs', 'cwjobs',
  'irishjobs', 'jobindex', 'jobnet', 'stepstone', 'careers', 'jobs', 'join-us', 'vacancies',
];
const EXCLUDED_HOST_RE = /(^|\.)(linkedin\.com|indeed\.|glassdoor\.|monster\.|ziprecruiter\.)/i;

function usage(exitCode = 0) {
  const out = exitCode === 0 ? process.stdout : process.stderr;
  out.write(`Usage:\n`);
  out.write(`  jh-discover.mjs [--locations UK,Ireland] [--queries "AI Architect,AI Lead"] [options]\n\n`);
  out.write(`Options:\n`);
  out.write(`  --locations <list>       comma/semicolon-separated locations (default: UK, IE, DK, NL)\n`);
  out.write(`  --queries <list>         comma/semicolon-separated role queries\n`);
  out.write(`  --time-range <value>     SearXNG time_range, default week\n`);
  out.write(`  --searxng-url <url>      default http://localhost:8888\n`);
  out.write(`  --limit-per-query <n>    SearXNG results inspected per query, default 12\n`);
  out.write(`  --db <path>              SQLite DB, default ${DEFAULT_DB_PATH}\n`);
  out.write(`  --out <path>             discovery JSON artifact, default logs/jh-discover-*.json\n`);
  out.write(`  --no-backfill            only insert listing stubs\n`);
  out.write(`  --backfill-existing      backfill existing source=external rows instead of only new rows\n`);
  out.write(`  --backfill-only          skip SearXNG search and only backfill source=external rows\n`);
  out.write(`  --backfill-limit <n>     limit rows backfilled\n`);
  out.write(`  --dry-run                fetch/report only; no DB writes\n`);
  out.write(`  --json                   print machine-readable summary\n`);
  out.write(`  --help                   show this help\n`);
  process.exit(exitCode);
}

function splitList(value) {
  return String(value || '')
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseArgs(argv) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  const opts = {
    locations: DEFAULT_LOCATIONS,
    queries: DEFAULT_QUERIES,
    timeRange: 'week',
    searxngUrl: process.env.SEARXNG_URL || 'http://localhost:8888',
    limitPerQuery: 12,
    db: process.env.JOBHUNTER_DB || DEFAULT_DB_PATH,
    out: path.join(LOGS_DIR, `jh-discover-${stamp}.json`),
    backfill: true,
    backfillExisting: false,
    backfillOnly: false,
    backfillLimit: 0,
    dryRun: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} requires a value`);
      return argv[++i];
    };
    if (a === '--help' || a === '-h') usage(0);
    else if (a === '--locations' || a === '--location') opts.locations = splitList(next());
    else if (a === '--queries' || a === '--query') opts.queries = splitList(next());
    else if (a === '--time-range') opts.timeRange = next();
    else if (a === '--searxng-url') opts.searxngUrl = next().replace(/\/$/, '');
    else if (a === '--limit-per-query') opts.limitPerQuery = Number(next());
    else if (a === '--db') opts.db = next();
    else if (a === '--out') opts.out = next();
    else if (a === '--no-backfill') opts.backfill = false;
    else if (a === '--backfill-existing') opts.backfillExisting = true;
    else if (a === '--backfill-only') { opts.backfillOnly = true; opts.backfillExisting = true; }
    else if (a === '--backfill-limit') opts.backfillLimit = Number(next());
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--json') opts.json = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!opts.locations.length) throw new Error('--locations resolved to an empty list');
  if (!opts.queries.length && !opts.backfillOnly) throw new Error('--queries resolved to an empty list');
  return opts;
}

function requireFromWorkspace(id) {
  const req = createRequire(path.join(JOBHUNTER_HOME, 'package.json'));
  return req(id);
}

function openDb(dbPath) {
  if (!existsSync(dbPath)) throw new Error(`DB not found: ${dbPath}`);
  const Database = requireFromWorkspace('better-sqlite3');
  return new Database(dbPath);
}

function sha1(s) {
  return createHash('sha1').update(s).digest('hex');
}

function safeUrl(raw) {
  try { return new URL(raw); } catch { return null; }
}

function countryCodeFor(location) {
  if (COUNTRY_BY_LOCATION.has(location)) return COUNTRY_BY_LOCATION.get(location);
  const lower = location.toLowerCase();
  for (const [name, code] of COUNTRY_BY_LOCATION.entries()) {
    if (lower.includes(name.toLowerCase())) return code;
  }
  return null;
}

function classifyListing({ title = '', descriptionText = '', provisional = true, jobFunction = '', industries = '' } = {}) {
  return assertRoleClassification(classifyRole({
    title,
    descriptionText,
    jobFunction,
    industries,
    provisional,
  }));
}

function classificationFields(classification) {
  return {
    role_family_inferred: classification.label,
    role_family_confidence: classification.confidence,
    role_family_reason: JSON.stringify(classification.reason),
  };
}

function shouldRetainProvisional(classification) {
  if (classification.label !== 'Out of scope') return true;
  if (!classification.signals.aiCentral) return false;
  return classification.signals.exclusions.length === 0;
}

function portalLooksRelevant(host, haystack) {
  const hay = `${host} ${haystack}`.toLowerCase();
  return PORTAL_MARKERS.some((m) => hay.includes(m));
}

async function fetchJson(url, timeoutMs = 30000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'pi-job-hunter-discovery/1.0' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function searxngSearch(opts, query, location) {
  const u = new URL('/search', opts.searxngUrl);
  const quotedQuery = query.includes('"') ? query : `"${query}"`;
  u.searchParams.set('q', `${quotedQuery} jobs "${location}" -site:linkedin.com -site:indeed.com`);
  u.searchParams.set('format', 'json');
  u.searchParams.set('language', 'en');
  u.searchParams.set('safesearch', '0');
  if (opts.timeRange) u.searchParams.set('time_range', opts.timeRange);
  const data = await fetchJson(u);
  return (data.results || []).slice(0, opts.limitPerQuery);
}

function rowFromResult(result, query, location) {
  const url = result.url || '';
  const parsed = safeUrl(url);
  if (!parsed || EXCLUDED_HOST_RE.test(parsed.hostname)) return null;
  const title = String(result.title || '').trim();
  const content = String(result.content || '').trim();
  const classification = classifyListing({
    title,
    descriptionText: content,
    provisional: true,
  });
  if (!shouldRetainProvisional(classification)) return null;
  const hay = `${title} ${content} ${url}`;
  if (!portalLooksRelevant(parsed.hostname, hay)) return null;
  return {
    source: 'external',
    job_id: sha1(url).slice(0, 20),
    url,
    title: title.slice(0, 300) || query,
    company: companyFromUrl(url) || parsed.hostname.toLowerCase(),
    description_raw: content,
    description_text: '',
    location_raw: location,
    country_code: countryCodeFor(location),
    application_links_json: JSON.stringify([url]),
    language_filter_reason: 'listing-only: discovered by SearXNG; JD not backfilled',
    searched_keywords: query,
    searched_location: location,
    application_status: 'saved',
    ...classificationFields(classification),
  };
}

function insertDiscoveredRows(db, rows, dryRun) {
  if (rows.length === 0) return { inserted: 0, existing: 0, insertedRows: [] };

  const existingStmt = db.prepare(`
    SELECT 1 FROM jobs WHERE source = ? AND job_id = ?
  `);
  const newRows = rows.filter((row) => !existingStmt.get(row.source, row.job_id));
  if (dryRun) return { inserted: 0, existing: rows.length, insertedRows: newRows };

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO jobs (
      source, job_id, url, title, company, description_raw, description_text,
      location_raw, country_code, application_links_json, role_family_inferred,
      role_family_confidence, role_family_reason, language_filter_reason,
      searched_keywords, searched_location, application_status
    ) VALUES (
      @source, @job_id, @url, @title, @company, @description_raw, @description_text,
      @location_raw, @country_code, @application_links_json, @role_family_inferred,
      @role_family_confidence, @role_family_reason, @language_filter_reason,
      @searched_keywords, @searched_location, @application_status
    )
  `);
  let inserted = 0;
  const insertedRows = [];
  const txn = db.transaction((items) => {
    for (const row of items) {
      if (stmt.run(row).changes) {
        inserted += 1;
        insertedRows.push(row);
      }
    }
  });
  txn(newRows);
  return { inserted, existing: rows.length - inserted, insertedRows };
}

function decodeHtml(s) {
  return String(s || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&pound;/g, '£')
    .replace(/&euro;/g, '€')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function htmlToText(html) {
  let out = String(html || '');
  out = out.replace(/<script\b[\s\S]*?<\/script>/gi, ' ');
  out = out.replace(/<style\b[\s\S]*?<\/style>/gi, ' ');
  out = out.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ');
  out = out.replace(/<\/(?:h[1-6]|p|div|li|ul|ol|br|tr|td|th|table|section|article|header|footer|aside|nav|main)>/gi, '\n');
  out = out.replace(/<[^>]+>/g, ' ');
  out = decodeHtml(out);
  out = out.replace(/[ \t\r\f\v]+/g, ' ');
  out = out.replace(/\n\s+/g, '\n').replace(/\n{3,}/g, '\n\n');
  return out.trim();
}

function extractTitle(html) {
  const m = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeHtml(m[1].replace(/<[^>]+>/g, ' ')).trim() : '';
}

function extractMeta(html, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${esc}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i');
  const alt = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${esc}["'][^>]*>`, 'i');
  const m = String(html || '').match(re) || String(html || '').match(alt);
  return m ? decodeHtml(m[1]).trim() : '';
}

function parseJsonLdBlocks(html) {
  const blocks = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(String(html || ''))) !== null) {
    try { blocks.push(JSON.parse(decodeHtml(m[1]).trim())); } catch {}
  }
  return blocks;
}

function walkJson(value, visitor) {
  if (Array.isArray(value)) value.forEach((v) => walkJson(v, visitor));
  else if (value && typeof value === 'object') {
    visitor(value);
    Object.values(value).forEach((v) => walkJson(v, visitor));
  }
}

function extractJobPosting(html) {
  const blocks = parseJsonLdBlocks(html);
  let job = null;
  for (const block of blocks) {
    walkJson(block, (obj) => {
      const type = Array.isArray(obj['@type']) ? obj['@type'].join(' ') : String(obj['@type'] || '');
      if (!job && /JobPosting/i.test(type)) job = obj;
    });
  }
  return job;
}

function titleCaseSlug(slug) {
  return decodeURIComponent(String(slug || ''))
    .replace(/[-_+]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function companyFromUrl(rawUrl) {
  const u = safeUrl(rawUrl);
  if (!u) return '';
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split('/').filter(Boolean);
  let slug = '';
  if (/jobs\.lever\.co$/.test(host) && parts[0]) slug = parts[0];
  else if (/(^|\.)greenhouse\.io$/.test(host) && parts[0]) slug = parts[0];
  else if (/jobs\.ashbyhq\.com$/.test(host) && parts[0]) slug = parts[0];
  else if (/smartrecruiters\.com$/.test(host) && parts[0]) slug = parts[0];
  else if (/workdayjobs\.com$|myworkdayjobs\.com$/.test(host)) slug = host.split('.')[0].replace(/-?wd\d*$/i, '');
  return slug ? titleCaseSlug(slug) : '';
}

function companyFromTitle(pageTitle, jobTitle) {
  const title = String(pageTitle || '').trim();
  const job = String(jobTitle || '').trim();
  if (!title) return '';
  const withoutJob = job ? title.replace(new RegExp(job.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), '') : title;
  const parts = withoutJob.split(/\s+[-|–—]\s+|\s+at\s+/i).map((s) => s.trim()).filter(Boolean);
  const candidate = parts[parts.length - 1] || '';
  if (!candidate || /job|career|greenhouse|lever|workday|smartrecruiters|ashby/i.test(candidate)) return '';
  return candidate.slice(0, 120);
}

async function fetchHtml(url, timeoutMs = 30000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 pi-job-hunter-discovery/1.0',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { finalUrl: res.url || url, html: body };
  } finally {
    clearTimeout(t);
  }
}

function extractBackfill(url, html, existingTitle, searchedKeywords = '') {
  const jobPosting = extractJobPosting(html);
  const pageTitle = extractTitle(html) || extractMeta(html, 'og:title');
  const jsonDescription = jobPosting?.description ? htmlToText(String(jobPosting.description)) : '';
  const text = jsonDescription || htmlToText(html);
  const org = jobPosting?.hiringOrganization;
  const orgName = typeof org === 'string' ? org : (org?.name || '');
  const company = String(orgName || '').trim()
    || companyFromUrl(url)
    || companyFromTitle(pageTitle, existingTitle)
    || extractMeta(html, 'og:site_name');
  const queryTitle = String(searchedKeywords || '').split(';')[0]?.trim();
  const isQueryTitle = (value) => String(value || '').trim().toLowerCase() === queryTitle.toLowerCase();
  const safeJobPostingTitle = !isQueryTitle(jobPosting?.title) ? String(jobPosting?.title || '').trim() : '';
  const safeExistingTitle = !isQueryTitle(existingTitle) ? String(existingTitle || '').trim() : '';
  const safePageTitle = !isQueryTitle(pageTitle) ? String(pageTitle || '').trim() : '';
  const title = String(safeJobPostingTitle || safeExistingTitle || safePageTitle || '').trim();
  return {
    title: title.slice(0, 300),
    company: company ? company.slice(0, 200) : '',
    description_raw: html.slice(0, 250000),
    description_text: text.slice(0, 120000),
  };
}

function candidateRowsForBackfill(db, opts, discoveredRows) {
  if (opts.backfillExisting || opts.backfillOnly) {
    let sql = `
      SELECT source, job_id, url, title, company, description_text, searched_keywords, language_filter_reason
      FROM jobs
      WHERE source='external'
      ORDER BY datetime(created_at) DESC, title COLLATE NOCASE
    `;
    if (opts.backfillLimit > 0) sql += ` LIMIT ${Number(opts.backfillLimit)}`;
    return db.prepare(sql).all();
  }
  if (!discoveredRows.length) return [];
  if (opts.dryRun) return discoveredRows;
  const keys = discoveredRows.map((r) => r.job_id);
  const stmt = db.prepare(`
    SELECT source, job_id, url, title, company, description_text, searched_keywords, language_filter_reason
    FROM jobs WHERE source='external' AND job_id=?
  `);
  return keys.map((jobId) => stmt.get(jobId)).filter(Boolean);
}

async function backfillRows(db, opts, candidates) {
  const successStmt = db.prepare(`
    UPDATE jobs
       SET title = COALESCE(NULLIF(@title,''), title),
           company = COALESCE(NULLIF(@company,''), company),
           description_raw = @description_raw,
           description_text = @description_text,
           role_family_inferred = @role_family_inferred,
           role_family_confidence = @role_family_confidence,
           role_family_reason = @role_family_reason,
           language_filter_reason = NULL,
           updated_at = CURRENT_TIMESTAMP
     WHERE source = @source AND job_id = @job_id
  `);
  const failStmt = db.prepare(`
    UPDATE jobs
       SET language_filter_reason = @reason,
           updated_at = CURRENT_TIMESTAMP
     WHERE source = @source AND job_id = @job_id
  `);
  const results = [];
  for (const row of candidates) {
    const rec = { source: row.source, job_id: row.job_id, url: row.url, ok: false };
    try {
      const { finalUrl, html } = await fetchHtml(row.url);
      const extracted = extractBackfill(finalUrl, html, row.title, row.searched_keywords);
      if (!extracted.description_text || extracted.description_text.length < 200) {
        throw new Error(`description too short (${extracted.description_text.length} chars)`);
      }
      const classification = classifyListing({
        title: extracted.title,
        descriptionText: extracted.description_text,
        provisional: false,
      });
      const fields = classificationFields(classification);
      rec.ok = true;
      rec.finalUrl = finalUrl;
      rec.company = extracted.company || row.company;
      rec.descriptionChars = extracted.description_text.length;
      rec.role_family_inferred = fields.role_family_inferred;
      rec.role_family_confidence = fields.role_family_confidence;
      rec.role_family_reason = classification.reason;
      if (!opts.dryRun) {
        successStmt.run({ ...extracted, ...fields, source: row.source, job_id: row.job_id });
      }
    } catch (err) {
      rec.error = String(err?.message || err).slice(0, 240);
      if (!opts.dryRun) {
        failStmt.run({ source: row.source, job_id: row.job_id, reason: `backfill-failed: ${rec.error}` });
      }
    }
    results.push(rec);
    if (!opts.json) {
      const status = rec.ok ? `backfilled ${rec.descriptionChars} chars` : `failed ${rec.error}`;
      console.log(`[backfill] ${row.job_id} ${row.title || ''} — ${status}`);
    }
  }
  return results;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  mkdirSync(path.dirname(opts.out), { recursive: true });
  const db = opts.dryRun && !existsSync(opts.db) ? null : openDb(opts.db);
  const seen = new Set();
  const discovered = [];
  const searchErrors = [];

  if (!opts.backfillOnly) {
    for (const location of opts.locations) {
      for (const query of opts.queries) {
        try {
          const results = await searxngSearch(opts, query, location);
          for (const result of results) {
            const row = rowFromResult(result, query, location);
            if (!row || seen.has(row.url)) continue;
            seen.add(row.url);
            discovered.push(row);
          }
          if (!opts.json) console.log(`[search] ${query} / ${location}: inspected ${results.length}, kept ${discovered.length} total`);
        } catch (err) {
          const error = { query, location, error: String(err?.message || err) };
          searchErrors.push(error);
          if (!opts.json) console.log(`[search-error] ${query} / ${location}: ${error.error}`);
        }
      }
    }
  }

  const insertSummary = db
    ? insertDiscoveredRows(db, discovered, opts.dryRun)
    : { inserted: 0, existing: 0, insertedRows: [] };
  const backfillCandidates = opts.backfill && db
    ? candidateRowsForBackfill(db, opts, insertSummary.insertedRows)
    : [];
  const backfillResults = opts.backfill && db ? await backfillRows(db, opts, backfillCandidates) : [];
  const summary = {
    generated_at: new Date().toISOString(),
    db: opts.db,
    dry_run: opts.dryRun,
    discovered_count: discovered.length,
    inserted: insertSummary.inserted,
    existing: insertSummary.existing,
    search_errors: searchErrors,
    backfill_candidates: backfillCandidates.length,
    backfilled: backfillResults.filter((r) => r.ok).length,
    backfill_failed: backfillResults.filter((r) => !r.ok).length,
    output: opts.out,
  };
  const artifact = { summary, discovered, backfill: backfillResults };
  await import('node:fs').then((fs) => fs.writeFileSync(opts.out, JSON.stringify(artifact, null, 2)));
  if (db) db.close();
  if (opts.json) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log(`\nDiscovered ${summary.discovered_count}; inserted ${summary.inserted}; existing ${summary.existing}`);
    console.log(`Backfill candidates ${summary.backfill_candidates}; ok ${summary.backfilled}; failed ${summary.backfill_failed}`);
    console.log(`Wrote ${opts.out}`);
  }
  if (searchErrors.length && !opts.backfillOnly) process.exitCode = 1;
}

export {
  backfillRows,
  classificationFields,
  classifyListing,
  extractBackfill,
  insertDiscoveredRows,
  rowFromResult,
};

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(`[fatal] ${err.stack || err}`);
    process.exit(2);
  });
}
