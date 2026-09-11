import { statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';

export const LINKEDIN_ACCESS_KEY = 'source.linkedin.access';
const messages = {
  INVALID_ARGUMENT: 'Invalid LinkedIn access arguments',
  MISSING_STATE: 'LinkedIn access state is missing',
  INVALID_STATE: 'LinkedIn access state is invalid',
  STORAGE_ERROR: 'LinkedIn access storage is unavailable',
};
const failure = (code) => ({ ok: false, allowed: false, record: null, error: { code, message: messages[code] } });
const success = (record) => ({ ok: true, allowed: record.state === 'ready', record, error: null });
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const validPath = (value) => typeof value === 'string' && value.trim().length > 0 && !value.includes('\0') && value !== ':memory:' && !value.startsWith('file:');
const validReason = (value) => typeof value === 'string' && value.length >= 1 && value.length <= 240 && value === value.trim() && !/[\x00-\x1f\x7f]/.test(value);
const validRunId = (value) => value === null || (typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value));
function validTimestamp(value) {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function validateRecord(value) {
  const required = ['schemaVersion', 'state', 'reason', 'observedAt', 'operatorConfirmation'];
  if (!object(value) || required.some((key) => !Object.hasOwn(value, key)) ||
      Object.keys(value).some((key) => !required.includes(key) && key !== 'runId') ||
      value.schemaVersion !== 1 || !['paused', 'ready'].includes(value.state) ||
      !validReason(value.reason) || !validTimestamp(value.observedAt)) return null;
  const runId = Object.hasOwn(value, 'runId') ? value.runId : null;
  if (!validRunId(runId)) return null;
  const confirmation = value.operatorConfirmation;
  if (value.state === 'paused') {
    if (confirmation !== null) return null;
  } else if (runId !== null || !object(confirmation) ||
      Object.keys(confirmation).length !== 2 ||
      !Object.hasOwn(confirmation, 'confirmedAt') || !Object.hasOwn(confirmation, 'reason') ||
      !validTimestamp(confirmation.confirmedAt) || confirmation.confirmedAt !== value.observedAt ||
      confirmation.reason !== value.reason) return null;
  return { ...value, runId };
}

function readRecord(db) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'jh_meta'").get()) return failure('MISSING_STATE');
  // Select all contracted columns so incompatible storage cannot masquerade as missing state.
  // A second row is only possible when the table lacks its key uniqueness
  // (incompatible storage); that ambiguity fails closed instead of picking one.
  const rows = db.prepare('SELECT value, updated_at FROM jh_meta WHERE key = ? LIMIT 2').all(LINKEDIN_ACCESS_KEY);
  if (rows.length > 1) return failure('STORAGE_ERROR');
  const [row] = rows;
  if (!row) return failure('MISSING_STATE');
  let value;
  try { value = JSON.parse(row.value); } catch { return failure('INVALID_STATE'); }
  const record = validateRecord(value);
  return record ? success(record) : failure('INVALID_STATE');
}

// The SQLite binding is resolved lazily (never at import) and cached per
// dependency home so hot-path readers do not re-resolve it on every call.
const constructors = new Map();
function databaseConstructor() {
  const home = process.env.JOBHUNTER_HOME || path.join(process.env.HOME || homedir(), '.job-hunter');
  if (!constructors.has(home)) constructors.set(home, createRequire(path.join(home, 'package.json'))('better-sqlite3'));
  return constructors.get(home);
}

function operate(dbPath, transition = null) {
  if (!validPath(dbPath)) return failure('INVALID_ARGUMENT');
  let db;
  let result;
  try {
    try { statSync(dbPath); } catch (error) {
      return failure(error.code === 'ENOENT' ? 'MISSING_STATE' : 'STORAGE_ERROR');
    }
    const Database = databaseConstructor();
    db = new Database(dbPath, { readonly: transition === null, fileMustExist: true, timeout: 1000 });
    if (transition === null) result = readRecord(db);
    else result = db.transaction(() => {
      const current = readRecord(db);
      if (!current.ok) return current;
      const observedAt = new Date().toISOString();
      const record = {
        schemaVersion: 1, state: transition.state, reason: transition.reason, observedAt,
        runId: transition.runId,
        operatorConfirmation: transition.state === 'ready' ? { confirmedAt: observedAt, reason: transition.reason } : null,
      };
      const updated = db.prepare('UPDATE jh_meta SET value = ?, updated_at = ? WHERE key = ?')
        .run(JSON.stringify(record), observedAt, LINKEDIN_ACCESS_KEY);
      if (updated.changes !== 1) throw new Error('Access update failed');
      return success(record);
    }).immediate();
  } catch {
    result = failure('STORAGE_ERROR');
  } finally {
    if (db) {
      try { db.close(); } catch { result = failure('STORAGE_ERROR'); }
    }
  }
  return result;
}

export function readLinkedInAccess(dbPath) {
  return operate(dbPath);
}

export function pauseLinkedInAccess(dbPath, options) {
  if (!object(options) || typeof options.reason !== 'string') return failure('INVALID_ARGUMENT');
  const reason = options.reason.trim();
  const runId = options.runId === undefined ? null : options.runId;
  if (!validReason(reason) || !validRunId(runId)) return failure('INVALID_ARGUMENT');
  return operate(dbPath, { state: 'paused', reason, runId });
}

export function resumeLinkedInAccess(dbPath, options) {
  if (!object(options) || options.acknowledge !== true || typeof options.reason !== 'string') return failure('INVALID_ARGUMENT');
  const reason = options.reason.trim();
  if (!validReason(reason)) return failure('INVALID_ARGUMENT');
  return operate(dbPath, { state: 'ready', reason, runId: null });
}
