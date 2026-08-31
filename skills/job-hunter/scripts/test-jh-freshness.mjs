#!/usr/bin/env node
/**
 * Unit tests for the jh-freshness.mjs posting-age filter.
 * Rows older than 30 days are excluded by default. Fixtures are synthetic
 * absolute-date, relative-date, and missing-signal cases.
 */
import assert from 'node:assert/strict';
import { resolvePostingAge, classifyFreshness, filterByFreshness } from './jh-freshness.mjs';

const NOW = new Date('2026-07-21T12:00:00Z');

// ── ISO posting_date: straightforward age math ────────────────────────
{
  // Synthetic stale posting — posted 2026-03-02, about 141 days old
  const resolved = resolvePostingAge('2026-03-02T13:01:27.407Z', '2026-06-07 15:26:36', NOW);
  assert.equal(resolved.hasRealSignal, true);
  assert.equal(resolved.method, 'posting_date_iso');
  assert.ok(resolved.ageDays > 140 && resolved.ageDays < 142, `expected ~141 days, got ${resolved.ageDays}`);
  console.log('✓ ISO posting_date resolves a synthetic stale age (~141d)');
}

// ── Relative text anchored to created_at (scrape time) ────────────────
{
  // LinkedIn "Reposted 4 days ago" scraped 2026-07-20 -> posted ~2026-07-16
  const resolved = resolvePostingAge('London, England, United Kingdom · Reposted 4 days ago · 47 people clicked apply', '2026-07-20 07:47:58', NOW);
  assert.equal(resolved.hasRealSignal, true);
  assert.equal(resolved.method, 'relative_day');
  assert.ok(resolved.ageDays >= 4 && resolved.ageDays <= 6, `expected ~5 days, got ${resolved.ageDays}`);
  console.log('✓ relative "Reposted N days ago" text anchors to created_at correctly');
}

{
  const resolved = resolvePostingAge('European Economic Area · Reposted 38 minutes ago · Over 100 people clicked apply', '2026-07-20 08:09:57', NOW);
  assert.equal(resolved.hasRealSignal, true);
  assert.equal(resolved.method, 'relative_minute');
  console.log('✓ relative minutes-ago text parses');
}

{
  const resolved = resolvePostingAge('Posted yesterday', '2026-07-02 05:25:02', NOW);
  assert.equal(resolved.hasRealSignal, true);
  assert.equal(resolved.method, 'yesterday');
  console.log('✓ "Posted yesterday" resolves via the yesterday branch');
}

// ── No real signal at all: created_at is a lower bound, never asserted as fact ──
{
  // Synthetic no-signal job — job_posting_date null, discovered 71 days ago
  const resolved = resolvePostingAge(null, '2026-05-11 20:06:45', NOW);
  assert.equal(resolved.hasRealSignal, false);
  assert.equal(resolved.ageDays, null, 'no fabricated ageDays when there is no real signal');
  assert.ok(resolved.createdAgeDays > 69 && resolved.createdAgeDays < 72);
  console.log('✓ no-signal case returns ageDays=null (never fabricates a posting date), exposes createdAgeDays as a lower bound only');
}

// ── classifyFreshness: real signal beyond cutoff -> stale ─────────────
{
  const row = { job_posting_date: '2026-03-02T13:01:27.407Z', created_at: '2026-06-07 15:26:36' };
  const c = classifyFreshness(row, 30, NOW);
  assert.equal(c.verdict, 'stale');
  console.log('✓ classifyFreshness: 141-day-old real posting date -> stale');
}

// ── classifyFreshness: real signal within cutoff -> fresh ─────────────
{
  const row = { job_posting_date: '2026-07-07T13:36:45.14Z', created_at: '2026-07-07 21:01:46' };
  const c = classifyFreshness(row, 30, NOW);
  assert.equal(c.verdict, 'fresh');
  console.log('✓ classifyFreshness: 14-day-old real posting date -> fresh');
}

// ── classifyFreshness: no signal, but discovery date alone exceeds cutoff -> stale ──
{
  // Example Company "AI Agents Solutions Architect" — no posting_date, discovered 52 days ago
  const row = { job_posting_date: null, created_at: '2026-05-30 23:04:50' };
  const c = classifyFreshness(row, 30, NOW);
  assert.equal(c.verdict, 'stale', 'discovery date alone is a lower bound; if it already exceeds cutoff, job cannot be fresher');
  assert.equal(c.method, 'no_signal_but_discovery_exceeds_cutoff');
  console.log('✓ classifyFreshness: no signal + discovery date alone > cutoff -> certainly stale (lower-bound logic)');
}

// ── classifyFreshness: no signal, discovery date within cutoff -> unverified (kept, flagged) ──
{
  // "AI Systems Architect (Dutch & English)" — no posting_date, discovered 6 days ago
  const row = { job_posting_date: null, created_at: '2026-07-15 23:44:28' };
  const c = classifyFreshness(row, 30, NOW);
  assert.equal(c.verdict, 'unverified', 'no signal but not provably stale -> unverified, not silently fresh');
  console.log('✓ classifyFreshness: no signal but discovery date within cutoff -> unverified (not asserted fresh)');
}

// ── filterByFreshness: buckets a mixed batch correctly, default cutoff 30d ──
{
  const jobs = [
    { title: 'Synthetic stale role (real signal)', job_posting_date: '2026-03-02T13:01:27.407Z', created_at: '2026-06-07 15:26:36' },
    { title: 'Synthetic fresh role', job_posting_date: '2026-07-07T13:36:45.14Z', created_at: '2026-07-07 21:01:46' },
    { title: 'Example Company (no signal, certainly stale by discovery date)', job_posting_date: null, created_at: '2026-05-30 23:04:50' },
    { title: 'AI Systems Architect (no signal, unverified)', job_posting_date: null, created_at: '2026-07-15 23:44:28' },
  ];
  const { fresh, stale, unverified } = filterByFreshness(jobs, { now: NOW });
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].title, 'Synthetic fresh role');
  assert.equal(stale.length, 2, 'both the real-signal-stale and no-signal-certainly-stale jobs land in stale');
  assert.equal(unverified.length, 1);
  assert.equal(unverified[0].title, 'AI Systems Architect (no signal, unverified)');
  console.log('✓ filterByFreshness buckets a mixed batch into fresh/stale/unverified correctly');
}

// ── Custom cutoff is respected (not hardcoded to 30) ──────────────────
{
  const row = { job_posting_date: '2026-06-23T21:19:08.538Z', created_at: '2026-07-21 05:36:17' }; // ~27-28 days old
  const c30 = classifyFreshness(row, 30, NOW);
  const c14 = classifyFreshness(row, 14, NOW);
  assert.equal(c30.verdict, 'fresh', '27-28 days old passes a 30-day cutoff');
  assert.equal(c14.verdict, 'stale', '27-28 days old fails a stricter 14-day cutoff');
  console.log('✓ cutoffDays is a real parameter, not hardcoded — same job classifies differently at 30d vs 14d');
}

console.log('\n── All jh-freshness.mjs tests passed ──\n');
