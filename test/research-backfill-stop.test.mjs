import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readLinkedInAccess } from '../skills/job-hunter/scripts/linkedin-access.mjs';

const backfillScript = fileURLToPath(new URL('../skills/linkedin-job-search/scripts/batch-fetch-jds.mjs', import.meta.url));
const accessKey = 'source.linkedin.access';
const readyRecord = () => {
  const observedAt = new Date().toISOString();
  return { schemaVersion: 1, state: 'ready', reason: 'fixture reviewed', observedAt, runId: null, operatorConfirmation: { confirmedAt: observedAt, reason: 'fixture reviewed' } };
};
const pausedRecord = () => ({ schemaVersion: 1, state: 'paused', reason: 'fixture pause', observedAt: '2000-01-01T00:00:00.000Z', runId: null, operatorConfirmation: null });

const require = createRequire(import.meta.url);
let scratch, Database, runBackfill;
before(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'jh-backfill-stop-'));
  await mkdir(join(scratch, 'node_modules'));
  for (const name of ['ws', 'better-sqlite3']) {
    await symlink(dirname(require.resolve(`${name}/package.json`)), join(scratch, 'node_modules', name), 'dir');
  }
  const previous = process.env.JOBHUNTER_HOME;
  process.env.JOBHUNTER_HOME = scratch;
  try {
    ({ runBackfill } = await import('../skills/linkedin-job-search/scripts/batch-fetch-jds.mjs'));
    ({ Database } = await import('../skills/job-hunter/scripts/workspace-dependencies.mjs'));
  } finally {
    if (previous === undefined) delete process.env.JOBHUNTER_HOME;
    else process.env.JOBHUNTER_HOME = previous;
  }
});
after(async () => { await rm(scratch, { recursive: true, force: true }); });

const healthy = 'Report this job\nResponsibilities: Build reliable systems and turn business challenges into platform improvements. English required. Design, implement and maintain services with the team.\nSeniority level';
const opts = { batchSize: 1, speaks: ['English'], excludeLanguages: ['German'], dryRun: false };
const noop = async () => {};
function gate() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t, snapshots, hooks = {}) {
  const requests = [], events = [];
  const server = createServer((req, res) => {
    requests.push(req.url.slice(1));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(snapshots[req.url.slice(1)] || { text: healthy }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const jobs = Object.keys(snapshots).map((job_id) => ({ source: 'linkedin', job_id, title: 'Software Engineer', url: `${origin}/${job_id}` }));
  const transport = (job) => {
    let response;
    return {
      async prepare() {
        events.push(`prepare:${job.job_id}`);
        await hooks.prepare?.(job);
      },
      async navigate() {
        const url = new URL(job.url);
        assert.equal(url.origin, origin);
        assert.equal(url.hostname, '127.0.0.1');
        events.push(`navigate:${job.job_id}`);
        response = await fetch(url, { redirect: 'error' });
        await hooks.navigate?.(job);
      },
      async read() {
        await hooks.read?.(job);
        return { url: job.url, ...await response.json() };
      },
      async close() {
        events.push(`close:${job.job_id}`);
        await hooks.close?.(job);
      },
    };
  };
  return { jobs, transport, requests, events, origin, pauses: [] };
}

async function database(t, jobs, { access = null } = {}) {
  const dir = await mkdtemp(join(scratch, 'db-'));
  const db = new Database(join(dir, 'fixture.sqlite'));
  t.after(() => { if (db.open) db.close(); });
  if (access) {
    db.exec('CREATE TABLE jh_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
    db.prepare('INSERT INTO jh_meta (key, value) VALUES (?, ?)').run(accessKey, JSON.stringify(access));
  }
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE jobs (source TEXT, job_id TEXT, description_text TEXT,
      description_raw TEXT, language_filter_reason TEXT, updated_at TEXT,
      PRIMARY KEY (source, job_id));
    CREATE TABLE job_languages (source TEXT, job_id TEXT, language TEXT,
      importance TEXT, PRIMARY KEY (source, job_id, language, importance),
      FOREIGN KEY (source, job_id) REFERENCES jobs(source, job_id));
  `);
  for (const job of jobs) {
    db.prepare('INSERT INTO jobs VALUES (?, ?, ?, ?, ?, ?)').run(job.source, job.job_id, `saved ${job.job_id}`, `raw ${job.job_id}`, 'saved filter', '2000-01-01');
    db.prepare('INSERT INTO job_languages VALUES (?, ?, ?, ?)').run(job.source, job.job_id, 'Italian', 'nice_to_have');
  }
  return db;
}
function saved(db, id) {
  return {
    job: db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(id),
    languages: db.prepare('SELECT * FROM job_languages WHERE job_id = ? ORDER BY language').all(id),
  };
}
function run(f, db, extra = {}) {
  // The loopback fixture origin is explicitly bound; every other destination
  // is validated against the production jobs-route allowlist. Pauses are
  // recorded unless a test opts into the real access writer.
  const pause = 'pause' in extra ? extra.pause : (restriction) => { f.pauses.push(restriction); return { ok: true, allowed: false, record: null, error: null }; };
  return runBackfill({ jobs: f.jobs, transport: f.transport, db, opts, fixtureOrigins: [f.origin],
    rateLimit: noop, stagger: noop, betweenBatches: noop, log() {}, ...extra, pause });
}
function accounting(summary, jobs) {
  const ids = summary.results.map((r) => r.job.job_id);
  assert.equal(new Set(ids).size, jobs.length);
  assert.deepEqual(ids.sort(), jobs.map((j) => j.job_id).sort());
  assert.equal(summary.processed + summary.deferredIds.length + summary.excluded, jobs.length);
}

test('first restriction ends backfill', { timeout: 10000 }, async (t) => {
  const f = await fixture(t, { a: { text: 'Too many requests' }, b: { text: healthy }, c: { text: healthy } });
  const db = await database(t, f.jobs);
  const result = await run(f, db);
  assert.deepEqual(f.requests, ['a']);
  assert.deepEqual(result.deferredIds, ['a', 'b', 'c']);
  assert.equal(result.restriction.state, 'rate_limited');
  assert.equal(result.restriction.job_id, 'a');
  assert.match(result.restriction.reason, /matched visible page text/);
  assert.equal(result.errors, 0);
  assert.equal(result.written, 0);
  accounting(result, f.jobs);
});

test('restriction never replaces a saved description', { timeout: 10000 }, async (t) => {
  const f = await fixture(t, { a: { text: healthy }, b: { text: 'Please solve CAPTCHA' }, c: { text: healthy } });
  const db = await database(t, f.jobs);
  const beforeB = saved(db, 'b'), beforeC = saved(db, 'c');
  const result = await run(f, db);
  assert.deepEqual(result.deferredIds, ['b', 'c']);
  assert.deepEqual(saved(db, 'b'), beforeB);
  assert.deepEqual(saved(db, 'c'), beforeC);
  assert.match(saved(db, 'a').job.description_text, /Build reliable systems/);
  assert.equal(saved(db, 'a').job.description_raw, saved(db, 'a').job.description_text);
  assert.notEqual(saved(db, 'a').job.updated_at, '2000-01-01');
  assert.deepEqual(saved(db, 'a').languages.map((r) => [r.language, r.importance]), [['English', 'required']]);
  assert.equal(result.written, 1);
  accounting(result, f.jobs);
});

for (const stage of ['stagger', 'rateLimit', 'prepare']) {
  test(`restriction during ${stage} denies navigation before cleanup completes`, { timeout: 10000 }, async (t) => {
    const waiting = gate(), observed = gate(), finished = gate();
    const hold = async (job) => {
      if (job.job_id === 'b') { waiting.resolve(); await observed.promise; }
    };
    const f = await fixture(t, { a: { text: 'Security verification' }, b: { text: healthy }, c: { text: healthy } }, {
      prepare: stage === 'prepare' ? hold : noop,
      read: async (job) => { if (job.job_id === 'a') await waiting.promise; },
      close: async (job) => {
        if (job.job_id === 'a') {
          observed.resolve();
          await finished.promise;
        }
      },
    });
    const db = await database(t, f.jobs);
    const original = f.jobs.map((j) => saved(db, j.job_id));
    const pending = run(f, db, { opts: { ...opts, batchSize: 2 }, [stage === 'prepare' ? 'stagger' : stage]: stage === 'prepare' ? noop : hold });
    await observed.promise;
    // Let the delayed worker resume while restriction cleanup is still held.
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(f.events.filter((e) => e.startsWith('navigate:')), ['navigate:a']);
    if (stage === 'prepare') assert.ok(f.events.includes('close:b'));
    else assert.ok(!f.events.includes('prepare:b'));
    finished.resolve();
    const result = await pending;
    assert.deepEqual(f.requests, ['a']);
    assert.deepEqual(result.deferredIds, ['a', 'b', 'c']);
    assert.deepEqual(f.jobs.map((j) => saved(db, j.job_id)), original);
    accounting(result, f.jobs);
  });
}

test('already admitted success persists after restriction and cannot start a later batch', { timeout: 10000 }, async (t) => {
  const admitted = gate(), observed = gate();
  const f = await fixture(t, { a: { text: 'Too many requests' }, b: { text: healthy }, c: { text: healthy } }, {
    navigate: async (job) => { if (job.job_id === 'b') admitted.resolve(); },
    read: async (job) => { await (job.job_id === 'a' ? admitted.promise : observed.promise); },
    close: async (job) => { if (job.job_id === 'a') observed.resolve(); },
  });
  const db = await database(t, f.jobs);
  const result = await run(f, db, { opts: { ...opts, batchSize: 2 } });
  assert.deepEqual(f.requests.sort(), ['a', 'b']);
  assert.deepEqual(result.deferredIds, ['a', 'c']);
  assert.equal(result.written, 1);
  assert.match(saved(db, 'b').job.description_text, /Build reliable systems/);
  accounting(result, f.jobs);
});

test('first canonical cause survives a later in-flight restriction', { timeout: 10000 }, async (t) => {
  const admitted = gate(), observed = gate();
  const f = await fixture(t, { a: { text: 'Too many requests' }, b: { text: 'Please solve CAPTCHA' } }, {
    navigate: async (job) => { if (job.job_id === 'b') admitted.resolve(); },
    read: async (job) => { await (job.job_id === 'a' ? admitted.promise : observed.promise); },
    close: async (job) => { if (job.job_id === 'a') observed.resolve(); },
  });
  const result = await run(f, await database(t, f.jobs), { opts: { ...opts, batchSize: 2 } });
  assert.equal(result.restriction.state, 'rate_limited');
  assert.equal(result.restriction.job_id, 'a');
  assert.deepEqual(result.deferredIds, ['a', 'b']);
  accounting(result, f.jobs);
});

for (const [state, snapshot] of [
  ['active_challenge', { text: 'Please solve CAPTCHA' }],
  ['blocked', { title: 'Security verification', text: '' }],
  ['login_required', { text: 'Sign in to LinkedIn' }],
  ['login_required', { text: '', url: 'http://127.0.0.1/login' }],
  ['active_challenge', { text: `${healthy}\nPlease solve CAPTCHA`, url: 'https://www.linkedin.com/checkpoint/fixture' }],
]) {
  test(`canonical ${state} snapshot is deferred`, async (t) => {
    const f = await fixture(t, { a: snapshot });
    const result = await run(f, await database(t, f.jobs));
    assert.equal(result.restriction.state, state);
    assert.equal(result.written, 0);
    assert.deepEqual(result.deferredIds, ['a']);
  });
}

test('healthy prose and passive CAPTCHA keep normal extraction and language filters', async (t) => {
  const f = await fixture(t, {
    a: { text: `${healthy}\n<script>recaptcha verify challenge</script>` },
    b: { text: healthy.replace('English required', 'German required') },
  });
  const result = await run(f, await database(t, f.jobs));
  assert.equal(result.restriction, null);
  assert.equal(result.written, 2);
  assert.equal(result.passed, 1);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.deferredIds, []);
});

test('ordinary transport and extraction errors remain failures and later jobs run', async (t) => {
  const f = await fixture(t, { a: { text: healthy }, b: { text: 'short' }, c: { text: healthy } }, {
    prepare: async (job) => { if (job.job_id === 'a') throw new Error('fixture transport failure'); },
  });
  // Repeated snapshots model a page that never yields extractable detail text.
  const baseTransport = f.transport;
  f.transport = (job) => {
    const page = baseTransport(job);
    if (job.job_id === 'b') page.read = async () => ({ text: 'short', url: job.url });
    return page;
  };
  const result = await run(f, await database(t, f.jobs));
  assert.equal(result.restriction, null);
  assert.equal(result.errors, 1);
  assert.equal(result.failed, 2);
  assert.equal(result.written, 3);
  assert.match(result.results[0].reason, /Error fetching page: fixture transport failure/);
  assert.match(result.results[1].reason, /Could not extract JD/);
  assert.deepEqual(f.requests, ['b', 'c']);
  accounting(result, f.jobs);
});

test('dry-run leaves real SQLite unchanged and empty input admits nothing', async (t) => {
  const f = await fixture(t, { a: { text: healthy }, b: { text: 'Too many requests' } });
  const db = await database(t, f.jobs);
  const original = f.jobs.map((j) => saved(db, j.job_id));
  const result = await run(f, db, { opts: { ...opts, dryRun: true } });
  assert.equal(result.written, 0);
  assert.deepEqual(result.deferredIds, ['b']);
  assert.deepEqual(f.jobs.map((j) => saved(db, j.job_id)), original);
  const empty = await run(f, null, { jobs: [] });
  assert.equal(empty.processed, 0);
  assert.equal(empty.restriction, null);
  assert.deepEqual(empty.results, []);
  assert.deepEqual(f.requests, ['a', 'b']);
});

test('restriction persists the pause at observation before cleanup', { timeout: 10000 }, async (t) => {
  const order = [];
  const f = await fixture(t, { a: { text: 'Too many requests' }, b: { text: healthy } }, {
    close: async (job) => { order.push(`close:${job.job_id}:pauses=${f.pauses.length}`); },
  });
  const result = await run(f, await database(t, f.jobs));
  assert.deepEqual(f.pauses.map((p) => [p.job_id, p.state]), [['a', 'rate_limited']]);
  assert.deepEqual(order, ['close:a:pauses=1']);
  assert.equal(result.pause.ok, true);
  assert.deepEqual(result.deferredIds, ['a', 'b']);
  accounting(result, f.jobs);
});

test('restriction pause reaches real SQLite access state', { timeout: 10000 }, async (t) => {
  const f = await fixture(t, { a: { text: 'Security verification' }, b: { text: healthy } });
  const db = await database(t, f.jobs, { access: readyRecord() });
  assert.equal(readLinkedInAccess(db.name).allowed, true);
  const result = await run(f, db, { opts: { ...opts, db: db.name }, pause: undefined });
  assert.equal(result.pause.ok, true);
  const access = readLinkedInAccess(db.name);
  assert.equal(access.record.state, 'paused');
  assert.equal(access.record.reason, 'backfill observed blocked');
  assert.deepEqual(result.deferredIds, ['a', 'b']);
  // A restriction with unwritable access state is still terminal; the failed
  // pause is reported, not hidden.
  const g = await fixture(t, { a: { text: 'Too many requests' } });
  const bare = await database(t, g.jobs);
  const failed = await run(g, bare, { opts: { ...opts, db: bare.name }, pause: undefined });
  assert.equal(failed.pause.ok, false);
  assert.equal(failed.pause.error.code, 'MISSING_STATE');
  assert.deepEqual(failed.deferredIds, ['a']);
});

test('stored non-jobs destinations are excluded before navigation', { timeout: 10000 }, async (t) => {
  const f = await fixture(t, { a: { text: healthy }, b: { text: healthy }, c: { text: healthy } });
  f.jobs[1].url = 'https://www.linkedin.com/in/person';
  f.jobs[2].url = 'https://example.test/jobs/view/1';
  const db = await database(t, f.jobs);
  const beforeB = saved(db, 'b'), beforeC = saved(db, 'c');
  const result = await run(f, db);
  assert.deepEqual(f.requests, ['a']);
  assert.equal(f.events.some((e) => e.endsWith(':b') || e.endsWith(':c')), false);
  assert.equal(result.excluded, 2);
  assert.equal(result.written, 1);
  assert.equal(result.restriction, null);
  assert.deepEqual(result.results.filter((r) => r.excluded).map((r) => [r.job.job_id, r.code]), [['b', 'disallowed_route'], ['c', 'disallowed_host']]);
  assert.deepEqual(saved(db, 'b'), beforeB);
  assert.deepEqual(saved(db, 'c'), beforeC);
  assert.deepEqual(f.pauses, []);
  accounting(result, f.jobs);
});

test('paused or missing access state stops the CLI before any CDP contact', { timeout: 20000 }, async (t) => {
  const dir = await mkdtemp(join(scratch, 'cli-'));
  const file = join(dir, 'paused.sqlite');
  const db = new Database(file);
  db.exec('CREATE TABLE jh_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  db.prepare('INSERT INTO jh_meta (key, value) VALUES (?, ?)').run(accessKey, JSON.stringify(pausedRecord()));
  db.close();
  const hits = [];
  const server = createServer((req, res) => { hits.push(req.url); res.statusCode = 404; res.end(); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const port = String(server.address().port);
  const env = { ...process.env, JOBHUNTER_HOME: scratch, LINKEDIN_CDP_PORT: port, BROWSER_CDP_PORT: port, OBSCURA_CDP_PORT: port, OBSCURA_PORT: port };
  for (const [database, code] of [[file, 'SOURCE_PAUSED'], [join(dir, 'missing.sqlite'), 'ACCESS_STATE_UNAVAILABLE']]) {
    const child = spawnSync(process.execPath, [backfillScript, '--db', database, '--port', port], { encoding: 'utf8', env, timeout: 15000 });
    assert.equal(child.status, 2, child.stderr);
    assert.equal(child.stderr, '');
    const lines = child.stdout.trim().split('\n');
    assert.equal(lines.length, 1, child.stdout);
    assert.deepEqual(JSON.parse(lines[0]), { ok: false, blocked: true, code, reason: code === 'SOURCE_PAUSED' ? 'LinkedIn research is paused' : 'LinkedIn access state is unavailable' });
    assert.equal(child.stdout.includes(dir), false);
  }
  assert.deepEqual(hits, []);
});
