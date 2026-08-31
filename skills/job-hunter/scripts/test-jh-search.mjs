#!/usr/bin/env node
/**
 * Unit tests for jh-search.mjs — the sanctioned single entry point for
 * LinkedIn/Indeed searches (remediation R2/R3/R4/R5).
 * Pure module surface — no CDP/browser/network. Exercises argument parsing,
 * per-country domain/location derivation, and outcome classification.
 */
import assert from 'node:assert/strict';
import {
  parseArgs,
  parseRefreshJobIds,
  buildLinkedInArgs,
  runId,
  classifySearchOutcome,
  INDEED_DOMAIN_BY_COUNTRY,
  LOCATION_BY_COUNTRY,
  EXIT,
} from './jh-search.mjs';

// ── One source + one country enforced ──────────────────────────────
{
  const opts = parseArgs(['--source', 'indeed', '--country', 'nl']);
  assert.equal(opts.source, 'indeed');
  assert.equal(opts.country, 'NL');
  assert.equal(opts.domain, INDEED_DOMAIN_BY_COUNTRY.get('NL'));
  assert.equal(opts.location, LOCATION_BY_COUNTRY.get('NL'));
  console.log('✓ parseArgs derives Indeed domain + location from country code');
}

{
  assert.throws(() => parseArgs(['--source', 'indeed', '--country', 'ZZ']),
    /no known Indeed domain/, 'unknown country without --domain throws');
  const explicit = parseArgs(['--source', 'indeed', '--country', 'ZZ', '--domain', 'https://zz.indeed.com']);
  assert.equal(explicit.domain, 'https://zz.indeed.com');
  console.log('✓ unknown country requires explicit --domain');
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
  const opts = parseArgs(['--source', 'linkedin', '--country', 'IE', '--refresh-job-ids', '9000001003,9000001004,9000001003']);
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
      searchQueries: [{ query: 'AI Architect', status: 'active_challenge' }],
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
      searchQueries: [{ query: 'AI Architect', status: 'healthy' }],
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
