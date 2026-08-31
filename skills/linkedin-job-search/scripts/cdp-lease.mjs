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
 * Budged file corruption or I/O errors → warn and fail open (caller proceeds).
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

async function withMutex(lockFile, fn) {
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
    if (Date.now() - started > MUTEX_MAX_WAIT_MS) {
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
