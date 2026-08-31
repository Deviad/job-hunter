/**
 * CDP target ownership registry and lifecycle cleanup.
 *
 * Tracks which browser targets (tabs) were created by this run vs.
 * pre-existing ones we merely attached to (borrowed). Cleanup closes
 * only owned targets; borrowed targets belong to the user and are
 * never closed.
 */

/**
 * Factory: create a fresh target registry instance.
 * Each run gets its own instance so tests are isolated.
 */
export function createTargetRegistry() {
  const owned = new Set();
  const borrowed = new Set();

  return {
    /** Register a target this run created. */
    registerOwned(targetId, _purpose) {
      if (targetId) owned.add(targetId);
    },

    /** Register a pre-existing target this run attached to. */
    registerBorrowed(targetId) {
      if (targetId) borrowed.add(targetId);
    },

    /** Remove a target from the registry (e.g. after normal close). */
    unregister(targetId) {
      owned.delete(targetId);
      borrowed.delete(targetId);
    },

    isOwned(targetId) {
      return owned.has(targetId);
    },

    isBorrowed(targetId) {
      return borrowed.has(targetId);
    },

    /** Snapshot of currently-owned target IDs. */
    getOwned() {
      return [...owned];
    },

    /** Snapshot of currently-borrowed target IDs. */
    getBorrowed() {
      return [...borrowed];
    },
  };
}

/**
 * Build a cleanup function that:
 *  1. Closes every owned target (safe if already closed / browser gone).
 *  2. Stops the keepalive timer.
 *  3. Closes the CDP client WebSocket.
 *
 * The returned function is idempotent — calling it more than once is a no-op.
 *
 * @param {object} opts
 * @param {ReturnType<createTargetRegistry>} opts.registry
 * @param {{ send: Function }}  [opts.client]          CDP client (may be null / already closed)
 * @param {Function}            [opts.stopKeepalive]   keepalive stop()
 * @param {Function}            [opts.closeClient]     CdpClient close()
 * @returns {() => Promise<void>}
 */
export function createCleanup({ registry, client, stopKeepalive, closeClient } = {}) {
  let ran = false;

  return async function cleanup() {
    if (ran) return;
    ran = true;

    // ── 1. Close owned targets ──────────────────────────────────────
    if (registry && client) {
      const owned = registry.getOwned();
      for (const targetId of owned) {
        try {
          await client.send('Target.closeTarget', { targetId });
        } catch (_) {
          // Target already closed, browser gone, or transient error.
          // Swallow — the goal is to release resources best-effort.
        }
        registry.unregister(targetId);
      }
    }

    // ── 2. Stop keepalive heartbeat ─────────────────────────────────
    if (typeof stopKeepalive === 'function') {
      try { stopKeepalive(); } catch (_) { /* best-effort */ }
    }

    // ── 3. Close CDP WebSocket ──────────────────────────────────────
    if (typeof closeClient === 'function') {
      try { closeClient(); } catch (_) { /* best-effort */ }
    }
  };
}
