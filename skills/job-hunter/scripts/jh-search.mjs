#!/usr/bin/env node
// jh-search.mjs — sanctioned single entry point for LinkedIn/Indeed searches.
// Implements remediation R2 (preflight), R3 (bounded, checkpointed searches),
// R4 (hard-blocker abort, no retry), R5 (per-region Indeed domain preflight).
// See references/search-safety-contract.md.
//
// Exactly one country + one source per invocation. Any other shape (multi-country
// sweeps) must be an ordered series of separate invocations of this script.
//
// Exit codes:
//   0  ok
//   1  usage / argument error
//   2  fatal error inside the search script
//   3  budget exhausted (checkpoint written; safe to --resume)
//   4  hard blocker detected (security check / CAPTCHA / verification wall)
//   5  preflight failed (doctor or CDP/domain check)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync as spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { JOBHUNTER_HOME, DB_PATH as DEFAULT_DB_PATH } from './jh-common.mjs';
import { ROLE_TAXONOMY_VERSION } from './role-taxonomy.mjs';
import { readLinkedInAccess, pauseLinkedInAccess } from './linkedin-access.mjs';
import { loadProfile, resolveCountry, ProfileError } from './jh-profile.mjs';
import { RESTRICTION_STATES } from '../../linkedin-job-search/scripts/linkedin-page-state.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_ROOT = path.resolve(SCRIPT_DIR, '..', '..'); // ~/.pi/agent/skills
const DOCTOR_SCRIPT = path.join(SCRIPT_DIR, 'jh-doctor.mjs');
const CDP_PREFLIGHT_SCRIPT = path.join(SKILLS_ROOT, 'linkedin-job-search', 'scripts', 'cdp-preflight.mjs');
const LINKEDIN_SEARCH_SCRIPT = path.join(SKILLS_ROOT, 'linkedin-job-search', 'scripts', 'search-linkedin-jobs.mjs');
const INDEED_SEARCH_SCRIPT = path.join(SKILLS_ROOT, 'indeed-job-search', 'scripts', 'search-indeed-jobs.mjs');
const RUNS_DIR = path.join(JOBHUNTER_HOME, 'runs');

// Country → display location / Indeed domain. The user's search-config.json
// (under JOBHUNTER_HOME) overrides the generic reference data; nothing here is
// specific to any maintainer.
function resolveCountryDefaults(country) {
  const resolved = resolveCountry(country, JOBHUNTER_HOME);
  return { location: resolved.location, indeedDomain: resolved.indeedDomain, userConfigured: resolved.userConfigured };
}

const EXIT = { OK: 0, USAGE: 1, FATAL: 2, BUDGET: 3, BLOCKED: 4, PREFLIGHT: 5 };

function usage(code = 0) {
  const out = code === 0 ? process.stdout : process.stderr;
  out.write(`Usage:
  jh-search.mjs --source <linkedin|indeed> --country <GB|IE|NL|DK|...> [options]

Required:
  --source <linkedin|indeed>    exactly one source per invocation
  --country <code>              exactly one ISO country code per invocation

Options:
  --role <role>                 LinkedIn role query (default: first primary role in the profile)
  --query <text>                Indeed query text (default same as --role)
  --speaks <langs>              comma-separated languages you speak (default: profile languages)
  --location <text>             override the derived location string
  --domain <url>                override the derived Indeed domain
  --max-queries <n>             query-batch cap, default 3, hard cap 5
  --budget-minutes <n>          wall-clock budget per invocation, default 10
  --resume <run-id>             resume a checkpointed run instead of starting fresh
  --db <path>                   SQLite DB (default ${DEFAULT_DB_PATH})
  --cdp-port <n>                default 9225
  --refresh-job-ids <ids>       comma-separated numeric LinkedIn IDs to re-scrape (max 50)
  --skip-preflight               DANGEROUS: skip doctor + CDP/domain preflight
  --json                        machine-readable summary on stdout
  --help                        show this help

Defaults not given on the command line come from the profile under JOBHUNTER_HOME
(personal-info-cache.json + profile-derived.json extracted from CV.docx); country
locations and Indeed domains come from search-config.json, falling back to the
generic reference data. There are no built-in personal defaults.

Exit codes: 0 ok, 1 usage, 2 fatal, 3 budget-exhausted (resumable), 4 blocked, 5 preflight-failed
`);
  process.exit(code);
}

function parseArgs(argv) {
  const o = {
    source: null,
    country: null,
    role: null,
    query: null,
    speaks: null,
    location: null,
    domain: null,
    maxQueries: 3,
    budgetMinutes: 10,
    resume: null,
    db: process.env.JOBHUNTER_DB || DEFAULT_DB_PATH,
    cdpPort: 9225,
    skipPreflight: false,
    json: false,
    refreshJobIds: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} requires a value`);
      return argv[++i];
    };
    if (a === '--help' || a === '-h') usage(0);
    else if (a === '--source') o.source = next();
    else if (a === '--country') o.country = next().toUpperCase();
    else if (a === '--role') o.role = next();
    else if (a === '--speaks') o.speaks = splitList(next());
    else if (a === '--query') o.query = next();
    else if (a === '--location') o.location = next();
    else if (a === '--domain') o.domain = next();
    else if (a === '--max-queries') o.maxQueries = Math.max(1, Math.min(5, Number(next()) || 3));
    else if (a === '--budget-minutes') o.budgetMinutes = Math.max(1, Number(next()) || 10);
    else if (a === '--resume') o.resume = next();
    else if (a === '--db') o.db = next();
    else if (a === '--cdp-port') o.cdpPort = Number(next()) || 9225;
    else if (a === '--refresh-job-ids') o.refreshJobIds = parseRefreshJobIds(next());
    else if (a === '--skip-preflight') o.skipPreflight = true;
    else if (a === '--json') o.json = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!o.source || !['linkedin', 'indeed'].includes(o.source)) usage(1);
  if (!o.country) usage(1);
  if (o.source === 'indeed' && o.refreshJobIds.length) {
    throw new Error('--refresh-job-ids is supported only for LinkedIn');
  }
  const country = resolveCountryDefaults(o.country);
  if (!o.location) o.location = country.location;
  if (o.source === 'indeed' && !o.domain) {
    o.domain = country.indeedDomain;
    if (!o.domain) throw new Error(`no known Indeed domain for country ${o.country}; add it to ${path.join(JOBHUNTER_HOME, 'search-config.json')} (countries.${o.country}.indeedDomain) or pass --domain explicitly`);
  }
  return o;
}

function splitList(value) {
  return String(value || '').split(/[;,]/).map((s) => s.trim()).filter(Boolean);
}

// Explicit flags always win; anything else comes from the profile. Returns
// the filled options; throws when a needed value has no source.
function resolveSearchDefaults(opts, profile) {
  const o = { ...opts };
  if (!o.role) {
    o.role = profile?.roles?.primary?.[0] || null;
    if (!o.role) throw new ProfileError('ROLES_MISSING', 'No --role given and the profile has no primary role (rolePreferences.preferredPrimaryRoles in personal-info-cache.json)');
  }
  if (!o.query) o.query = o.role;
  if (!o.speaks?.length) o.speaks = profile?.speaks?.length ? [...profile.speaks] : [];
  if (o.source === 'linkedin' && !o.speaks.length) {
    throw new ProfileError('LANGUAGES_MISSING', 'Confirm languages and save them in personal-info-cache.json, or pass --speaks');
  }
  return o;
}

function needsProfile(opts) {
  return !opts.role || !opts.query || (opts.source === 'linkedin' && !opts.speaks?.length);
}

// Lazy profile load: only when a default is needed, or to stamp the
// checkpoint with the CV hash. A missing profile is fatal only when needed.
function loadSearchProfile({ required }) {
  try {
    return loadProfile({ home: JOBHUNTER_HOME, requireConfirmed: true });
  } catch (error) {
    if (!required && error instanceof ProfileError && error.code === 'PROFILE_MISSING') return null;
    throw error;
  }
}

function profileStamp(profile) {
  return profile ? { cvSha256: profile.provenance.cvSha256 || null, profileSha256: profile.provenance.profileSha256 || null, status: profile.provenance.status } : { cvSha256: null, profileSha256: null, status: 'unavailable' };
}

// A resumed run must not silently mix keyword sets from two different CVs.
export function requestStamp(opts) {
  const fields = ['source', 'country', 'role', 'query', 'location', 'domain', 'speaks', 'refreshJobIds', 'maxQueries'];
  return createHash('sha256').update(JSON.stringify(fields.map((key) => [key, opts[key] ?? null]))).digest('hex');
}

function checkResumeProfile(checkpoint, profile, opts) {
  if (opts && checkpoint.requestSha256 !== requestStamp(opts)) return 'checkpoint search options changed or are unstamped; start a fresh run';
  const recorded = checkpoint?.profile?.profileSha256 ?? null;
  const current = profileStamp(profile).profileSha256;
  if (recorded && recorded === current) return null;
  return `checkpoint ${checkpoint.runId} was recorded with profile hash ${recorded || 'none'} but the current profile hash is ${current || 'none'}; ` +
    'the keyword set may differ. Start a fresh run instead of resuming.';
}

function parseRefreshJobIds(value) {
  const ids = String(value || '').split(',').map((id) => id.trim()).filter(Boolean);
  const result = [...new Set(ids)];
  for (const id of result) {
    if (!/^\d+$/.test(id)) throw new Error(`invalid LinkedIn job ID: ${id}`);
  }
  if (result.length > 50) throw new Error(`too many refresh job IDs: ${result.length} (max 50)`);
  return result;
}

function buildLinkedInArgs(opts, outPath, summaryPath) {
  const args = [
    LINKEDIN_SEARCH_SCRIPT,
    '--role', opts.role,
    '--location', opts.location,
    ...(opts.speaks?.length ? ['--speaks', opts.speaks.join(',')] : []),
    '--db', opts.db,
    '--out', outPath,
    '--summary', summaryPath,
    '--obscura-port', String(opts.cdpPort),
  ];
  if (opts.refreshJobIds.length) args.push('--refresh-job-ids', opts.refreshJobIds.join(','));
  return args;
}

function runId(opts) {
  if (opts.resume) return opts.resume;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  return `${opts.source}-${opts.country}-${stamp}`;
}

function checkpointPath(id) {
  return path.join(RUNS_DIR, id, 'checkpoint.json');
}

function loadCheckpoint(id) {
  const p = checkpointPath(id);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

function saveCheckpoint(id, data) {
  const dir = path.join(RUNS_DIR, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(checkpointPath(id), JSON.stringify(data, null, 2));
}

function report(opts, msg) {
  if (!opts.json) console.log(msg);
}

// ── Gate 1: doctor ──────────────────────────────────────────────────
function runDoctor() {
  const res = spawn('node', [DOCTOR_SCRIPT], { encoding: 'utf8' });
  const out = (res.stdout || '') + (res.stderr || '');
  return { ok: res.status === 0, output: out, status: res.status };
}

// ── Gate 2: CDP + exact-domain preflight ───────────────────────────
function runCdpPreflight(opts) {
  const probeUrl = opts.source === 'linkedin'
    ? `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(opts.role)}&location=${encodeURIComponent(opts.location)}`
    : `${opts.domain}/jobs?q=${encodeURIComponent(opts.query)}&l=${encodeURIComponent(opts.location)}`;
  const args = [CDP_PREFLIGHT_SCRIPT, '--port', String(opts.cdpPort), '--db', opts.db, '--json', '--probe-url', probeUrl];
  const res = spawn('node', args, { encoding: 'utf8' });
  let parsed = null;
  try { parsed = JSON.parse((res.stdout || '').trim().split('\n').pop()); } catch {}
  return { ok: res.status === 0 && parsed?.ok === true, raw: res.stdout, parsed, status: res.status };
}

// ── Gate 4: hard-blocker detection from a search-script terminal report ──
// The wrapper does not re-implement page classification (that lives in
// linkedin-page-state.mjs / search-indeed-jobs.mjs isVerificationText); it
// interprets the exit code + summary the search script already produces.
function classifySearchOutcome(opts, spawnResult, summary) {
  if (opts.source === 'linkedin') {
    // search-linkedin-jobs.mjs: exit 3 = cancelled, exit 2 = terminal blocking state
    // or persist failure. Summary.terminalStatuses carries the page states.
    const states = summary?.terminalStatuses?.searchQueries?.map((q) => q.status) || [];
    const detailState = summary?.terminalStatuses?.detailPages?.status;
    const blocking = new Set(RESTRICTION_STATES);
    const state = [...states, detailState].find((s) => blocking.has(s));
    if (state) {
      return { verdict: 'blocked', state, reason: `LinkedIn page state: ${[...states, detailState].filter((s) => blocking.has(s)).join(', ')}` };
    }
    if (spawnResult.status === 0) return { verdict: 'ok' };
    if (spawnResult.status === 3) return { verdict: 'cancelled' };
    return { verdict: 'fatal', reason: `search-linkedin-jobs.mjs exited ${spawnResult.status}` };
  }
  if (spawnResult.status === 0) return { verdict: 'ok' };
  // indeed: script throws a plain Error and exits 1 on verification/CAPTCHA text
  const stderrTail = String(spawnResult.stderr || '').slice(-2000);
  if (/verification\/CAPTCHA page detected/i.test(stderrTail)) {
    return { verdict: 'blocked', reason: 'Indeed verification/CAPTCHA page detected' };
  }
  return { verdict: 'fatal', reason: `search-indeed-jobs.mjs exited ${spawnResult.status}: ${stderrTail.slice(-400)}` };
}

async function main() {
  let opts = parseArgs(process.argv.slice(2));
  if (opts.source === 'linkedin') {
    const access = readLinkedInAccess(opts.db);
    if (!access.ok || !access.allowed) {
      const code = access.ok ? 'SOURCE_PAUSED' : 'ACCESS_STATE_UNAVAILABLE';
      const reason = access.ok ? 'LinkedIn research is paused' : 'LinkedIn access state is unavailable';
      report(opts, `[blocked] ${reason}`);
      if (opts.json) console.log(JSON.stringify({ ok: false, blocked: true, code, reason }));
      process.exit(EXIT.BLOCKED);
    }
  }
  // Profile: explicit flags win; missing values come from the profile. The
  // loader logs to stderr when it rebuilds the derived profile from the CV.
  let profile;
  try {
    profile = loadSearchProfile({ required: needsProfile(opts) });
    opts = resolveSearchDefaults(opts, profile);
  } catch (error) {
    if (!(error instanceof ProfileError)) throw error;
    console.error(`${error.code}: ${error.message}`);
    process.exit(EXIT.USAGE);
  }
  if (profile?.provenance.refreshed) report(opts, `[profile] derived profile refreshed from ${path.basename(profile.provenance.cvPath)}`);
  const id = runId(opts);
  let checkpoint = opts.resume ? loadCheckpoint(id) : null;
  if (opts.resume && !checkpoint) {
    console.error(`--resume ${opts.resume} given but no checkpoint found at ${checkpointPath(id)}`);
    process.exit(EXIT.USAGE);
  }
  if (checkpoint) {
    const mismatch = checkResumeProfile(checkpoint, profile, opts);
    if (mismatch) {
      console.error(`[refused] ${mismatch}`);
      if (opts.json) console.log(JSON.stringify({ ok: false, runId: id, reason: mismatch }));
      process.exit(EXIT.USAGE);
    }
  }
  mkdirSync(path.join(RUNS_DIR, id), { recursive: true });
  const startedAt = Date.now();
  const budgetMs = opts.budgetMinutes * 60 * 1000;

  checkpoint ||= {
    runId: id, source: opts.source, country: opts.country, query: opts.query,
    role: opts.role, speaks: opts.speaks,
    location: opts.location, domain: opts.domain || null,
    profile: profileStamp(profile),
    requestSha256: requestStamp(opts),
    refreshJobIds: opts.source === 'linkedin' ? opts.refreshJobIds : [],
    startedAt: new Date().toISOString(), status: 'started', queriesCompleted: 0,
    jobsSaved: 0, blockers: [], preflight: {},
  };

  // ── Gate 1+2: doctor + exact source-URL preflight ─────────────────
  if (!opts.skipPreflight) {
    const doctor = runDoctor();
    checkpoint.preflight.doctor = { ok: doctor.ok, status: doctor.status };
    if (!doctor.ok) {
      checkpoint.status = 'preflight-failed';
      saveCheckpoint(id, checkpoint);
      report(opts, `[preflight-failed] jh-doctor.mjs reported FAIL:\n${doctor.output}`);
      process.exit(EXIT.PREFLIGHT);
    }
    const preflight = runCdpPreflight(opts);
    checkpoint.preflight.cdp = { ok: preflight.ok, status: preflight.status, pages: preflight.parsed?.pages };
    if (!preflight.ok) {
      const blocked = opts.source === 'linkedin' && (preflight.parsed?.paused === true || preflight.parsed?.admitted === false || Boolean(preflight.parsed?.accessError));
      checkpoint.status = blocked ? 'blocked' : 'preflight-failed';
      saveCheckpoint(id, checkpoint);
      report(opts, `[${checkpoint.status}] cdp-preflight.mjs against the exact ${opts.source} URL for ${opts.country} failed:\n${preflight.raw}`);
      if (opts.json) console.log(JSON.stringify({ ok: false, blocked, runId: id, reason: blocked ? 'LinkedIn access is blocked' : 'CDP preflight failed' }));
      process.exit(blocked ? EXIT.BLOCKED : EXIT.PREFLIGHT);
    }
    report(opts, `[preflight] doctor OK, CDP+URL preflight OK for ${opts.source}/${opts.country}`);
  } else {
    report(opts, `[preflight] SKIPPED (--skip-preflight)`);
  }

  // ── Gate 3: bounded single-source invocation with a wall-clock budget ──
  const outPath = path.join(RUNS_DIR, id, 'results.json');
  const summaryPath = path.join(RUNS_DIR, id, 'summary.json');
  let spawnResult;
  let summary = null;

  if (opts.source === 'linkedin') {
    const args = buildLinkedInArgs(opts, outPath, summaryPath);
    report(opts, `[search] node search-linkedin-jobs.mjs ${args.slice(1).join(' ')}`);
    spawnResult = spawn('node', args, { encoding: 'utf8', timeout: budgetMs, stdio: ['ignore', 'pipe', 'pipe'] });
    if (existsSync(summaryPath)) { try { summary = JSON.parse(readFileSync(summaryPath, 'utf8')); } catch {} }
  } else {
    const args = [
      INDEED_SEARCH_SCRIPT,
      '--query', opts.query,
      '--location', opts.location,
      '--domain', opts.domain,
      '--max-queries', String(opts.maxQueries),
      '--db', opts.db,
      '--out', outPath,
      '--save',
      '--cdp-port', String(opts.cdpPort),
    ];
    report(opts, `[search] node search-indeed-jobs.mjs ${args.slice(1).join(' ')}`);
    spawnResult = spawn('node', args, { encoding: 'utf8', timeout: budgetMs, stdio: ['ignore', 'pipe', 'pipe'] });
  }

  const elapsedMs = Date.now() - startedAt;
  const timedOut = spawnResult.signal === 'SIGTERM' && elapsedMs >= budgetMs - 1000;

  if (timedOut) {
    checkpoint.status = 'budget-exhausted';
    checkpoint.elapsedMs = elapsedMs;
    saveCheckpoint(id, checkpoint);
    report(opts, `[budget] ${opts.budgetMinutes}min budget exhausted for run ${id}. Resume with: node jh-search.mjs --source ${opts.source} --country ${opts.country} --resume ${id}`);
    process.exit(EXIT.BUDGET);
  }

  const outcome = classifySearchOutcome(opts, spawnResult, summary);

  if (outcome.verdict === 'ok') {
    checkpoint.status = 'ok';
    checkpoint.queriesCompleted += 1;
    checkpoint.summary = summary ? {
      generatedAt: summary.generatedAt,
      totalUniqueJobIds: summary.totalUniqueJobIds,
      included: summary.included,
      queryFamilies: summary.parameters?.queryFamilies || [],
      refresh: summary.refresh || null,
    } : undefined;
    saveCheckpoint(id, checkpoint);
    report(opts, `[ok] ${opts.source}/${opts.country} search completed. results=${outPath}${summaryPath ? ` summary=${summaryPath}` : ''}`);
    if (opts.json) console.log(JSON.stringify({ ok: true, runId: id, checkpoint }, null, 2));
    process.exit(EXIT.OK);
  }

  if (outcome.verdict === 'blocked') {
    if (opts.source === 'linkedin') {
      const pause = pauseLinkedInAccess(opts.db, { reason: `wrapper observed ${outcome.state} on linkedin search`, runId: id });
      if (!pause.ok) {
        report(opts, '[blocked] LinkedIn pause could not be persisted');
        if (opts.json) console.log(JSON.stringify({ ok: false, blocked: true, runId: id, pausePersisted: false, reason: 'LinkedIn pause could not be persisted' }));
        process.exit(EXIT.BLOCKED);
      }
    }
    checkpoint.status = 'blocked';
    checkpoint.blockers.push({ at: new Date().toISOString(), reason: outcome.reason });
    saveCheckpoint(id, checkpoint);
    report(opts, `[blocked] ${outcome.reason}\nStop — do not retry automatically. Await explicit operator review.`);
    if (opts.json) console.log(JSON.stringify({ ok: false, blocked: true, runId: id, reason: outcome.reason }, null, 2));
    process.exit(EXIT.BLOCKED);
  }

  if (outcome.verdict === 'cancelled') {
    checkpoint.status = 'cancelled';
    saveCheckpoint(id, checkpoint);
    report(opts, `[cancelled] run ${id} was cancelled.`);
    process.exit(EXIT.FATAL);
  }

  checkpoint.status = 'fatal';
  checkpoint.lastError = outcome.reason;
  saveCheckpoint(id, checkpoint);
  report(opts, `[fatal] ${outcome.reason}\nstderr tail: ${String(spawnResult.stderr || '').slice(-1000)}`);
  process.exit(EXIT.FATAL);
}

export {
  parseArgs,
  parseRefreshJobIds,
  buildLinkedInArgs,
  runId,
  classifySearchOutcome,
  resolveCountryDefaults,
  resolveSearchDefaults,
  needsProfile,
  checkResumeProfile,
  profileStamp,
  EXIT,
};

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(`[fatal] ${err.stack || err}`);
    process.exit(EXIT.FATAL);
  });
}
