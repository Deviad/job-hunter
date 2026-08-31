// Writer-lock library — satisfies CONC-01/02/03.
//
// API:
//   makeIdentity()                                    -> { hostname, pid, started_at, nonce }
//   acquire(db, identity?)                            -> handle
//   formatContentionMessage(holder, now?)             -> string
//   installSignalHandlers(handle)                     -> uninstall fn
//   PROCESS_STARTED_AT                                -> ISO string
//
// handle (on success): { acquired:true, reclaimed?, nonce, release(), startHeartbeat(opts), stopHeartbeat() }
// handle (on contention): { acquired:false, holder:{hostname,pid,acquired_at}, nonce, release: noop, ... }
//
// Per-instance state (released flag, heartbeat timer) is closure-local so multiple
// acquire/release cycles in one process work natively.
//
// Heartbeat single-miss abort is mandatory and non-overridable. Any failed heartbeat
// UPDATE (changes !== 1 or thrown) writes to stderr, attempts a best-effort
// nonce-fenced DELETE, and calls process.exit(4). No onLost callback exists.
//
// Self-bootstrap: acquire() runs LOCK_TABLE_DDL as its FIRST statement so a fresh-install
// DB (no salary_writer_lock yet) still works. The bootstrap runs OUTSIDE the
// BEGIN IMMEDIATE transaction (DDL inside an explicit txn risks the implicit-commit
// anti-pattern flagged in RESEARCH.md).
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { LOCK_TABLE_DDL, NOW_SQL } from './salary-schema.mjs';

export const PROCESS_STARTED_AT = new Date().toISOString();

export function makeIdentity() {
  return {
    hostname: hostname(),
    pid: process.pid,
    started_at: PROCESS_STARTED_AT,
    nonce: randomUUID(),
  };
}

export function acquire(db, identity = makeIdentity()) {
  // Self-bootstrap: idempotent CREATE TABLE IF NOT EXISTS.
  db.exec(LOCK_TABLE_DDL);

  const txn = db.transaction(() => {
    const ins = db.prepare(`
      INSERT OR IGNORE INTO salary_writer_lock
        (id, hostname, pid, started_at, nonce, acquired_at)
      VALUES (1, @hostname, @pid, @started_at, @nonce, ${NOW_SQL})
    `).run(identity);
    if (ins.changes === 1) return { fresh: true };

    const upd = db.prepare(`
      UPDATE salary_writer_lock
         SET hostname=@hostname, pid=@pid, started_at=@started_at,
             nonce=@nonce, acquired_at=${NOW_SQL}
       WHERE id=1 AND acquired_at < datetime('now','-10 minutes')
    `).run(identity);
    if (upd.changes === 1) return { fresh: false, reclaimed: true };

    const holder = db.prepare(
      `SELECT hostname, pid, acquired_at FROM salary_writer_lock WHERE id=1`
    ).get();
    return { contended: true, holder };
  });
  const result = txn.immediate();

  if (result.contended) {
    return {
      acquired: false,
      holder: result.holder,
      nonce: identity.nonce,
      release: () => {},
      startHeartbeat: () => {},
      stopHeartbeat: () => {},
    };
  }

  let released = false;
  let heartbeatTimer = null;
  let heartbeatStopped = true;

  function startHeartbeat({ intervalMs = 2 * 60 * 1000 } = {}) {
    if (heartbeatTimer) return;
    heartbeatStopped = false;
    heartbeatTimer = setInterval(() => {
      if (heartbeatStopped || released) return;
      let lost = false;
      let cause = null;
      try {
        const r = db.prepare(
          `UPDATE salary_writer_lock SET acquired_at=${NOW_SQL} WHERE id=1 AND nonce=?`
        ).run(identity.nonce);
        if (r.changes !== 1) lost = true;
      } catch (e) {
        lost = true;
        cause = e;
      }
      if (lost) {
        // MANDATORY single-miss abort.
        heartbeatStopped = true;
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
        try {
          db.prepare(`DELETE FROM salary_writer_lock WHERE nonce=?`).run(identity.nonce);
        } catch {}
        const msg = `[writer-lock] heartbeat lost (nonce=${identity.nonce.slice(0,8)}...${cause ? ': ' + cause.message : ''}); aborting with exit code 4`;
        try { process.stderr.write(msg + '\n'); } catch {}
        if (typeof process.exit === 'function') {
          process.exit(4);
        } else {
          throw new Error(msg);
        }
      }
    }, intervalMs);
    heartbeatTimer.unref?.();
  }

  function stopHeartbeat() {
    if (!heartbeatTimer) return;
    heartbeatStopped = true;
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  function release() {
    if (released) return;
    released = true;
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      heartbeatStopped = true;
    }
    try {
      db.prepare(`DELETE FROM salary_writer_lock WHERE id=1 AND nonce=?`).run(identity.nonce);
    } catch { /* best-effort */ }
  }

  return {
    acquired: true,
    reclaimed: !!result.reclaimed,
    nonce: identity.nonce,
    release,
    startHeartbeat,
    stopHeartbeat,
  };
}

/**
 * Format the locked CONC-01 contention message.
 * N = 10 - floor((now - acquired_at) / 60s), clamped to [1, 10].
 */
export function formatContentionMessage(holder, now = new Date()) {
  if (!holder || !holder.acquired_at) {
    return 'Another writer holds the lock; try again in 10 minutes';
  }
  // Stored format: 'YYYY-MM-DD HH:MM:SS' or 'YYYY-MM-DD HH:MM:SS.fff' (UTC).
  // Normalize to ISO and parse.
  const acquiredMs = new Date(holder.acquired_at.replace(' ', 'T') + 'Z').getTime();
  const ageSec = Math.floor((now.getTime() - acquiredMs) / 1000);
  const remaining = Math.max(1, Math.min(10, 10 - Math.floor(ageSec / 60)));
  return `Another writer holds the lock; try again in ${remaining} minutes`;
}

/**
 * Wire SIGINT/SIGTERM/exit handlers to release the given handle.
 * Returns an uninstall() function. release() is idempotent so double-fire is safe.
 * SIGKILL falls back to the 10-minute stale window.
 */
export function installSignalHandlers(handle) {
  const onSigint  = () => { handle.release(); process.exit(130); };
  const onSigterm = () => { handle.release(); process.exit(143); };
  const onExit    = () => { handle.release(); };
  process.on('SIGINT',  onSigint);
  process.on('SIGTERM', onSigterm);
  process.on('exit',    onExit);
  return function uninstall() {
    process.off('SIGINT',  onSigint);
    process.off('SIGTERM', onSigterm);
    process.off('exit',    onExit);
  };
}
