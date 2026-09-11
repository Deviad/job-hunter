import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync, symlinkSync } from 'node:fs';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import * as access from '../skills/job-hunter/scripts/linkedin-access.mjs';
import { parseArgs, main } from '../skills/job-hunter/scripts/jh-linkedin-access.mjs';

const dependencyHome = process.env.JOBHUNTER_HOME || path.join(process.env.HOME || homedir(), '.job-hunter');
const Database = createRequire(path.join(dependencyHome, 'package.json'))('better-sqlite3');
const cliPath = path.resolve('skills/job-hunter/scripts/jh-linkedin-access.mjs');
const key = 'source.linkedin.access';
const paused = () => ({ schemaVersion: 1, state: 'paused', reason: 'review pending', observedAt: '2000-01-01T00:00:00.000Z', runId: null, operatorConfirmation: null });
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'research-access-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'fixture.sqlite');
  const db = new Database(file);
  db.exec('CREATE TABLE jh_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)');
  db.prepare('INSERT INTO jh_meta VALUES (?, ?, ?)').run(key, JSON.stringify(paused()), 'original');
  db.prepare('INSERT INTO jh_meta VALUES (?, ?, ?)').run('sentinel', 'untouched', 'original');
  t.after(() => { if (db.open) db.close(); });
  return { root, file, db };
}
function cli(file, ...args) {
  return spawnSync(process.execPath, [cliPath, ...args, '--db', file], { encoding: 'utf8', env: { ...process.env, JOBHUNTER_DB: file } });
}
function result(child, status = 0) {
  assert.equal(child.status, status, child.stderr);
  assert.equal(child.stderr, '');
  assert.equal(child.stdout.trim().split('\n').length, 1);
  return JSON.parse(child.stdout);
}
function failure(value, code) {
  const messages = { INVALID_ARGUMENT: 'Invalid LinkedIn access arguments', MISSING_STATE: 'LinkedIn access state is missing', INVALID_STATE: 'LinkedIn access state is invalid', STORAGE_ERROR: 'LinkedIn access storage is unavailable' };
  assert.deepEqual(value, { ok: false, allowed: false, record: null, error: { code, message: messages[code] } });
}
const snapshot = (db) => ({ rows: db.prepare('SELECT * FROM jh_meta ORDER BY key').all(), schema: db.prepare('SELECT * FROM sqlite_master ORDER BY name').all() });
const put = (db, record) => db.prepare('UPDATE jh_meta SET value = ? WHERE key = ?').run(typeof record === 'string' ? record : JSON.stringify(record), key);

test('status and imports do not mutate access state', async (t) => {
  const { root, file, db } = fixture(t);
  for (const record of [paused(), { ...paused(), state: 'ready', operatorConfirmation: { confirmedAt: paused().observedAt, reason: paused().reason } }, '{private malformed']) {
    put(db, record);
    const before = snapshot(db);
    const bytes = readFileSync(file);
    result(cli(file, 'status'), typeof record === 'string' ? 2 : 0);
    access.readLinkedInAccess(file);
    assert.deepEqual(snapshot(db), before);
    assert.deepEqual(readFileSync(file), bytes);
  }
  const absentHome = path.join(root, 'absent-home');
  const missing = path.join(root, 'missing', 'db.sqlite');
  const cdp = await cdpFixture(t);
  const env = { ...process.env, JOBHUNTER_HOME: absentHome, JOBHUNTER_DB: missing, BROWSER_CDP_PORT: String(cdp.port) };
  const imports = ['./skills/job-hunter/scripts/linkedin-access.mjs', './skills/job-hunter/scripts/jh-linkedin-access.mjs', './skills/job-hunter/scripts/jh-migrate.mjs', './skills/job-hunter/scripts/jh-search.mjs', './skills/linkedin-job-search/scripts/cdp-preflight.mjs'];
  const child = await runNode(['--input-type=module', '-e', `for (const name of ${JSON.stringify(imports)}) await import(name);`], env);
  assert.deepEqual(cdp.requests, []);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout + child.stderr, '');
  const help = spawnSync(process.execPath, [cliPath, '--help'], { encoding: 'utf8', env });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage:/);
  assert.equal(help.stderr, '');
  assert.equal(existsSync(absentHome), false);
  assert.equal(existsSync(path.dirname(missing)), false);
  const unavailable = spawnSync(process.execPath, [cliPath, 'status', '--db', file], { encoding: 'utf8', env });
  failure(result(unavailable, 2), 'STORAGE_ERROR');
  assert.equal(typeof main, 'function');
});

test('pause persists across operator processes', (t) => {
  const { file, db } = fixture(t);
  assert.equal(access.resumeLinkedInAccess(file, { acknowledge: true, reason: 'reviewed' }).allowed, true);
  assert.equal(result(cli(file, 'status')).allowed, true);
  result(cli(file, 'pause', '--reason', ' restriction ', '--run-id', 'run-1'));
  let record = access.readLinkedInAccess(file).record;
  assert.equal(record.state, 'paused');
  assert.equal(record.reason, 'restriction');
  assert.equal(record.runId, 'run-1');
  assert.equal(record.operatorConfirmation, null);
  for (let i = 0; i < 2; i++) {
    record = result(cli(file, 'resume', '--acknowledge', '--reason', `review ${i}`)).record;
    assert.deepEqual(record.operatorConfirmation, { confirmedAt: record.observedAt, reason: record.reason });
    assert.equal(access.readLinkedInAccess(file).allowed, true);
  }
  for (let i = 0; i < 2; i++) {
    assert.equal(access.pauseLinkedInAccess(file, { reason: `pause ${i}` }).ok, true);
    assert.equal(result(cli(file, 'status')).record.reason, `pause ${i}`);
  }
  const legacy = paused();
  delete legacy.runId;
  put(db, legacy);
  for (let i = 0; i < 2; i++) {
    const state = result(cli(file, 'status'));
    assert.equal(state.allowed, false);
    assert.equal(state.record.runId, null);
    assert.equal(state.record.observedAt, legacy.observedAt);
  }
});

test('missing or corrupt access state fails closed', (t) => {
  const { root, file, db } = fixture(t);
  const missing = path.join(root, 'absent', 'db.sqlite');
  failure(access.readLinkedInAccess(missing), 'MISSING_STATE');
  failure(access.pauseLinkedInAccess(missing, { reason: 'pause' }), 'MISSING_STATE');
  assert.equal(existsSync(path.dirname(missing)), false);
  const badFile = path.join(root, 'bad.sqlite');
  writeFileSync(badFile, 'not sqlite');
  failure(access.readLinkedInAccess(badFile), 'STORAGE_ERROR');
  failure(access.readLinkedInAccess(root), 'STORAGE_ERROR');
  const empty = path.join(root, 'empty.sqlite');
  const emptyDb = new Database(empty);
  failure(access.readLinkedInAccess(empty), 'MISSING_STATE');
  emptyDb.exec('CREATE TABLE jh_meta (wrong TEXT)');
  failure(access.readLinkedInAccess(empty), 'STORAGE_ERROR');
  emptyDb.close();
  const invalid = ['{private', 'null', '[]', { ...paused(), extra: 1 }];
  for (const field of ['schemaVersion', 'state', 'reason', 'observedAt', 'operatorConfirmation']) { const r = paused(); delete r[field]; invalid.push(r); }
  for (const [field, values] of Object.entries({ schemaVersion: [2, '1', null], state: ['READY', null], reason: ['', ' x', 'x ', 'x'.repeat(241), 'a\nb', 'a\x7fb', 2], observedAt: ['yesterday', '2000-01-01', '2000-02-30T00:00:00.000Z', null], runId: ['', '_bad', 'x'.repeat(129), 'run\n', 'run\u2028', 1], operatorConfirmation: [{}, []] })) {
    for (const value of values) invalid.push({ ...paused(), [field]: value });
  }
  const ready = { ...paused(), state: 'ready', operatorConfirmation: { confirmedAt: paused().observedAt, reason: paused().reason } };
  invalid.push({ ...ready, operatorConfirmation: null }, { ...ready, runId: 'run' });
  for (const confirmation of [{ reason: ready.reason }, { ...ready.operatorConfirmation, extra: true }, { ...ready.operatorConfirmation, reason: 'other' }, { ...ready.operatorConfirmation, confirmedAt: '2001-01-01T00:00:00.000Z' }]) invalid.push({ ...ready, operatorConfirmation: confirmation });
  for (const record of invalid) {
    put(db, record);
    const before = snapshot(db);
    failure(access.readLinkedInAccess(file), 'INVALID_STATE');
    failure(access.pauseLinkedInAccess(file, { reason: 'pause' }), 'INVALID_STATE');
    failure(access.resumeLinkedInAccess(file, { reason: 'review', acknowledge: true }), 'INVALID_STATE');
    failure(result(cli(file, 'status'), 2), 'INVALID_STATE');
    assert.deepEqual(snapshot(db), before);
  }
  db.prepare('DELETE FROM jh_meta WHERE key = ?').run(key);
  failure(access.readLinkedInAccess(file), 'MISSING_STATE');
  failure(access.resumeLinkedInAccess(file, { reason: 'review', acknowledge: true }), 'MISSING_STATE');
});

test('ambiguous access rows fail closed without changing storage', (t) => {
  const { file, db } = fixture(t);
  db.exec('DROP TABLE jh_meta; CREATE TABLE jh_meta (key TEXT, value TEXT, updated_at TEXT)');
  const ready = { ...paused(), state: 'ready', operatorConfirmation: { confirmedAt: paused().observedAt, reason: paused().reason } };
  const insert = db.prepare('INSERT INTO jh_meta VALUES (?, ?, ?)');
  for (const records of [[ready, paused()], [paused(), ready]]) {
    db.exec('DELETE FROM jh_meta');
    insert.run('sentinel', 'untouched', 'sentinel-time');
    records.forEach((record, index) => insert.run(key, JSON.stringify(record), 'original-' + index));
    const before = snapshot(db);
    failure(access.readLinkedInAccess(file), 'STORAGE_ERROR');
    failure(result(cli(file, 'status'), 2), 'STORAGE_ERROR');
    failure(access.pauseLinkedInAccess(file, { reason: 'pause' }), 'STORAGE_ERROR');
    failure(access.resumeLinkedInAccess(file, { reason: 'review', acknowledge: true }), 'STORAGE_ERROR');
    failure(result(cli(file, 'pause', '--reason', 'pause'), 2), 'STORAGE_ERROR');
    failure(result(cli(file, 'resume', '--acknowledge', '--reason', 'review'), 2), 'STORAGE_ERROR');
    assert.deepEqual(snapshot(db), before);
  }
  db.prepare('DELETE FROM jh_meta WHERE key = ?').run(key);
  failure(access.readLinkedInAccess(file), 'MISSING_STATE');
  insert.run(key, JSON.stringify(paused()), 'single-time');
  assert.equal(access.readLinkedInAccess(file).allowed, false);
  assert.equal(access.resumeLinkedInAccess(file, { reason: 'single review', acknowledge: true }).allowed, true);
});

test('resume requires explicit operator reason', (t) => {
  const { file, db } = fixture(t);
  const before = snapshot(db);
  for (const options of [undefined, null, 3, [], {}, { reason: 'review' }, { reason: '', acknowledge: true }, { reason: 'x'.repeat(241), acknowledge: true }, { reason: 'private\nvalue', acknowledge: true }, { reason: 'review', acknowledge: 'true' }]) failure(access.resumeLinkedInAccess(file, options), 'INVALID_ARGUMENT');
  for (const options of [undefined, null, [], {}, { reason: 'ok', runId: false }, { reason: 'ok', runId: '_bad' }]) failure(access.pauseLinkedInAccess(file, options), 'INVALID_ARGUMENT');
  for (const fileArg of [undefined, null, 4, '', ' ', ':memory:', 'file:secret', 'a\0b']) {
    failure(access.readLinkedInAccess(fileArg), 'INVALID_ARGUMENT');
    failure(access.pauseLinkedInAccess(fileArg, { reason: 'ok' }), 'INVALID_ARGUMENT');
  }
  for (const args of [[], ['secret'], ['status', 'extra'], ['status', '--reason', 'private'], ['resume', '--reason', 'private'], ['resume', '--acknowledge', 'true', '--reason', 'private'], ['resume', '--acknowledge', '--reason', 'private', '--run-id', 'r'], ['pause', '--reason'], ['pause', '--reason', 'private', '--reason', 'again'], ['status', '--force'], ['--help', 'status'], ['status', '--db', file]]) {
    const child = cli(file, ...args);
    assert.equal(child.status, 1);
    assert.equal(child.stdout, '');
    assert.equal(child.stderr, 'Invalid LinkedIn access arguments. Use --help for usage.\n');
  }
  assert.deepEqual(snapshot(db), before);
  assert.deepEqual(parseArgs(['status', '--db', file]), { help: false, action: 'status', db: file, reason: null, runId: null, acknowledge: null });
  assert.throws(() => parseArgs(null), /Invalid LinkedIn access arguments/);
  assert.equal(result(cli(file, 'resume', '--acknowledge', '--reason', ' reviewed ')).record.reason, 'reviewed');
});

test('real SQLite rollback, permissions and busy recovery', async (t) => {
  const { file, db } = fixture(t);
  db.exec("CREATE TRIGGER reject_update BEFORE UPDATE ON jh_meta BEGIN SELECT RAISE(ABORT, 'private trigger detail'); END");
  const before = snapshot(db);
  failure(access.pauseLinkedInAccess(file, { reason: 'pause' }), 'STORAGE_ERROR');
  failure(result(cli(file, 'resume', '--acknowledge', '--reason', 'review'), 2), 'STORAGE_ERROR');
  assert.deepEqual(snapshot(db), before);
  db.exec('DROP TRIGGER reject_update');
  chmodSync(file, 0o444);
  try {
    const permission = access.pauseLinkedInAccess(file, { reason: 'permission check' });
    if (permission.ok) t.diagnostic('OS write permissions are ineffective for this execution identity; trigger rejection proves write-failure handling.');
    else failure(permission, 'STORAGE_ERROR');
  } finally { chmodSync(file, 0o600); }
  chmodSync(file, 0);
  try {
    const permission = access.readLinkedInAccess(file);
    if (permission.ok) t.diagnostic('OS read permissions are ineffective for this execution identity.');
    else failure(permission, 'STORAGE_ERROR');
  } finally { chmodSync(file, 0o600); }
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import { createRequire } from 'node:module'; const Database = createRequire(${JSON.stringify(path.join(dependencyHome, 'package.json'))})('better-sqlite3'); const db = new Database(process.argv[1]); db.exec('BEGIN IMMEDIATE'); process.stdout.write('locked\\n'); process.stdin.once('data', () => { db.exec('ROLLBACK'); db.close(); });`, file], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await once(child.stdout, 'data');
  const lockedBefore = snapshot(db);
  failure(access.pauseLinkedInAccess(file, { reason: 'blocked writer' }), 'STORAGE_ERROR');
  assert.deepEqual(snapshot(db), lockedBefore);
  const exited = once(child, 'exit');
  child.stdin.end('release');
  assert.equal((await exited)[0], 0);
  assert.equal(access.pauseLinkedInAccess(file, { reason: 'recovered' }).ok, true);
});

test('CLI defaults, main return values and API subprocesses use explicit fixtures', (t) => {
  const { root, file } = fixture(t);
  const env = { ...process.env, JOBHUNTER_DB: file };
  const status = spawnSync(process.execPath, [cliPath, 'status'], { encoding: 'utf8', env });
  assert.equal(result(status).record.state, 'paused');
  const absent = path.join(root, 'absent.sqlite');
  const override = spawnSync(process.execPath, [cliPath, 'status', '--db', file], { encoding: 'utf8', env: { ...env, JOBHUNTER_DB: absent } });
  assert.equal(result(override).ok, true);
  const moduleUrl = new URL('../skills/job-hunter/scripts/jh-linkedin-access.mjs', import.meta.url).href;
  const apiUrl = new URL('../skills/job-hunter/scripts/linkedin-access.mjs', import.meta.url).href;
  const script = `import assert from 'node:assert/strict';
    import { main, parseArgs } from ${JSON.stringify(moduleUrl)};
    import { pauseLinkedInAccess } from ${JSON.stringify(apiUrl)};
    assert.equal(pauseLinkedInAccess(process.argv[1], { reason: 'child API' }).ok, true);
    assert.equal(main(['status', '--db', process.argv[1]]), 0);
    assert.equal(process.exitCode, undefined);
    process.env.JOBHUNTER_DB = '';
    process.env.JOBHUNTER_HOME = process.argv[2];
    assert.equal(parseArgs(['status']).db, process.argv[2] + '/jobhunter.sqlite');
    delete process.env.JOBHUNTER_HOME;
    process.env.HOME = process.argv[2];
    assert.equal(parseArgs(['status']).db, process.argv[2] + '/.job-hunter/jobhunter.sqlite');`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, file, root], { encoding: 'utf8', env });
  assert.equal(result(child).record.reason, 'child API');
  assert.equal(access.readLinkedInAccess(file).record.reason, 'child API');
  assert.equal(existsSync(absent), false);
});

test('reads observe committed WAL and commit failures roll back all updates', (t) => {
  const { file, db } = fixture(t);
  db.pragma('journal_mode = WAL');
  assert.equal(access.resumeLinkedInAccess(file, { reason: 'WAL review', acknowledge: true }).ok, true);
  assert.equal(result(cli(file, 'status')).record.reason, 'WAL review');
  db.exec(`CREATE TABLE parent (id INTEGER PRIMARY KEY);
    CREATE TABLE child (parent_id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED);
    CREATE TRIGGER reject_commit AFTER UPDATE ON jh_meta BEGIN INSERT INTO child VALUES (123); END;`);
  const before = snapshot(db);
  failure(access.pauseLinkedInAccess(file, { reason: 'commit must fail' }), 'STORAGE_ERROR');
  assert.deepEqual(snapshot(db), before);
  assert.equal(db.prepare('SELECT count(*) AS n FROM child').get().n, 0);
  db.exec('DROP TRIGGER reject_commit');
  assert.equal(access.pauseLinkedInAccess(file, { reason: 'after rollback' }).ok, true);
});

async function runNode(args, env) {
  const child = spawn(process.execPath, args, { env, timeout: 10_000 });
  let stdout = '', stderr = '';
  child.stdout.on('data', (data) => { stdout += data; });
  child.stderr.on('data', (data) => { stderr += data; });
  const [status, signal] = await once(child, 'close');
  assert.equal(signal, null, `fixture subprocess timed out: ${stderr}`);
  return { status, stdout, stderr };
}

async function cdpFixture(t) {
  const { WebSocketServer } = createRequire(path.join(dependencyHome, 'package.json'))('ws');
  const sockets = new WebSocketServer({ noServer: true });
  const state = { requests: [], evaluations: [], methods: [], targets: [], page: {}, port: 0 };
  const pages = new Map();
  let sequence = 0;
  const server = http.createServer((req, res) => {
    state.requests.push(req.url);
    if (state.failVersion && req.url === '/json/version') {
      res.end('private CDP fixture error');
      return;
    }
    const endpoint = `ws://127.0.0.1:${state.port}`;
    let value = {};
    if (req.url === '/json/version') value = { Browser: 'offline-fixture', webSocketDebuggerUrl: `${endpoint}/browser` };
    else if (req.url === '/json/list') value = state.targets;
    else if (req.url.startsWith('/json/new?')) {
      const id = String(++sequence);
      const url = decodeURIComponent(req.url.slice('/json/new?'.length));
      pages.set(`/target/${id}`, { title: 'Jobs', text: 'Available jobs', url, ...state.page });
      value = { id, url, webSocketDebuggerUrl: `${endpoint}/target/${id}` };
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(value));
  });
  server.on('upgrade', (req, socket, head) => sockets.handleUpgrade(req, socket, head, (ws) => {
    ws.on('message', (data) => {
      const message = JSON.parse(data);
      state.methods.push(message.method);
      if (message.method === 'Runtime.evaluate') state.evaluations.push(req.url);
      const result = message.method === 'Runtime.evaluate' ? { result: { value: JSON.stringify(pages.get(req.url) || state.page) } } : {};
      ws.send(JSON.stringify({ id: message.id, result }));
    });
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  state.port = server.address().port;
  t.after(async () => {
    for (const ws of sockets.clients) ws.terminate();
    sockets.close();
    await new Promise((resolve) => server.close(resolve));
  });
  return state;
}

function callerFixture(root, port) {
  const home = path.join(root, 'caller-home');
  mkdirSync(home);
  writeFileSync(path.join(home, 'package.json'), '{}');
  symlinkSync(path.join(dependencyHome, 'node_modules'), path.join(home, 'node_modules'), 'dir');
  const log = path.join(root, 'children.jsonl');
  const preload = path.join(root, 'child-sentinel.mjs');
  writeFileSync(preload, `import { appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const name = path.basename(process.argv[1] || '');
if (['jh-doctor.mjs', 'search-linkedin-jobs.mjs', 'search-indeed-jobs.mjs'].includes(name)) {
  appendFileSync(process.env.FIXTURE_CHILD_LOG, JSON.stringify(process.argv.slice(1)) + '\\n');
  if (name === 'jh-doctor.mjs') process.exit(Number(process.env.FIXTURE_DOCTOR_EXIT || '0'));
  if (name === 'search-linkedin-jobs.mjs' && process.env.FIXTURE_STATE) {
    const summary = process.argv[process.argv.indexOf('--summary') + 1];
    writeFileSync(summary, JSON.stringify({ terminalStatuses: { searchQueries: [{ status: process.env.FIXTURE_STATE }] } }));
    process.exit(Number(process.env.FIXTURE_EXIT || '2'));
  }
  process.exit(0);
}
`);
  return {
    home, log,
    env: { ...process.env, JOBHUNTER_HOME: home, JOBHUNTER_DB: path.join(root, 'wrong.sqlite'), BROWSER_CDP_PORT: String(port), NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`, FIXTURE_CHILD_LOG: log, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}` },
  };
}

const wrapperPath = path.resolve('skills/job-hunter/scripts/jh-search.mjs');
const preflightPath = path.resolve('skills/linkedin-job-search/scripts/cdp-preflight.mjs');
const wrapperArgs = (db, port) => [wrapperPath, '--source', 'linkedin', '--country', 'GB', '--db', db, '--cdp-port', String(port), '--json'];
const preflightArgs = (db, port) => [preflightPath, '--db', db, '--port', String(port), '--json', '--wait-ms', '500'];
const backfillPath = path.resolve('skills/linkedin-job-search/scripts/batch-fetch-jds.mjs');
const backfillArgs = (db, port) => [backfillPath, '--db', db, '--port', String(port)];
const expectedExit = (args) => (args[0] === wrapperPath ? 4 : args[0] === backfillPath ? 2 : 3);

test('pause survives restart and every entrypoint stops before access', async (t) => {
  const { root, file, db } = fixture(t);
  const cdp = await cdpFixture(t);
  const caller = callerFixture(root, cdp.port);
  const corrupt = path.join(root, 'corrupt.sqlite');
  writeFileSync(corrupt, 'private malformed storage');
  const before = snapshot(db);
  for (const database of [file, path.join(root, 'missing.sqlite'), corrupt]) {
    for (const args of [wrapperArgs(database, cdp.port), [...wrapperArgs(database, cdp.port), '--skip-preflight', '--resume', 'absent'], preflightArgs(database, cdp.port), backfillArgs(database, cdp.port), [...backfillArgs(database, cdp.port), '--dry-run', '--all']]) {
      const child = await runNode(args, caller.env);
      const output = result(child, expectedExit(args));
      assert.equal(output.ok, false);
      assert.equal(output.code, database === file ? 'SOURCE_PAUSED' : 'ACCESS_STATE_UNAVAILABLE');
      assert.equal(child.stdout.includes(root), false);
      assert.equal(child.stdout.includes('private malformed'), false);
    }
  }
  assert.deepEqual(cdp.requests, []);
  assert.equal(existsSync(caller.log), false);
  assert.equal(existsSync(path.join(caller.home, 'runs')), false);
  assert.deepEqual(snapshot(db), before);
  const indeed = await runNode([wrapperPath, '--source', 'indeed', '--country', 'GB', '--db', file, '--skip-preflight', '--json'], caller.env);
  assert.equal(indeed.status, 0, indeed.stderr);
  assert.match(readFileSync(caller.log, 'utf8'), /search-indeed-jobs/);
  assert.deepEqual(snapshot(db), before);
});

test('preflight bypass cannot bypass pause', async (t) => {
  const { root, file, db } = fixture(t);
  const cdp = await cdpFixture(t);
  const caller = callerFixture(root, cdp.port);
  for (const state of ['active_challenge', 'blocked', 'rate_limited', 'login_required']) {
    assert.equal(access.resumeLinkedInAccess(file, { acknowledge: true, reason: 'fixture reviewed' }).ok, true);
    const env = { ...caller.env, FIXTURE_STATE: state, FIXTURE_EXIT: state === 'login_required' ? '0' : '2' };
    const child = await runNode([...wrapperArgs(file, cdp.port), '--skip-preflight'], env);
    assert.equal(child.status, 4, child.stderr);
    const output = JSON.parse(child.stdout);
    const record = result(cli(file, 'status')).record;
    assert.equal(record.state, 'paused');
    assert.equal(record.runId, output.runId);
    const called = readFileSync(caller.log, 'utf8');
    result(await runNode([...wrapperArgs(file, cdp.port), '--skip-preflight'], env), 4);
    assert.equal(readFileSync(caller.log, 'utf8'), called);
  }
  assert.deepEqual(cdp.requests, []);
  assert.equal(access.resumeLinkedInAccess(file, { acknowledge: true, reason: 'preflight fixture' }).ok, true);
  cdp.page = { title: 'Sign in to LinkedIn', url: 'https://www.linkedin.com/login', text: 'Sign in to LinkedIn' };
  const calls = readFileSync(caller.log, 'utf8');
  const preflight = await runNode(wrapperArgs(file, cdp.port), caller.env);
  assert.equal(preflight.status, 4, preflight.stderr);
  assert.equal(access.readLinkedInAccess(file).record.state, 'paused');
  assert.equal(readFileSync(caller.log, 'utf8').slice(calls.length).includes('search-linkedin-jobs.mjs'), false);
  assert.equal(db.prepare('SELECT value FROM jh_meta WHERE key = ?').get('sentinel').value, 'untouched');
  assert.equal(access.resumeLinkedInAccess(file, { acknowledge: true, reason: 'failed persistence fixture' }).ok, true);
  db.exec("CREATE TRIGGER deny_pause BEFORE UPDATE ON jh_meta BEGIN SELECT RAISE(ABORT, 'private-storage-details'); END");
  const isolatedRoot = path.join(root, 'failed-pause');
  mkdirSync(isolatedRoot);
  const isolated = callerFixture(isolatedRoot, cdp.port);
  const failed = await runNode([...wrapperArgs(file, cdp.port), '--skip-preflight'], { ...isolated.env, FIXTURE_STATE: 'blocked' });
  const failure = result(failed, 4);
  assert.equal(failure.pausePersisted, false);
  assert.equal(failed.stdout.includes('private-storage-details'), false);
  assert.equal(existsSync(path.join(isolated.home, 'runs', failure.runId, 'checkpoint.json')), false);
  const deniedPause = result(await runNode([...preflightArgs(file, cdp.port), '--probe-url', 'https://www.linkedin.com/jobs/'], caller.env), 3);
  assert.equal(deniedPause.paused, false);
  assert.equal(deniedPause.accessError, 'STORAGE_ERROR');
  assert.equal(access.readLinkedInAccess(file).record.state, 'ready');
  const failedPreflight = await runNode(wrapperArgs(file, cdp.port), caller.env);
  assert.equal(failedPreflight.status, 4, failedPreflight.stderr);
  assert.equal(JSON.parse(failedPreflight.stdout).blocked, true);
  assert.equal(access.readLinkedInAccess(file).record.state, 'ready');
  assert.equal(failedPreflight.stdout.includes('private-storage-details'), false);
  db.exec('DROP TRIGGER deny_pause');
  const beforeFailure = snapshot(db);
  cdp.requests.length = 0;
  const doctorFailure = await runNode(wrapperArgs(file, cdp.port), { ...caller.env, FIXTURE_DOCTOR_EXIT: '9' });
  assert.equal(doctorFailure.status, 5, doctorFailure.stderr);
  assert.deepEqual(cdp.requests, []);
  cdp.failVersion = true;
  const cdpFailure = await runNode(wrapperArgs(file, cdp.port), caller.env);
  assert.equal(cdpFailure.status, 5, cdpFailure.stderr);
  assert.equal(JSON.parse(cdpFailure.stdout).blocked, false);
  assert.equal(cdpFailure.stdout.includes('private CDP fixture error'), false);
  assert.deepEqual(snapshot(db), beforeFailure);
  cdp.failVersion = false;
});

test('research navigation rejects member profiles', async (t) => {
  const { root, file, db } = fixture(t);
  const cdp = await cdpFixture(t);
  const caller = callerFixture(root, cdp.port);
  assert.equal(access.resumeLinkedInAccess(file, { acknowledge: true, reason: 'navigation fixture' }).ok, true);
  const unsafe = ['https://www.linkedin.com/in/person', 'https://www.linkedin.com/company/company', 'https://www.linkedin.com/feed', 'https://www.linkedin.com/jobs/../in/person', 'https://www.linkedin.com.evil.test/jobs', 'file:///private/file', 'https://example.test/jobs', 'file://uk.indeed.com/private/file'];
  for (const host of ['www.linkedin.com', 'uk.indeed.com']) {
    const credentials = new URL(`https://${host}/jobs`);
    credentials.username = 'fixture-user';
    credentials.password = 'fixture-password';
    unsafe.push(credentials.href);
  }
  for (const url of unsafe) {
    const output = result(await runNode([...preflightArgs(file, cdp.port), '--probe-url', url], caller.env), 3);
    assert.equal(output.ok, false);
  }
  assert.deepEqual(cdp.requests, []);
  const moduleUrl = pathToFileURL(preflightPath).href;
  const checks = await runNode(['--input-type=module', '-e', `import assert from 'node:assert/strict'; const m = await import(${JSON.stringify(moduleUrl)}); assert.equal(typeof m.main, 'function'); assert.equal(m.parseArgs(['--db', ${JSON.stringify(file)}]).db, ${JSON.stringify(file)}); assert.equal(m.parseArgs([]).db, process.env.JOBHUNTER_DB); for (const url of ['https://www.linkedin.com/jobs', 'https://linkedin.com/jobs/search/', 'https://www.linkedin.com/jobs/view/123?x=1']) assert.equal(m.researchNavigationDecision(url).allowed, true); const origin = 'http://127.0.0.1:${cdp.port}'; assert.equal(m.researchNavigationDecision(origin + '/jobs').allowed, false); assert.equal(m.researchNavigationDecision(origin + '/jobs', {fixtureOrigins:[origin]}).allowed, true);`], caller.env);
  assert.equal(checks.status, 0, checks.stderr);
  assert.equal(checks.stdout, '');
  const observations = [{ text: 'Please solve the captcha' }, { text: 'Security verification' }, { text: 'Too many requests' }, { title: 'Sign in to LinkedIn', url: 'https://www.linkedin.com/login', text: 'Sign in to LinkedIn' }];
  for (const page of observations) {
    assert.equal(access.resumeLinkedInAccess(file, { acknowledge: true, reason: 'next observation' }).ok, true);
    cdp.page = page;
    cdp.requests.length = cdp.evaluations.length = cdp.methods.length = 0;
    const args = [...preflightArgs(file, cdp.port), '--probe-url', 'https://www.linkedin.com/jobs/', '--probe-url', 'https://www.linkedin.com/jobs/view/123', '--watch-seconds', '1'];
    const output = result(await runNode(args, caller.env), 3);
    assert.equal(output.paused, true);
    assert.equal(access.readLinkedInAccess(file).record.state, 'paused');
    assert.equal(cdp.requests.filter((url) => url.startsWith('/json/new?')).length, 1);
    assert.equal(cdp.requests.filter((url) => url.startsWith('/json/close/')).length, 1);
    assert.equal(cdp.evaluations.length, 1);
    assert.deepEqual(output.heartbeat, { sent: 0, failed: 0 });
    assert.equal(cdp.methods.includes('Browser.getVersion'), false);
  }
  const before = snapshot(db);
  cdp.page = { title: 'Jobs', text: 'Available jobs', url: 'https://uk.indeed.com/jobs' };
  result(await runNode([...preflightArgs(file, cdp.port), '--probe-url', 'https://uk.indeed.com/jobs'], caller.env), 0);
  assert.deepEqual(snapshot(db), before);
  assert.equal(access.resumeLinkedInAccess(file, { acknowledge: true, reason: 'existing targets fixture' }).ok, true);
  cdp.page = { title: 'Jobs', text: 'Available jobs', url: 'https://www.linkedin.com/jobs/' };
  cdp.targets = [{ id: 'profile', type: 'page', url: 'https://www.linkedin.com/in/person', webSocketDebuggerUrl: `ws://127.0.0.1:${cdp.port}/profile` }];
  cdp.evaluations.length = 0;
  result(await runNode([...preflightArgs(file, cdp.port), '--probe-url', 'https://www.linkedin.com/jobs/'], caller.env), 0);
  assert.equal(cdp.evaluations.includes('/profile'), false);
  cdp.targets = [{ id: 'unreadable', type: 'page', url: 'https://www.linkedin.com/jobs/' }];
  const unreadable = result(await runNode(preflightArgs(file, cdp.port), caller.env), 3);
  assert.equal(unreadable.pages[0].state, 'error');
  assert.equal(access.readLinkedInAccess(file).record.state, 'ready');
  cdp.page.text = 'Too many requests';
  cdp.targets = ['first', 'second'].map((id) => ({ id, type: 'page', url: 'https://www.linkedin.com/jobs/', webSocketDebuggerUrl: `ws://127.0.0.1:${cdp.port}/${id}` }));
  cdp.requests.length = cdp.evaluations.length = cdp.methods.length = 0;
  result(await runNode([...preflightArgs(file, cdp.port), '--probe-url', 'https://www.linkedin.com/jobs/'], caller.env), 3);
  assert.deepEqual(cdp.evaluations, ['/first']);
  assert.equal(cdp.requests.some((url) => url.startsWith('/json/new') || url.startsWith('/json/close')), false);
  assert.equal(access.resumeLinkedInAccess(file, { acknowledge: true, reason: 'checkpoint fixture' }).ok, true);
  cdp.page = { title: 'Jobs', text: 'Available jobs', url: 'https://www.linkedin.com/jobs/' };
  cdp.targets = [{ id: 'checkpoint', type: 'page', title: 'LinkedIn', url: 'https://www.linkedin.com/checkpoint/challenge', webSocketDebuggerUrl: `ws://127.0.0.1:${cdp.port}/checkpoint` }];
  cdp.requests.length = cdp.evaluations.length = cdp.methods.length = 0;
  const checkpoint = result(await runNode([...preflightArgs(file, cdp.port), '--probe-url', 'https://www.linkedin.com/jobs/'], caller.env), 3);
  assert.equal(checkpoint.paused, true);
  assert.deepEqual(cdp.evaluations, []);
  assert.equal(cdp.requests.some((url) => url.startsWith('/json/new') || url.startsWith('/json/close')), false);
  assert.equal(access.readLinkedInAccess(file).record.state, 'paused');
  const pausedBeforeIndeed = snapshot(db);
  cdp.page = { title: 'Jobs', text: 'Available jobs', url: 'https://uk.indeed.com/jobs' };
  result(await runNode([...preflightArgs(file, cdp.port), '--probe-url', 'https://uk.indeed.com/jobs'], caller.env), 0);
  assert.equal(cdp.evaluations.includes('/checkpoint'), false);
  assert.deepEqual(snapshot(db), pausedBeforeIndeed);
});
