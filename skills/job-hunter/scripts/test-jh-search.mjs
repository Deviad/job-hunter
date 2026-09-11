#!/usr/bin/env node
/**
 * Unit tests for jh-search.mjs — the sanctioned single entry point for
 * LinkedIn/Indeed searches (remediation R2/R3/R4/R5).
 * Pure module surface — no CDP/browser/network. Exercises argument parsing,
 * per-country domain/location derivation through the user's search-config,
 * profile-derived defaults, checkpoint/profile pinning, and outcome
 * classification. Every profile is a synthetic fixture in a temp home.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const JH_SEARCH = path.join(SCRIPT_DIR, 'jh-search.mjs');

// ── Synthetic profile fixtures (no CV: a derived file without a CV is loadable) ──
const DERIVED = { schemaVersion: 1, extractorVersion: 'cv-v1', cvSha256: 'fixture-cv-sha', generatedAt: '2026-01-01T00:00:00Z', skills: [], certifications: [], languages: [], titles: { values: [] } };
function makeHome({ roles, speaks, cvSha256 = 'fixture-cv-sha', searchConfig = null } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'jh-search-test-'));
  if (roles) {
    writeFileSync(path.join(dir, 'personal-info-cache.json'), JSON.stringify({
      schemaVersion: 2,
      rolePreferences: { preferredPrimaryRoles: roles, adjacentRoles: { adjacentTechnicalLeadership: [], leadershipProgression: [] }, excludedTitleFamilies: [], queryExclusionTerms: [] },
      languages: Object.fromEntries((speaks || []).map((l) => [l, 'native'])),
    }));
    writeFileSync(path.join(dir, 'profile-derived.json'), JSON.stringify({ ...DERIVED, cvSha256 }));
  }
  if (searchConfig) writeFileSync(path.join(dir, 'search-config.json'), JSON.stringify(searchConfig));
  return dir;
}
const homes = [];
const track = (dir) => { homes.push(dir); return dir; };
process.on('exit', () => { for (const dir of homes) rmSync(dir, { recursive: true, force: true }); });

const HOME_ONE = track(makeHome({ roles: ['Platform Architect', 'Cloud Architect'], speaks: ['English', 'Spanish'], searchConfig: { schemaVersion: 1, countries: { ZZ: { location: 'Zedland', indeedDomain: 'https://zz.indeed.example' }, GB: { location: 'Britain' } }, knownLocations: [] } }));
const HOME_TWO = track(makeHome({ roles: ['Embedded Software Engineer'], speaks: ['Dutch', 'English'], cvSha256: 'other-cv-sha' }));
const HOME_EMPTY = track(makeHome());

process.env.JOBHUNTER_HOME = HOME_ONE;
const {
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
} = await import('./jh-search.mjs');
const { loadProfile, confirmProfile, ProfileError } = await import('./jh-profile.mjs');
const quiet = () => {};
const profileOne = loadProfile({ home: HOME_ONE, log: quiet });
const profileTwo = loadProfile({ home: HOME_TWO, log: quiet });
confirmProfile({ home: HOME_ONE, expectedProfileSha256: profileOne.provenance.profileSha256 });
confirmProfile({ home: HOME_TWO, expectedProfileSha256: profileTwo.provenance.profileSha256 });

// ── One source + one country enforced; country data comes from reference + search-config ──
{
  const opts = parseArgs(['--source', 'indeed', '--country', 'nl']);
  assert.equal(opts.source, 'indeed');
  assert.equal(opts.country, 'NL');
  assert.equal(opts.domain, 'https://nl.indeed.com', 'generic reference data supplies the Indeed domain');
  assert.equal(opts.location, 'Netherlands');
  assert.deepEqual(resolveCountryDefaults('NL'), { location: 'Netherlands', indeedDomain: 'https://nl.indeed.com', userConfigured: false });
  console.log('✓ parseArgs derives Indeed domain + location from country code via reference data');
}

{
  const opts = parseArgs(['--source', 'indeed', '--country', 'zz']);
  assert.equal(opts.domain, 'https://zz.indeed.example', 'search-config.json supplies unknown countries');
  assert.equal(opts.location, 'Zedland');
  assert.equal(resolveCountryDefaults('ZZ').userConfigured, true);
  assert.equal(parseArgs(['--source', 'linkedin', '--country', 'GB']).location, 'Britain', 'search-config.json overrides the generic location');
  assert.equal(resolveCountryDefaults('GB').indeedDomain, 'https://uk.indeed.com', 'partial user entries fall back to reference data per field');
  console.log('✓ search-config.json overrides and extends the generic country data');
}

{
  assert.throws(() => parseArgs(['--source', 'indeed', '--country', 'QQ']),
    /no known Indeed domain.*search-config\.json/, 'unknown country without --domain throws and points at search-config.json');
  const explicit = parseArgs(['--source', 'indeed', '--country', 'QQ', '--domain', 'https://qq.indeed.com']);
  assert.equal(explicit.domain, 'https://qq.indeed.com');
  assert.equal(explicit.location, 'QQ');
  console.log('✓ unknown country requires explicit --domain');
}

// ── parseArgs is pure: no profile values, no built-in personal defaults ──
{
  const opts = parseArgs(['--source', 'linkedin', '--country', 'IE']);
  assert.equal(opts.role, null, 'parseArgs leaves the role for the profile');
  assert.equal(opts.query, null);
  assert.equal(opts.speaks, null);
  assert.equal(needsProfile(opts), true);
  const explicit = parseArgs(['--source', 'linkedin', '--country', 'IE', '--role', 'Site Reliability Engineer', '--speaks', 'French, German']);
  assert.equal(explicit.role, 'Site Reliability Engineer');
  assert.deepEqual(explicit.speaks, ['French', 'German']);
  assert.equal(needsProfile(explicit), true, 'query still needs filling');
  const filled = resolveSearchDefaults(explicit, null);
  assert.equal(filled.query, 'Site Reliability Engineer', 'query defaults to the role without any profile');
  assert.equal(needsProfile(filled), false);
  console.log('✓ parseArgs is pure and explicit --role/--speaks need no profile');
}

// ── Profile fills whatever the CLI did not give; explicit flags always win ──
{
  const filled = resolveSearchDefaults(parseArgs(['--source', 'linkedin', '--country', 'IE']), profileOne);
  assert.equal(filled.role, 'Platform Architect');
  assert.equal(filled.query, 'Platform Architect');
  assert.deepEqual(filled.speaks, ['English', 'Spanish']);
  const args = buildLinkedInArgs(filled, '/tmp/out.json', '/tmp/summary.json');
  assert.equal(args[args.indexOf('--speaks') + 1], 'English,Spanish');
  assert.equal(args[args.indexOf('--role') + 1], 'Platform Architect');
  const mixed = resolveSearchDefaults(parseArgs(['--source', 'linkedin', '--country', 'IE', '--role', 'Data Engineer']), profileOne);
  assert.equal(mixed.role, 'Data Engineer', 'explicit role wins over the profile');
  assert.deepEqual(mixed.speaks, ['English', 'Spanish'], 'profile fills the missing languages');
  const indeed = resolveSearchDefaults(parseArgs(['--source', 'indeed', '--country', 'GB', '--query', 'SRE']), profileOne);
  assert.equal(indeed.query, 'SRE');
  assert.equal(indeed.role, 'Platform Architect');
  console.log('✓ profile supplies role/query/speaks defaults; explicit flags win');
}

// ── A different profile yields a different keyword set with no leftovers ──
{
  const filled = resolveSearchDefaults(parseArgs(['--source', 'linkedin', '--country', 'NL']), profileTwo);
  assert.equal(filled.role, 'Embedded Software Engineer');
  assert.deepEqual(filled.speaks, ['Dutch', 'English']);
  const args = buildLinkedInArgs(filled, '/tmp/out.json', '/tmp/summary.json').join(' ');
  assert.doesNotMatch(args, /\bai\b|architect/i, 'no AI-architect terms leak into a non-architect profile');
  assert.equal(args.includes('Dutch,English'), true);
  console.log('✓ second synthetic profile produces its own role and languages with zero AI-architect terms');
}

// ── Missing profile fails loudly when a default is needed ──
{
  assert.throws(() => loadProfile({ home: HOME_EMPTY, log: quiet }), (error) => error instanceof ProfileError && error.code === 'PROFILE_MISSING');
  assert.throws(() => resolveSearchDefaults(parseArgs(['--source', 'linkedin', '--country', 'IE']), null), (error) => error instanceof ProfileError && error.code === 'ROLES_MISSING');
  const env = { ...process.env, JOBHUNTER_HOME: HOME_EMPTY, JOBHUNTER_DB: path.join(HOME_EMPTY, 'nope.sqlite') };
  const run = spawnSync(process.execPath, [JH_SEARCH, '--source', 'indeed', '--country', 'GB', '--skip-preflight'], { env, encoding: 'utf8' });
  assert.equal(run.status, EXIT.USAGE, run.stderr);
  assert.match(run.stderr, /PROFILE_MISSING/);
  assert.doesNotMatch(run.stdout + run.stderr, /AI Architect/, 'no built-in personal fallback');
  console.log('✓ missing profile: loud ProfileError, usage exit, no built-in personal defaults');
}

// ── Checkpoints pin the profile CV hash; a resumed run refuses to mix keyword sets ──
{
  assert.deepEqual(profileStamp(profileOne), { cvSha256: 'fixture-cv-sha', profileSha256: profileOne.provenance.profileSha256, status: 'no-cv' });
  assert.deepEqual(profileStamp(null), { cvSha256: null, profileSha256: null, status: 'unavailable' });
  assert.equal(checkResumeProfile({ runId: 'r', profile: profileStamp(profileOne) }, profileOne), null);
  assert.match(checkResumeProfile({ runId: 'r', profile: profileStamp(profileOne) }, profileTwo), /keyword set may differ/);
  assert.match(checkResumeProfile({ runId: 'r', profile: { cvSha256: 'fixture-cv-sha' } }, null), /none/);
  const runsDir = path.join(HOME_TWO, 'runs', 'indeed-GB-pinned');
  mkdirSync(runsDir, { recursive: true });
  writeFileSync(path.join(runsDir, 'checkpoint.json'), JSON.stringify({ runId: 'indeed-GB-pinned', source: 'indeed', country: 'GB', status: 'budget-exhausted', profile: { cvSha256: 'fixture-cv-sha' } }));
  const env = { ...process.env, JOBHUNTER_HOME: HOME_TWO, JOBHUNTER_DB: path.join(HOME_TWO, 'nope.sqlite') };
  const run = spawnSync(process.execPath, [JH_SEARCH, '--source', 'indeed', '--country', 'GB', '--skip-preflight', '--resume', 'indeed-GB-pinned', '--json'], { env, encoding: 'utf8' });
  assert.equal(run.status, EXIT.USAGE, run.stderr);
  assert.match(run.stderr, /\[refused\].*checkpoint/);
  assert.equal(JSON.parse(run.stdout.trim()).ok, false);
  console.log('✓ --resume refuses a checkpoint recorded under a different profile CV hash');
}

// ── Query-batch cap: default 3, hard cap 5 ───────────────────────────
{
  assert.equal(parseArgs(['--source', 'indeed', '--country', 'GB']).maxQueries, 3, 'default max-queries is 3');
  assert.equal(parseArgs(['--source', 'indeed', '--country', 'GB', '--max-queries', '5']).maxQueries, 5);
  assert.equal(parseArgs(['--source', 'indeed', '--country', 'GB', '--max-queries', '9']).maxQueries, 5, 'hard cap at 5');
  assert.equal(parseArgs(['--source', 'indeed', '--country', 'GB', '--max-queries', '0']).maxQueries, 3, '0 is falsy, falls back to default 3');
  console.log('✓ --max-queries is bounded to [1,5], default 3');
}

// ── LinkedIn requires no --domain ─────────────────────────────────────
{
  const opts = parseArgs(['--source', 'linkedin', '--country', 'IE']);
  assert.equal(opts.domain, null);
  assert.equal(opts.location, 'Ireland');
  console.log('✓ LinkedIn invocation derives location without requiring a domain');
}

// ── LinkedIn refresh IDs are bounded and forwarded ───────────────────
{
  const opts = resolveSearchDefaults(parseArgs(['--source', 'linkedin', '--country', 'IE', '--refresh-job-ids', '9000001003,9000001004,9000001003']), profileOne);
  assert.deepEqual(opts.refreshJobIds, ['9000001003', '9000001004']);
  assert.deepEqual(parseRefreshJobIds(' 9000001003,9000001004 '), ['9000001003', '9000001004']);
  assert.throws(() => parseRefreshJobIds('9000001003,abc'), /invalid LinkedIn job ID/);
  assert.throws(() => parseRefreshJobIds(Array.from({ length: 51 }, (_, index) => String(index + 1)).join(',')), /max 50/);
  assert.throws(() => parseArgs(['--source', 'indeed', '--country', 'GB', '--refresh-job-ids', '9000001003']), /only for LinkedIn/);
  const args = buildLinkedInArgs(opts, '/tmp/out.json', '/tmp/summary.json');
  const refreshIndex = args.indexOf('--refresh-job-ids');
  assert.ok(refreshIndex >= 0);
  assert.equal(args[refreshIndex + 1], '9000001003,9000001004');
  console.log('✓ LinkedIn refresh IDs are validated, capped, deduplicated, and forwarded');
}

// ── runId is stable across --resume, fresh otherwise ─────────────────
{
  const resumed = parseArgs(['--source', 'linkedin', '--country', 'GB', '--resume', 'linkedin-GB-fixed-id']);
  assert.equal(runId(resumed), 'linkedin-GB-fixed-id', '--resume pins the run id');
  const fresh1 = runId(parseArgs(['--source', 'linkedin', '--country', 'GB']));
  assert.match(fresh1, /^linkedin-GB-\d{8}-\d{6}$/, 'fresh run id is source-country-timestamp');
  console.log('✓ runId: --resume pins id, fresh run derives a timestamped id');
}

// ── classifySearchOutcome: LinkedIn blocking states map to 'blocked' ──
{
  const opts = { source: 'linkedin' };
  const blockedSummary = {
    terminalStatuses: {
      searchQueries: [{ query: 'Platform Architect', status: 'active_challenge' }],
      detailPages: { status: 'healthy' },
    },
  };
  const outcome = classifySearchOutcome(opts, { status: 2 }, blockedSummary);
  assert.equal(outcome.verdict, 'blocked');
  assert.match(outcome.reason, /active_challenge/);
  console.log('✓ classifySearchOutcome: LinkedIn active_challenge -> blocked verdict');
}

{
  const opts = { source: 'linkedin' };
  const rateLimitedDetail = {
    terminalStatuses: {
      searchQueries: [{ query: 'Platform Architect', status: 'healthy' }],
      detailPages: { status: 'blocked' },
    },
  };
  const outcome = classifySearchOutcome(opts, { status: 2 }, rateLimitedDetail);
  assert.equal(outcome.verdict, 'blocked', 'detail-page block also counts as blocked');
  console.log('✓ classifySearchOutcome: LinkedIn detail-page block -> blocked verdict');
}

{
  const opts = { source: 'linkedin' };
  const cancelledOutcome = classifySearchOutcome(opts, { status: 3 }, { terminalStatuses: { searchQueries: [], detailPages: {} } });
  assert.equal(cancelledOutcome.verdict, 'cancelled');
  console.log('✓ classifySearchOutcome: exit 3 -> cancelled verdict');
}

// ── classifySearchOutcome: Indeed verification/CAPTCHA text -> blocked ──
{
  const opts = { source: 'indeed', domain: 'https://nl.indeed.com' };
  const spawnResult = { status: 1, stderr: '❌ Indeed verification/CAPTCHA page detected at https://nl.indeed.com/jobs; user intervention required.' };
  const outcome = classifySearchOutcome(opts, spawnResult, null);
  assert.equal(outcome.verdict, 'blocked');
  assert.match(outcome.reason, /verification\/CAPTCHA/);
  console.log('✓ classifySearchOutcome: Indeed CAPTCHA stderr -> blocked verdict, not retried');
}

// ── classifySearchOutcome: non-blocking failures stay 'fatal', never silently retried ──
{
  const opts = { source: 'indeed', domain: 'https://uk.indeed.com' };
  const outcome = classifySearchOutcome(opts, { status: 1, stderr: 'TypeError: cannot read property x' }, null);
  assert.equal(outcome.verdict, 'fatal');
  console.log('✓ classifySearchOutcome: ordinary script error -> fatal (not blocked, not auto-retried)');
}

// ── Exit code table matches the remediation plan contract ────────────
{
  assert.equal(EXIT.OK, 0);
  assert.equal(EXIT.USAGE, 1);
  assert.equal(EXIT.FATAL, 2);
  assert.equal(EXIT.BUDGET, 3);
  assert.equal(EXIT.BLOCKED, 4);
  assert.equal(EXIT.PREFLIGHT, 5);
  console.log('✓ EXIT codes match documented contract (0 ok / 1 usage / 2 fatal / 3 budget / 4 blocked / 5 preflight)');
}

console.log('\n── All jh-search.mjs tests passed ──\n');
