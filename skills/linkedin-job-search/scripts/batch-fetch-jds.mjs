#!/usr/bin/env node
import { Database } from '../../job-hunter/scripts/workspace-dependencies.mjs';
/**
 * Batch-backfill LinkedIn job descriptions already saved in SQLite.
 *
 * This is the skill-integrated version of the project-local helper that was
 * previously run from a project-local scripts folder. It uses the
 * browser-based Obscura CLI text path (not raw HTTP to LinkedIn), extracts the
 * JD segment, refreshes language-filter decisions, and updates job_languages.
 *
 * Usage:
 *   node ../../linkedin-job-search/scripts/batch-fetch-jds.mjs \
 *     --db $PWD/jobhunter.sqlite \
 *     --speaks "English,Italian" \
 *     --exclude-languages "German,French" \
 *     --batch-size 5 --timeout 25
 *
 * The --db flag is optional; the script defaults to
 * path.join(process.cwd(), 'jobhunter.sqlite') — i.e. the directory
 * Pi Agent was launched from.
 */

import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';

import { startCdpKeepAlive } from './cdp-keepalive.mjs';
import { detectLinkedInBlockPage } from './linkedin-page-state.mjs';

const JOBHUNTER_HOME = process.env.JOBHUNTER_HOME || path.join(process.env.HOME || process.cwd(), '.job-hunter');
const DEFAULT_DB = process.env.JOBHUNTER_DB || path.join(JOBHUNTER_HOME, 'jobhunter.sqlite');
const DEFAULT_OBSCURA_BIN = process.env.OBSCURA_BIN || 'obscura';
const DEFAULT_PORT = parsePositiveInt(process.env.LINKEDIN_CDP_PORT || process.env.BROWSER_CDP_PORT || process.env.OBSCURA_CDP_PORT || process.env.OBSCURA_PORT, 9225);
const COMMON_OBSCURA_PORTS = [9225, 9222, 9224, 9226, 9227, 9228, 9230];

function usage() {
  console.log(`Usage:
  batch-fetch-jds.mjs [options]

Purpose:
  Backfill description_text/description_raw and language_filter_reason for
  LinkedIn jobs already saved in SQLite, using the active browser CDP text
  fetch path. This is intended for jobs whose detail fetch timed out or whose
  description was missing after a search run.

Options:
  --db <path>                   SQLite DB (default ${DEFAULT_DB})
  --source <source>             job source to process (default linkedin)
  --speaks <langs>              comma-separated languages user speaks (default English,Italian)
  --exclude-languages <langs>   comma-separated required languages that block (default German,French)
  --batch-size <n>              concurrent detail fetches per batch (default 2)
  --limit <n>                   process at most n jobs
  --timeout <seconds>           browser per-page timeout (default 25)
  --wait <seconds>              browser wait before dump (default 2)
  --keepalive-seconds <n>       CDP heartbeat interval; 0 disables (default 15)
  --obscura-bin <path>          Obscura CLI binary, used only for --start-obscura (default obscura or $OBSCURA_BIN)
  --port <n>                    browser CDP port to use/check (default ${DEFAULT_PORT})
  --obscura-port <n>            alias for --port
  --start-obscura               start 'obscura serve' only if no existing CDP is reachable
  --retry-failed                also retry prior JD extraction failures
  --all                         process all saved source jobs, not only missing descriptions
  --dry-run                     fetch and classify, but do not write SQLite
  --help                        show this help

Notes:
  - LinkedIn pages are fetched through the existing browser CDP session.
  - This script does not use curl/raw HTTP against LinkedIn or spawn per-page Obscura fetch processes.
  - It updates normalized job_languages rows to match the refreshed JD parse.
`);
}

function splitList(value) {
  return String(value || '')
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parsePositiveInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseArgs(argv) {
  const opts = {
    db: DEFAULT_DB,
    source: 'linkedin',
    speaks: ['English', 'Italian'],
    excludeLanguages: ['German', 'French'],
    batchSize: 2,
    limit: null,
    timeout: 25,
    wait: 2,
    keepAliveSeconds: Math.max(0, Number(process.env.CDP_KEEPALIVE_SECONDS ?? 15) || 0),
    obscuraBin: DEFAULT_OBSCURA_BIN,
    port: DEFAULT_PORT,
    startObscura: false,
    retryFailed: false,
    all: false,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    } else if (arg === '--db') {
      opts.db = argv[++i];
    } else if (arg === '--source') {
      opts.source = argv[++i] || opts.source;
    } else if (arg === '--speaks') {
      opts.speaks = splitList(argv[++i]);
    } else if (arg === '--exclude-languages') {
      opts.excludeLanguages = splitList(argv[++i]);
    } else if (arg === '--batch-size') {
      opts.batchSize = parsePositiveInt(argv[++i], opts.batchSize);
    } else if (arg === '--limit') {
      opts.limit = parsePositiveInt(argv[++i], opts.limit || 0) || null;
    } else if (arg === '--timeout') {
      opts.timeout = parsePositiveInt(argv[++i], opts.timeout);
    } else if (arg === '--wait') {
      opts.wait = parsePositiveInt(argv[++i], opts.wait);
    } else if (arg === '--keepalive-seconds') {
      opts.keepAliveSeconds = Math.max(0, Number(argv[++i]) || 0);
    } else if (arg === '--obscura-bin') {
      opts.obscuraBin = argv[++i] || opts.obscuraBin;
    } else if (arg === '--port' || arg === '--obscura-port') {
      opts.port = parsePositiveInt(argv[++i], opts.port);
    } else if (arg === '--start-obscura') {
      opts.startObscura = true;
    } else if (arg === '--retry-failed') {
      opts.retryFailed = true;
    } else if (arg === '--all') {
      opts.all = true;
    } else if (arg === '--dry-run') {
      opts.dryRun = true;
    } else {
      console.error(`Unknown argument: ${arg}`);
      usage();
      process.exit(2);
    }
  }

  if (!opts.speaks.length) {
    console.error('At least one spoken language is required via --speaks.');
    process.exit(2);
  }
  return opts;
}

function shQuiet(cmd, args, options = {}) {
  return execFileSync(cmd, args, { stdio: 'ignore', ...options });
}

function readCdpVersion(port) {
  try {
    const out = execFileSync('curl', ['-sS', '-f', '--max-time', '3', `http://127.0.0.1:${port}/json/version`], { encoding: 'utf8', timeout: 5000 });
    return JSON.parse(out);
  } catch {
    return null;
  }
}

function uniq(values) {
  return [...new Set(values.filter(Boolean))];
}

function candidateObscuraPorts(preferred) {
  return uniq([
    preferred,
    process.env.OBSCURA_CDP_PORT,
    process.env.OBSCURA_PORT,
    DEFAULT_PORT,
    ...COMMON_OBSCURA_PORTS,
  ].map((value) => parsePositiveInt(value, null)).filter(Boolean));
}

function findExistingObscuraCdp(preferred) {
  for (const port of candidateObscuraPorts(preferred)) {
    const version = readCdpVersion(port);
    if (version?.webSocketDebuggerUrl) return { port, version };
  }
  return null;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function ensureObscura(opts) {
  const existing = findExistingObscuraCdp(opts.port);
  if (existing) {
    opts.port = existing.port;
    console.log(`Using existing Docker Chromium/CDP browser on 127.0.0.1:${opts.port}.`);
    return opts.port;
  }
  if (!opts.startObscura) {
    const ports = candidateObscuraPorts(opts.port).join(', ');
    throw new Error(`Browser CDP is not reachable on checked port(s): ${ports}. Start the Docker Chromium session, pass --port, or use --start-obscura only for the optional legacy fallback.`);
  }

  console.log(`Starting Obscura on port ${opts.port}...`);
  const child = spawn(opts.obscuraBin, ['serve', '-p', String(opts.port), '--stealth', '--workers', '8'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  for (let i = 0; i < 30; i++) {
    if (readCdpVersion(opts.port)?.webSocketDebuggerUrl) {
      console.log(`Obscura started on 127.0.0.1:${opts.port}.`);
      return opts.port;
    }
    sleepSync(500);
  }
  throw new Error(`Timed out waiting for Obscura on 127.0.0.1:${opts.port}.`);
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelayMs(minSeconds = 1, maxSeconds = 2) {
  const min = Math.min(minSeconds, maxSeconds);
  const max = Math.max(minSeconds, maxSeconds);
  return Math.round((min + Math.random() * (max - min)) * 1000);
}

// ── Anti-detection utilities ──────────────────────────────────────────────

function jitter(min, max) {
  return min + Math.random() * (max - min);
}

async function humanDelay(context, minMs, maxMs) {
  const ms = Math.round(jitter(minMs, maxMs));
  console.log(`  [human] ${context} (${(ms / 1000).toFixed(1)}s)`);
  await sleep(ms);
}

const ANTI_DETECT_EXPR = `(() => {
  try {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
    const origQuery = navigator.permissions.query;
    navigator.permissions.query = (p) => p.name === 'notifications'
      ? Promise.resolve({ state: Notification.permission })
      : origQuery(p);
    Object.defineProperty(navigator, 'plugins', { get: () => ({ length: 5 }) });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' });
    return { ok: true };
  } catch(e) { return { ok: false, error: e.message }; }
})()`;

async function injectAntiDetection(client, sessionId) {
  try {
    const result = await withTimeout(
      client.send('Runtime.evaluate', {
        expression: ANTI_DETECT_EXPR,
        returnByValue: true,
        awaitPromise: true,
      }, sessionId),
      5000,
      'inject anti-detect'
    );
    return result?.result?.value?.ok === true;
  } catch {
    return false;
  }
}

async function simulateMouseMovement(client, sessionId) {
  const moves = 3 + Math.floor(Math.random() * 4);
  const vw = 800 + Math.floor(Math.random() * 400);
  const vh = 500 + Math.floor(Math.random() * 300);
  for (let i = 0; i < moves; i++) {
    const x = Math.floor(jitter(vw * 0.1, vw * 0.9));
    const y = Math.floor(jitter(vh * 0.1, vh * 0.7));
    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sessionId).catch(() => {});
    await sleep(Math.round(jitter(150, 400)));
  }
}

async function simulateScroll(client, sessionId) {
  const scrolls = 3 + Math.floor(Math.random() * 3);
  await client.send('Runtime.evaluate', {
    expression: `(async () => {
      for (let i = 0; i < ${scrolls}; i++) {
        const amount = ${200 + Math.floor(Math.random() * 500)};
        window.scrollBy({ top: amount, behavior: 'smooth' });
        await new Promise(r => setTimeout(r, ${200 + Math.floor(Math.random() * 300)}));
      }
      return 'ok';
    })()`,
    awaitPromise: true,
    returnByValue: true,
  }, sessionId).catch(() => {});
}

const detectBlockPage = detectLinkedInBlockPage;

function backoffDelay(attempt, baseMs = 10000, maxMs = 120000) {
  return Math.round(Math.min(baseMs * Math.pow(2, Math.min(attempt, 4)) + jitter(0, 3000), maxMs));
}

const rateTracker = { requests: [], windowMs: 60000, maxRequests: 12 };

function noteRequest() {
  const now = Date.now();
  rateTracker.requests.push(now);
  while (rateTracker.requests.length && rateTracker.requests[0] < now - rateTracker.windowMs) {
    rateTracker.requests.shift();
  }
}

async function enforceRateLimit() {
  noteRequest();
  while (rateTracker.requests.length > rateTracker.maxRequests) {
    const oldest = rateTracker.requests[0];
    const waitMs = oldest + rateTracker.windowMs - Date.now() + 1000;
    if (waitMs > 0) {
      console.log(`  [rate-limit] ${rateTracker.requests.length} requests in window, pausing ${(waitMs / 1000).toFixed(1)}s`);
      await sleep(waitMs);
    }
    const now = Date.now();
    while (rateTracker.requests.length && rateTracker.requests[0] < now - rateTracker.windowMs) {
      rateTracker.requests.shift();
    }
  }
}

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.seq = 0;
    this.pending = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
      }
    };
  }

  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      this.pending.set(id, { resolve, reject });
      const msg = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      this.ws.send(JSON.stringify(msg));
    });
  }

  close() {
    try { this.ws?.close(); } catch {}
  }
}

async function connectCdp(opts) {
  const version = readCdpVersion(opts.port);
  if (!version?.webSocketDebuggerUrl) throw new Error(`Browser CDP is not reachable on 127.0.0.1:${opts.port}`);
  const client = new CdpClient(version.webSocketDebuggerUrl);
  await client.connect();
  return client;
}

async function mapLimit(items, limit, fn, interDelayMs = 0) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length || 1) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      if (interDelayMs > 0 && i > 0) {
        const delayMs = Math.round(jitter(interDelayMs * 0.5, interDelayMs * 1.5));
        await sleep(delayMs);
      }
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

async function fetchJobText(job, opts, client) {
  const url = job.url || `https://www.linkedin.com/jobs/view/${job.job_id}`;
  let targetId;
  try {
    const timeoutMs = Math.max(5000, Number(opts.timeout || 25) * 1000);
    const target = await withTimeout(client.send('Target.createTarget', { url: 'about:blank' }), 10000, 'Target.createTarget');
    targetId = target.targetId;
    const attached = await withTimeout(client.send('Target.attachToTarget', { targetId, flatten: true }), 10000, 'Target.attachToTarget');
    const sessionId = attached.sessionId;
    await withTimeout(client.send('Page.enable', {}, sessionId), 8000, 'Page.enable');
    await withTimeout(client.send('Runtime.enable', {}, sessionId), 8000, 'Runtime.enable');
    await injectAntiDetection(client, sessionId);
    await humanDelay('batch-detail nav', 2000, 5000);
    const nav = await withTimeout(client.send('Page.navigate', { url, referrer: 'https://www.linkedin.com/jobs/search/' }, sessionId), timeoutMs, 'Page.navigate');
    if (nav.errorText) throw new Error(nav.errorText);

    await simulateMouseMovement(client, sessionId);
    await simulateScroll(client, sessionId);
    await humanDelay('batch-detail read', 3000, 6000);

    let text = '';
    for (let i = 0; i < 18; i++) {
      if (i > 0) await humanDelay('batch-detail retry', 2000, 4000);
      const result = await withTimeout(client.send('Runtime.evaluate', {
        expression: 'document.body ? document.body.innerText : document.documentElement.innerText || ""',
        returnByValue: true,
        awaitPromise: true,
      }, sessionId), timeoutMs, 'Runtime.evaluate');
      text = String(result.result?.value || '');
      const block = detectBlockPage(text);
      if (block.blocked) {
        return { ok: true, text, url, blocked: true, isCaptcha: block.isCaptcha, blockReason: block.reason };
      }
      if (text.includes('Report this job') || text.includes('Seniority level') || text.includes('About the job')) break;
    }
    if (!text) throw new Error('empty detail page text');
    return { ok: true, text, url, blocked: false, isCaptcha: false, blockReason: null };
  } catch (e) {
    return { ok: false, text: '', url, error: e.message, blocked: false, isCaptcha: false, blockReason: null };
  } finally {
    if (targetId) await client.send('Target.closeTarget', { targetId }).catch(() => {});
  }
}

function publicTextLines(text) {
  const lines = [];
  for (const part of String(text || '').split(/\n+/)) {
    const line = part.trim().replace(/\s+/g, ' ');
    if (!line) continue;
    if (line === lines[lines.length - 1]) continue;
    if (/^window\.__/.test(line)) continue;
    lines.push(line);
  }
  return lines;
}

function extractDescriptionFromLines(lines) {
  const start = lines.findIndex((line) => line === 'Report this job');
  const end = lines.findIndex((line, index) => index > start && line === 'Seniority level');
  let descLines = start >= 0 && end > start ? lines.slice(start + 1, end) : [];
  if (!descLines.length) {
    const aboutStart = lines.findIndex((line) => /^About the job$/i.test(line));
    const aboutEnds = [/^Show less$/i, /^Show more$/i, /^Seniority level$/i, /^Employment type$/i, /^Job function$/i, /^Industries$/i, /^Skills$/i, /^Similar jobs$/i, /^People also viewed$/i, /^Set alert/i];
    const aboutEnd = lines.findIndex((line, index) => index > aboutStart && aboutEnds.some((re) => re.test(line)));
    if (aboutStart >= 0) descLines = lines.slice(aboutStart + 1, aboutEnd > aboutStart ? aboutEnd : undefined);
  }

  const actualStart = descLines.findIndex((line) => /^(About|Responsibilities|Requirements|Qualifications|Job description|The Role|Role Overview|Your role|What you|We are|We’re|Our client|Company Description|Minimum qualifications|Basic qualifications|Overview|Locations?|Aufgaben|Profil|Deine|Ihre|Your mission)/i.test(line));
  if (actualStart > 0) descLines = descLines.slice(actualStart);

  return descLines.join('\n').trim();
}

function extractDescriptionByMarkers(text) {
  const markers = [
    ['Report this job', 'Seniority level'],
    ['Report this job', 'Employment type'],
    ['Report this job', 'Show more'],
    ['About this job', 'Show more'],
    ['About this job', 'Show less'],
    ['About the job', 'Show more'],
    ['About the job', 'Show less'],
    ['Job description', 'Show more'],
  ];

  for (const [startMarker, endMarker] of markers) {
    const start = text.indexOf(startMarker);
    const end = text.indexOf(endMarker, start + startMarker.length);
    if (start >= 0 && end > start) {
      const jd = cleanDescription(text.slice(start + startMarker.length, end));
      if (jd.length > 100) return jd;
    }
  }
  return null;
}

function cleanDescription(text) {
  return String(text || '')
    .replace(/\b(?:Join now|Sign in|Apply|Easy Apply|Save)\b/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function extractJD(text) {
  if (!text || text.length < 100) return null;
  const lines = publicTextLines(text);
  const fromLines = cleanDescription(extractDescriptionFromLines(lines));
  if (fromLines.length > 100) return fromLines;
  return extractDescriptionByMarkers(text);
}

function escapeRe(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sentenceSplit(text) {
  return String(text || '')
    .replace(/\n+/g, '. ')
    .split(/(?<=[.!?;])\s+|\s+[-–—]\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

const LANGUAGE_MAP = {
  English: ['English', 'Englisch', 'anglais', 'inglese'],
  Italian: ['Italian', 'Italienisch', 'italien', 'italiano'],
  German: ['German', 'Deutsch', 'Allemand', 'Tedesco', 'Deutschkenntnisse'],
  French: ['French', 'Français', 'Francais', 'Französisch', 'Franzoesisch', 'francese'],
  Spanish: ['Spanish', 'Spanisch', 'Espagnol', 'Spagnolo'],
  Dutch: ['Dutch', 'Niederländisch', 'Nederlands'],
  Portuguese: ['Portuguese', 'Portugiesisch', 'Portugais'],
};

const NICE_CONTEXT = /\b(nice[- ]to[- ]have|plus|bonus|preferred|advantage|asset|optional|beneficial|would be a plus|good to have|desirable)\b/i;
const REQUIRED_CONTEXT = /\b(required|must|mandatory|essential|fluent|fluency|proficient|excellent|strong|native|business fluent|c1|c2|kenntnisse|maîtrise|maitrise|obligatoire|nécessaire|necessaire|erforderlich|voraussetzung|zwingend)\b/i;
const LANGUAGE_CONTEXT = /\b(language skills|sprachkenntnisse|langues?|languages?|written and spoken|spoken and written)\b/i;

function parseLanguages(description) {
  const required = new Set();
  const niceToHave = new Set();

  for (const sentence of sentenceSplit(description)) {
    for (const [language, aliases] of Object.entries(LANGUAGE_MAP)) {
      if (!aliases.some((alias) => new RegExp(`\\b${escapeRe(alias)}\\b`, 'i').test(sentence))) continue;
      if (NICE_CONTEXT.test(sentence) && !REQUIRED_CONTEXT.test(sentence.replace(NICE_CONTEXT, ''))) {
        niceToHave.add(language);
      } else if (REQUIRED_CONTEXT.test(sentence) || LANGUAGE_CONTEXT.test(sentence)) {
        required.add(language);
      }
    }
  }

  return {
    required: [...required],
    niceToHave: [...niceToHave].filter((language) => !required.has(language)),
  };
}

function canonicalLanguage(value) {
  const text = String(value || '').trim().toLowerCase();
  for (const [language, aliases] of Object.entries(LANGUAGE_MAP)) {
    if (language.toLowerCase() === text || aliases.some((alias) => alias.toLowerCase() === text)) return language;
  }
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : null;
}

function checkLanguageFilter(requirements, opts) {
  const speaks = new Set(opts.speaks.map((language) => canonicalLanguage(language)?.toLowerCase()).filter(Boolean));
  const blockedExplicit = new Set(opts.excludeLanguages.map((language) => canonicalLanguage(language)?.toLowerCase()).filter(Boolean));
  const missing = requirements.required.filter((language) => !speaks.has(language.toLowerCase()));
  const blocked = requirements.required.filter((language) => blockedExplicit.has(language.toLowerCase()));

  if (!requirements.required.length) {
    return { pass: true, reason: 'PASS: No language requirements detected in JD' };
  }
  if (blocked.length) {
    return { pass: false, reason: `FAIL: JD requires ${blocked.join(', ')} (user does not speak it/them)` };
  }
  if (missing.length) {
    return { pass: false, reason: `FAIL: JD requires ${missing.join(', ')} (not in user spoken languages)` };
  }
  return { pass: true, reason: `PASS: JD requires ${requirements.required.join(', ')} (user speaks all)` };
}

const BLOCKED_TITLE_RE = /\b(architekt(?:in)?|architecte|architetto|projektleiter(?:in)?|zeichner(?:in)?|bauleiter(?:in)?|innenarchitekt|architecte d.intérieur|architetto d.interni|praktikant(?:in)?)\b/i;
const AI_SOFTWARE_RE = /\b(ai|a\.i\.|artificial intelligence|genai|generative ai|llm|machine learning|ml\b|data\s*&\s*ai|data and ai|ai\s*&\s*data|solution architect|solutions architect|enterprise architect|software architect|cloud architect)\b/i;

function checkTitle(title) {
  const text = String(title || '');
  if (BLOCKED_TITLE_RE.test(text) && !AI_SOFTWARE_RE.test(text)) {
    return { pass: false, reason: `FAIL: Title appears to be a non-IT/building architect role (${text})` };
  }
  return { pass: true, reason: null };
}

function buildJobQuery(opts) {
  const where = ['source = @source'];
  if (!opts.all) {
    where.push(`(
      description_text IS NULL
      OR trim(description_text) = ''
      ${opts.retryFailed ? "OR language_filter_reason LIKE 'FAIL: Could not extract JD%' OR language_filter_reason LIKE 'FAIL: Error fetching page:%' OR language_filter_reason LIKE 'scrape_failed:%'" : ''}
    )`);
  }
  const limitSql = opts.limit ? 'LIMIT @limit' : '';
  return `
    SELECT source, job_id, url, title, company, location_raw, language_filter_reason
    FROM jobs
    WHERE ${where.join(' AND ')}
    ORDER BY updated_at DESC, title COLLATE NOCASE
    ${limitSql}
  `;
}

function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS job_languages (
      source TEXT NOT NULL,
      job_id TEXT NOT NULL,
      language TEXT NOT NULL,
      importance TEXT NOT NULL CHECK (importance IN ('required', 'nice_to_have')),
      PRIMARY KEY (source, job_id, language, importance),
      FOREIGN KEY (source, job_id) REFERENCES jobs(source, job_id) ON DELETE CASCADE
    );
  `);
}

function makeUpdater(db) {
  const updateJob = db.prepare(`
    UPDATE jobs
    SET description_text = ?,
        description_raw = ?,
        language_filter_reason = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE source = ? AND job_id = ?
  `);
  const deleteLanguages = db.prepare('DELETE FROM job_languages WHERE source = ? AND job_id = ?');
  const insertLanguage = db.prepare(`
    INSERT OR IGNORE INTO job_languages (source, job_id, language, importance)
    VALUES (?, ?, ?, ?)
  `);

  return db.transaction((job, descriptionText, descriptionRaw, languageFilterReason, requirements) => {
    updateJob.run(descriptionText, descriptionRaw, languageFilterReason, job.source, job.job_id);
    deleteLanguages.run(job.source, job.job_id);
    for (const language of requirements.required || []) {
      insertLanguage.run(job.source, job.job_id, language, 'required');
    }
    for (const language of requirements.niceToHave || []) {
      insertLanguage.run(job.source, job.job_id, language, 'nice_to_have');
    }
  });
}

async function processJob(job, opts, client) {
  let blockAttempt = 0;
  while (true) {
    await enforceRateLimit();
    const fetched = await fetchJobText(job, opts, client);

    if (fetched.blocked) {
      blockAttempt++;
      if (fetched.isCaptcha) {
        console.warn(`  [captcha] CAPTCHA on detail ${job.job_id}: ${fetched.blockReason}`);
      } else {
        console.warn(`  [blocked] LinkedIn warning on detail ${job.job_id}: ${fetched.blockReason}`);
      }
      const backoff = backoffDelay(blockAttempt, 15000, 120000);
      console.warn(`  [batch-backoff] ${job.job_id} attempt=${blockAttempt} waiting ${(backoff / 1000).toFixed(1)}s`);
      await sleep(backoff);
      continue;
    }

    const jd = extractJD(fetched.text);
    const requirements = jd ? parseLanguages(jd) : { required: [], niceToHave: [] };

    if (!fetched.ok) {
      return {
        job,
        jd: null,
        raw: fetched.text ? fetched.text.slice(0, 10000) : null,
        requirements,
        pass: false,
        reason: `FAIL: Error fetching page: ${fetched.error}`,
      };
    }

    if (!jd) {
      return {
        job,
        jd: null,
        raw: fetched.text ? fetched.text.slice(0, 10000) : null,
        requirements,
        pass: false,
        reason: 'FAIL: Could not extract JD from page',
      };
    }

    const titleCheck = checkTitle(job.title);
    if (!titleCheck.pass) {
      return {
        job,
        jd,
        raw: jd,
        requirements,
        pass: false,
        reason: titleCheck.reason,
      };
    }

    const languageCheck = checkLanguageFilter(requirements, opts);
    const suffix = requirements.niceToHave.length ? ` Nice-to-have: ${requirements.niceToHave.join(', ')}.` : '';
    return {
      job,
      jd,
      raw: jd,
      requirements,
      pass: languageCheck.pass,
      reason: `${languageCheck.reason}.${suffix}`.replace('..', '.'),
    };
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  console.log('Batch JD backfill started');
  console.log(`DB: ${opts.db}`);
  console.log(`Source: ${opts.source}`);
  console.log(`Speaks: ${opts.speaks.join(', ')}`);
  console.log(`Blocked required languages: ${opts.excludeLanguages.join(', ') || '(none)'}`);
  console.log(`Batch size: ${opts.batchSize}; timeout: ${opts.timeout}s; dry-run: ${opts.dryRun ? 'yes' : 'no'}`);

  ensureObscura(opts);
  const client = await connectCdp(opts);
  const keepAlive = startCdpKeepAlive(client, {
    intervalMs: opts.keepAliveSeconds * 1000,
    label: 'LinkedIn JD CDP',
    onStart: ({ intervalMs }) => console.log(`[cdp] heartbeat enabled every ${intervalMs / 1000}s on 127.0.0.1:${opts.port}`),
    onFailure: (error) => console.warn(`[cdp] heartbeat failed: ${error.message}`),
  });

  const db = new Database(opts.db);
  ensureTables(db);
  const jobs = db.prepare(buildJobQuery(opts)).all({ source: opts.source, limit: opts.limit });
  console.log(`Found ${jobs.length} job(s) to process.`);

  if (!jobs.length) {
    keepAlive.stop();
    client.close();
    db.close();
    return;
  }

  const update = makeUpdater(db);
  const totals = { processed: 0, passed: 0, failed: 0, errors: 0, written: 0 };

  for (let i = 0; i < jobs.length; i += opts.batchSize) {
    const batch = jobs.slice(i, i + opts.batchSize);
    console.log(`\nBatch ${Math.floor(i / opts.batchSize) + 1}: fetching ${batch.length} job detail page(s)...`);
    const results = await mapLimit(batch, opts.batchSize, (job) => processJob(job, opts, client), 5000);

    for (const result of results) {
      totals.processed++;
      if (result.pass) totals.passed++;
      else totals.failed++;
      if (result.reason.startsWith('FAIL: Error fetching page:')) totals.errors++;

      if (!opts.dryRun) {
        update(result.job, result.jd, result.raw, result.reason, result.requirements);
        totals.written++;
      }

      const mark = result.pass ? '✓ PASS' : '✗ FAIL';
      const title = result.job.title || result.job.job_id;
      const company = result.job.company ? ` @ ${result.job.company}` : '';
      const langs = [...result.requirements.required.map((l) => `${l}:required`), ...result.requirements.niceToHave.map((l) => `${l}:nice`)];
      const langText = langs.length ? ` [${langs.join(', ')}]` : '';
      console.log(`  [${totals.processed}/${jobs.length}] ${mark} ${title}${company} — ${result.reason}${langText}`);
    }

    if (i + opts.batchSize < jobs.length) {
      await humanDelay('between batches', 5000, 10000);
    }
  }

  keepAlive.stop();
  client.close();
  db.close();
  console.log('\n=== Summary ===');
  console.log(`Total processed: ${totals.processed}`);
  console.log(`Passed language filter: ${totals.passed}`);
  console.log(`Failed language/title/JD filter: ${totals.failed}`);
  console.log(`Fetch errors: ${totals.errors}`);
  console.log(`SQLite rows updated: ${totals.written}`);
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
