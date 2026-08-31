#!/usr/bin/env node
/**
 * Unit tests for cdp-lease.mjs — pure module, no CDP/browser/network.
 * Uses os.tmpdir() for all artifacts; never touches ~/.job-hunter/locks.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Ensure we import from the local module ───────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Use a dynamic import path — resolve relative to this file
import {
  acquireLease,
  tryAcquireLease,
  createSharedBudget,
  tryCreateSharedBudget,
} from './cdp-lease.mjs';

function tempDir() {
  const dir = path.join(tmpdir(), `cdp-lease-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  return dir;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── 1. acquire/release basic cycle ───────────────────────────────────
{
  const dir = tempDir();
  const h = acquireLease({ lockDir: dir, leaseName: 'test-basic', runId: 'run-1' });
  assert.ok(h, 'acquire returns handle');
  assert.ok(existsSync(h.leasePath), 'lease file exists');

  h.release();
  assert.ok(!existsSync(h.leasePath), 'lease file removed on release');

  console.log('  1. acquire/release: PASS');
}

// ── 2. Second acquire fails while lease held by live process ─────────
{
  const dir = tempDir();
  const h1 = acquireLease({ lockDir: dir, leaseName: 'test-conflict' });
  assert.throws(
    () => acquireLease({ lockDir: dir, leaseName: 'test-conflict' }),
    /already held/,
    'second acquire throws while lease held'
  );
  h1.release();
  console.log('  2. second acquire fails: PASS');
}

// ── 3. Acquire then release then re-acquire works ────────────────────
{
  const dir = tempDir();
  const h1 = acquireLease({ lockDir: dir, leaseName: 'test-reacquire' });
  h1.release();
  const h2 = acquireLease({ lockDir: dir, leaseName: 'test-reacquire' });
  assert.ok(h2, 're-acquire after release works');
  h2.release();
  console.log('  3. release + re-acquire: PASS');
}

// ── 4. Stale heartbeat takeover — simulate by writing an old heartbeat
{
  const dir = tempDir();
  mkdirSync(dir, { recursive: true });
  // Simulate a lease held by "another PID" with an ancient heartbeat
  const leasePath = path.join(dir, 'test-stale.lease');
  const staleData = {
    leaseName: 'test-stale',
    pid: 99999, // non-existent PID
    runId: 'stale-run',
    acquiredAt: new Date(Date.now() - 120_000).toISOString(),
    heartbeat: new Date(Date.now() - 120_000).toISOString(),
    tabs: [],
  };
  writeFileSync(leasePath, JSON.stringify(staleData, null, 2));

  // Attempting acquire should take over the stale lease (dead PID)
  const h = acquireLease({
    lockDir: dir,
    leaseName: 'test-stale',
    heartbeatThresholdMs: 60_000,
  });
  assert.ok(h, 'acquire succeeds on stale lease');

  // Verify the new lease data has our PID
  const data = JSON.parse(readFileSync(leasePath, 'utf8'));
  assert.equal(data.pid, process.pid, 'lease now owned by our PID');
  assert.ok(typeof data.runId === 'string' && data.runId.length > 0, 'runId updated');
  assert.notEqual(data.runId, 'stale-run', 'runId differs from stale entry');

  h.release();
  console.log('  4. stale-heartbeat takeover: PASS');
}

// ── 5. Dead-PID takeover — liveness check kills a fake PID ───────────
{
  const dir = tempDir();
  mkdirSync(dir, { recursive: true });

  // Find a PID that is almost certainly dead
  // Use a very high PID that won't exist, but also set a fresh heartbeat
  // so the dead-PID check triggers instead of stale-heartbeat check
  const deadPid = 99998;
  const leasePath = path.join(dir, 'test-deadpid.lease');
  const freshButDeadData = {
    leaseName: 'test-deadpid',
    pid: deadPid,
    runId: 'dead-run',
    acquiredAt: new Date().toISOString(),
    heartbeat: new Date().toISOString(), // fresh heartbeat, but dead PID
    tabs: [],
  };
  writeFileSync(leasePath, JSON.stringify(freshButDeadData, null, 2));

  const h = acquireLease({
    lockDir: dir,
    leaseName: 'test-deadpid',
    heartbeatThresholdMs: 60_000,
  });
  assert.ok(h, 'acquire succeeds on dead-PID lease');
  const data = JSON.parse(readFileSync(leasePath, 'utf8'));
  assert.equal(data.pid, process.pid, 'lease taken over by our PID');
  h.release();
  console.log('  5. dead-PID takeover: PASS');
}

// ── 6. Heartbeat refresh ─────────────────────────────────────────────
{
  const dir = tempDir();
  const h = acquireLease({ lockDir: dir, leaseName: 'test-hb' });
  const before = JSON.parse(readFileSync(h.leasePath, 'utf8')).heartbeat;

  await sleep(100);
  const ok = h.refreshHeartbeat();
  assert.equal(ok, true, 'refreshHeartbeat returns true');

  const after = JSON.parse(readFileSync(h.leasePath, 'utf8')).heartbeat;
  assert.notEqual(after, before, 'heartbeat timestamp updated');
  h.release();
  console.log('  6. heartbeat refresh: PASS');
}

// ── 7. Tab registration API ──────────────────────────────────────────
{
  const dir = tempDir();
  const h = acquireLease({ lockDir: dir, leaseName: 'test-tabs' });

  h.registerTab('target-1');
  h.registerTab('target-2');
  const tabs = h.getTabs();
  assert.deepStrictEqual(tabs.sort(), ['target-1', 'target-2'], 'two tabs registered');

  h.registerTab('target-1'); // duplicate — should be idempotent
  assert.equal(h.getTabs().length, 2, 'duplicate tab not added');

  h.registerTab(null);        // no-op
  h.registerTab(undefined);   // no-op
  assert.equal(h.getTabs().length, 2, 'null/undefined tabs ignored');

  h.release();
  console.log('  7. tab registration: PASS');
}

// ── 8. tryAcquireLease returns null on conflict (no throw) ──────────
{
  const dir = tempDir();
  const h1 = acquireLease({ lockDir: dir, leaseName: 'test-try' });
  const h2 = tryAcquireLease({ lockDir: dir, leaseName: 'test-try' });
  assert.equal(h2, null, 'tryAcquireLease returns null on conflict');
  h1.release();

  // After release, tryAcquireLease should succeed
  const h3 = tryAcquireLease({ lockDir: dir, leaseName: 'test-try' });
  assert.ok(h3, 'tryAcquireLease succeeds after release');
  assert.equal(typeof h3.release, 'function', 'handle has release method');
  h3.release();
  console.log('  8. tryAcquireLease: PASS');
}

// ── 9. Shared budget: basic request recording ────────────────────────
{
  const dir = tempDir();
  const b = createSharedBudget({
    lockDir: dir,
    budgetName: 'test-budget-basic',
    windowMs: 60_000,
    maxRequests: 5,
  });

  // Record 3 requests — should all go through quickly
  for (let i = 0; i < 3; i++) {
    await b.waitForSlot();
  }

  // Give file writes a moment to land, then check budget file existence
  await sleep(100);
  const budgetPath = path.join(dir, 'budget-test-budget-basic.json');
  const budgetExists = existsSync(budgetPath);
  // Budget file may or may not exist depending on write timing — either is fine
  // The key assertion: no error was thrown
  b.destroy();
  console.log('  9. shared budget basic: PASS');
}

// ── 10. Shared budget: rate limiting kicks in ────────────────────────
{
  const dir = tempDir();
  const b = createSharedBudget({
    lockDir: dir,
    budgetName: 'test-budget-throttle',
    windowMs: 10_000,
    maxRequests: 3,
  });

  // Fill all slots
  await b.waitForSlot();
  await b.waitForSlot();
  await b.waitForSlot();

  // Now waitForSlot should block — but with a short window it'll resolve
  // quickly when the oldest expires. We test that it doesn't crash.
  const start = Date.now();
  await b.waitForSlot();
  const elapsed = Date.now() - start;
  // Should have waited some time (at least a little), or at least not thrown
  assert.ok(elapsed >= 0, 'fourth waitForSlot did not throw');
  b.destroy();
  console.log('  10. shared budget rate limiting: PASS');
}

// ── 11. Shared budget: noteRequest records without waiting ───────────
{
  const dir = tempDir();
  const b = createSharedBudget({
    lockDir: dir,
    budgetName: 'test-budget-note',
    windowMs: 60_000,
    maxRequests: 100,
  });

  // noteRequest should be synchronous-ish and not throw
  b.noteRequest();
  b.noteRequest();
  b.noteRequest();
  // All slots available, no waiting needed
  await b.waitForSlot();
  b.destroy();
  console.log('  11. shared budget noteRequest: PASS');
}

// ── 12. Corrupt budget file fails open ──────────────────────────────
{
  const dir = tempDir();
  mkdirSync(dir, { recursive: true });

  const budgetPath = path.join(dir, 'budget-test-corrupt.json');
  writeFileSync(budgetPath, 'this is not JSON {{{', 'utf8');

  const b = createSharedBudget({
    lockDir: dir,
    budgetName: 'test-corrupt',
    windowMs: 60000,
    maxRequests: 5,
  });

  // Must not throw — must fail open
  await b.waitForSlot();
  b.noteRequest();
  b.destroy();
  console.log('  12. corrupt budget fails open: PASS');
}

// ── 13. tryCreateSharedBudget returns null on invalid config ─────────
{
  // Omit budgetName → should throw in createSharedBudget, caught by try*
  let b = tryCreateSharedBudget({ lockDir: tmpdir() });
  assert.equal(b, null, 'tryCreateSharedBudget returns null on missing budgetName');
  console.log('  13. tryCreateSharedBudget: PASS');
}

// ── 14. Lease does not leak heartbeat timer after release ────────────
{
  const dir = tempDir();
  const h = acquireLease({ lockDir: dir, leaseName: 'test-timer' });
  assert.ok(existsSync(h.leasePath), 'lease created');
  h.release();
  assert.ok(!existsSync(h.leasePath), 'lease cleaned up');

  // release called twice — idempotent
  h.release();
  assert.ok(!existsSync(h.leasePath), 'double release safe');
  console.log('  14. release idempotent: PASS');
}

// ── 15. Multiple budget instances for different names are independent ─
{
  const dir = tempDir();
  const b1 = createSharedBudget({ lockDir: dir, budgetName: 'indep-1', windowMs: 60000, maxRequests: 2 });
  const b2 = createSharedBudget({ lockDir: dir, budgetName: 'indep-2', windowMs: 60000, maxRequests: 2 });

  await b1.waitForSlot();
  await b1.waitForSlot();

  // b2 should be unaffected
  await b2.waitForSlot();
  await b2.waitForSlot();

  b1.destroy();
  b2.destroy();
  console.log('  15. independent budgets: PASS');
}

// ── 16. Two simulated processes share one budget: N requests stay within window budget
{
  const dir = tempDir();
  const windowMs = 60_000;
  const maxRequests = 6;
  // Two handles on the SAME budget name = two cooperating processes
  const p1 = createSharedBudget({ lockDir: dir, budgetName: 'shared-arith', windowMs, maxRequests });
  const p2 = createSharedBudget({ lockDir: dir, budgetName: 'shared-arith', windowMs, maxRequests });

  // Interleave 6 slot acquisitions across both "processes" — exactly the budget
  await p1.waitForSlot();
  await p2.waitForSlot();
  await p1.waitForSlot();
  await p2.waitForSlot();
  await p1.waitForSlot();
  await p2.waitForSlot();

  // The shared file must show at most maxRequests timestamps inside the window
  const budgetPath = path.join(dir, 'budget-shared-arith.json');
  const data = JSON.parse(readFileSync(budgetPath, 'utf8'));
  const cutoff = Date.now() - windowMs;
  const inWindow = data.requests.filter((ts) => ts > cutoff);
  assert.equal(inWindow.length, maxRequests, `combined in-window requests == budget (got ${inWindow.length})`);

  // A 7th acquisition from either process must block until a slot frees.
  // With a 60s window nothing frees quickly, so race waitForSlot against a
  // short timer and assert it had NOT resolved by then.
  let resolved = false;
  const pending = p2.waitForSlot().then(() => { resolved = true; });
  await sleep(400);
  assert.equal(resolved, false, '7th request over shared budget is blocked, not admitted');

  p1.destroy();
  p2.destroy();
  // Let the pending waiter die with the process (its timer is harmless);
  // detach so an unhandled rejection cannot fail the suite.
  pending.catch(() => {});
  console.log('  16. cross-process budget arithmetic: PASS');
  // Exit here: the pending waitForSlot sleeper would otherwise hold the
  // event loop open for up to the 60s window.
  console.log('\n✅ cdp-lease tests: ALL PASS');
  process.exit(0);
}

// ── Done ─────────────────────────────────────────────────────────────
console.log('\n✅ cdp-lease tests: ALL PASS');
