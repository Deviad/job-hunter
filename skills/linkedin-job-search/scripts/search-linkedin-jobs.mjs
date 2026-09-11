#!/usr/bin/env node
/**
 * Generic LinkedIn job search runner.
 *
 * Example:
 *   node search-linkedin-jobs.mjs \
 *     --role "AI Architect" \
 *     --location "Switzerland" \
 *     --speaks "English,Italian" \
 *     --exclude-languages "German,French" \
 *     --industry "IT" \
 *     --db $PWD/jobhunter.sqlite
 *
 * The --db flag is optional; if omitted the script defaults to
 * path.join(process.cwd(), 'jobhunter.sqlite') — i.e. the directory
 * Pi Agent was launched from.
 *
 * Raw LinkedIn HTML/page text stays inside this process. Output is only a summary.
 *
 * Exit codes:
 *   0 — All query/detail sources completed without terminal blocking states.
 *   1 — Fatal startup error (uncaught exception).
 *   2 — One or more query or detail sources ended in a blocking/terminal state
 *        (active_challenge, blocked, rate_limited, or failed), or a checkpoint
 *        persist failed. The run terminated safely but with incomplete results.
 *   3 — Run cancelled (SIGINT/SIGTERM). Completed queries were already
 *        checkpoint-persisted; unfinished queries are reported as cancelled.
 *
 * Retry policy (finite, no unbounded loops):
 *   - Per-page retries are capped at 3 attempts.
 *   - Circuit breaker: 3 (search) / 4 (detail) consecutive blocking states
 *     across an origin stop all further retries for that origin.
 *
 * Strict source mode (--strict-owner or LINKEDIN_STRICT_OWNER=1):
 *   Source-owner admission (one port-free LinkedIn owner per workspace) runs
 *   before any browser/CDP contact; denial = blocked summary, exit 2. One
 *   source-wide strict retry policy stops the run on the first canonical
 *   restriction, and every navigation reserves a slot immediately before
 *   sending; pause/cancel/storage denial halts further admissions instead of
 *   falling open. The first canonical restriction this run observes is
 *   persisted as the source pause through the owner at the observation site
 *   (summary.terminalStatuses.sourcePause records the outcome), before any
 *   further admission and before release. Unflagged runs keep the legacy
 *   lease/budget/policy path. In every mode each navigation URL is validated
 *   against the LinkedIn jobs-route allowlist immediately before it is sent.
 *   LINKEDIN_TARGET_BASE overrides the navigation base only for loopback
 *   fixtures and requires LINKEDIN_ALLOW_LOCAL_TARGET=1; any other value
 *   aborts startup.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startCdpKeepAlive } from './cdp-keepalive.mjs';
import { createTargetRegistry, createCleanup } from './target-registry.mjs';
import { detectLinkedInBlockPage, classifyLinkedInPage, PAGE_STATE, isBlockingState, isRestrictionState, RESTRICTION_STATES, researchNavigationDecision } from './linkedin-page-state.mjs';
import { createRetryPolicy, createStrictSourceRetryPolicy } from './retry-policy.mjs';
import { tryAcquireLease, createSharedBudget, tryAcquireStrictLinkedInOwner } from './cdp-lease.mjs';
import {
  classifyRole as classifySharedRole,
  assertRoleClassification,
  expandRoleQueries,
} from '../../job-hunter/scripts/role-taxonomy.mjs';
import * as _roleTaxonomyNs from '../../job-hunter/scripts/role-taxonomy.mjs';

const SHARED_TAXONOMY_VERSION = _roleTaxonomyNs.ROLE_TAXONOMY_VERSION ?? null;

const JOBHUNTER_HOME = process.env.JOBHUNTER_HOME || path.join(process.env.HOME || process.cwd(), '.job-hunter');
const DEFAULT_DB = process.env.JOBHUNTER_DB || path.join(JOBHUNTER_HOME, 'jobhunter.sqlite');
const DEFAULT_SAVE_SCRIPT = path.join(path.dirname(new URL(import.meta.url).pathname), 'save-to-sqlite.mjs');
const DEFAULT_SESSION_JSON = '/tmp/linkedin-chromium-empty-session.json';
const DEFAULT_COOKIE_FILE = '/tmp/linkedin-cookies.txt'; // deprecated; search pages use browser CDP + optional session JSON; detail pages use the same CDP browser
const DEFAULT_OUT = '/tmp/linkedin-job-search-results.json';
const DEFAULT_SUMMARY = '/tmp/linkedin-job-search-summary.json';
const DEFAULT_OBSCURA_BIN = '$(which obscura 2>/dev/null || echo obscura)';
const DEFAULT_OBSCURA_PORT = parsePort(process.env.LINKEDIN_CDP_PORT || process.env.BROWSER_CDP_PORT || process.env.OBSCURA_CDP_PORT || process.env.OBSCURA_PORT, 9225);
const COMMON_OBSCURA_PORTS = [9225, 9222, 9224, 9226, 9227, 9228, 9230];

// Module-level target registry — populated by main() on each run.
let targetRegistry = null;
let cdpLease = null;
let sharedBudget = null;
let runCancelled = false;
let sourceOwner = null;   // strict mode: the one LinkedIn source owner
let sourceRetry = null;   // strict mode: shared source-wide retry policy
let sourceHalted = false; // strict mode: admissions denied — stop, defer, do not fail open
let sourcePause = null;   // strict mode: first restriction observed by this run and its persisted-pause result
let targetBase = 'https://www.linkedin.com';

const LOOPBACK_TARGET_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function sourceUrl(pathAndQuery) {
  return targetBase + pathAndQuery;
}

function resolveTargetBase() {
  const raw = process.env.LINKEDIN_TARGET_BASE;
  if (!raw) return 'https://www.linkedin.com';
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`LINKEDIN_TARGET_BASE is not a valid URL (${raw}); unset it to use LinkedIn.`);
  }
  const loopback = LOOPBACK_TARGET_HOSTS.has(parsed.hostname);
  if (process.env.LINKEDIN_ALLOW_LOCAL_TARGET === '1' && loopback) {
    console.warn(`  [target-binding] Navigations bound to loopback fixture ${parsed.origin} — LinkedIn destinations are not reachable from this run.`);
    return parsed.origin;
  }
  throw new Error(`LINKEDIN_TARGET_BASE rejected: only loopback hosts with LINKEDIN_ALLOW_LOCAL_TARGET=1 are allowed (got ${parsed.origin}). Unset it to use LinkedIn.`);
}

/**
 * Every automated navigation is validated against the jobs-route allowlist
 * at the seam where the URL is actually sent, in strict and legacy runs
 * alike. Only the explicitly bound loopback fixture origin is exempt.
 */
function navigationDecision(url) {
  const fixtureOrigins = targetBase === 'https://www.linkedin.com' ? [] : [targetBase];
  return researchNavigationDecision(url, { fixtureOrigins });
}

/**
 * Strict mode admission for one navigation: allowed route + reserved slot +
 * unpaused source immediately before sending. Legacy (non-strict) runs only
 * get the route check — per-process pacing is unchanged there.
 */
async function admitNavigation(url) {
  const decision = navigationDecision(url);
  if (!decision.allowed) {
    if (sourceOwner) { sourceHalted = true; sourceOwner.abort(); }
    console.warn(`  [navigation] Rejected ${decision.code}: ${decision.reason}`);
    return { ok: false, reason: `navigation_${decision.code}` };
  }
  if (!sourceOwner) return { ok: true };
  const slot = await sourceOwner.reserveRequest();
  if (!slot.ok) {
    sourceHalted = true;
    sourceOwner.abort(); // stop queued waits immediately
    console.warn(`  [source-owner] Navigation denied (${slot.stage}/${slot.reason}); halting further admissions and deferring remaining work.`);
    return { ok: false, reason: slot.reason };
  }
  return { ok: true, used: slot.used };
}

/**
 * Strict mode: the first canonical restriction observed by this run is
 * persisted as the source pause at the observation site, before the owner
 * releases and before any further admission. The wrapper's own pause on the
 * child summary remains as a second writer; a repeated pause is idempotent.
 */
function noteSourceRestriction(state, reason) {
  if (!sourceOwner || sourcePause || !isRestrictionState(state)) return;
  const res = sourceOwner.pauseSource(`collector observed ${state}`);
  sourcePause = { state, reason: reason || null, persisted: res.ok === true, error: res.ok ? null : (res.error?.code ?? 'PAUSE_UNAVAILABLE') };
  sourceHalted = true;
  console.warn(`  [source-owner] Restriction ${state} observed; pause ${sourcePause.persisted ? 'persisted' : `NOT persisted (${sourcePause.error})`}; halting further admissions.`);
}

function usage(exitCode = 0) {
  const out = exitCode === 0 ? process.stdout : process.stderr;
  out.write(`Usage:\n`);
  out.write(`  search-linkedin-jobs.mjs --role <role> --location <location> --speaks <langs> [options]\n\n`);
  out.write(`Required:\n`);
  out.write(`  --role <role>                 e.g. "AI Architect"\n`);
  out.write(`  --location <location>         e.g. "Switzerland"\n`);
  out.write(`  --speaks <langs>              comma-separated, e.g. "English,Italian"\n\n`);
  out.write(`Options:\n`);
  out.write(`  --exclude-languages <langs>   comma-separated, e.g. "German,French"\n`);
  out.write(`  --industry <industry>         e.g. "IT"; used to filter non-industry results\n`);
  out.write(`  --similar-roles <roles>       comma-separated extra roles to search\n`);
  out.write(`  --queries <queries>           comma-separated exact LinkedIn search queries\n`);
  out.write(`  --no-role-variants            do not add obvious role aliases\n`);
  out.write(`  --refresh-job-ids <ids>       comma-separated numeric LinkedIn job IDs to re-scrape (max 50)\n`);
  out.write(`  --fresh-days <n>              LinkedIn time filter in days, e.g. 7 for f_TPR=r604800\n`);
  out.write(`  --max-start <n>               LinkedIn pagination max offset (default 200)\n`);
  out.write(`  --detail-limit <n>            limit job detail fetches (test/debug only)\n`);
  out.write(`  --detail-concurrency <n>      concurrent public detail-page text fetches (default 2)\n`);
  out.write(`  --detail-timeout <seconds>    per-detail public text fetch timeout (default 25)\n`);
  out.write(`  --retry-failed                retry rows previously saved as scrape_failed\n`);
  out.write(`  --authenticated-details       fallback to authenticated CDP detail fetch if public text fails\n`);
  out.write(`  --search-concurrency <n>      concurrent browser CDP search-page targets (default 1)\n`);
  out.write(`  --keepalive-seconds <n>       CDP heartbeat interval; 0 disables (default 15)\n`);
  out.write(`  --obscura-port <n>            browser CDP port to use/check (default ${DEFAULT_OBSCURA_PORT})\n`);
  out.write(`  --port <n>                    alias for --obscura-port\n`);
  out.write(`  --strict-owner                run under the strict LinkedIn source owner: fail-closed admission before any CDP contact, one source-wide budget/retry policy, no fail-open fallback\n`);
  out.write(`  --lock-dir <path>             strict-mode lease/budget storage dir (default $JOBHUNTER_HOME/locks)\n`);
  out.write(`  --db <path>                   SQLite DB file (default ${DEFAULT_DB})\n`);
  out.write(`  --session-json <path>         optional browser session export (default ${DEFAULT_SESSION_JSON})\n`);
  out.write(`  --cookie-file <path>          deprecated; ignored. Searches use browser CDP.\n`);
  out.write(`  --out <path>                  result JSON (default ${DEFAULT_OUT})\n`);
  out.write(`  --summary <path>              summary JSON (default ${DEFAULT_SUMMARY})\n`);
  out.write(`  --start-obscura               start local obscura serve only if no existing CDP is reachable\n`);
  out.write(`  --help                        show this help\n`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const o = {
    db: DEFAULT_DB,
    sessionJson: DEFAULT_SESSION_JSON,
    cookieFile: DEFAULT_COOKIE_FILE,
    out: DEFAULT_OUT,
    summary: DEFAULT_SUMMARY,
    freshDays: null,
    maxStart: 200,
    pageStep: 7,
    searchConcurrency: 1,
    keepAliveSeconds: Math.max(0, Number(process.env.CDP_KEEPALIVE_SECONDS ?? 15) || 0),
    detailConcurrency: 2,
    detailTimeout: 25,
    retryFailed: false,
    authenticatedDetails: false,
    roleVariants: true,
    refreshJobIds: [],
    startObscura: false,
    obscuraPort: DEFAULT_OBSCURA_PORT,
    strictOwner: process.env.LINKEDIN_STRICT_OWNER === '1',
    lockDir: process.env.LINKEDIN_LOCK_DIR || null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${a}`);
      return argv[++i];
    };
    if (a === '--role') o.role = next();
    else if (a === '--location') o.location = next();
    else if (a === '--speaks') o.speaks = splitList(next());
    else if (a === '--exclude-languages') o.excludeLanguages = splitList(next());
    else if (a === '--industry') o.industry = next();
    else if (a === '--similar-roles') o.similarRoles = splitList(next());
    else if (a === '--queries') o.queries = splitList(next());
    else if (a === '--no-role-variants') o.roleVariants = false;
    else if (a === '--fresh-days') o.freshDays = Number(next());
    else if (a === '--max-start') o.maxStart = Number(next());
    else if (a === '--detail-limit') o.detailLimit = Number(next());
    else if (a === '--detail-concurrency') o.detailConcurrency = Number(next());
    else if (a === '--detail-timeout') o.detailTimeout = Number(next());
    else if (a === '--retry-failed') o.retryFailed = true;
    else if (a === '--authenticated-details') o.authenticatedDetails = true;
    else if (a === '--search-concurrency') o.searchConcurrency = Number(next());
    else if (a === '--keepalive-seconds') o.keepAliveSeconds = Math.max(0, Number(next()) || 0);
    else if (a === '--obscura-port' || a === '--port') o.obscuraPort = parsePort(next(), o.obscuraPort);
    else if (a === '--db') o.db = next();
    else if (a === '--session-json') o.sessionJson = next();
    else if (a === '--cookie-file') o.cookieFile = next();
    else if (a === '--out') o.out = next();
    else if (a === '--summary') o.summary = next();
    else if (a === '--refresh-job-ids') o.refreshJobIds = parseRefreshJobIds(next());
    else if (a === '--start-obscura') o.startObscura = true;
    else if (a === '--strict-owner') o.strictOwner = true;
    else if (a === '--lock-dir') o.lockDir = next();
    else if (a === '--help' || a === '-h') usage(0);
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!o.role) throw new Error('--role is required');
  if (!o.location) throw new Error('--location is required');
  if (!o.speaks?.length) throw new Error('--speaks is required');
  o.excludeLanguages ||= [];
  o.similarRoles ||= [];
  o.industry ||= inferIndustry(o.role);
  if (!Number.isFinite(o.freshDays) || o.freshDays <= 0) o.freshDays = null;
  return o;
}

function splitList(value) {
  return String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function parsePort(value, fallback) {
  const port = Number.parseInt(value, 10);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : fallback;
}

function inferIndustry(role) {
  return /\b(ai|artificial intelligence|machine learning|ml|software|data|cloud|solution|enterprise|it|technology|architect|engineer)\b/i.test(role)
    ? 'IT'
    : '';
}

function uniq(values) {
  return [...new Set(values.filter(Boolean).map((v) => String(v).trim()).filter(Boolean))];
}

const SUPPLEMENTARY_QUERY_FAMILIES = [
  { query: 'Applied AI Architect', family: 'applied-ai-architect' },
  { query: 'Forward Deployed Architect', family: 'forward-deployed' },
  { query: 'Forward Deployed Engineer', family: 'forward-deployed' },
  { query: 'AI Field Engineer', family: 'solutions-field' },
  { query: 'AI Customer Engineer', family: 'solutions-field' },
];

const MAX_TOTAL_QUERIES = 32;

function getQueryFamily(query) {
  const q = String(query || '').toLowerCase();
  if (!q) return 'user-supplied';
  if (/explicit linkedin id refresh/.test(q)) return 'explicit-refresh';
  if (/forward.?deployed/.test(q)) return 'forward-deployed';
  if (/applied ai architect/.test(q)) return 'applied-ai-architect';
  if (/principal|staff|applied ai engineer|ai technical lead|ai engineering lead/.test(q)) return 'principal-staff-lead';
  if (/ai platform|ml platform|mlops|ai infrastructure/.test(q)) return 'platform-mlops';
  if (/ai solutions?|ai integration|ai enablement|pre-sales/.test(q)) return 'solutions-field';
  if (/engineering manager|head of ai|director of ai|solutions architecture manager|technical delivery/.test(q)) return 'leadership';
  if (/ai security|ai governance|ai strategy/.test(q)) return 'security-governance';
  if (/data.*ai|ai.*data/.test(q)) return 'data-ai';
  if (/enterprise ai/.test(q)) return 'enterprise';
  if (/genai|gen ai|generative ai|agentic|llm/.test(q)) return 'generative-ai';
  if (/ai architect|ai\/ml architect/.test(q)) return 'core-architect';
  return 'user-supplied';
}

function parseRefreshJobIds(value) {
  if (!value) return [];
  const ids = String(value).split(',').map((s) => s.trim()).filter(Boolean);
  const seen = new Set();
  const result = [];
  for (const id of ids) {
    if (!/^\d+$/.test(id)) throw new Error(`Invalid LinkedIn job ID: "${id}" — must be numeric`);
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  if (result.length > 50) throw new Error(`Too many refresh job IDs: ${result.length} (max 50)`);
  return result;
}

function bypassRefreshIds(existingIds, refreshIds) {
  if (!refreshIds?.size) return existingIds;
  const result = new Set(existingIds);
  for (const id of refreshIds) result.delete(id);
  return result;
}

function mergeExplicitRefreshIds(queryResults, refreshJobIds) {
  const refreshSet = new Set(refreshJobIds);
  const results = queryResults.map((result) => ({
    ...result,
    ids: result.ids.filter((id) => !refreshSet.has(id)),
    pages: [...result.pages],
  }));
  if (refreshJobIds.length) {
    results.unshift({ query: 'Explicit LinkedIn ID refresh', ids: [...refreshJobIds], pages: [], status: PAGE_STATE.HEALTHY });
  }
  return results;
}

function buildQueries(opts) {
  if (opts.queries?.length) return uniq(opts.queries);
  if (!opts.roleVariants) return uniq([opts.role, ...opts.similarRoles]);
  const taxonomyQueries = expandRoleQueries({
    targetRole: opts.role,
    similarRoles: opts.similarRoles,
    maxQueries: MAX_TOTAL_QUERIES,
  });
  const supplementary = SUPPLEMENTARY_QUERY_FAMILIES
    .map((f) => f.query)
    .filter((q) => !taxonomyQueries.some((tq) => tq.toLowerCase() === q.toLowerCase()));
  return uniq([...taxonomyQueries, ...supplementary]).slice(0, MAX_TOTAL_QUERIES);
}

function shQuiet(cmd, args, options = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, ...options });
}

function loadExistingJobIds(dbPath, opts = {}) {
  if (!dbPath || dbPath === ':memory:' || !existsSync(dbPath)) return new Set();
  try {
    const sql = `
      SELECT job_id
      FROM jobs
      WHERE source = 'linkedin'
        AND description_text IS NOT NULL
        AND trim(description_text) <> ''
        ${opts.retryFailed ? "AND (language_filter_reason IS NULL OR language_filter_reason NOT LIKE 'scrape_failed:%')" : ''}
    `;
    const out = shQuiet('sqlite3', [dbPath, sql]);
    const existingIds = new Set(String(out || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
    return bypassRefreshIds(existingIds, opts.refreshIds);
  } catch {
    return new Set();
  }
}

function readCdpVersion(port) {
  try {
    return JSON.parse(shQuiet('curl', ['-sS', '-f', '--max-time', '3', `http://127.0.0.1:${port}/json/version`]));
  } catch {
    return null;
  }
}

function candidateObscuraPorts(preferred) {
  return uniq([
    preferred,
    process.env.OBSCURA_CDP_PORT,
    process.env.OBSCURA_PORT,
    DEFAULT_OBSCURA_PORT,
    ...COMMON_OBSCURA_PORTS,
  ].map((value) => parsePort(value, null)).filter(Boolean));
}

function findExistingObscuraCdp(preferred) {
  for (const port of candidateObscuraPorts(preferred)) {
    const version = readCdpVersion(port);
    if (version?.webSocketDebuggerUrl) return { port, version };
  }
  return null;
}

function ensureObscura(opts) {
  const existing = findExistingObscuraCdp(opts.obscuraPort);
  if (existing) {
    opts.obscuraPort = existing.port;
    console.log(`Using existing Docker Chromium/CDP browser on 127.0.0.1:${existing.port}.`);
    return existing.port;
  }

  if (!opts.startObscura) {
    const ports = candidateObscuraPorts(opts.obscuraPort).join(', ');
    throw new Error(`Browser CDP is not reachable on checked port(s): ${ports}. Start the Docker Chromium session, pass --obscura-port, or use --start-obscura only for the optional legacy fallback.`);
  }

  const port = opts.obscuraPort;
  console.log(`No existing browser CDP found; starting the optional legacy Obscura fallback on 127.0.0.1:${port}.`);
  const child = spawn(DEFAULT_OBSCURA_BIN, ['serve', '-p', String(port), '--stealth', '--workers', '8'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const version = readCdpVersion(port);
    if (version?.webSocketDebuggerUrl) return port;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  throw new Error(`Timed out waiting for browser CDP on 127.0.0.1:${port}`);
}

function decodeHtmlLite(s) {
  return String(s || '')
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#61;/g, '=')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function extractJobIds(html) {
  const decoded = decodeHtmlLite(html);
  const ids = new Set();
  for (const m of decoded.matchAll(/"job_id":(\d+)/g)) ids.add(m[1]);
  for (const m of decoded.matchAll(/\/jobs\/view\/(\d+)/g)) ids.add(m[1]);
  for (const m of decoded.matchAll(/urn:li:[^:"']*job[^:"']*:(\d+)/gi)) ids.add(m[1]);
  for (const m of decoded.matchAll(/fsd_jobPostingCard:\((\d+),/g)) ids.add(m[1]);
  return [...ids];
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

async function fetchQueryIds(client, query, opts, secret) {
  const seen = new Set();
  const pages = [];
  let empty = 0;
  let queryStatus = PAGE_STATE.HEALTHY;

  const searchOrigin = 'linkedin.com';
  // Strict mode shares the single source-wide policy; legacy keeps the
  // per-query three-strike breaker.
  const searchRp = sourceRetry ?? createRetryPolicy({ maxRetries: 3, circuitBreakerThreshold: 3 });

  for (let start = 0; start <= opts.maxStart; start += opts.pageStep) {
    const fresh = opts.freshDays ? `&f_TPR=r${Math.round(opts.freshDays * 86400)}&sortBy=DD` : '';
    const url = sourceUrl(`/jobs/search/?keywords=${encodeURIComponent(query)}&location=${encodeURIComponent(opts.location)}${fresh}&start=${start}`);

    // Check retry policy before reserving a slot, so a terminated source
    // does not burn budget on pages it will never fetch.
    const decision = searchRp.canRetry(url, searchOrigin);
    if (!decision.allowed) {
      console.warn(`  [terminal] Search page start=${start}: ${decision.reason}`);
      queryStatus = searchRp.isCircuitBroken(searchOrigin) ? PAGE_STATE.BLOCKED : PAGE_STATE.TRANSIENT_ERROR;
      break;
    }
    const admission = await admitNavigation(url);
    if (!admission.ok) {
      queryStatus = PAGE_STATE.BLOCKED;
      break;
    }
    await enforceRateLimit();

    const result = await fetchSearchHtmlViaObscura(client, url, secret);
    const pageState = result.state || (result.blocked ? (result.isCaptcha ? PAGE_STATE.ACTIVE_CHALLENGE : PAGE_STATE.BLOCKED) : PAGE_STATE.HEALTHY);
    searchRp.recordResult(url, searchOrigin, pageState, result.error || null);
    noteSourceRestriction(pageState, result.error || null);

    if (isBlockingState(pageState)) {
      if (result.isCaptcha) {
        console.warn(`  [captcha] CAPTCHA detected on search page start=${start}: ${result.error}. Use captcha-resolution skill to solve.`);
      } else if (pageState === PAGE_STATE.RATE_LIMITED) {
        console.warn(`  [rate-limited] on search page start=${start}: ${result.error}`);
      } else {
        console.warn(`  [blocked] LinkedIn warning on search page start=${start}: ${result.error}`);
      }
      start -= opts.pageStep; // retry same page (policy gate above limits retries)
      continue;
    }

    if (pageState === PAGE_STATE.LOGIN_REQUIRED) {
      console.warn(`  [login] Login required on search page start=${start}. Aborting query.`);
      queryStatus = PAGE_STATE.LOGIN_REQUIRED;
      break;
    }

    const ids = result.status === 200 ? extractJobIds(result.html) : [];
    const newIds = ids.filter((id) => !seen.has(id));
    for (const id of newIds) seen.add(id);
    pages.push({ start, status: result.status, ids: ids.length, newIds: newIds.length, error: result.error || null });
    if (!ids.length || !newIds.length) empty++;
    else empty = 0;
    if (empty >= 3) break;
    await humanDelay('between search pages', 3000, 8000);
  }
  return { query, ids: [...seen], pages, status: queryStatus };
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
  // Shared cross-process budget recording happens in enforceRateLimit via
  // waitForSlot (which records the slot); recording here too would
  // double-count each request and halve the effective shared rate.
}

async function enforceRateLimit() {
  noteRequest();
  // Shared cross-process budget: wait for a slot (fail-open on error / missing file)
  if (sharedBudget) {
    try { await sharedBudget.waitForSlot(); } catch { /* fail open to per-process */ }
  }
  // Per-process fallback enforcement
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

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
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
    try {
      if (this.ws) {
        this.ws.onclose = null;
        this.ws.onerror = null;
        this.ws.onmessage = null;
        this.ws.close();
      }
    } catch {}
    // Reject all in-flight CDP calls so cancelled workers fail fast.
    for (const [, p] of this.pending) {
      p.reject(new Error('CDP client closed'));
    }
    this.pending.clear();
  }
}

async function connectCdp(opts) {
  const version = readCdpVersion(opts.obscuraPort);
  if (!version?.webSocketDebuggerUrl) throw new Error(`Browser CDP is not reachable on 127.0.0.1:${opts.obscuraPort}`);
  const client = new CdpClient(version.webSocketDebuggerUrl);
  await client.connect();
  return client;
}

async function seedAuthState(client, sessionId, targetUrl, secret) {
  const cookies = secret?.cookies || [];
  if (cookies.length) {
    await withTimeout(
      client.send('Network.setCookies', { cookies: cookies.map(cdpCookie) }, sessionId),
      8000,
      'Network.setCookies'
    );
  }

  const localStorage = secret?.localStorage || {};
  const sessionStorage = secret?.sessionStorage || {};
  if (Object.keys(localStorage).length || Object.keys(sessionStorage).length) {
    const originUrl = `${new URL(targetUrl).origin}/`;
    await withTimeout(
      client.send('Page.navigate', { url: originUrl }, sessionId).catch(() => {}),
      12000,
      'seed auth navigate'
    );
    await sleep(2500);
    const expression = `(() => {
      const local = ${JSON.stringify(secret?.localStorage || {})};
      const session = ${JSON.stringify(secret?.sessionStorage || {})};
      for (const [k, v] of Object.entries(local)) localStorage.setItem(k, String(v));
      for (const [k, v] of Object.entries(session)) sessionStorage.setItem(k, String(v));
      return { localStorageSet: Object.keys(local).length, sessionStorageSet: Object.keys(session).length };
    })()`;
    const result = await withTimeout(client.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }, sessionId), 12000, 'seed auth evaluate');
    if (result.exceptionDetails) throw new Error('failed to inject storage into Obscura CDP session');
    await withTimeout(
      client.send('Page.reload', { ignoreCache: true }, sessionId).catch(() => {}),
      12000,
      'seed auth reload'
    );
    await sleep(2000);
  }
}

async function fetchSearchHtmlViaObscura(client, url, secret) {
  let targetId;
  const titleMatchRe = /<title>([^<]+)<\/title>/i;
  try {
    const target = await withTimeout(client.send('Target.createTarget', { url: 'about:blank' }), 10000, 'Target.createTarget');
    targetId = target.targetId;
    if (targetRegistry) targetRegistry.registerOwned(targetId, 'search page');
    if (cdpLease) cdpLease.registerTab(targetId);
    const attached = await withTimeout(client.send('Target.attachToTarget', { targetId, flatten: true }), 10000, 'Target.attachToTarget');
    const sessionId = attached.sessionId;
    await withTimeout(client.send('Page.enable', {}, sessionId), 8000, 'Page.enable');
    await withTimeout(client.send('Runtime.enable', {}, sessionId), 8000, 'Runtime.enable');
    await withTimeout(client.send('Network.enable', {}, sessionId), 8000, 'Network.enable');
    await injectAntiDetection(client, sessionId);
    await seedAuthState(client, sessionId, url, secret);
    const nav = await withTimeout(client.send('Page.navigate', { url, referrer: 'https://www.linkedin.com/feed/' }, sessionId), 20000, 'Page.navigate');
    if (nav.errorText) {
      const classification = classifyLinkedInPage({ url, text: nav.errorText, isSearch: true });
      return { status: 0, html: '', error: nav.errorText, blocked: false, isCaptcha: false, state: classification.state };
    }

    await simulateMouseMovement(client, sessionId);
    await simulateScroll(client, sessionId);
    await humanDelay('search page load', 4000, 7000);

    let html = '';
    for (let i = 0; i < 10; i++) {
      if (i > 0) await humanDelay('search retry poll', 2000, 4000);
      const result = await withTimeout(client.send('Runtime.evaluate', {
        expression: 'document.documentElement ? document.documentElement.outerHTML : ""',
        returnByValue: true,
        awaitPromise: true,
      }, sessionId), 15000, 'search Runtime.evaluate');
      html = String(result.result?.value || '');

      const title = (html.match(titleMatchRe) || [])[1] || '';
      const classification = classifyLinkedInPage({ title, url, text: html, isSearch: true });
      if (classification.blocked) {
        return { status: 0, html: '', error: classification.reason, blocked: true, isCaptcha: classification.isCaptcha, state: classification.state };
      }
      if (/"job_id":\d+|\/jobs\/view\/\d+|jobCardPrefetchQueries|totalResultSize/.test(decodeHtmlLite(html))) {
        return { status: 200, html, blocked: false, isCaptcha: false, state: classification.state };
      }
      if (/Sign in|Join LinkedIn|session expired/i.test(html) && html.length > 2000) {
        return { status: 200, html, blocked: false, isCaptcha: false, state: classification.state };
      }
    }
    const title = (html.match(titleMatchRe) || [])[1] || '';
    const classification = classifyLinkedInPage({ title, url, text: html, isSearch: true });
    return { status: html ? 200 : 0, html, blocked: false, isCaptcha: false, state: classification.state };
  } catch (e) {
    return { status: 0, html: '', error: e.message, blocked: false, isCaptcha: false, state: PAGE_STATE.TRANSIENT_ERROR };
  } finally {
    if (targetId) {
      if (targetRegistry) targetRegistry.unregister(targetId);
      await client.send('Target.closeTarget', { targetId }).catch(() => {});
    }
  }
}

function cdpCookie(c) {
  const out = {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || '/',
    secure: Boolean(c.secure),
    httpOnly: Boolean(c.httpOnly),
  };
  if (Number.isFinite(c.expires) && c.expires > 0) out.expires = c.expires;
  if (c.sameSite) out.sameSite = c.sameSite;
  return out;
}

const EXTRACT_EXPR = `JSON.stringify((() => {
  const text = document.body?.innerText || document.body?.textContent || '';
  const title = document.title || '';
  const href = location.href;
  const raw = [];
  const selectors = 'h1,h2,h3,h4,p,li,span,a,button,section,div[class*=job],div[class*=description],div[class*=top-card],div[class*=details]';
  for (const el of Array.from(document.querySelectorAll(selectors))) {
    const t = (el.innerText || el.textContent || '').trim();
    if (!t || t.length > 12000) continue;
    for (const part of t.split(/\\n+/)) {
      const line = part.trim().replace(/\\s+/g, ' ');
      if (line) raw.push(line);
    }
  }
  if (raw.length < 10) {
    for (const part of text.split(/\\n+|(?<=applicants)\\s+|(?=Seniority level)|(?=Employment type)|(?=Job function)|(?=Industries)|(?=Report this job)/i)) {
      const line = part.trim().replace(/\\s+/g, ' ');
      if (line) raw.push(line);
    }
  }
  const lines = [];
  for (const line of raw) {
    if (line === lines[lines.length - 1]) continue;
    if (/^window\\.__/.test(line)) continue;
    lines.push(line);
  }
  return { title, href, lines };
})())`;

function publicTextLines(text) {
  const lines = [];
  for (const part of String(text || '').split(/\n+/)) {
    const line = part.trim().replace(/\s+/g, ' ');
    if (!line) continue;
    if (line === lines[lines.length - 1]) continue;
    lines.push(line);
  }
  return lines;
}

function splitCompanyLocation(value) {
  const v = String(value || '').trim();
  if (!v) return { company: null, location: null };

  // Obscura text often renders LinkedIn top cards as e.g. "CognizantLondon, England, United Kingdom".
  // Find a comma-bearing location substring from the first plausible city token.
  const locationRe = /[A-Z][a-zA-Z.'-]*(?:\s+[A-Z][a-zA-Z.'-]*){0,5},\s*[A-Z][a-zA-Z .'-]+(?:,\s*[A-Z][a-zA-Z .'-]+)*/g;
  for (const m of v.matchAll(locationRe)) {
    if (m.index > 0) {
      return { company: v.slice(0, m.index).trim() || null, location: m[0].trim() || null };
    }
  }

  const knownLocationRe = /\b(Remote|EMEA|United Kingdom|England|Scotland|Wales|Northern Ireland|London(?: Area)?|Greater London|Knutsford|Manchester|Glasgow|Edinburgh|Birmingham|Bristol|Leeds|Liverpool|Cambridge|Oxford|Reading|Example Location 013|Example Location 016|Switzerland|Dublin|Ireland|Amsterdam|Netherlands|Berlin|Germany|Paris|France|Milan|Italy)\b/i;
  const known = knownLocationRe.exec(v);
  if (known && known.index > 0) {
    return { company: v.slice(0, known.index).trim() || null, location: v.slice(known.index).trim() || null };
  }
  return { company: v, location: null };
}

function extractPublicTopCard(lines) {
  for (let i = 0; i < lines.length; i++) {
    if (!/^(Apply|Easy Apply|Apply now)$/i.test(lines[i])) continue;
    const title = lines[i - 2];
    const companyLocation = lines[i - 1];
    if (!plausibleLine(title) || !plausibleLine(companyLocation)) continue;
    if (/applicants?|password|sign in|join now/i.test(companyLocation)) continue;
    const split = splitCompanyLocation(companyLocation);
    return { title, company: split.company, location: split.location };
  }
  return {};
}

async function fetchJobTextViaCdp(client, url, opts) {
  const timeoutMs = Math.max(5000, Number(opts.detailTimeout || 25) * 1000);
  let targetId;
  try {
    const target = await withTimeout(client.send('Target.createTarget', { url: 'about:blank' }), 10000, 'detail Target.createTarget');
    targetId = target.targetId;
    if (targetRegistry) targetRegistry.registerOwned(targetId, 'detail page');
    if (cdpLease) cdpLease.registerTab(targetId);
    const attached = await withTimeout(client.send('Target.attachToTarget', { targetId, flatten: true }), 10000, 'detail Target.attachToTarget');
    const sessionId = attached.sessionId;
    await withTimeout(client.send('Page.enable', {}, sessionId), 8000, 'detail Page.enable');
    await withTimeout(client.send('Runtime.enable', {}, sessionId), 8000, 'detail Runtime.enable');
    await injectAntiDetection(client, sessionId);
    await humanDelay('pre-detail nav', 2000, 5000);
    const nav = await withTimeout(client.send('Page.navigate', { url, referrer: 'https://www.linkedin.com/jobs/search/' }, sessionId), timeoutMs, 'detail Page.navigate');
    if (nav.errorText) throw new Error(nav.errorText);

    await simulateMouseMovement(client, sessionId);
    await simulateScroll(client, sessionId);
    await humanDelay('detail page read', 3000, 6000);

    let detail = { title: '', text: '' };
    for (let i = 0; i < 18; i++) {
      if (i > 0) await humanDelay('detail retry poll', 2000, 4000);
      const result = await withTimeout(client.send('Runtime.evaluate', {
        expression: 'JSON.stringify({ title: document.title || "", text: document.body ? document.body.innerText : document.documentElement.innerText || "" })',
        returnByValue: true,
        awaitPromise: true,
      }, sessionId), timeoutMs, 'detail text Runtime.evaluate');
      detail = JSON.parse(result.result?.value || '{"title":"","text":""}');
      const classification = classifyLinkedInPage({ title: detail.title, url, text: detail.text });
      if (classification.blocked) {
        return { title: '', text: '', blocked: true, isCaptcha: classification.isCaptcha, blockReason: classification.reason, state: classification.state };
      }
      if (detail.text.includes('Report this job') || detail.text.includes('Seniority level') || detail.text.includes('About the job')) break;
    }
    if (!detail.text) throw new Error('empty detail page text');
    const finalClassification = classifyLinkedInPage({ title: detail.title, url, text: detail.text });
    return { ...detail, blocked: false, isCaptcha: false, blockReason: null, state: finalClassification.state };
  } finally {
    if (targetId) {
      if (targetRegistry) targetRegistry.unregister(targetId);
      await client.send('Target.closeTarget', { targetId }).catch(() => {});
    }
  }
}

async function scrapeJob(client, id, secret, opts, queries, detailRp) {
  const url = sourceUrl(`/jobs/view/${id}`);
  const origin = 'linkedin.com';
  const MAX_ATTEMPTS = 10; // safety cap; retry policy gates below this
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (sourceHalted) return failedJob(id, url, opts, queries, 'source_halted_before_attempt');

    // Check retry policy before each attempt and before reserving a slot.
    // Legacy skips the check on the first attempt; strict mode checks every
    // attempt so a restriction observed elsewhere in the source stops this
    // fetch before it is sent.
    if (attempt > 1 || sourceRetry) {
      const decision = detailRp.canRetry(url, origin);
      if (!decision.allowed) {
        console.warn(`  [terminal] Detail ${id}: ${decision.reason}`);
        return failedJob(id, url, opts, queries, `terminal: ${decision.reason}`);
      }
      if (attempt > 1) {
        const backoff = backoffDelay(attempt - 1, 15000, 120000);
        console.log(`  [detail-backoff] ${id} attempt=${attempt} waiting ${(backoff / 1000).toFixed(1)}s`);
        await sleep(backoff);
      }
    }
    const admission = await admitNavigation(url);
    if (!admission.ok) return failedJob(id, url, opts, queries, `source_halted: ${admission.reason}`);
    await enforceRateLimit();

    try {
      const detail = await fetchJobTextViaCdp(client, url, opts);
      const pageState = detail.state || (detail.blocked ? (detail.isCaptcha ? PAGE_STATE.ACTIVE_CHALLENGE : PAGE_STATE.BLOCKED) : PAGE_STATE.HEALTHY);

      if (detail.blocked) {
        detailRp.recordResult(url, origin, pageState, detail.blockReason || 'blocked');
        noteSourceRestriction(pageState, detail.blockReason || 'blocked');
        if (detail.isCaptcha) {
          console.warn(`  [captcha] CAPTCHA on detail ${id}: ${detail.blockReason}`);
        } else if (pageState === PAGE_STATE.RATE_LIMITED) {
          console.warn(`  [rate-limited] on detail ${id}: ${detail.blockReason}`);
        } else {
          console.warn(`  [blocked] LinkedIn warning on detail ${id}: ${detail.blockReason}`);
        }
        continue;
      }

      detailRp.recordResult(url, origin, pageState, null);

      const lines = publicTextLines(detail.text);
      const topCard = extractPublicTopCard(lines);
      const parsed = parseJobPayload(id, url, { title: detail.title || topCard.title || '', href: url, lines, topCard, publicText: true }, opts, queries);
      if (parsed.description && parsed.description.length > 200) return parsed;
      throw new Error(`short public detail text (${parsed.description?.length || 0} description chars)`);
    } catch (e) {
      detailRp.recordResult(url, origin, PAGE_STATE.TRANSIENT_ERROR, e.message);
      if (!opts.authenticatedDetails) return failedJob(id, url, opts, queries, `public_detail_fetch_failed: ${e.message}`);
      const fallback = await scrapeJobViaAuthenticatedCdp(client, id, secret, opts, queries);
      if (fallback.languageFilterReason) {
        fallback.languageFilterReason = `public_detail_fetch_failed: ${e.message}; ${fallback.languageFilterReason}`;
      }
      return fallback;
    }
  }
  // Should not reach here; safety fallback
  return failedJob(id, url, opts, queries, 'exhausted all retry attempts');
}

async function scrapeJobViaAuthenticatedCdp(client, id, secret, opts, queries) {
  const url = sourceUrl(`/jobs/view/${id}`);
  let targetId;
  try {
    const target = await withTimeout(client.send('Target.createTarget', { url: 'about:blank' }), 10000, 'Target.createTarget');
    targetId = target.targetId;
    if (targetRegistry) targetRegistry.registerOwned(targetId, 'auth detail page');
    if (cdpLease) cdpLease.registerTab(targetId);
    const attached = await withTimeout(client.send('Target.attachToTarget', { targetId, flatten: true }), 10000, 'Target.attachToTarget');
    const sessionId = attached.sessionId;
    await withTimeout(client.send('Page.enable', {}, sessionId), 8000, 'Page.enable');
    await withTimeout(client.send('Runtime.enable', {}, sessionId), 8000, 'Runtime.enable');
    await withTimeout(client.send('Network.enable', {}, sessionId), 8000, 'Network.enable');
    await injectAntiDetection(client, sessionId);
    await seedAuthState(client, sessionId, url, secret);
    await humanDelay('auth-detail nav', 2000, 5000);
    await withTimeout(client.send('Page.navigate', { url, referrer: 'https://www.linkedin.com/jobs/search/' }, sessionId), 20000, 'Page.navigate');
    await simulateMouseMovement(client, sessionId);
    await simulateScroll(client, sessionId);
    await humanDelay('auth-detail read', 3000, 6000);

    let payload;
    for (let i = 0; i < 18; i++) {
      if (i > 0) await humanDelay('auth-detail retry', 2000, 4000);
      const result = await withTimeout(client.send('Runtime.evaluate', { expression: EXTRACT_EXPR, returnByValue: true, awaitPromise: true }, sessionId), 15000, 'detail Runtime.evaluate');
      if (result.result?.value) {
        payload = JSON.parse(result.result.value);
        const joined = payload.lines.join('\n');
        const block = detectBlockPage(joined);
        if (block.blocked) {
          throw new Error(`blocked: ${block.reason}${block.isCaptcha ? ' (CAPTCHA)' : ''}`);
        }
        if (joined.includes('Report this job') || joined.includes('Seniority level') || joined.includes('About the job')) break;
      }
    }
    if (!payload) throw new Error('no payload');
    return parseJobPayload(id, url, payload, opts, queries);
  } catch (e) {
    return failedJob(id, url, opts, queries, e.message);
  } finally {
    if (targetId) {
      if (targetRegistry) targetRegistry.unregister(targetId);
      await client.send('Target.closeTarget', { targetId }).catch(() => {});
    }
  }
}

function classifyLinkedInRole(job = {}, provisional = false) {
  const descriptionText = [job.descriptionText, job.description]
    .find((value) => String(value ?? '').trim()) || '';
  const classification = classifySharedRole({
    title: job.title,
    descriptionText,
    jobFunction: job.jobFunction,
    industries: job.industries,
    provisional: Boolean(provisional || !descriptionText.trim()),
  });
  return assertRoleClassification(classification);
}

function failedJob(id, url, opts, queries, message) {
  const role = classifyLinkedInRole({ title: null, descriptionText: '' }, true);
  return {
    source: 'linkedin', job_id: id, url,
    title: null, company: null, location: null, applicants: null,
    description: '', descriptionText: '', applicationLinks: [url], recruiter: null, recruiterEmail: null, recruiterProfileLink: null,
    jobPostingDate: null,
    languageRequirements: { required: [], niceToHave: [] },
    languageFilterPassed: false,
    languageFilterReason: `scrape_failed: ${message}`,
    roleType: role.label, roleConfidence: role.confidence, roleFilterPassed: false, roleFilterReason: role.reason.summary,
    searchedKeywords: queries.join('; '), searchedLocation: opts.location,
  };
}

function parseTitleMeta(docTitle) {
  const cleaned = String(docTitle || '').replace(/\s+\|\s+LinkedIn.*$/i, '').trim();
  const hiring = cleaned.match(/^(.+?) hiring (.+?) in (.+)$/i);
  if (hiring) return { company: hiring[1].trim(), title: hiring[2].trim(), location: hiring[3].trim() };
  const pipe = String(docTitle || '').match(/^(.+?)\s+\|\s+(.+?)\s+\|\s+LinkedIn/i);
  if (pipe) return { title: pipe[1].trim(), company: pipe[2].trim(), location: null };
  return { title: cleaned || null, company: null, location: null };
}

function valueAfter(lines, label) {
  const i = lines.findIndex((l) => l.toLowerCase() === label.toLowerCase());
  return i >= 0 ? lines[i + 1] || null : null;
}

function plausibleLine(v) {
  return Boolean(v && v.length < 180 && !/^window\.__/.test(v) && !/^(Apply|Save|Report this job|Sign in|Join now|Clear text)$/i.test(v));
}

function findTopCard(lines, title, company) {
  if (!title) return {};
  for (let i = 0; i < lines.length - 2; i++) {
    if (lines[i] !== title) continue;
    const c = lines[i + 1];
    const loc = lines[i + 2];
    if (company && c && c !== company) continue;
    if (plausibleLine(c)) return { company: c, location: plausibleLine(loc) ? loc : null };
  }
  return {};
}

function findPosted(lines) {
  return lines.find((l) => /\b(\d+\s+(minute|hour|day|week|month)s? ago|just now|reposted)\b/i.test(l)) || null;
}

function findApplicants(lines) {
  return lines.find((l) => /applicants?/i.test(l) && !/has hired/i.test(l)) || null;
}

function extractDescription(lines) {
  const start = lines.findIndex((l) => l === 'Report this job');
  const end = lines.findIndex((l, i) => i > start && l === 'Seniority level');
  let descLines = start >= 0 && end > start ? lines.slice(start + 1, end) : [];
  if (!descLines.length) {
    const aboutStart = lines.findIndex((l) => /^About the job$/i.test(l));
    const aboutEnds = [/^Show less$/i, /^Show more$/i, /^Seniority level$/i, /^Employment type$/i, /^Job function$/i, /^Industries$/i, /^Skills$/i, /^Similar jobs$/i, /^People also viewed$/i, /^Set alert/i];
    const aboutEnd = lines.findIndex((l, i) => i > aboutStart && aboutEnds.some((re) => re.test(l)));
    if (aboutStart >= 0) descLines = lines.slice(aboutStart + 1, aboutEnd > aboutStart ? aboutEnd : undefined);
  }
  const actualStart = descLines.findIndex((l) => /^(About|Responsibilities|Requirements|Job description|The Role|Role Overview|Your role|What you|We are|We’re|Our client|Company Description|Minimum qualifications|Basic qualifications|Overview|Locations?|Aufgaben|Profil|Deine|Ihre|Your mission)/i.test(l));
  if (actualStart > 0) descLines = descLines.slice(actualStart);
  return descLines.join('\n').trim();
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
const REQUIRED_CONTEXT = /\b(required|must|mandatory|essential|fluent|proficient|excellent|strong|native|business fluent|c1|c2|kenntnisse|maîtrise|maitrise|obligatoire|nécessaire|necessaire|erforderlich|voraussetzung|zwingend)\b/i;

function sentenceSplit(text) {
  return String(text || '').replace(/\n+/g, '. ').split(/(?<=[.!?;])\s+|\s+[-–—]\s+/).map((s) => s.trim()).filter(Boolean);
}

function parseLanguages(description) {
  const required = new Set();
  const niceToHave = new Set();
  for (const sentence of sentenceSplit(description)) {
    for (const [lang, aliases] of Object.entries(LANGUAGE_MAP)) {
      if (!aliases.some((a) => new RegExp(`\\b${escapeRe(a)}\\b`, 'i').test(sentence))) continue;
      if (NICE_CONTEXT.test(sentence)) niceToHave.add(lang);
      else if (REQUIRED_CONTEXT.test(sentence) || /language skills|sprachkenntnisse|langues?|languages?/i.test(sentence)) required.add(lang);
    }
  }
  return { required: [...required], niceToHave: [...niceToHave].filter((l) => !required.has(l)) };
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function passesLanguage(reqs, opts) {
  const speaks = new Set(opts.speaks.map((l) => l.toLowerCase()));
  const blocked = reqs.required.filter((l) => !speaks.has(l.toLowerCase()));
  return { pass: blocked.length === 0, reason: blocked.length ? `requires ${blocked.join(', ')}` : null };
}

function parseJobPayload(id, url, payload, opts, queries) {
  const lines = payload.lines || [];
  const meta = parseTitleMeta(payload.title);
  const title = meta.title || payload.topCard?.title || valueAfter(lines, 'Jobs') || null;
  const top = payload.topCard?.title ? payload.topCard : findTopCard(lines, title, meta.company);
  const description = extractDescription(lines);
  const base = {
    source: 'linkedin',
    job_id: id,
    url,
    title,
    company: meta.company || top.company || null,
    location: top.location || meta.location || null,
    applicants: findApplicants(lines),
    description,
    descriptionText: description,
    applicationLinks: [url],
    recruiter: null,
    recruiterEmail: null,
    recruiterProfileLink: null,
    jobPostingDate: findPosted(lines),
    languageRequirements: parseLanguages(description),
    jobFunction: valueAfter(lines, 'Job function'),
    industries: valueAfter(lines, 'Industries'),
    seniority: valueAfter(lines, 'Seniority level'),
    employmentType: valueAfter(lines, 'Employment type'),
    searchedKeywords: queries.join('; '),
    searchedLocation: opts.location,
  };
  const lang = passesLanguage(base.languageRequirements, opts);
  const role = classifyLinkedInRole(base, !description.trim());
  return {
    ...base,
    languageFilterPassed: lang.pass,
    languageFilterReason: lang.reason,
    roleType: role.label,
    roleConfidence: role.confidence,
    roleClassification: role,
    roleFilterPassed: role.label !== 'Out of scope',
    roleFilterReason: role.reason.summary,
  };
}

function toDbRecord(r) {
  const descriptionText = [r.descriptionText, r.description]
    .find((value) => String(value ?? '').trim()) || '';
  const role = classifyLinkedInRole(
    { ...r, descriptionText },
    !descriptionText.trim(),
  );
  return {
    source: r.source,
    job_id: r.job_id,
    url: r.url,
    title: r.title,
    company: r.company,
    locationRaw: r.location,
    applicantsRaw: r.applicants,
    descriptionRaw: r.description,
    descriptionText,
    jobFunction: r.jobFunction,
    industries: r.industries,
    applicationLinks: r.applicationLinks,
    recruiter: r.recruiter,
    recruiterEmail: r.recruiterEmail,
    recruiterProfileLink: r.recruiterProfileLink,
    jobPostingDate: r.jobPostingDate,
    languageRequirements: r.languageRequirements,
    languageFilterReason: r.languageFilterReason,
    roleFamilyInferred: role.label,
    roleFamilyConfidence: role.confidence,
    roleFamilyReason: role.reason.summary,
    roleTaxonomyVersion: SHARED_TAXONOMY_VERSION,
    searchedKeywords: r.searchedKeywords,
    searchedLocation: r.searchedLocation,
  };
}

function compact(r) {
  return {
    job_id: r.job_id,
    title: r.title,
    company: r.company,
    location: r.location,
    posted: r.jobPostingDate,
    applicants: r.applicants,
    requiredLanguages: r.languageRequirements?.required || [],
    niceToHaveLanguages: r.languageRequirements?.niceToHave || [],
    reason: r.languageFilterReason || r.roleFilterReason || null,
    url: r.url,
  };
}

/**
 * Persist a batch of normalized job records to SQLite via save-to-sqlite.mjs.
 * Writes to a temp file, calls the save script, cleans up the temp file.
 * Returns { success, count, inserted, updated, error? }.
 * On failure, the error is logged and returned — the caller decides how to proceed.
 */
function persistBatch(records, dbPath) {
  if (!records || records.length === 0) return { success: true, count: 0, inserted: 0, updated: 0 };
  const tmpFile = `/tmp/linkedin-checkpoint-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  try {
    writeFileSync(tmpFile, JSON.stringify(records, null, 2));
    const out = execFileSync('node', [DEFAULT_SAVE_SCRIPT, tmpFile, '--db', dbPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const inserted = parseInt((out.match(/Jobs inserted: (\d+)/) || [])[1] || '0', 10);
    const updated = parseInt((out.match(/updated: (\d+)/) || [])[1] || '0', 10);
    return { success: true, count: records.length, inserted, updated };
  } catch (e) {
    console.error(`\n⚠ Checkpoint persist failed: ${e.message}`);
    if (e.stderr) console.error(String(e.stderr));
    return { success: false, count: records.length, error: e.message };
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}

async function main() {
  // ── Target lifecycle: registry + cleanup + cancellation ───────────
  targetRegistry = createTargetRegistry();
  let cancelled = false;
  let cleanupFn = null;

  function onCancel(signal) {
    if (cancelled) {
      // Second signal — force-exit immediately.
      console.error(`\n[${signal}] Force exiting.`);
      process.exit(3);
    }
    cancelled = true;
    runCancelled = true;
    console.error(`\n[${signal}] Cancelling run. Cleaning up...`);
    if (cleanupFn) cleanupFn().catch(() => process.exit(3));
  }
  process.once('SIGINT', () => onCancel('SIGINT'));
  process.once('SIGTERM', () => onCancel('SIGTERM'));

  const opts = parseArgs(process.argv.slice(2));
  try {
    targetBase = resolveTargetBase();
  } catch (err) {
    console.error(`Search aborted before any navigation: ${err.message}`);
    process.exitCode = 1;
    return;
  }
  if (opts.strictOwner) {
    // ── Strict source admission — before any browser or CDP contact ───
    const ownerRes = await tryAcquireStrictLinkedInOwner({
      dbPath: opts.db,
      lockDir: opts.lockDir || path.join(JOBHUNTER_HOME, 'locks'),
      runId: `${opts.role.replace(/\s+/g, '-')}-${Date.now()}`,
    });
    if (!ownerRes.ok) {
      const summary = {
        status: 'source_blocked',
        stage: ownerRes.stage,
        reason: ownerRes.reason,
        detail: ownerRes.detail ?? null,
        deferred: 'all — no navigation was attempted',
        dbPath: opts.db,
      };
      writeFileSync(opts.summary, JSON.stringify(summary, null, 2));
      console.warn(`  [source-owner] Blocked before navigation: ${ownerRes.stage}/${ownerRes.reason} — ${ownerRes.detail ?? ''}`);
      console.warn('  [source-owner] Requested scope deferred; no CDP contact attempted.');
      process.exitCode = 2;
      return;
    }
    sourceOwner = ownerRes.owner;
    sourceRetry = createStrictSourceRetryPolicy({ maxRetries: 3 });
    console.log(`  [source-owner] Strict LinkedIn source owner acquired (identity: linkedin-source, access: ${sourceOwner.accessSource}).`);
  }

  if (!existsSync(opts.sessionJson)) {
    writeFileSync(opts.sessionJson, JSON.stringify({ cookies: [], localStorage: {}, sessionStorage: {} }, null, 2));
  }
  ensureObscura(opts);

  if (!opts.strictOwner) {
    // ── Cross-process CDP coordination (legacy fail-open path) ────────
    // Coordination, not prohibition: if another live run holds the lease we
    // proceed without it (shared budget still throttles us collectively);
    // we just cannot advertise our tab ownership in the lease file.
    cdpLease = tryAcquireLease({
      leaseName: `linkedin-search:${opts.obscuraPort}`,
      runId: `${opts.role.replace(/\s+/g, '-')}-${Date.now()}`,
    });
    if (!cdpLease) {
      console.warn('  [cdp-lease] Proceeding without lease — another run is active on this browser; shared budget still applies');
    }
    sharedBudget = createSharedBudget({
      budgetName: `linkedin.com:${opts.obscuraPort}`,
      windowMs: rateTracker.windowMs,
      maxRequests: rateTracker.maxRequests,
    });
  } else {
    // Strict mode owns the source through the one owner; no second lease and
    // no per-process budget fallback — admissions go through the owner.
    console.log('  [source-owner] budget identity: linkedin-source (shared source-wide, port-independent)');
  }

  const queries = buildQueries(opts);
  console.log(`Searching LinkedIn via browser CDP: role="${opts.role}" location="${opts.location}" speaks="${opts.speaks.join(', ')}" port=${opts.obscuraPort} queries=${queries.length} detailMode=existing-cdp-text`);

  const secret = JSON.parse(readFileSync(opts.sessionJson, 'utf8'));
  const client = await connectCdp(opts);
  const keepAlive = startCdpKeepAlive(client, {
    intervalMs: opts.keepAliveSeconds * 1000,
    label: 'LinkedIn CDP',
    onStart: ({ intervalMs }) => console.log(`[cdp] heartbeat enabled every ${intervalMs / 1000}s on 127.0.0.1:${opts.obscuraPort}`),
    onFailure: (error) => console.warn(`[cdp] heartbeat failed: ${error.message}`),
  });

  // Wire cleanup: close owned targets → stop keepalive → close client → release lease.
  cleanupFn = createCleanup({
    registry: targetRegistry,
    client,
    stopKeepalive: () => keepAlive.stop(),
    closeClient: () => client.close(),
  });
  // Chain lease/owner release into cleanup (after CDP teardown)
  const innerCleanup = cleanupFn;
  cleanupFn = async () => {
    await innerCleanup();
    if (sourceOwner) { sourceOwner.release(); sourceOwner = null; }
    if (cdpLease) { cdpLease.release(); cdpLease = null; }
    if (sharedBudget) { sharedBudget.destroy(); sharedBudget = null; }
  };

  // Shared detail-page retry policy. Legacy: all detail fetches share one
  // circuit breaker. Strict: the run-wide source policy is shared by the
  // search and detail phases so the first canonical restriction ends both.
  const detailRp = sourceRetry ?? createRetryPolicy({ maxRetries: 3, circuitBreakerThreshold: 4 });

  let queryResults;
  let allRecords = [];
  const allScrapedIds = new Set();
  const perQueryPersistStats = [];

  try {
    // ── Phase 1: Search (unchanged) ─────────────────────────────────
    queryResults = await mapLimit(queries, opts.searchConcurrency, (q) => fetchQueryIds(client, q, opts, secret), 5000);
    queryResults = mergeExplicitRefreshIds(queryResults, opts.refreshJobIds);
    const queryById = new Map();
    for (const qr of queryResults) {
      for (const id of qr.ids) {
        if (!queryById.has(id)) queryById.set(id, []);
        queryById.get(id).push(qr.query);
      }
    }
    const allUniqueIds = [...queryById.keys()];
    console.log(`Search pages complete: ${allUniqueIds.length} unique job IDs across ${queries.length} queries`);

    // ── Phase 2: Detail scraping + incremental checkpointing ─────────
    // Process one query at a time; persist after each query's details complete.
    // A later query failure or cancellation leaves earlier checkpoints intact.
    let globalDetailCount = 0;

    for (const qr of queryResults) {
      if (cancelled) {
        perQueryPersistStats.push({
          query: qr.query,
          idsTotal: qr.ids.length,
          idsNew: 0,
          scraped: 0,
          failed: 0,
          persisted: 0,
          status: 'cancelled',
        });
        continue;
      }
      if (sourceHalted) {
        // The source stopped admitting (pause, cancellation signal into the
        // owner, or budget/storage failure). Remaining queries are deferred
        // as durable stats, never fetched fail-open.
        perQueryPersistStats.push({
          query: qr.query,
          idsTotal: qr.ids.length,
          idsNew: 0,
          scraped: 0,
          failed: 0,
          persisted: 0,
          status: 'deferred_source_halted',
        });
        continue;
      }

      // IDs from this query that haven't been scraped in a prior batch
      const queryNewIds = qr.ids.filter((id) => !allScrapedIds.has(id));
      const existingIds = loadExistingJobIds(opts.db, { ...opts, refreshIds: new Set(opts.refreshJobIds) });
      const unseenIds = queryNewIds.filter((id) => !existingIds.has(id));

      if (unseenIds.length === 0) {
        perQueryPersistStats.push({
          query: qr.query,
          idsTotal: qr.ids.length,
          idsNew: 0,
          scraped: 0,
          failed: 0,
          persisted: 0,
          status: 'no_new_ids',
        });
        continue;
      }

      // Apply global detail limit (cap total detail pages scraped)
      let batchIds = unseenIds;
      if (opts.detailLimit) {
        const remaining = Math.max(0, opts.detailLimit - globalDetailCount);
        batchIds = unseenIds.slice(0, remaining);
      }

      if (batchIds.length === 0) {
        perQueryPersistStats.push({
          query: qr.query,
          idsTotal: qr.ids.length,
          idsNew: 0,
          scraped: 0,
          failed: 0,
          persisted: 0,
          status: 'detail_limit_reached',
        });
        continue;
      }

      console.log(`  Scraping ${batchIds.length} detail pages for query "${qr.query}"...`);
      const batchRecords = await mapLimit(
        batchIds,
        opts.detailConcurrency,
        (id) => scrapeJob(client, id, secret, opts, queryById.get(id) || queries, detailRp),
        5000,
      );

      // Track scraped IDs globally so later queries skip them
      for (const id of batchIds) allScrapedIds.add(id);
      allRecords.push(...batchRecords);
      globalDetailCount += batchIds.length;

      // ── Checkpoint: persist this batch immediately ─────────────────
      const dbRecords = batchRecords.map(toDbRecord);
      const persistResult = persistBatch(dbRecords, opts.db);

      const scraped = batchRecords.filter((r) => r.description && r.description.length > 0).length;
      const failed = batchRecords.length - scraped;
      perQueryPersistStats.push({
        query: qr.query,
        idsTotal: qr.ids.length,
        idsNew: batchIds.length,
        scraped,
        failed,
        persisted: persistResult.success ? persistResult.count : 0,
        persistError: persistResult.error || null,
        status: persistResult.success ? 'persisted' : 'persist_failed',
      });

      if (opts.detailLimit && globalDetailCount >= opts.detailLimit) {
        console.log(`  Detail limit reached (${opts.detailLimit}). Stopping further detail scraping.`);
        break;
      }
    }
  } finally {
    await cleanupFn();
  }

  // ── Build final aggregates from per-query stats ───────────────────
  const records = allRecords;
  const ids = [...allScrapedIds];

  // Combined output for debugging / downstream consumers
  const allDbRecords = allRecords.map(toDbRecord);
  writeFileSync(opts.out, JSON.stringify(allDbRecords, null, 2));

  const roleMatches = records.filter((r) => r.roleFilterPassed);
  const included = roleMatches.filter((r) => r.languageFilterPassed);
  const languageSkipped = roleMatches.filter((r) => !r.languageFilterPassed);

  // ── Terminal status reporting ──────────────────────────────────────
  const queryStatuses = queryResults.map((q) => ({
    query: q.query,
    status: q.status || PAGE_STATE.HEALTHY,
    uniqueIds: q.ids.length,
    pagesFetched: q.pages.length,
  }));
  const detailStats = detailRp.getStats();
  const detailCircuitBroken = detailStats.origins.some((o) => o.broken);
  const detailStatus = detailCircuitBroken ? PAGE_STATE.BLOCKED : PAGE_STATE.HEALTHY;

  // Distinguish scraped vs failed detail records
  const scrapedRecords = records.filter((r) => r.description && r.description.length > 0);
  const failedRecords = records.filter((r) => !r.description || r.description.length === 0);

  const totalPersisted = perQueryPersistStats
    .filter((s) => s.status === 'persisted')
    .reduce((sum, s) => sum + s.persisted, 0);
  const totalUnpersisted = perQueryPersistStats
    .filter((s) => s.status !== 'persisted' && s.idsNew > 0)
    .reduce((sum, s) => sum + s.idsNew, 0);

  const summary = {
    generatedAt: new Date().toISOString(),
    parameters: {
      role: opts.role,
      location: opts.location,
      speaks: opts.speaks,
      excludeLanguages: opts.excludeLanguages,
      industry: opts.industry,
      similarRoles: opts.similarRoles,
      freshDays: opts.freshDays,
      queries,
      queryFamilies: queries.map((q) => ({ query: q, family: getQueryFamily(q) })),
    },
    terminalStatuses: {
      searchQueries: queryStatuses,
      detailPages: { status: detailStatus, total: ids.length, scraped: scrapedRecords.length, failed: failedRecords.length, circuitBroken: detailCircuitBroken },
      sourcePause: sourcePause ?? undefined,
    },
    queryStats: queryResults.map((q) => ({ query: q.query, family: getQueryFamily(q.query), uniqueIds: q.ids.length, pagesFetched: q.pages.length })),
    totalUniqueJobIds: ids.length,
    scraped: records.length,
    roleMatches: roleMatches.length,
    included: included.length,
    languageSkipped: languageSkipped.length,
    roleSkipped: records.length - roleMatches.length,
    includedJobs: included.map(compact),
    languageSkippedJobs: languageSkipped.map(compact),
    persistStats: {
      totalPersisted,
      totalUnpersisted,
      perQuery: perQueryPersistStats,
    },
    refresh: opts.refreshJobIds?.length ? {
      requested: opts.refreshJobIds.length,
      found: opts.refreshJobIds.filter((id) => ids.includes(id)).length,
      refreshed: opts.refreshJobIds.filter((id) => scrapedRecords.some((r) => r.job_id === id && r.descriptionText)).length,
      missing: opts.refreshJobIds.filter((id) => !scrapedRecords.some((r) => r.job_id === id)).length,
    } : undefined,
    cancelled: cancelled || undefined,
  };
  writeFileSync(opts.summary, JSON.stringify(summary, null, 2));

  // ── Terminal status report (stdout) ────────────────────────────────
  console.log(`\n── Terminal run status ──`);
  for (const qs of queryStatuses) {
    console.log(`  search query "${qs.query}": ${qs.status} (${qs.uniqueIds} ids, ${qs.pagesFetched} pages)`);
  }
  console.log(`  detail pages: ${detailStatus} (${scrapedRecords.length} scraped, ${failedRecords.length} failed, circuit=${detailCircuitBroken})`);
  // Per-query persist summary
  console.log(`  persist: ${totalPersisted} records persisted across queries`);
  for (const ps of perQueryPersistStats) {
    if (ps.status === 'persisted') {
      console.log(`    "${ps.query}": ${ps.persisted} persisted (${ps.scraped} scraped, ${ps.failed} failed) from ${ps.idsNew} new IDs`);
    } else {
      console.log(`    "${ps.query}": ${ps.status} (${ps.idsNew} new IDs unpersisted)`);
    }
  }
  console.log(`── End terminal status ──\n`);

  console.log(`Summary: unique=${summary.totalUniqueJobIds}, roleMatches=${summary.roleMatches}, included=${summary.included}, languageSkipped=${summary.languageSkipped}, roleSkipped=${summary.roleSkipped}, persisted=${totalPersisted}`);
  console.log(`Saved DB: ${opts.db}`);
  console.log(`Results JSON: ${opts.out}`);
  console.log(`Summary JSON: ${opts.summary}`);
  for (const j of included.slice(0, 12)) console.log(`INCLUDED: ${j.title} — ${j.company} — ${j.location} — ${j.url}`);
  if (included.length > 12) console.log(`... ${included.length - 12} more included jobs in summary JSON`);

  // ── Exit code determination ───────────────────────────────────────
  const terminalStates = new Set([...RESTRICTION_STATES, 'failed']);
  const hasTerminal = queryStatuses.some((qs) => terminalStates.has(qs.status)) ||
    (detailStatus === PAGE_STATE.BLOCKED || detailStatus === PAGE_STATE.ACTIVE_CHALLENGE) ||
    sourceHalted;
  const persistFailed = perQueryPersistStats.some((s) => s.status === 'persist_failed');

  if (cancelled) {
    console.log('Run was cancelled. Exit code 3.');
    process.exitCode = 3;
  } else if (hasTerminal) {
    console.log('Terminal status: one or more sources ended in a blocking state. Exit code 2.');
    process.exitCode = 2;
  } else if (persistFailed) {
    console.log('One or more checkpoint persists failed (records may be incomplete). Exit code 2.');
    process.exitCode = 2;
  }
}

function writeCancelledSummary(opts, queries) {
  const summary = {
    generatedAt: new Date().toISOString(),
    parameters: {
      role: opts.role,
      location: opts.location,
      speaks: opts.speaks,
      excludeLanguages: opts.excludeLanguages,
      industry: opts.industry,
      similarRoles: opts.similarRoles,
      freshDays: opts.freshDays,
      queries,
      queryFamilies: queries.map((q) => ({ query: q, family: getQueryFamily(q) })),
    },
    terminalStatuses: {
      searchQueries: queries.map((q) => ({ query: q, family: getQueryFamily(q), status: 'cancelled', uniqueIds: 0, pagesFetched: 0 })),
      detailPages: { status: 'cancelled', total: 0, scraped: 0, failed: 0, circuitBroken: false },
    },
    queryStats: queries.map((q) => ({ query: q, family: getQueryFamily(q), uniqueIds: 0, pagesFetched: 0 })),
    totalUniqueJobIds: 0,
    scraped: 0,
    roleMatches: 0,
    included: 0,
    languageSkipped: 0,
    roleSkipped: 0,
    includedJobs: [],
    languageSkippedJobs: [],
    refresh: opts.refreshJobIds?.length ? {
      requested: opts.refreshJobIds.length,
      found: 0,
      refreshed: 0,
      missing: opts.refreshJobIds.length,
    } : undefined,
    cancelled: true,
  };
  writeFileSync(opts.summary, JSON.stringify(summary, null, 2));
}

export {
  buildQueries,
  bypassRefreshIds,
  mergeExplicitRefreshIds,
  classifyLinkedInRole,
  extractDescription,
  getQueryFamily,
  parseJobPayload,
  parseRefreshJobIds,
  toDbRecord,
};

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => {
    if (runCancelled) {
      // Cancellation-triggered failure — cleanup already ran, exit with cancel code.
      process.exit(3);
    }
    console.error(`Search failed: ${err.message}`);
    process.exit(1);
  });
}
