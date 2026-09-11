#!/usr/bin/env node
import http from 'node:http';
import { writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startCdpKeepAlive } from '../../linkedin-job-search/scripts/cdp-keepalive.mjs';
import { tryAcquireLease } from '../../linkedin-job-search/scripts/cdp-lease.mjs';
import { classifyRole, assertRoleClassification, expandRoleQueries } from '../../job-hunter/scripts/role-taxonomy.mjs';
import { loadProfile } from '../../job-hunter/scripts/jh-profile.mjs';
import { loadDataFile } from '../../job-hunter/scripts/jh-profile-extract.mjs';
let activeTaxonomy = null;

const JOBHUNTER_HOME = process.env.JOBHUNTER_HOME || path.join(process.env.HOME || process.cwd(), '.job-hunter');
const DEFAULT_DB = process.env.JOBHUNTER_DB || path.join(JOBHUNTER_HOME, 'jobhunter.sqlite');
const DEFAULT_SAVE_SCRIPT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'linkedin-job-search', 'scripts', 'save-to-sqlite.mjs');
const DEFAULT_CDP_PORT = Number(process.env.INDEED_CDP_PORT || process.env.BROWSER_CDP_PORT || 9225) || 9225;

function usage(exitCode = 0) {
  console.error(`
Usage:
  node search-indeed-jobs.mjs --domain https://uk.indeed.com --query "AI Architect" --location "London" [options]

Options:
  --query, --q <text>             Search keywords (required)
  --location, --l <text>          Indeed location (required)
  --domain <url>                  Indeed domain/origin (default: https://uk.indeed.com)
  --pages <n>                     Search result pages to inspect (default: 2)
  --max <n>                       Maximum unique jobs to detail-fetch (default: 25)
  --fromage <days>                Posted within N days (optional)
  --sort <date|relevance>         Sort order (default: date)
  --max-queries <n>               Maximum bounded taxonomy query expansion (default: 8)
  --no-query-expansion            Search only the supplied --query
  --speaks <csv>                  Languages the user can satisfy (default: confirmed profile)
  --exclude-languages <csv>       Required languages that should skip a role
  --include-skipped               Include skipped jobs in --out/--save
  --cdp-port <port>               CDP port for active browser session (default: ${DEFAULT_CDP_PORT})
  --keepalive-seconds <n>         CDP heartbeat interval; 0 disables (default: 15)
  --wait-ms <ms>                  Initial wait after each navigation (default: 2500)
  --out <path>                    Write normalized JSON records
  --save                          Save normalized records to SQLite
  --db <path>                     SQLite DB path (default: ${DEFAULT_DB})
  --save-script <path>            Generic save-to-sqlite script path
  --json                          Print full normalized records to stdout
  --help                          Show this help
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const opts = {
    domain: 'https://uk.indeed.com',
    pages: 2,
    max: 25,
    sort: 'date',
    maxQueries: 8,
    queryExpansion: true,
    speaks: [],
    excludeLanguages: [],
    includeSkipped: false,
    cdpPort: DEFAULT_CDP_PORT,
    keepAliveSeconds: Math.max(0, Number(process.env.CDP_KEEPALIVE_SECONDS ?? 15) || 0),
    waitMs: 2500,
    db: DEFAULT_DB,
    saveScript: DEFAULT_SAVE_SCRIPT,
    save: false,
    json: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[++i];
    };
    if (arg === '--help' || arg === '-h') usage(0);
    else if (arg === '--query' || arg === '--q') opts.query = next();
    else if (arg === '--location' || arg === '--l') opts.location = next();
    else if (arg === '--domain') opts.domain = next();
    else if (arg === '--pages') opts.pages = Math.max(1, Number(next()) || 1);
    else if (arg === '--max') opts.max = Math.max(1, Number(next()) || 1);
    else if (arg === '--fromage') opts.fromage = Math.max(0, Number(next()) || 0);
    else if (arg === '--sort') opts.sort = next();
    else if (arg === '--max-queries') opts.maxQueries = Math.max(1, Number(next()) || 1);
    else if (arg === '--no-query-expansion') opts.queryExpansion = false;
    else if (arg === '--speaks') opts.speaks = splitCsv(next());
    else if (arg === '--exclude-languages') opts.excludeLanguages = splitCsv(next());
    else if (arg === '--include-skipped') opts.includeSkipped = true;
    else if (arg === '--cdp-port') opts.cdpPort = Number(next()) || DEFAULT_CDP_PORT;
    else if (arg === '--keepalive-seconds') opts.keepAliveSeconds = Math.max(0, Number(next()) || 0);
    else if (arg === '--wait-ms') opts.waitMs = Math.max(500, Number(next()) || 2500);
    else if (arg === '--out') opts.out = next();
    else if (arg === '--save') opts.save = true;
    else if (arg === '--db') opts.db = next();
    else if (arg === '--save-script') opts.saveScript = next();
    else if (arg === '--json') opts.json = true;
    else throw new Error(`Unknown option: ${arg}`);
  }

  if (!opts.query || !opts.location) usage(2);
  opts.domain = normalizeDomain(opts.domain);
  return opts;
}

function splitCsv(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeDomain(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) return 'https://uk.indeed.com';
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const url = new URL(withScheme);
  return `${url.protocol}//${url.host}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Invalid JSON from ${url}: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.seq = 0;
    this.pending = new Map();
  }

  async connect() {
    if (typeof WebSocket !== 'function') {
      throw new Error('Global WebSocket is unavailable. Use Node 22+ or run from Pi runtime with WebSocket support.');
    }
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const item = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? item.reject(new Error(JSON.stringify(msg.error))) : item.resolve(msg.result);
      }
    };
  }

  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    this.ws.send(JSON.stringify(msg));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  close() {
    try { this.ws?.close(); } catch {}
  }
}

async function connectCdp(port) {
  let wsUrl = null;
  try {
    const version = await getJson(`http://127.0.0.1:${port}/json/version`);
    wsUrl = version.webSocketDebuggerUrl;
  } catch {}
  if (!wsUrl) {
    const tabs = await getJson(`http://127.0.0.1:${port}/json/list`);
    wsUrl = tabs?.[0]?.webSocketDebuggerUrl;
  }
  if (!wsUrl) throw new Error(`No CDP WebSocket found on port ${port}. Start or reconnect the active browser CDP session first.`);
  const client = new CdpClient(wsUrl);
  await client.connect();
  return client;
}

async function withPage(client, fn) {
  let targetId;
  try {
    const target = await client.send('Target.createTarget', { url: 'about:blank' });
    targetId = target.targetId;
    const attached = await client.send('Target.attachToTarget', { targetId, flatten: true });
    const sessionId = attached.sessionId;
    await client.send('Page.enable', {}, sessionId);
    await client.send('Runtime.enable', {}, sessionId);
    await client.send('Network.enable', {}, sessionId).catch(() => {});
    return await fn(sessionId);
  } finally {
    if (targetId) await client.send('Target.closeTarget', { targetId }).catch(() => {});
  }
}

async function evaluateJson(client, sessionId, expression) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  }, sessionId);
  if (result.exceptionDetails) {
    const desc = result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Runtime exception';
    throw new Error(desc);
  }
  const value = result.result?.value;
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function isVerificationText(text) {
  return /verify you are human|unusual traffic|captcha|security check|additional verification|required verification/i.test(String(text || ''));
}

async function fetchPageJson(client, sessionId, url, expression, accept, opts) {
  const nav = await client.send('Page.navigate', { url }, sessionId);
  if (nav.errorText) throw new Error(`Navigation failed for ${url}: ${nav.errorText}`);
  await sleep(opts.waitMs);

  let last;
  for (let i = 0; i < 7; i++) {
    last = await evaluateJson(client, sessionId, expression);
    if (isVerificationText(last?.text || last?.body || last?.title)) {
      throw new Error(`Indeed verification/CAPTCHA page detected at ${url}; user intervention required.`);
    }
    if (!accept || accept(last)) return last;
    await sleep(900);
  }
  return last;
}

function buildSearchUrl(opts, query, pageIndex) {
  const url = new URL('/jobs', opts.domain);
  url.searchParams.set('q', query);
  url.searchParams.set('l', opts.location);
  if (opts.sort) url.searchParams.set('sort', opts.sort);
  if (opts.fromage) url.searchParams.set('fromage', String(opts.fromage));
  if (pageIndex > 0) url.searchParams.set('start', String(pageIndex * 10));
  return url.toString();
}

const SEARCH_EXPR = `JSON.stringify((() => {
  const clean = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
  const textOf = (el) => clean(el?.innerText || el?.textContent || '');
  const firstText = (root, selectors) => {
    for (const selector of selectors) {
      const el = root?.querySelector?.(selector);
      const val = clean(el?.getAttribute?.('title') || el?.getAttribute?.('aria-label') || textOf(el));
      if (val) return val;
    }
    return '';
  };
  const keyFromHref = (href) => {
    try {
      const u = new URL(href, location.href);
      return u.searchParams.get('jk') || u.searchParams.get('vjk') || '';
    } catch { return ''; }
  };
  const jobKey = (el, card) => {
    let node = el;
    for (let i = 0; node && i < 8; i++, node = node.parentElement) {
      const key = node.getAttribute?.('data-jk');
      if (key) return key;
    }
    const own = el.getAttribute?.('data-jk') || card?.getAttribute?.('data-jk');
    if (own) return own;
    const link = el.closest?.('a[href]') || el.querySelector?.('a[href]') || card?.querySelector?.('a[href*="jk="],a[href*="vjk="],a[href*="/rc/clk"]');
    return keyFromHref(link?.href || '');
  };
  const candidates = Array.from(document.querySelectorAll('[data-jk], a[data-jk], a[href*="jk="], a[href*="vjk="], a[href*="/rc/clk"]'));
  const seen = new Set();
  const jobs = [];
  for (const el of candidates) {
    const card = el.closest('[data-jk]') || el.closest('td.resultContent') || el.closest('div.job_seen_beacon') || el.closest('li') || el.closest('article') || el;
    const key = jobKey(el, card);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const title = firstText(card, [
      'h2 a span[title]',
      'h2.jobTitle span[title]',
      '[data-testid="jobTitle"]',
      'a[data-jk] span[title]',
      'a[data-jk]',
      'h2'
    ]) || textOf(el).split('\\n')[0];
    const company = firstText(card, ['[data-testid="company-name"]', '[data-testid="companyName"]', '.companyName', '[data-company-name]']);
    const locationRaw = firstText(card, ['[data-testid="text-location"]', '[data-testid="job-location"]', '.companyLocation']);
    const salary = firstText(card, ['[data-testid="attribute_snippet_testid"]', '.salary-snippet', '.metadata.salary-snippet-container']);
    const cardDescriptionText = firstText(card, [
      '.job-snippet',
      '[data-testid="job-snippet"]',
      '[data-testid="jobDescription"]',
    ]);
    const cardText = textOf(card);
    const postedMatch = cardText.match(/(Just posted|Posted today|Today|Employer active today|\\d+\\+?\\s+days? ago|Posted\\s+\\d+[^.]{0,40})/i);
    const href = new URL('/viewjob', location.origin);
    href.searchParams.set('jk', key);
    jobs.push({
      jobId: key,
      url: href.toString(),
      title,
      company,
      locationRaw,
      salaryRaw: salary,
      jobPostingDateRaw: postedMatch ? postedMatch[1] : '',
      cardDescriptionText,
      cardText: cardText.slice(0, 1000),
    });
  }
  return { url: location.href, title: document.title || '', text: textOf(document.body).slice(0, 2000), jobs };
})())`;

const DETAIL_EXPR = `JSON.stringify((() => {
  const clean = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
  const textOf = (el) => clean(el?.innerText || el?.textContent || '');
  const htmlToText = (html) => {
    const div = document.createElement('div');
    div.innerHTML = String(html || '');
    return textOf(div);
  };
  const firstText = (selectors) => {
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      const val = clean(el?.getAttribute?.('title') || el?.getAttribute?.('aria-label') || textOf(el));
      if (val) return val;
    }
    return '';
  };
  const flatten = (value, out = []) => {
    if (!value) return out;
    if (Array.isArray(value)) { for (const item of value) flatten(item, out); return out; }
    if (typeof value === 'object') {
      out.push(value);
      if (value['@graph']) flatten(value['@graph'], out);
      for (const key of ['mainEntity', 'itemListElement']) flatten(value[key], out);
    }
    return out;
  };
  const jsonLd = [];
  for (const script of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
    try { flatten(JSON.parse(script.textContent || ''), jsonLd); } catch {}
  }
  const posting = jsonLd.find((item) => String(item['@type'] || '').toLowerCase().includes('jobposting')) || {};
  const addressToText = (addr) => clean([
    addr?.streetAddress,
    addr?.addressLocality,
    addr?.addressRegion,
    addr?.postalCode,
    addr?.addressCountry?.name || addr?.addressCountry,
  ].filter(Boolean).join(', '));
  const locToText = (loc) => {
    if (Array.isArray(loc)) return clean(loc.map(locToText).filter(Boolean).join('; '));
    return addressToText(loc?.address || loc) || clean(loc?.name || '');
  };
  const salaryToText = (salary) => {
    if (!salary) return '';
    if (typeof salary === 'string') return salary;
    const value = salary.value || salary;
    const parts = [salary.currency || value.currency, value.minValue, value.maxValue || value.value, value.unitText].filter(Boolean);
    return clean(parts.join(' ')) || clean(JSON.stringify(salary));
  };
  const descriptionFromJson = htmlToText(posting.description || '');
  const descriptionFromDom = firstText(['#jobDescriptionText', '[data-testid="jobsearch-JobComponent-description"]', '[id*="jobDescription"]']);
  const jobFunction = clean(posting.jobFunction || posting.occupationalCategory || firstText(['[data-testid="job-function"]', '[data-testid="jobsearch-JobComponent-jobFunction"]']));
  const industries = clean(posting.industry || posting.industries || firstText(['[data-testid="industry"]', '[data-testid="jobsearch-JobComponent-industry"]']));
  const body = textOf(document.body);
  const applyLinks = new Set([location.href]);
  for (const a of Array.from(document.querySelectorAll('a[href]'))) {
    const href = a.href || '';
    const label = textOf(a);
    if (/apply|company site|continue|start/i.test(label) || /apply|ia=1|from=mobRdr/i.test(href)) applyLinks.add(href);
  }
  return {
    url: location.href,
    title: clean(posting.title || firstText(['h1', '[data-testid="jobsearch-JobInfoHeader-title"]'])),
    company: clean(posting.hiringOrganization?.name || firstText(['[data-testid="inlineHeader-companyName"]', '[data-company-name]', 'a[href*="/cmp/"]'])),
    locationRaw: clean(locToText(posting.jobLocation) || firstText(['[data-testid="job-location"]', '[data-testid="inlineHeader-companyLocation"]', '#jobLocationText'])),
    salaryRaw: clean(salaryToText(posting.baseSalary) || firstText(['[data-testid="jobsearch-JobInfoHeader-salary"]', '[aria-label*="Salary"]'])),
    jobPostingDate: clean(posting.datePosted || ''),
    validThrough: clean(posting.validThrough || ''),
    jobFunction,
    industries,
    descriptionText: clean(descriptionFromDom || descriptionFromJson),
    descriptionExtracted: Boolean(descriptionFromDom || descriptionFromJson),
    applicationLinks: Array.from(applyLinks),
    text: body.slice(0, 2500),
  };
})())`;

function stripHtml(value) {
  return String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function uniq(values) {
  return [...new Set(values.map((v) => String(v || '').trim()).filter(Boolean))];
}

const KNOWN_LANGUAGES = Object.keys(loadDataFile('language-aliases.json').languages);

function escapeRe(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseLanguages(text) {
  const source = String(text || '');
  const lower = source.toLowerCase();
  const required = [];
  const niceToHave = [];
  const requiredWords = '(must|required|mandatory|essential|fluent|proficient|native|business fluent|professional)';
  const niceWords = '(nice to have|preferred|bonus|plus|optional|advantage|good to have|desirable)';

  for (const lang of KNOWN_LANGUAGES) {
    const langRe = escapeRe(lang.toLowerCase());
    const req = new RegExp(`${requiredWords}[^.\\n]{0,80}\\b${langRe}\\b|\\b${langRe}\\b[^.\\n]{0,80}${requiredWords}`, 'i');
    const nice = new RegExp(`${niceWords}[^.\\n]{0,80}\\b${langRe}\\b|\\b${langRe}\\b[^.\\n]{0,80}${niceWords}`, 'i');
    if (req.test(lower)) required.push(lang);
    else if (nice.test(lower)) niceToHave.push(lang);
  }

  return { required: uniq(required), niceToHave: uniq(niceToHave) };
}

function languageDecision(requirements, opts) {
  const speaks = new Set(opts.speaks.map((s) => s.toLowerCase()));
  const excludes = new Set(opts.excludeLanguages.map((s) => s.toLowerCase()));
  const failing = requirements.required.filter((lang) => excludes.has(lang.toLowerCase()));
  const unknown = requirements.required.filter((lang) => !speaks.has(lang.toLowerCase()) && !excludes.has(lang.toLowerCase()));
  if (failing.length) return { include: false, reason: `SKIP: requires ${failing.join(', ')}` };
  if (unknown.length) return { include: true, unknown, reason: `REVIEW: confirm proficiency in ${unknown.join(', ')}` };
  if (requirements.required.length) return { include: true, reason: `PASS: required languages satisfied (${requirements.required.join(', ')})` };
  return { include: true, reason: 'PASS: no required non-user languages found' };
}

function classifyForIndeed(job, taxonomy = activeTaxonomy) {
  const title = String(job.title || '').trim();
  const evidenceText = `${job.title || ''}\n${job.descriptionText || ''}\n${job.jobFunction || ''}\n${job.industries || ''}`;
  const classification = assertRoleClassification(classifyRole({
    taxonomy,
    title,
    descriptionText: job.descriptionText,
    jobFunction: job.jobFunction,
    industries: job.industries,
    provisional: Boolean(job.provisional),
  }));
  if (!title || /we can.?t find this page|page not found|error 404/i.test(title) || /we can.?t find this page|page not found|error 404/i.test(evidenceText)) {
    return { include: false, reason: 'SKIP: invalid or expired Indeed job page', classification };
  }

  const include = classification.label !== 'Out of scope';
  const reason = classification.reason.summary;
  return {
    include,
    reason: `${include ? 'PASS' : 'SKIP'}: ${reason}`,
    classification,
  };
}

function roleReasonText(classification) {
  if (!classification?.reason) return null;
  const { summary, evidence = [], gaps = [] } = classification.reason;
  const details = [];
  if (evidence.length) details.push(`Evidence: ${evidence.join('; ')}`);
  if (gaps.length) details.push(`Gaps: ${gaps.join('; ')}`);
  return [summary, ...details].join(' ');
}

function normalizeSalary(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text || /^salary guide$/i.test(text)) return null;
  return text;
}

function inferWorkModes(job) {
  const text = `${job.title || ''}\n${job.locationRaw || ''}\n${job.descriptionText || ''}`;
  const modes = [];
  if (/remote|work from home|home[- ]based/i.test(text)) modes.push('remote');
  if (/hybrid/i.test(text)) modes.push('hybrid');
  if (/on[- ]?site|office[- ]based|in office/i.test(text)) modes.push('onsite');
  return uniq(modes).map((mode, index) => ({ workMode: mode, isPrimary: index === 0 }));
}

function countryForDomain(domain) {
  const host = new URL(domain).host.toLowerCase();
  if (host.startsWith('uk.')) return 'GB';
  if (host.startsWith('ie.')) return 'IE';
  if (host.startsWith('ch.')) return 'CH';
  if (host.startsWith('de.')) return 'DE';
  if (host.startsWith('fr.')) return 'FR';
  if (host.startsWith('nl.')) return 'NL';
  if (host.startsWith('it.')) return 'IT';
  if (host === 'www.indeed.com' || host === 'indeed.com') return 'US';
  return null;
}

function inferCity(locationRaw) {
  const text = String(locationRaw || '').trim();
  if (!text || /remote|united kingdom|ireland|switzerland|united states/i.test(text)) return null;
  return text.split(/,|\(|-/)[0].trim() || null;
}

function normalizeJob(searchJob, detail, opts) {
  const merged = { ...searchJob, ...detail };
  // Detail pages can omit fields that were present on the result card. Keep the
  // card values as extraction fallbacks, but classify only the permitted JD
  // evidence fields and the final detail description when one was extracted.
  const title = String(merged.title || searchJob.title || '').trim();
  const company = String(merged.company || searchJob.company || '').trim();
  const locationRaw = String(merged.locationRaw || searchJob.locationRaw || '').trim();
  const descriptionText = stripHtml(merged.descriptionText || merged.cardDescriptionText || '');
  const jobFunction = String(merged.jobFunction || searchJob.jobFunction || '').trim();
  const industries = String(merged.industries || searchJob.industries || '').trim();
  const provisional = merged.descriptionExtracted !== true;
  const requirements = parseLanguages(descriptionText);
  const lang = languageDecision(requirements, opts);
  const role = classifyForIndeed({
    title,
    descriptionText,
    jobFunction,
    industries,
    provisional,
  }, opts.taxonomy || activeTaxonomy);
  const classification = role.classification;
  const include = lang.include && role.include;
  const languageFilterReason = include ? lang.reason : [lang.reason, role.reason].filter((r) => !/^PASS/.test(r)).join('; ') || lang.reason;
  const applicationLinks = uniq([...(merged.applicationLinks || []), merged.url]).filter(Boolean);
  const workModes = inferWorkModes({ title, locationRaw, descriptionText });

  return {
    source: 'indeed',
    jobId: merged.jobId,
    url: merged.url || `${opts.domain}/viewjob?jk=${encodeURIComponent(merged.jobId)}`,
    title: title || null,
    company: company || null,
    descriptionRaw: descriptionText,
    descriptionText,
    locationRaw: locationRaw || null,
    countryCode: countryForDomain(opts.domain),
    city: inferCity(locationRaw),
    jobPostingDate: merged.jobPostingDate || merged.jobPostingDateRaw || null,
    applicantsRaw: null,
    applicantsCount: null,
    applicationLinks,
    recruiter: null,
    recruiterEmail: null,
    recruiterProfileLink: null,
    roleFamilyInferred: classification.label,
    roleFamilyConfidence: classification.confidence,
    roleFamilyReason: roleReasonText(classification) || role.reason,
    roleClassification: classification,
    roleClassificationProvisional: provisional,
    languageFilterReason,
    workModeReason: workModes.length ? `Detected ${workModes.map((m) => m.workMode).join(', ')}` : null,
    searchedKeywords: merged.searchedKeywords || opts.query,
    searchedLocation: opts.location,
    requiredLanguages: requirements.required,
    niceToHaveLanguages: requirements.niceToHave,
    workModes,
    salaryRaw: normalizeSalary(merged.salaryRaw),
    include,
  };
}

function compact(job) {
  return {
    jobId: job.jobId,
    title: job.title,
    company: job.company,
    location: job.locationRaw,
    salary: job.salaryRaw || 'Not posted',
    roleFamilyInferred: job.roleFamilyInferred,
    roleFamilyConfidence: job.roleFamilyConfidence,
    roleFamilyReason: job.roleFamilyReason,
    include: job.include,
    reason: job.languageFilterReason || job.roleFamilyReason,
    url: job.url,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const profile = loadProfile({ requireConfirmed: true });
  activeTaxonomy = profile.taxonomy;
  opts.taxonomy = profile.taxonomy;
  opts.speaks = opts.speaks?.length ? opts.speaks : profile.speaks;
  opts.excludeLanguages = [...new Set([...(opts.excludeLanguages || []), ...profile.excludeLanguages])];

  // ── Cross-process CDP coordination ────────────────────────────────
  // Coordination, not prohibition: proceed without the lease if another
  // live run holds it — never abort the search over coordination state.
  const lease = tryAcquireLease({
    leaseName: `indeed-search:${opts.cdpPort}`,
    runId: `indeed-${opts.query.replace(/\s+/g, '-')}-${Date.now()}`,
  });
  if (!lease) {
    console.warn('  [cdp-lease] Proceeding without lease — another run is active on this browser');
  }

  const expandedQueries = opts.queryExpansion
    ? expandRoleQueries({ targetRole: opts.query, maxQueries: opts.maxQueries, taxonomy: activeTaxonomy })
    : [];
  opts.searchQueries = uniq([opts.query, ...expandedQueries]).slice(0, opts.maxQueries);
  if (!opts.searchQueries.length) opts.searchQueries = [opts.query];
  const client = await connectCdp(opts.cdpPort);
  const keepAlive = startCdpKeepAlive(client, {
    intervalMs: opts.keepAliveSeconds * 1000,
    label: 'Indeed CDP',
    onStart: ({ intervalMs }) => console.error(`[cdp] heartbeat enabled every ${intervalMs / 1000}s on 127.0.0.1:${opts.cdpPort}`),
    onFailure: (error) => console.error(`[cdp] heartbeat failed: ${error.message}`),
  });
  const allSearchJobs = [];
  const seen = new Set();

  try {
    await withPage(client, async (sessionId) => {
      for (const query of opts.searchQueries) {
        for (let page = 0; page < opts.pages; page++) {
          const url = buildSearchUrl(opts, query, page);
          const parsed = await fetchPageJson(client, sessionId, url, SEARCH_EXPR, (r) => r.jobs?.length > 0, opts);
          for (const job of parsed.jobs || []) {
            if (!job.jobId || seen.has(job.jobId)) continue;
            const listingRole = classifyForIndeed({
              ...job,
              descriptionText: job.cardDescriptionText || '',
              provisional: true,
            });
            job.searchedKeywords = query;
            job.roleClassification = listingRole.classification;
            seen.add(job.jobId);
            allSearchJobs.push(job);
          }
          console.error(`Indeed query "${query}" page ${page + 1}/${opts.pages}: ${parsed.jobs?.length || 0} jobs (${seen.size} unique)`);
          if (allSearchJobs.length >= opts.max) break;
        }
        if (allSearchJobs.length >= opts.max) break;
      }

      const selected = allSearchJobs.slice(0, opts.max);
      const normalized = [];
      for (let i = 0; i < selected.length; i++) {
        const searchJob = selected[i];
        const detailUrl = new URL('/viewjob', opts.domain);
        detailUrl.searchParams.set('jk', searchJob.jobId);
        try {
          const detail = await fetchPageJson(
            client,
            sessionId,
            detailUrl.toString(),
            DETAIL_EXPR,
            (r) => r.descriptionExtracted === true,
            opts,
          );
          normalized.push(normalizeJob(searchJob, { ...detail, url: detailUrl.toString() }, opts));
          console.error(`Detail ${i + 1}/${selected.length}: ${searchJob.jobId}`);
        } catch (e) {
          normalized.push(normalizeJob(searchJob, {
            url: detailUrl.toString(),
            descriptionText: searchJob.cardDescriptionText || '',
            descriptionExtracted: false,
            applicationLinks: [detailUrl.toString()],
          }, opts));
          console.error(`Detail ${i + 1}/${selected.length} failed for ${searchJob.jobId}: ${e.message}`);
        }
      }

      const toWrite = opts.includeSkipped ? normalized : normalized.filter((job) => job.include);
      let outPath = opts.out || null;
      if ((opts.save || opts.out) && !outPath) outPath = `/tmp/indeed-results-${Date.now()}.json`;
      if (outPath) writeFileSync(outPath, `${JSON.stringify(toWrite, null, 2)}\n`);

      let saved = false;
      if (opts.save) {
        if (!existsSync(opts.saveScript)) throw new Error(`Save script not found: ${opts.saveScript}`);
        execFileSync('node', [opts.saveScript, outPath, '--db', opts.db], { stdio: 'inherit' });
        saved = true;
      }

      const summary = {
        source: 'indeed',
        query: opts.query,
        queries: opts.searchQueries,
        location: opts.location,
        domain: opts.domain,
        counts: {
          uniqueSearchJobs: allSearchJobs.length,
          detailed: normalized.length,
          included: normalized.filter((job) => job.include).length,
          skipped: normalized.filter((job) => !job.include).length,
          written: toWrite.length,
        },
        output: outPath,
        saved,
        db: saved ? opts.db : undefined,
        jobs: opts.json ? toWrite : toWrite.slice(0, 15).map(compact),
      };
      console.log(JSON.stringify(summary, null, 2));
    });
  } finally {
    keepAlive.stop();
    client.close();
    if (lease) lease.release();
  }
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  main().catch((error) => {
    console.error(`❌ ${error.message}`);
    process.exit(1);
  });
}

export {
  buildSearchUrl,
  classifyForIndeed,
  compact,
  expandRoleQueries,
  normalizeJob,
  parseArgs,
};
