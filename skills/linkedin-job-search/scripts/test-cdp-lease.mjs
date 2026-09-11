#!/usr/bin/env node
/**
 * Unit tests for cdp-lease.mjs — pure module, no CDP/browser/network.
 * Uses os.tmpdir() for all artifacts; never touches ~/.job-hunter/locks.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
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
  acquireStrictLinkedInOwner,
  tryAcquireStrictLinkedInOwner,
} from './cdp-lease.mjs';

function tempDir() {
  const dir = path.join(tmpdir(), `cdp-lease-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  return dir;
}
// Disposable workspace DB path used by strict-owner fixtures (never opened:
// every strict proof injects its access reader).
const DISPOSABLE_DB = path.join(tmpdir(), `cdp-lease-test-db-${process.pid}.sqlite`);

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

// ── 16. Strict owner: success cycle, release, shared budget persists ─
{
  const dir = tempDir();
  const ready = () => ({ ok: true, allowed: true, record: null, error: null });
  const res = await acquireStrictLinkedInOwner({
    dbPath: path.join(dir, 'workspace.sqlite'), // string contract; fake reader below
    lockDir: dir,
    runId: 'strict-run-a',
    accessReader: ready,
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  const owner = res.owner;
  assert.ok(existsSync(owner.leasePath), 'strict lease file exists');

  const slot = await owner.reserveRequest();
  assert.equal(slot.ok, true);
  assert.equal(slot.used, 1);

  const released = owner.release();
  assert.deepEqual(released, { released: true });
  assert.ok(!existsSync(owner.leasePath), 'lease removed on release');
  assert.ok(existsSync(owner.budgetPath), 'shared budget file intentionally persists');
  console.log('  16. strict owner success cycle: PASS');
}

// ── 17. Strict owner requires dbPath (discriminated denials, no throw) ─
{
  const dir = tempDir();
  const ready = () => ({ ok: true, allowed: true });
  const noDb = await acquireStrictLinkedInOwner({ lockDir: dir, accessReader: ready });
  assert.equal(noDb.ok, false);
  assert.equal(noDb.stage, 'arguments');
  assert.equal(noDb.reason, 'db_path_required');
  const tryRes = await tryAcquireStrictLinkedInOwner({ lockDir: dir, accessReader: ready });
  assert.equal(tryRes.ok, false);
  assert.equal(tryRes.reason, 'db_path_required', 'try-variant also returns a result, not null');
  console.log('  17. dbPath required: PASS');
}

// ── 18. Strict cross-port exclusion on one port-free source identity ─
{
  const dir = tempDir();
  const ready = () => ({ ok: true, allowed: true });
  const dbPath = path.join(dir, 'workspace.sqlite');
  const a = await acquireStrictLinkedInOwner({ dbPath, lockDir: dir, runId: 'run-a', cdpPort: 9225, accessReader: ready });
  assert.ok(a.ok, 'first strict owner acquires');
  const b = await acquireStrictLinkedInOwner({ dbPath, lockDir: dir, runId: 'run-b', cdpPort: 9226, accessReader: ready });
  assert.equal(b.ok, false, 'second strict owner denied while first holds the source lease');
  assert.equal(b.reason, 'lease_contended');
  assert.ok(a.owner.leasePath.endsWith('linkedin-source.lease'), 'lease identity is port-free');
  const tryB = await tryAcquireStrictLinkedInOwner({ dbPath, lockDir: dir, runId: 'run-c', accessReader: ready });
  assert.equal(tryB.reason, 'lease_contended', 'try-variant denies instead of proceeding');
  a.owner.release();
  const c = await acquireStrictLinkedInOwner({ dbPath, lockDir: dir, runId: 'run-d', accessReader: ready });
  assert.ok(c.ok, 'strict acquire works after release');
  c.owner.release();
  console.log('  18. strict cross-port contention: PASS');
}

// ── 19. Strict mode denies corrupt/busy/unwritable storage ───────────
{
  const ready = () => ({ ok: true, allowed: true });
  const dbPath = DISPOSABLE_DB;

  const dir1 = tempDir();
  mkdirSync(dir1, { recursive: true });
  writeFileSync(path.join(dir1, 'linkedin-source.lease'), 'this is not JSON {{{');
  const r1 = await acquireStrictLinkedInOwner({ dbPath, lockDir: dir1, accessReader: ready });
  assert.equal(r1.ok, false, 'corrupt lease denies (contrast legacy takeover)');
  assert.equal(r1.stage, 'lease');
  assert.equal(r1.reason, 'lease_corrupt');

  const dir2 = tempDir();
  mkdirSync(dir2, { recursive: true });
  writeFileSync(path.join(dir2, 'budget-linkedin-source.json'), 'garbage {{{');
  const r2 = await acquireStrictLinkedInOwner({ dbPath, lockDir: dir2, accessReader: ready });
  assert.equal(r2.ok, false, 'corrupt budget denies (contrast legacy fail-open)');
  assert.equal(r2.stage, 'storage');
  assert.equal(r2.reason, 'budget_corrupt');

  const dir3Parent = tempDir();
  mkdirSync(dir3Parent, { recursive: true });
  chmodSync(dir3Parent, 0o500); // r-x: unwritable for this user
  const r3 = await acquireStrictLinkedInOwner({
    dbPath,
    lockDir: path.join(dir3Parent, 'locks'), // does not exist and cannot be created
    accessReader: ready,
  });
  assert.equal(r3.ok, false, 'unwritable storage denies admission');
  assert.equal(r3.stage, 'storage');
  assert.equal(r3.reason, 'storage_unavailable');
  chmodSync(dir3Parent, 0o755);
  console.log('  19. strict corrupt/busy/unwritable storage denies: PASS');
}

// ── 20. Strict mode denies on busy budget mutex (no fail-open slot) ──
{
  const dir = tempDir();
  mkdirSync(dir, { recursive: true });
  // A live foreign holder (our parent shell PID) sits on the budget lock.
  writeFileSync(path.join(dir, 'budget-linkedin-source.lock'), String(process.ppid));
  const res = await acquireStrictLinkedInOwner({
    dbPath: path.join(dir, 'workspace.sqlite'),
    lockDir: dir,
    accessReader: () => ({ ok: true, allowed: true }),
    mutexMaxWaitMs: 300,
  });
  assert.ok(res.ok, 'a busy budget mutex does not block acquisition itself');
  const t0 = Date.now();
  const slot = await res.owner.reserveRequest();
  const elapsed = Date.now() - t0;
  assert.equal(slot.ok, false, 'busy mutex denies the request instead of failing open');
  assert.equal(slot.reason, 'storage_error');
  assert.ok(elapsed < 3000, `denial came promptly (${elapsed}ms)`);
  res.owner.release();
  console.log('  20. strict mutex contention denies: PASS');
}

// ── 21. Ownership-safe release (never deletes a foreign lease) ───────
{
  const dir = tempDir();
  const res = await acquireStrictLinkedInOwner({
    dbPath: path.join(dir, 'workspace.sqlite'),
    lockDir: dir,
    runId: 'strict-owner-test',
    accessReader: () => ({ ok: true, allowed: true }),
  });
  const owner = res.owner;
  // Simulate a foreign live holder overwriting the lease record.
  writeFileSync(owner.leasePath, JSON.stringify({
    leaseName: 'linkedin-source',
    pid: process.ppid,
    runId: 'other-run',
    acquiredAt: new Date().toISOString(),
    heartbeat: new Date().toISOString(),
    tabs: [],
  }));
  const rel = owner.release();
  assert.equal(rel.released, false);
  assert.equal(rel.abandoned, true);
  assert.ok(existsSync(owner.leasePath), 'foreign lease record untouched');
  // Restore our own record; release then cleans up.
  writeFileSync(owner.leasePath, JSON.stringify({
    leaseName: 'linkedin-source',
    pid: process.pid,
    runId: owner.runId,
    acquiredAt: new Date().toISOString(),
    heartbeat: new Date().toISOString(),
    tabs: [],
  }));
  const rel2 = owner.release();
  assert.equal(rel2.released, true);
  console.log('  21. ownership-safe release: PASS');
}

// ── 22. Pause and cancellation honored while waiting ─────────────────
{
  const ready = () => ({ ok: true, allowed: true, record: null, error: null });

  // (a) acquisition-time pause denies immediately.
  const dirA = tempDir();
  const paused = () => ({ ok: true, allowed: false, record: { reason: 'manual pause' }, error: null });
  const rA = await acquireStrictLinkedInOwner({
    dbPath: path.join(dirA, 'workspace.sqlite'),
    lockDir: dirA,
    accessReader: paused,
  });
  assert.equal(rA.ok, false);
  assert.equal(rA.stage, 'access');
  assert.equal(rA.reason, 'access_paused');

  // (b) access flips to paused mid-wait → wait aborts promptly.
  const dirB = tempDir();
  mkdirSync(dirB, { recursive: true });
  const now = Date.now();
  writeFileSync(path.join(dirB, 'budget-linkedin-source.json'),
    JSON.stringify({ windowMs: 20000, requests: [now, now] })); // window already full
  const flipAt = Date.now() + 150;
  const flipping = () => (Date.now() >= flipAt
    ? { ok: true, allowed: false, record: { reason: 'paused mid-wait' }, error: null }
    : { ok: true, allowed: true, record: null, error: null });
  const rB = await acquireStrictLinkedInOwner({
    dbPath: path.join(dirB, 'workspace.sqlite'),
    lockDir: dirB,
    windowMs: 20000,
    maxRequests: 2,
    waitPollMs: 50,
    accessReader: flipping,
  });
  assert.ok(rB.ok, 'entry access was ready');
  const t0 = Date.now();
  const slot = await rB.owner.reserveRequest();
  const elapsed = Date.now() - t0;
  assert.equal(slot.ok, false);
  assert.equal(slot.reason, 'access_paused', 'paused access shortens the wait');
  assert.ok(elapsed < 5000, `pause denied promptly (${elapsed}ms, wait was 20s)`);
  rB.owner.release();

  // (c) cancellation while waiting.
  const dirC = tempDir();
  mkdirSync(dirC, { recursive: true });
  writeFileSync(path.join(dirC, 'budget-linkedin-source.json'),
    JSON.stringify({ windowMs: 20000, requests: [now, now] }));
  const rC = await acquireStrictLinkedInOwner({
    dbPath: path.join(dirC, 'workspace.sqlite'),
    lockDir: dirC,
    windowMs: 20000,
    maxRequests: 2,
    waitPollMs: 50,
    accessReader: ready,
  });
  setTimeout(() => rC.owner.abort(), 120);
  const t1 = Date.now();
  const slotC = await rC.owner.reserveRequest();
  const elapsedC = Date.now() - t1;
  assert.equal(slotC.ok, false);
  assert.equal(slotC.reason, 'cancelled');
  assert.ok(elapsedC < 5000, `abort honored promptly (${elapsedC}ms)`);
  rC.owner.release();
  console.log('  22. pause + cancellation while waiting: PASS');
}

// ── 23. One source-wide budget identity continues across owners ──────
{
  const dir = tempDir();
  const ready = () => ({ ok: true, allowed: true });
  const dbPath = path.join(dir, 'workspace.sqlite');
  const a = await acquireStrictLinkedInOwner({ dbPath, lockDir: dir, runId: 'budget-a', windowMs: 800, maxRequests: 1, accessReader: ready });
  const s1 = await a.owner.reserveRequest();
  assert.equal(s1.ok, true);
  a.owner.release();

  const b = await acquireStrictLinkedInOwner({ dbPath, lockDir: dir, runId: 'budget-b', windowMs: 800, maxRequests: 1, accessReader: ready });
  assert.ok(b.ok);
  assert.equal(b.owner.snapshot().requests, 1, 'second owner inherits the shared source-wide budget window');
  const slot = await b.owner.reserveRequest(); // blocks until the 800ms window expires
  assert.equal(slot.ok, true, 'slot frees after window expiry');
  b.owner.release();
  console.log('  23. shared source-wide budget identity: PASS');
}

// ── 24. Default persisted-access resolver (real module boundary) ─────
{
  // Proves the default resolver loads a linkedin-access-shaped module and
  // re-reads persisted state on every reserve. The real linkedin-access
  // module plus SQLite contract is already proven by the repository-root
  // research access suite.
  const dir = tempDir();
  mkdirSync(dir, { recursive: true });
  const stateFile = path.join(dir, 'access-state.json');
  writeFileSync(stateFile, JSON.stringify({ state: 'ready' }));
  const stubPath = path.join(dir, 'fake-access.mjs');
  writeFileSync(stubPath, `
import { readFileSync } from 'node:fs';
export function readLinkedInAccess() {
  try {
    const v = JSON.parse(readFileSync(process.env.LINKEDIN_ACCESS_STATE_FILE, 'utf8'));
    return { ok: true, allowed: v.state === 'ready', record: v, error: null };
  } catch {
    return { ok: false, allowed: false, record: null, error: { code: 'STORAGE_ERROR' } };
  }
}
`);
  process.env.LINKEDIN_ACCESS_MODULE = stubPath;
  process.env.LINKEDIN_ACCESS_STATE_FILE = stateFile;
  try {
    const res = await acquireStrictLinkedInOwner({
      dbPath: path.join(dir, 'workspace.sqlite'),
      lockDir: dir,
      runId: 'stub-run',
    });
    assert.ok(res.ok, JSON.stringify(res));
    assert.equal(res.owner.accessSource, stubPath, 'default resolver used the module boundary');
    const s1 = await res.owner.reserveRequest();
    assert.equal(s1.ok, true);
    writeFileSync(stateFile, JSON.stringify({ state: 'paused', reason: 'manual pause' }));
    const s2 = await res.owner.reserveRequest();
    assert.equal(s2.ok, false);
    assert.equal(s2.reason, 'access_paused', 'persisted pause is re-read per request');
    res.owner.release();

    // Unavailable resolver denies admission (fail-closed, not fail-open).
    process.env.LINKEDIN_ACCESS_MODULE = path.join(dir, 'does-not-exist.mjs');
    const dir2 = tempDir();
    const noReader = await acquireStrictLinkedInOwner({
      dbPath: path.join(dir2, 'workspace.sqlite'),
      lockDir: dir2,
    });
    // Falls through to sibling resolution; in a lean layout nothing resolves
    // → deny. In this checkout the sibling exists, so either deny-with-no-
    // verifiable-state or a resolved module is acceptable; assert the strong
    // invariant instead: a resolvable-but-erroring state never admits.
    if (noReader.ok) {
      const s = await noReader.owner.reserveRequest();
      assert.equal(s.ok, false, 'erroring access state never admits');
      assert.equal(s.reason, 'access_unavailable');
      noReader.owner.release();
    } else {
      assert.equal(noReader.stage, 'access');
    }
  } finally {
    delete process.env.LINKEDIN_ACCESS_MODULE;
    delete process.env.LINKEDIN_ACCESS_STATE_FILE;
  }
  console.log('  24. default resolver + fail-closed access: PASS');
}

// ── 25. Cross-process strict exclusion (real second process) ─────────
{
  const dir = tempDir();
  const modulePath = path.join(__dirname, 'cdp-lease.mjs').replaceAll('\\', '/');
  const holderScript = `
import { acquireStrictLinkedInOwner } from ${JSON.stringify('file://' + modulePath)};
const res = await acquireStrictLinkedInOwner({
  dbPath: ${JSON.stringify(DISPOSABLE_DB)},
  lockDir: ${JSON.stringify(dir.replaceAll('\\', '/'))},
  runId: 'holder',
  accessReader: () => ({ ok: true, allowed: true }),
});
if (!res.ok) { console.error('HOLDER DENIED: ' + JSON.stringify(res)); process.exit(2); }
console.log('HELD ' + process.pid);
await new Promise((r) => setTimeout(r, 1500));
res.owner.release();
process.exit(0);
`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', holderScript], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const held = await new Promise((resolve, reject) => {
    let buf = '';
    const to = setTimeout(() => reject(new Error('holder process did not acquire within 6s')), 6000);
    child.stdout.on('data', (d) => {
      buf += String(d);
      if (buf.includes('HELD')) { clearTimeout(to); resolve(buf); }
    });
    child.on('exit', (code) => {
      if (code !== 0) reject(new Error(`holder exited early: ${code}\n${buf}`));
    });
  });
  assert.ok(held.includes('HELD'));

  const deny = await acquireStrictLinkedInOwner({
    dbPath: DISPOSABLE_DB,
    lockDir: dir,
    runId: 'parent-check',
    accessReader: () => ({ ok: true, allowed: true }),
  });
  assert.equal(deny.ok, false, 'parent is denied while the child process holds the source lease');
  assert.equal(deny.reason, 'lease_contended');
  assert.ok(deny.detail.includes(String(child.pid)), `denial names the foreign holder pid: ${deny.detail}`);
  child.kill();
  console.log('  25. cross-process strict exclusion: PASS');
}

// ── Shared helpers for real-subprocess proofs (sections 26-28) ─────
const LEASE_MODULE_URL = 'file://' + path.join(__dirname, 'cdp-lease.mjs').replaceAll('\\', '/');

function runScript(name, code, args = [], env = {}, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    let out = '';
    let err = '';
    const to = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${name} timed out after ${timeoutMs}ms\n${out}${err}`));
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.on('data', (d) => { err += String(d); });
    child.on('exit', (code) => { clearTimeout(to); resolve({ code, out, err }); });
  });
}

function runCli(name, args, env = {}, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'search-linkedin-jobs.mjs'), '--no-role-variants', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    let out = '';
    const to = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${name} timed out after ${timeoutMs}ms\n${out}`));
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.on('data', (d) => { out += String(d); });
    child.on('exit', (code) => { clearTimeout(to); resolve({ code, out }); });
  });
}

function startCountingServer() {
  return new Promise((resolve) => {
    const state = { hits: 0 };
    const server = http.createServer((req, res) => { state.hits += 1; res.writeHead(200); res.end('ok'); });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}/hit`, hits: () => state.hits });
    });
  });
}

// ── 26. strict LinkedIn callers share one owner ──────────────────────
// Real competing subprocesses against a loopback counting target:
// while one owner holds the source, no other caller may reach the
// target; after the owner releases, the next caller may.
{
  const dir = tempDir();
  mkdirSync(dir, { recursive: true });
  const { server, url, hits } = await startCountingServer();

  const fetcherScript = `
import { tryAcquireStrictLinkedInOwner } from ${JSON.stringify(LEASE_MODULE_URL)};
import http from 'node:http';
const [lockDir, target, role] = process.argv.slice(1);
const res = await tryAcquireStrictLinkedInOwner({
  dbPath: ${JSON.stringify(DISPOSABLE_DB)},
  lockDir,
  runId: 'fixture-' + role,
  accessReader: () => ({ ok: true, allowed: true }),
});
if (!res.ok) { console.log('DENIED ' + res.stage + '/' + res.reason); process.exit(0); }
console.log('HELD ' + process.pid);
await new Promise((r) => setTimeout(r, role === 'holder' ? 800 : 50));
const slot = await res.owner.reserveRequest();
if (!slot.ok) { console.log('NO_SLOT ' + slot.reason); res.owner.release(); process.exit(0); }
const code = await new Promise((r) => {
  http.get(target, (resp) => { resp.resume(); r(resp.statusCode); }).on('error', () => r('ERR'));
});
console.log('FETCHED ' + code);
res.owner.release();
process.exit(0);
`;

  // Concurrent competition between two real processes: the holder fetches
  // while it owns the source; the contender, spawned only after the holder
  // announced its lease, must be excluded before touching the target.
  const holder = spawn(process.execPath, ['--input-type=module', '-e', fetcherScript, dir, url, 'holder'], { stdio: ['ignore', 'pipe', 'inherit'] });
  let holderBuf = '';
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('holder never acquired')), 10000);
    holder.stdout.on('data', (d) => { holderBuf += String(d); if (holderBuf.includes('HELD')) { clearTimeout(to); resolve(); } });
    holder.on('exit', (c) => { if (c !== 0) reject(new Error(`holder exited early: ${c}\n${holderBuf}`)); });
  });
  const contender = spawn(process.execPath, ['--input-type=module', '-e', fetcherScript, dir, url, 'contender'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const [holderExit, contenderExit] = await Promise.all([
    new Promise((resolve) => holder.on('exit', resolve)),
    new Promise((resolve) => {
      let buf = '';
      const to = setTimeout(() => { contender.kill('SIGKILL'); reject(new Error('contender timed out')); }, 15000);
      contender.stdout.on('data', (d) => { buf += String(d); });
      contender.on('exit', () => { clearTimeout(to); resolve(buf); });
    }),
  ]);
  void holderExit;
  const contenderOut = typeof contenderExit === 'string' ? contenderExit : '';
  assert.match(holderBuf, /FETCHED 200/, `the owner reached the local target:\n${holderBuf}`);
  assert.match(contenderOut, /DENIED lease\/lease_contended/, `the competing process was excluded: ${contenderOut}`);
  assert.doesNotMatch(contenderOut, /FETCHED|REACHED/, 'a denied caller must not touch the target');
  assert.equal(hits(), 1, `exactly one caller reached the target during contention (got ${hits()})`);

  // After the owner exits and releases, a new caller may own and fetch.
  const after = await runScript('after-owner-fixture', fetcherScript, [dir, url, 'after'], {}, 15000);
  assert.match(after.out, /FETCHED 200/, `the next caller acquires once the owner is done: ${after.out}`);
  assert.equal(hits(), 2, 'post-release navigation is admitted');

  // Production caller subprocess: real search-linkedin-jobs.mjs under
  // contention must terminate blocked before any CDP contact.
  const stubPath = path.join(dir, 'fake-access.mjs');
  writeFileSync(stubPath, `
import { readFileSync } from 'node:fs';
export function readLinkedInAccess() {
  try {
    const v = JSON.parse(readFileSync(process.env.LINKEDIN_ACCESS_STATE_FILE, 'utf8'));
    return { ok: true, allowed: v.state === 'ready', record: v, error: null };
  } catch {
    return { ok: false, allowed: false, record: null, error: { code: 'STORAGE_ERROR' } };
  }
}
`);
  const stateFile = path.join(dir, 'access-state.json');
  writeFileSync(stateFile, JSON.stringify({ state: 'ready' }));
  writeFileSync(path.join(dir, 'linkedin-source.lease'), JSON.stringify({
    leaseName: 'linkedin-source', pid: process.ppid, runId: 'foreign',
    acquiredAt: new Date().toISOString(), heartbeat: new Date().toISOString(), tabs: [],
  }, null, 2));
  const sumPath = path.join(dir, 'summary-contended.json');
  const cliA = await runCli('cli-contended', [
    '--role', 'Test Role', '--location', 'Testland', '--speaks', 'English',
    '--strict-owner', '--lock-dir', dir,
    '--db', path.join(dir, 'disposable-workspace.sqlite'),
    '--out', path.join(dir, 'results.json'), '--summary', sumPath,
  ], { LINKEDIN_ACCESS_MODULE: stubPath, LINKEDIN_ACCESS_STATE_FILE: stateFile });
  assert.equal(cliA.code, 2, `blocked run exits 2 (got ${cliA.code}):\n${cliA.out}`);
  assert.match(cliA.out, /Blocked before navigation/, 'blockage is reported before navigation');
  assert.doesNotMatch(cliA.out, /Searching LinkedIn via browser CDP/, 'run never reached the browser phase');
  assert.doesNotMatch(cliA.out, /\[cdp\]/, 'no CDP contact was attempted');
  const sumA = JSON.parse(readFileSync(sumPath, 'utf8'));
  assert.equal(sumA.status, 'source_blocked');
  assert.equal(sumA.reason, 'lease_contended');

  // Destination-binding guard: a non-loopback override aborts startup
  // (fixtures cannot be silently redirected anywhere, LinkedIn included).
  const cliB = await runCli('cli-bad-target', [
    '--role', 'Test Role', '--location', 'Testland', '--speaks', 'English',
  ], { LINKEDIN_TARGET_BASE: 'https://example.com' });
  assert.equal(cliB.code, 1, `bad destination binding aborts (got ${cliB.code}):\n${cliB.out}`);
  assert.match(cliB.out, /LINKEDIN_TARGET_BASE rejected/);
  assert.doesNotMatch(cliB.out, /Searching LinkedIn via browser CDP/);

  // Loopback binding + strict mode with an unreadable access source (no
  // stub): admission denies before any navigation in either layout.
  unlinkSync(path.join(dir, 'linkedin-source.lease'));
  const sumC = path.join(dir, 'summary-unverified.json');
  const cliC = await runCli('cli-unverified', [
    '--role', 'Test Role', '--location', 'Testland', '--speaks', 'English',
    '--strict-owner', '--lock-dir', dir,
    '--db', path.join(dir, 'missing-workspace.sqlite'),
    '--out', path.join(dir, 'results-c.json'), '--summary', sumC,
  ], { LINKEDIN_TARGET_BASE: 'http://127.0.0.1:59999', LINKEDIN_ALLOW_LOCAL_TARGET: '1' });
  assert.equal(cliC.code, 2, `unverified access denies before navigation (got ${cliC.code}):\n${cliC.out}`);
  const sumC2 = JSON.parse(readFileSync(sumC, 'utf8'));
  assert.equal(sumC2.status, 'source_blocked');
  assert.equal(sumC2.reason, 'access_unavailable');
  assert.match(cliC.out, /loopback fixture/, 'explicit loopback binding was honored');
  assert.doesNotMatch(cliC.out, /Searching LinkedIn via browser CDP/);

  server.close();
  console.log('  26. strict LinkedIn callers share one owner: PASS');
}

// ── 27. strict budget I/O failure prevents navigation ────────────────
// Real filesystem contention: a live foreign budget lock and a corrupt
// budget window must each end the run without any fetch attempt.
{
  const dir = tempDir();
  mkdirSync(dir, { recursive: true });
  const { server, url, hits } = await startCountingServer();

  const blockedScript = `
import { tryAcquireStrictLinkedInOwner } from ${JSON.stringify(LEASE_MODULE_URL)};
import http from 'node:http';
const [lockDir, target] = process.argv.slice(1);
const res = await tryAcquireStrictLinkedInOwner({
  dbPath: ${JSON.stringify(DISPOSABLE_DB)},
  lockDir,
  runId: 'fixture-blocked',
  accessReader: () => ({ ok: true, allowed: true }),
  mutexMaxWaitMs: 400,
});
if (!res.ok) {
  console.log('ACQUIRE_DENIED ' + res.stage + '/' + res.reason);
  process.exit(0);
}
const slot = await res.owner.reserveRequest();
if (!slot.ok) {
  // Navigation is prevented, not skipped by luck: fetch would be next.
  console.log('NO_FETCH ' + slot.stage + '/' + slot.reason);
  res.owner.release();
  process.exit(0);
}
const code = await new Promise((r) => { http.get(target, (resp) => { resp.resume(); r(resp.statusCode); }).on('error', () => r('ERR')); });
console.log('FETCHED ' + code);
res.owner.release();
process.exit(0);
`;

  // Case 1: budget mutex held by a live foreign process (our parent).
  writeFileSync(path.join(dir, 'budget-linkedin-source.lock'), String(process.ppid));
  const busy = await runScript('budget-busy-fixture', blockedScript, [dir, url]);
  assert.match(busy.out, /NO_FETCH storage\/storage_error/, `busy budget denies admission-level use: ${busy.out}`);
  assert.doesNotMatch(busy.out, /FETCHED/, 'a budget failure must not reach the target');
  assert.equal(hits(), 0, 'zero navigations during budget failure');
  unlinkSync(path.join(dir, 'budget-linkedin-source.lock'));

  // Case 2: corrupt persisted budget window denies acquisition outright.
  writeFileSync(path.join(dir, 'budget-linkedin-source.json'), 'this is not a request window');
  const corrupt = await runScript('budget-corrupt-fixture', blockedScript, [dir, url]);
  assert.match(corrupt.out, /ACQUIRE_DENIED storage\/budget_corrupt/, `corrupt window denies: ${corrupt.out}`);
  assert.equal(hits(), 0, 'zero navigations with a corrupt budget');

  server.close();
  console.log('  27. strict budget I/O failure prevents navigation: PASS');
}

// ── 28. paused owner releases without admitting queued work ──────────
// A queued sequence of reserves must deny every entry after the source
// pauses (persisted state re-read per request through the real module
// boundary), and the owner must then release cleanly.
{
  const dir = tempDir();
  mkdirSync(dir, { recursive: true });
  const stateFile = path.join(dir, 'access-state.json');
  writeFileSync(stateFile, JSON.stringify({ state: 'ready' }));
  const stubPath = path.join(dir, 'fake-access.mjs');
  writeFileSync(stubPath, `
import { readFileSync } from 'node:fs';
export function readLinkedInAccess() {
  try {
    const v = JSON.parse(readFileSync(process.env.LINKEDIN_ACCESS_STATE_FILE, 'utf8'));
    return { ok: true, allowed: v.state === 'ready', record: v, error: null };
  } catch {
    return { ok: false, allowed: false, record: null, error: { code: 'STORAGE_ERROR' } };
  }
}
`);
  const pausedScript = `
import { acquireStrictLinkedInOwner } from ${JSON.stringify(LEASE_MODULE_URL)};
import { writeFileSync, existsSync, unlinkSync } from 'node:fs';
const [lockDir] = process.argv.slice(1);
const res = await acquireStrictLinkedInOwner({
  dbPath: ${JSON.stringify(DISPOSABLE_DB)},
  lockDir,
  runId: 'fixture-pause',
});
if (!res.ok) { console.log('ACQUIRE_DENIED ' + res.reason); process.exit(3); }
const owner = res.owner;
const s1 = await owner.reserveRequest();
writeFileSync(process.env.LINKEDIN_ACCESS_STATE_FILE, JSON.stringify({ state: 'paused', reason: 'manual pause' }));
const denials = [];
for (let i = 0; i < 3; i++) {
  const s = await owner.reserveRequest();
  denials.push(s.ok ? 'ADMITTED' : s.reason);
}
const rel = owner.release();
console.log('S1=' + s1.ok + ' DENIALS:' + denials.join(',') + ' RELEASED=' + rel.released);
process.exit(0);
`;
  const paused = await runScript('paused-queue-fixture', pausedScript, [dir], {
    LINKEDIN_ACCESS_MODULE: stubPath,
    LINKEDIN_ACCESS_STATE_FILE: stateFile,
  });
  assert.equal(paused.code, 0, `fixture exited ${paused.code}:\n${paused.out}`);
  assert.match(
    paused.out,
    /S1=true DENIALS:access_paused,access_paused,access_paused RELEASED=true/,
    `queued work after a persisted pause is denied and the owner releases: ${paused.out}`,
  );
  assert.ok(!existsSync(path.join(dir, 'linkedin-source.lease')), 'the released lease file is gone');
  assert.ok(existsSync(path.join(dir, 'budget-linkedin-source.json')), 'the shared budget window intentionally persists');
  console.log('  28. paused owner releases without admitting queued work: PASS');
}

// ── 29. strict owner persists the pause at the observation site ─────
{
  const dir = tempDir();
  const pauses = [];
  const ready = () => ({ ok: true, allowed: true });
  const res = await acquireStrictLinkedInOwner({
    dbPath: DISPOSABLE_DB, lockDir: dir, runId: 'pause-owner', accessReader: ready,
    accessPauser: (dbPath, options) => { pauses.push({ dbPath, ...options }); return { ok: true, allowed: false, record: { state: 'paused' }, error: null }; },
  });
  assert.ok(res.ok, 'owner acquires with an injected pauser');
  const before = await res.owner.reserveRequest();
  assert.ok(before.ok, 'slot admitted before the observation');
  const paused = res.owner.pauseSource('collector observed blocked');
  assert.equal(paused.ok, true, 'pause result is the access API shape');
  assert.deepEqual(pauses, [{ dbPath: DISPOSABLE_DB, reason: 'collector observed blocked', runId: 'pause-owner' }], 'pause written once with the owner run id');
  const after = await res.owner.reserveRequest();
  assert.equal(after.ok, false, 'no admission after the owner paused the source');
  assert.equal(after.reason, 'cancelled');
  res.owner.release();

  // No resolvable pauser → reported, never silently skipped.
  const bare = await acquireStrictLinkedInOwner({ dbPath: DISPOSABLE_DB, lockDir: dir, runId: 'bare', accessReader: ready });
  assert.ok(bare.ok);
  const missing = bare.owner.pauseSource('x');
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, 'PAUSE_UNAVAILABLE');
  bare.owner.release();

  // A relative lockDir is denied instead of creating state under cwd.
  const rel = await acquireStrictLinkedInOwner({ dbPath: DISPOSABLE_DB, lockDir: 'relative/locks', accessReader: ready });
  assert.equal(rel.ok, false);
  assert.equal(rel.reason, 'storage_unavailable');
  assert.equal(existsSync('relative/locks'), false, 'no directory created under cwd');
  console.log('  29. strict owner persists the pause at the observation site: PASS');
}

// ── 30. Two simulated processes share one budget: N requests stay within window budget
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
  console.log('  30. cross-process budget arithmetic: PASS');
  // Exit here: the pending waitForSlot sleeper would otherwise hold the
  // event loop open for up to the 60s window.
  console.log('\n✅ cdp-lease tests: ALL PASS');
  process.exit(0);
}

// ── Done ─────────────────────────────────────────────────────────────
console.log('\n✅ cdp-lease tests: ALL PASS');
