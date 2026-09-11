/**
 * Cross-process CDP coordination: lease + shared request budget + tab registry.
 *
 * All state is stored in files under a lock directory (default ~/.job-hunter/locks/).
 * Every operation is fail-open: a corrupt/missing file never crashes the caller.
 *
 * LEASE
 *   const h = acquireLease({ lockDir, leaseName: 'linkedin-search:9225', runId: 'x' });
 *   refreshHeartbeat(h);
 *   registerTab(h, targetId);
 *   releaseLease(h);  // call on cleanup
 *
 * Stale leases (heartbeat > 60 s, or dead PID) may be taken over by a new process.
 *
 * SHARED BUDGET
 *   const b = createSharedBudget({ lockDir, budgetName: 'linkedin.com:9225', windowMs: 60000, maxRequests: 12 });
 *   await b.waitForSlot();  // sleep until a slot is available
 *   // On cleanup: b.destroy() (optional)
 *
 * Legacy fail-open contract (kept for existing callers): budget file corruption
 * or I/O errors warn and let the caller proceed.
 *
 * STRICT SOURCE OWNER (S04, opt-in; legacy behavior above is unchanged)
 *   const res = await acquireStrictLinkedInOwner({ dbPath, lockDir, runId });
 *   if (!res.ok) → deny admission (never warn-and-continue).
 *   const slot = await res.owner.reserveRequest();  // rechecks persisted
 *     access + honors cancel/pause while waiting.
 * Strict mode is fail-closed: corrupt/busy/unwritable storage, contention,
 * mutex timeout and non-ready persisted access deny instead of proceeding.
 * Lease and budget use one source-wide identity independent of CDP port.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ── Helpers ──────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function safeReadJson(filePath) {
  try {
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function safeWriteJson(filePath, obj) {
  try {
    writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

function safeUnlink(filePath) {
  try {
    if (existsSync(filePath)) unlinkSync(filePath);
  } catch {
    // best-effort
  }
}

/**
 * Atomic file creation: returns true if the file was newly created, false
 * if it already existed. Uses the O_EXCL | O_CREAT trick on Unix.
 */
function atomicCreate(filePath, content) {
  let fd;
  try {
    fd = openSync(filePath, 'wx');
    writeFileSync(fd, content, 'utf8');
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
  }
}

// ── Mutex (advisory, file-based) ─────────────────────────────────────

const MUTEX_RETRY_MS = 50;
const MUTEX_MAX_WAIT_MS = 3000;

async function withMutex(lockFile, fn, maxWaitMs = MUTEX_MAX_WAIT_MS) {
  const started = Date.now();
  while (true) {
    if (atomicCreate(lockFile, String(process.pid))) {
      try {
        return await fn();
      } finally {
        safeUnlink(lockFile);
      }
    }
    // Break stale mutex left by a crashed process (dead PID).
    try {
      const holderPid = parseInt(readFileSync(lockFile, 'utf8').trim(), 10);
      if (Number.isInteger(holderPid) && holderPid > 0 && !pidAlive(holderPid)) {
        safeUnlink(lockFile);
        continue;
      }
    } catch {
      // Lockfile vanished between create attempt and read — retry.
      continue;
    }
    if (Date.now() - started > maxWaitMs) {
      throw new Error(`mutex timeout on ${lockFile}`);
    }
    await sleep(MUTEX_RETRY_MS + Math.random() * 30);
  }
}

// ── Lease ────────────────────────────────────────────────────────────

const DEFAULT_HEARTBEAT_THRESHOLD_MS = 60_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;

/**
 * Acquire a named lease for CDP coordination.
 *
 * @param {object} opts
 * @param {string} [opts.lockDir]    directory for lock files (default ~/.job-hunter/locks)
 * @param {string} opts.leaseName    unique lease identifier, e.g. "linkedin-search:9225"
 * @param {string} [opts.runId]      optional run identifier for diagnostics
 * @param {number} [opts.heartbeatThresholdMs]  max heartbeat age before lease considered stale (default 60000)
 * @returns {object} lease handle { leaseName, leasePath, destroy }
 */
export function acquireLease({
  lockDir,
  leaseName,
  runId = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  heartbeatThresholdMs = DEFAULT_HEARTBEAT_THRESHOLD_MS,
} = {}) {
  if (!leaseName) throw new Error('leaseName is required');

  const dir = lockDir || path.join(homedir(), '.job-hunter', 'locks');
  ensureDir(dir);

  const safeName = leaseName.replace(/[^a-zA-Z0-9:_-]/g, '_');
  const leasePath = path.join(dir, `${safeName}.lease`);
  const lockPath = path.join(dir, `${safeName}.lease.lock`);

  function readLease() {
    return safeReadJson(leasePath);
  }

  function writeLease(data, ignoreStale = false) {
    // Only write if we still own the lease (or if we're forcing)
    if (!ignoreStale) {
      const current = readLease();
      if (!current || current.pid !== process.pid) return false;
    }
    return safeWriteJson(leasePath, data);
  }

  function isStale(data) {
    if (!data) return true;
    // Dead PID → stale
    if (!pidAlive(data.pid)) return true;
    // Heartbeat too old → stale
    const heartbeat = data.heartbeat ? new Date(data.heartbeat).getTime() : 0;
    if (Date.now() - heartbeat > heartbeatThresholdMs) return true;
    return false;
  }

  // ── Acquire (try-create, then take-over if stale) ──────────────────
  let data = readLease();
  if (data && !isStale(data)) {
    throw new Error(
      `Lease "${leaseName}" already held by PID ${data.pid} (run ${data.runId || '?'}) since ${data.acquiredAt}`
    );
  }

  if (data && isStale(data)) {
    // Take over stale lease
    console.warn(`  [cdp-lease] Taking over stale lease "${leaseName}" (PID ${data.pid} ${pidAlive(data.pid) ? 'alive but heartbeat stale' : 'dead'})`);
    safeUnlink(leasePath);
  }

  const now = new Date().toISOString();
  const leaseData = {
    leaseName,
    pid: process.pid,
    runId,
    acquiredAt: now,
    heartbeat: now,
    tabs: [],
  };

  const created = atomicCreate(leasePath, JSON.stringify(leaseData, null, 2));
  if (!created) {
    // Raced — re-read and check
    data = readLease();
    if (data && !isStale(data)) {
      throw new Error(
        `Lease "${leaseName}" already held by PID ${data.pid} (run ${data.runId || '?'}) — lost race`
      );
    }
    // Stale after all — force it
    safeUnlink(leasePath);
    const created2 = atomicCreate(leasePath, JSON.stringify(leaseData, null, 2));
    if (!created2) {
      throw new Error(`Could not acquire lease "${leaseName}" — atomic create failed after cleanup`);
    }
  }

  console.log(`  [cdp-lease] Acquired lease "${leaseName}" (run ${runId})`);

  // ── Heartbeat starter ──────────────────────────────────────────────
  let heartbeatTimer = null;

  function startHeartbeat(intervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS) {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(() => {
      try {
        const current = readLease();
        if (!current || current.pid !== process.pid) return; // lost lease
        current.heartbeat = new Date().toISOString();
        writeLease(current, true);
      } catch {
        // heartbeat failure is non-fatal
      }
    }, intervalMs);
    heartbeatTimer.unref();
  }

  startHeartbeat();

  // ── Handle ─────────────────────────────────────────────────────────
  const handle = {
    leaseName,
    leasePath,
    /** Refresh heartbeat immediately. */
    refreshHeartbeat() {
      const current = readLease();
      if (!current || current.pid !== process.pid) return false;
      current.heartbeat = new Date().toISOString();
      return writeLease(current, true);
    },
    /** Register a CDP target (tab) as owned by this lease. */
    registerTab(targetId) {
      if (!targetId) return;
      try {
        const current = readLease();
        if (!current || current.pid !== process.pid) return;
        if (!Array.isArray(current.tabs)) current.tabs = [];
        if (!current.tabs.includes(targetId)) {
          current.tabs.push(targetId);
          writeLease(current, true);
        }
      } catch {
        // best-effort
      }
    },
    /** Get all tabs registered under this lease. */
    getTabs() {
      const current = readLease();
      if (!current || !Array.isArray(current.tabs)) return [];
      return [...current.tabs];
    },
    /** Release the lease and stop heartbeat. */
    release() {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      try {
        const current = readLease();
        if (current && current.pid === process.pid) {
          safeUnlink(leasePath);
          console.log(`  [cdp-lease] Released lease "${leaseName}"`);
        }
        // Also clean up mutex lockfile if we left it
        safeUnlink(lockPath);
      } catch {
        // best-effort
      }
    },
  };

  return handle;
}

/**
 * Non-throwing wrapper: returns the handle or null on failure.
 */
export function tryAcquireLease(opts) {
  try {
    return acquireLease(opts);
  } catch (err) {
    console.warn(`  [cdp-lease] Could not acquire lease "${opts?.leaseName}": ${err.message}`);
    return null;
  }
}

// ── Shared cross-process request budget ──────────────────────────────

/**
 * Create a shared rate budget manager keyed by budgetName.
 *
 * @param {object} opts
 * @param {string} [opts.lockDir]
 * @param {string} opts.budgetName   e.g. "linkedin.com:9225"
 * @param {number} [opts.windowMs]   rolling window in ms (default 60000)
 * @param {number} [opts.maxRequests] max requests in window (default 12)
 * @returns {{ waitForSlot: () => Promise<void>, noteRequest: () => void, destroy: () => void }}
 */
export function createSharedBudget({
  lockDir,
  budgetName,
  windowMs = 60_000,
  maxRequests = 12,
} = {}) {
  if (!budgetName) throw new Error('budgetName is required');

  const dir = lockDir || path.join(homedir(), '.job-hunter', 'locks');
  ensureDir(dir);

  const safeName = budgetName.replace(/[^a-zA-Z0-9:_-]/g, '_');
  const budgetPath = path.join(dir, `budget-${safeName}.json`);
  const lockPath = path.join(dir, `budget-${safeName}.lock`);

  function readBudget() {
    try {
      if (!existsSync(budgetPath)) return { windowMs, maxRequests, requests: [] };
      const data = JSON.parse(readFileSync(budgetPath, 'utf8'));
      return {
        windowMs: data.windowMs || windowMs,
        maxRequests: data.maxRequests || maxRequests,
        requests: Array.isArray(data.requests) ? data.requests : [],
      };
    } catch {
      // Corrupt file → fail open
      return { windowMs, maxRequests, requests: [] };
    }
  }

  function writeBudget(budget) {
    try {
      writeFileSync(budgetPath, JSON.stringify(budget, null, 2), 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Prune timestamps outside the window. Returns the pruned array.
   */
  function pruneRequests(requests) {
    const cutoff = Date.now() - windowMs;
    return requests.filter((ts) => ts > cutoff);
  }

  const handle = {
    /**
     * Record a request in the shared budget. Best-effort; never throws.
     */
    noteRequest() {
      try {
        let budget = readBudget();
        budget.requests = pruneRequests(budget.requests);
        budget.requests.push(Date.now());
        // Keep from growing unbounded (windowMs worth at most)
        budget.requests = budget.requests.slice(-maxRequests * 3);
        writeBudget(budget);
      } catch {
        // fail open
      }
    },

    /**
     * Wait until a request slot is available under the shared budget.
     * Returns once a slot is acquired (our timestamp is recorded).
     * On persistent budget file errors, fails open immediately.
     */
    async waitForSlot() {
      while (true) {
        let outcome;
        try {
          // Read-modify-write under the advisory lockfile so concurrent
          // processes don't both claim the last slot. Small races after a
          // mutex timeout are accepted (fail open).
          outcome = await withMutex(lockPath, async () => {
            const budget = readBudget();
            budget.requests = pruneRequests(budget.requests);
            if (budget.requests.length < maxRequests) {
              budget.requests.push(Date.now());
              budget.requests = budget.requests.slice(-maxRequests * 3);
              const ok = writeBudget(budget);
              return { acquired: true, writeOk: ok };
            }
            return { acquired: false, oldest: budget.requests[0], used: budget.requests.length };
          });
        } catch {
          // Mutex timeout or I/O error — fail open to per-process limiting
          console.warn('  [cdp-lease] Budget lock/IO error — proceeding without shared rate limit');
          return;
        }

        if (outcome.acquired) {
          if (!outcome.writeOk) {
            console.warn('  [cdp-lease] Budget file write error — proceeding without shared rate limit');
          }
          return;
        }

        // Budget exhausted — compute wait
        const waitMs = outcome.oldest + windowMs - Date.now() + 100;
        if (waitMs <= 0) {
          // Window already expired for oldest entry — retry prune+write
          continue;
        }

        console.log(
          `  [cdp-lease:budget] ${outcome.used}/${maxRequests} slots used, pausing ${(waitMs / 1000).toFixed(1)}s`
        );
        // Sleep for the full wait time so we don't spin. Maximum one log line per slot wait.
        await sleep(waitMs);
      }
    },

    /**
     * Detach from the budget. Leaves the budget file in place — sibling
     * processes may still be sharing it and it self-prunes by window —
     * but clears any advisory lockfile we may have left behind.
     */
    destroy() {
      try {
        const holder = existsSync(lockPath) ? readFileSync(lockPath, 'utf8').trim() : null;
        if (holder === String(process.pid)) safeUnlink(lockPath);
      } catch {}
    },
  };

  return handle;
}

/**
 * Non-throwing wrapper for createSharedBudget.
 */
export function tryCreateSharedBudget(opts) {
  try {
    return createSharedBudget(opts);
  } catch (err) {
    console.warn(`  [cdp-lease] Could not create shared budget "${opts?.budgetName}": ${err.message}`);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════
//  STRICT SOURCE OWNER — one owner per LinkedIn source, fail-closed
// ═══════════════════════════════════════════════════════════════════
//
// Extends the lease/budget primitives above; no competing storage.
// A strict owner binds:
//   * one source-wide lease identity (port-independent),
//   * one source-wide budget identity (port-independent),
//   * a required dbPath whose persisted access state is rechecked at
//     acquisition, at every reserveRequest entry, and while waiting.
//
// Every denial is a discriminated result ({ ok: false, stage, reason,
// detail }); strict mode never warns and continues. Legacy acquireLease/
// createSharedBudget keep their throw/fail-open contracts untouched.
//
// Access reader resolution (in order):
//   1. opts.accessReader — function(dbPath) -> { ok, allowed, error? }
//   2. $LINKEDIN_ACCESS_MODULE (file path) — for tests/alt layouts
//   3. sibling skill file linkedin-job-search → ../job-hunter/scripts/
//      linkedin-access.mjs (valid in repo checkout and installed layout)
// If none resolves, strict acquisition denies: an unverifiable access
// state is not an admitted one.

function strictDeny(stage, reason, detail = undefined) {
  return { ok: false, stage, reason, ...(detail !== undefined ? { detail } : {}) };
}

function isValidDbPath(value) {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    !value.includes('\0') &&
    value !== ':memory:' &&
    !value.startsWith('file:')
  );
}

async function resolveAccessReader(opts) {
  if (typeof opts.accessReader === 'function') {
    return {
      reader: opts.accessReader,
      pauser: typeof opts.accessPauser === 'function' ? opts.accessPauser : null,
      source: 'injected',
    };
  }
  const candidates = [];
  if (process.env.LINKEDIN_ACCESS_MODULE) candidates.push(process.env.LINKEDIN_ACCESS_MODULE);
  try {
    candidates.push(fileURLToPath(new URL('../../job-hunter/scripts/linkedin-access.mjs', import.meta.url)));
  } catch {
    // Non-file import context — nothing to resolve.
  }
  for (const candidate of candidates) {
    if (!candidate || !existsSync(candidate)) continue;
    try {
      const mod = await import(pathToFileURL(candidate).href);
      if (typeof mod.readLinkedInAccess === 'function') {
        return {
          reader: mod.readLinkedInAccess,
          pauser: typeof mod.pauseLinkedInAccess === 'function' ? mod.pauseLinkedInAccess : null,
          source: candidate,
        };
      }
    } catch {
      // Unreadable module — fall through to denial, never fail open.
    }
  }
  return { reader: null, pauser: null, source: 'unavailable' };
}

// Maps a persisted-access read to strict admission. Only an explicit
// ready state admits; paused, missing, invalid or errored state denies.
function strictAccessVerdict(readResult) {
  if (readResult && readResult.ok === true && readResult.allowed === true) {
    return { allowed: true };
  }
  if (readResult && readResult.ok === true && readResult.allowed === false) {
    return { allowed: false, reason: 'access_paused', detail: readResult.record?.reason ?? null };
  }
  return { allowed: false, reason: 'access_unavailable', detail: readResult?.error?.code ?? 'READER_DID_NOT_RETURN_STATE' };
}

function strictReadLease(leasePath) {
  // Returns { state: 'free' | 'corrupt' | 'held' | 'takeover', ... }.
  if (!existsSync(leasePath)) return { state: 'free' };
  let raw;
  try {
    raw = readFileSync(leasePath, 'utf8');
  } catch (error) {
    return { state: 'corrupt', detail: `lease unreadable: ${error.code ?? error.message}` };
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { state: 'corrupt', detail: 'lease file is not valid JSON' };
  }
  if (!data || typeof data !== 'object' || typeof data.pid !== 'number' || data.pid <= 0) {
    return { state: 'corrupt', detail: 'lease file has no valid holder pid' };
  }
  const hbAge = (() => {
    const t = Date.parse(data.heartbeat ?? '');
    return Number.isFinite(t) ? Date.now() - t : Number.POSITIVE_INFINITY;
  })();
  const alive = pidAlive(data.pid);
  if (alive && hbAge <= (data.heartbeatThresholdMs ?? DEFAULT_HEARTBEAT_THRESHOLD_MS)) {
    return { state: 'held', detail: `held by live pid ${data.pid} (run ${data.runId ?? 'unknown'})` };
  }
  return { state: 'takeover', detail: `stale lease from pid ${data.pid} (alive=${alive}, heartbeatAgeMs=${Number.isFinite(hbAge) ? Math.round(hbAge) : 'never'})` };
}

/**
 * Acquire the strict LinkedIn source owner: one lease identity and one
 * budget identity for the whole LinkedIn source, independent of CDP port.
 * Never throws for operational conditions; all denials are results.
 *
 * @param {object} opts
 * @param {string} opts.dbPath                required workspace DB (persisted access source)
 * @param {string} [opts.lockDir]             storage dir (default env or tmp)
 * @param {string} [opts.runId]
 * @param {string} [opts.leaseName]           default 'linkedin-source' (port-free)
 * @param {string} [opts.budgetName]          default 'linkedin-source' (port-free)
 * @param {number} [opts.windowMs]            default 60000 (compat value, not a platform claim)
 * @param {number} [opts.maxRequests]         default 12 (compat value, not a platform claim)
 * @param {function} [opts.accessReader]      injected dbPath -> access read; else resolved module
 * @param {function} [opts.accessPauser]      injected (dbPath, {reason, runId}) -> pause write; else resolved module
 * @param {function} [opts.isCancelled]       () => boolean, checked while waiting
 * @param {number} [opts.waitPollMs]          recheck cadence while waiting (default 250)
 * @param {number} [opts.mutexMaxWaitMs]      strict mutex budget (default 3000)
 * @param {number} [opts.maxWaitMs]           ceiling for budget waits (default 130000)
 * @returns {Promise<{ok:true, owner:object}|{ok:false, stage:string, reason:string, detail?:string}>}
 */
export async function acquireStrictLinkedInOwner(opts = {}) {
  const {
    dbPath,
    leaseName = 'linkedin-source',
    budgetName = 'linkedin-source',
    windowMs = 60_000,   // compat default (same value as legacy budgets), not a platform claim
    maxRequests = 12,    // compat default (same value as legacy budgets), not a platform claim
    waitPollMs = 250,
    mutexMaxWaitMs = MUTEX_MAX_WAIT_MS,
    maxWaitMs = 90_000,
    isCancelled = () => false,
  } = opts;

  if (!isValidDbPath(dbPath)) {
    return strictDeny('arguments', 'db_path_required', 'strict ownership requires an explicit workspace dbPath');
  }
  const lockDir = opts.lockDir || path.join(homedir(), '.job-hunter', 'locks');
  if (typeof lockDir !== 'string' || !path.isAbsolute(lockDir) || lockDir.includes('\0')) {
    // A relative or malformed lockDir would silently create state under cwd.
    return strictDeny('storage', 'storage_unavailable', 'lockDir must be an absolute path');
  }
  try {
    mkdirSync(lockDir, { recursive: true });
  } catch (error) {
    return strictDeny('storage', 'storage_unavailable', `lockDir unavailable: ${error.code ?? error.message}`);
  }

  const { reader: accessReader, pauser: accessPauser, source: accessSource } = await resolveAccessReader(opts);
  if (!accessReader) {
    return strictDeny('access', 'access_unavailable', 'no persisted-access reader could be resolved; strict mode does not proceed unverified');
  }
  const checkAccess = () => strictAccessVerdict(accessReader(dbPath));

  const safeLease = leaseName.replace(/[^a-zA-Z0-9:_-]/g, '_');
  const leasePath = path.join(lockDir, `${safeLease}.lease`);
  const safeBudget = budgetName.replace(/[^a-zA-Z0-9:_-]/g, '_');
  const budgetPath = path.join(lockDir, `budget-${safeBudget}.json`);
  const budgetLockPath = path.join(lockDir, `budget-${safeBudget}.lock`);

  // Persistent access must already be ready before any source admission.
  const entryAccess = checkAccess();
  if (!entryAccess.allowed) {
    return strictDeny('access', entryAccess.reason, `persisted access is not ready (source: ${accessSource})`);
  }

  // Budget storage: corrupt state denies (strict), unlike legacy fail-open.
  if (existsSync(budgetPath)) {
    try {
      const data = JSON.parse(readFileSync(budgetPath, 'utf8'));
      if (!data || !Array.isArray(data.requests)) {
        return strictDeny('storage', 'budget_corrupt', `${budgetPath} exists but holds no valid request window`);
      }
    } catch {
      return strictDeny('storage', 'budget_corrupt', `${budgetPath} exists but is not readable JSON`);
    }
  }

  // Lease: contention/corruption/unwritable storage deny.
  const leaseState = strictReadLease(leasePath);
  if (leaseState.state === 'corrupt') return strictDeny('lease', 'lease_corrupt', leaseState.detail);
  if (leaseState.state === 'held') return strictDeny('lease', 'lease_contended', leaseState.detail);

  const runId = typeof opts.runId === 'string' && opts.runId ? opts.runId : strictDefaultRunId();
  const leaseData = {
    leaseName,
    pid: process.pid,
    runId,
    acquiredAt: new Date().toISOString(),
    heartbeat: new Date().toISOString(),
    tabs: [],
  };
  if (leaseState.state === 'takeover') safeUnlink(leasePath);
  let claimed = false;
  try {
    claimed = atomicCreate(leasePath, JSON.stringify(leaseData, null, 2));
  } catch (error) {
    // Unwritable storage (EACCES/EROFS) denies admission in strict mode.
    return strictDeny('storage', 'storage_unavailable', `lease create failed: ${error.code ?? error.message}`);
  }
  if (!claimed) {
    const after = strictReadLease(leasePath);
    if (after.state === 'corrupt') return strictDeny('lease', 'lease_corrupt', after.detail);
    return strictDeny('lease', 'lease_contended', after.detail ?? 'another strict owner claimed the lease first');
  }

  const owner = {
    leaseName,
    budgetName,
    leasePath,
    budgetPath,
    runId,
    accessSource,
    cancelled: false,
    isAborted: () => owner.cancelled || isCancelled(),
    abort() { owner.cancelled = true; },

    /**
     * Persist the source pause at the observation site, before this owner
     * releases. Returns the access API result shape; an unavailable pauser
     * is reported, never silently skipped. Also aborts queued waits.
     */
    pauseSource(reason) {
      owner.cancelled = true;
      if (!accessPauser) {
        return { ok: false, allowed: false, record: null, error: { code: 'PAUSE_UNAVAILABLE', message: 'No persisted-access pauser could be resolved' } };
      }
      try {
        const res = accessPauser(dbPath, { reason: String(reason ?? 'strict owner observed a restriction').slice(0, 240), runId });
        return res && typeof res === 'object' ? res : { ok: false, allowed: false, record: null, error: { code: 'STORAGE_ERROR', message: 'Pause write returned no result' } };
      } catch {
        return { ok: false, allowed: false, record: null, error: { code: 'STORAGE_ERROR', message: 'Pause write threw' } };
      }
    },

    refreshHeartbeat() {
      const state = strictReadLease(leasePath);
      if (state.state === 'held' && state.detail.includes(`pid ${process.pid}`)) {
        // Still ours — rewrite heartbeat (contention-safe rewrite of own record).
        try {
          writeFileSync(leasePath, JSON.stringify({
            ...JSON.parse(readFileSync(leasePath, 'utf8')),
            heartbeat: new Date().toISOString(),
          }, null, 2));
          return true;
        } catch { return false; }
      }
      return false;
    },

    registerTab(targetId) {
      if (!targetId) return false;
      try {
        const data = JSON.parse(readFileSync(leasePath, 'utf8'));
        if (data.pid !== process.pid || data.runId !== runId) return false;
        if (!data.tabs.includes(targetId)) { data.tabs.push(targetId); writeFileSync(leasePath, JSON.stringify(data, null, 2)); }
        return true;
      } catch { return false; }
    },

    /**
     * Reserve one source-wide request slot. Fail-closed sequence:
     * cancel → access → budget read → (wait with per-slice cancel/pause
     * rechecks) → access recheck → write. Any storage failure denies.
     * The access recheck runs immediately before the budget mutex is
     * taken, never inside it, so the SQLite read never holds the lock.
     */
    async reserveRequest() {
      if (owner.isAborted()) return strictDeny('wait', 'cancelled', 'strict owner was aborted before the request');
      const started = Date.now();
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const preFlight = checkAccess();
        if (!preFlight.allowed) return strictDeny('access', preFlight.reason, 'persisted access is not ready');
        let grant = null;
        try {
          grant = await withMutex(budgetLockPath, () => {
            let data = { windowMs, requests: [] };
            if (existsSync(budgetPath)) {
              data = JSON.parse(readFileSync(budgetPath, 'utf8'));
              if (!data || !Array.isArray(data.requests)) {
                return { deny: strictDeny('storage', 'budget_corrupt', 'budget window became unreadable mid-run') };
              }
            }
            const cutoff = Date.now() - windowMs;
            data.requests = data.requests.filter((t) => typeof t === 'number' && t > cutoff);
            if (data.requests.length >= maxRequests) {
              const waitMs = (data.requests[0] + windowMs) - Date.now() + 40;
              return { wait: Math.max(waitMs, 10) };
            }
            if (owner.isAborted()) {
              return { deny: strictDeny('wait', 'cancelled', 'strict owner was aborted while waiting') };
            }
            data.requests.push(Date.now());
            writeFileSync(budgetPath, JSON.stringify(data, null, 2));
            return { ok: true, used: data.requests.length, waitedMs: Date.now() - started };
          }, mutexMaxWaitMs);
        } catch (error) {
          return strictDeny('storage', 'storage_error', `budget storage unavailable: ${error.message}`);
        }
        if (grant.ok) return { ok: true, waitedMs: grant.waitedMs, used: grant.used };
        if (grant.deny) return grant.deny;
        // Wait in recheck slices so cancellation and pause deny promptly.
        let remaining = grant.wait;
        while (remaining > 0) {
          if (owner.isAborted()) return strictDeny('wait', 'cancelled', 'strict owner was aborted while waiting');
          const slice = Math.min(waitPollMs, remaining);
          await sleep(slice);
          remaining -= slice;
          const waitAccess = checkAccess();
          if (!waitAccess.allowed) return strictDeny('access', waitAccess.reason, 'persisted access changed while waiting');
          if (Date.now() - started > maxWaitMs) {
            return strictDeny('wait', 'budget_exhausted', `budget slot did not free within ${maxWaitMs} ms`);
          }
        }
      }
    },

    /**
     * Ownership-safe release: removes only the lease this owner wrote
     * (matching pid + runId). A lease overwritten elsewhere is abandoned,
     * never deleted — same rule as legacy, but reported as a result.
     * The budget file is shared source-wide state and intentionally persists.
     */
    release() {
      owner.cancelled = true;
      try {
        if (!existsSync(leasePath)) return { released: true, alreadyGone: true };
        const data = JSON.parse(readFileSync(leasePath, 'utf8'));
        if (data.pid !== process.pid || data.runId !== runId) {
          return { released: false, abandoned: true, reason: 'lease no longer belongs to this owner' };
        }
        safeUnlink(leasePath);
        return { released: true };
      } catch {
        return { released: false, abandoned: true, reason: 'lease state unreadable at release' };
      }
    },

    snapshot() {
      try {
        const data = JSON.parse(readFileSync(budgetPath, 'utf8'));
        return { windowMs, requests: Array.isArray(data.requests) ? data.requests.length : null };
      } catch {
        return { windowMs, requests: null };
      }
    },
  };

  return { ok: true, owner };
}

/**
 * Non-throwing wrapper matching the acquire/try naming: operational
 * denials and unexpected exceptions both become discriminated results.
 */
export async function tryAcquireStrictLinkedInOwner(opts = {}) {
  try {
    return await acquireStrictLinkedInOwner(opts);
  } catch (error) {
    return strictDeny('error', 'unexpected_error', error?.message ?? String(error));
  }
}

function strictDefaultRunId() {
  const random = Math.random().toString(36).slice(2, 8);
  return `strict-${Math.floor(Date.now() / 1000).toString(36)}${random}`;
}
