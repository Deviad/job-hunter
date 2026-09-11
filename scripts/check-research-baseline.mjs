import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Acquisition-only checkpoint: requires private evidence and the original runtime sources.
// Run explicitly with npm run verify:research-baseline before intentional runtime edits.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ART = join(ROOT, 'agent-output', 'linkedin-research-safety', 'US-001');

const MANIFEST_SHA256 = 'eead31cb082eb71a6c66729227ea582a69bf5a7a17c0a7fc67e0ecaef825238b';
const BACKUP_SHA256 = '750254e5300ee7804867c255c3d7957e42a44d969725a321b12d9b785d1bd2a7';
const MARKERS = [
  'search-linkedin-jobs.mjs:396',
  'batch-fetch-jds.mjs:661',
  'cdp-preflight.mjs:168',
  'enrich-pipeline.mjs:168',
  'external-salary-scan.mjs:138',
  'jh-search.mjs:198',
];

const ARTIFACTS = [
  'checksum-manifest.txt',
  'runtime-inventory.json',
  'caller-inventory.md',
  'baseline.json',
  'baseline-check.json',
];

function readText(name) {
  const p = join(ART, name);
  assert.ok(existsSync(p), `missing artifact: ${name}`);
  const text = readFileSync(p, 'utf8');
  assert.ok(text.trim().length > 0, `empty artifact: ${name}`);
  return text;
}

function readJson(name) {
  return JSON.parse(readText(name));
}

function walk(dir, skip = ['node_modules', '__pycache__', '.DS_Store']) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries = [];
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (skip.includes(ent.name)) continue;
      const full = join(cur, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (ent.isFile()) out.push(full);
    }
  }
  return out;
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

test('all five US-001 artifacts exist and parse', () => {
  for (const name of ARTIFACTS) readText(name);
  for (const name of ['runtime-inventory.json', 'baseline.json', 'baseline-check.json']) {
    const doc = readJson(name);
    assert.equal(typeof doc, 'object', `${name} must parse to JSON`);
    assert.equal(doc.schemaVersion, 1, `${name} must carry schemaVersion 1`);
  }
});

test('runtime inventory classifies every entry point', () => {
  const inv = readJson('runtime-inventory.json');
  assert.equal(inv.schemaVersion, 1);
  assert.ok(Array.isArray(inv.entrypoints), 'entrypoints must be an array');
  assert.ok(inv.entrypoints.length >= 53, `expected at least 53 entry points, got ${inv.entrypoints.length}`);
  const allowed = new Set(['both', 'installed-only', 'missing']);
  const counts = { both: 0, 'installed-only': 0, missing: 0 };
  for (const ep of inv.entrypoints) {
    assert.ok(typeof ep.name === 'string' && ep.name.length > 0, 'entry point needs a name');
    assert.ok(allowed.has(ep.classification), `unclassified entry point: ${ep.name}`);
    counts[ep.classification] += 1;
    if (ep.classification === 'both') {
      assert.ok(ep.repoSha256 && ep.installedSha256, `${ep.name} needs a sha256 pair`);
    }
  }
  const t = inv.derivation.totals;
  assert.equal(t.both, counts.both);
  assert.equal(t.installedOnly, counts['installed-only']);
  assert.equal(t.missing, counts.missing);
  assert.equal(counts.both + counts['installed-only'] + counts.missing, inv.entrypoints.length);
});

// Acceptance criterion 1 names runtime-inventory.json itself, so the caller
// graph, the drift decisions and the evidence references have to live in that
// file, not only in caller-inventory.md.
test('every entry point carries caller relationships, a drift decision and evidence references', () => {
  const inv = readJson('runtime-inventory.json');
  const callerKinds = new Set([
    'spawned-by',
    'launched-by',
    'imported-by',
    'imports',
    'launches',
    'documented-invocation',
    'truncated',
    'unknown',
    'self-check',
  ]);
  for (const ep of inv.entrypoints) {
    // referencedAt is required, not optional: it is the documentation citation
    // that made this entry point an entry point in the first place.
    assert.ok(Array.isArray(ep.referencedAt) && ep.referencedAt.length > 0,
      `${ep.name} must record at least one SKILL.md reference`);
    assert.ok(Array.isArray(ep.callerRelationships) && ep.callerRelationships.length > 0,
      `${ep.name} must record caller relationships`);
    for (const rel of ep.callerRelationships) {
      assert.ok(callerKinds.has(rel.kind), `${ep.name}: unknown relationship kind ${rel.kind}`);
      assert.ok(typeof rel.from === 'string' && rel.from.length > 0, `${ep.name}: relationship needs a source`);
      assert.ok(typeof rel.at === 'string' && rel.at.length > 0, `${ep.name}: relationship needs a file:line or an explicit not-found note`);
      assert.ok(typeof rel.basis === 'string' && rel.basis.length > 0, `${ep.name}: relationship needs its evidence basis`);
    }
    assert.ok(ep.driftDecision && typeof ep.driftDecision === 'object',
      `${ep.name} must record a drift decision`);
    for (const key of ['state', 'reconciliationClass', 'decision', 'targetWave']) {
      assert.ok(typeof ep.driftDecision[key] === 'string' && ep.driftDecision[key].length > 0,
        `${ep.name}.driftDecision is missing ${key}`);
    }
    assert.ok(Array.isArray(ep.evidenceReferences) && ep.evidenceReferences.length > 0,
      `${ep.name} must record evidence references`);
    for (const ref of ep.evidenceReferences) {
      assert.ok(typeof ref === 'string' && ref.length > 0, `${ep.name}: empty evidence reference`);
    }
  }
  // The jh-search gate chain must be expressed as relationships inside the
  // inventory itself, not only as prose in caller-inventory.md.
  for (const gated of ['jh-doctor.mjs', 'cdp-preflight.mjs', 'search-linkedin-jobs.mjs', 'search-indeed-jobs.mjs']) {
    const ep = inv.entrypoints.find((e) => e.name === gated);
    assert.ok(ep, `${gated} must be inventoried`);
    assert.ok(ep.callerRelationships.some((rel) => rel.from.includes('jh-search.mjs') && rel.kind !== 'documented-invocation'),
      `${gated} must record the jh-search spawn that launches it`);
  }
  const unknowns = inv.entrypoints.filter((ep) =>
    ep.callerRelationships.every((rel) => rel.kind === 'unknown'));
  for (const ep of unknowns) {
    assert.equal(ep.classification, 'installed-only',
      `${ep.name} records no caller; that is only acceptable for an installed-only entry point`);
  }
});

test('paired drift decisions match the grounded reconciliation report', () => {
  const inv = readJson('runtime-inventory.json');
  const reports = new Map();
  for (const entry of inv.entrypoints.filter((ep) => ep.classification === 'both' && !ep.identical)) {
    const decision = entry.driftDecision;
    const evidence = decision.analysisEvidence;
    assert.ok(evidence, `${entry.name}: grounded drift evidence is missing`);
    if (!reports.has(evidence.reportPath)) {
      const bytes = readFileSync(join(ROOT, evidence.reportPath));
      const report = JSON.parse(bytes);
      const findings = report.claims.flatMap((claim) => claim.evidence
        .filter((item) => item.source === 'consolidated-drift-finding')
        .map((item) => JSON.parse(item.detail)));
      assert.equal(new Set(findings.map((finding) => finding.name)).size, findings.length);
      reports.set(evidence.reportPath, { hash: sha256(bytes), findings });
    }
    const report = reports.get(evidence.reportPath);
    assert.equal(evidence.reportSha256, report.hash);
    const finding = report.findings.find((item) => item.name === entry.name);
    assert.ok(finding, `${entry.name}: source-pair finding is missing`);
    for (const key of ['repoPath', 'installedPath', 'repoSha256', 'installedSha256']) {
      assert.equal(finding[key], entry[key], `${entry.name}: ${key} differs`);
    }
    for (const key of ['categories', 'reconciliationClass', 'classBasis', 'decision', 'targetWave', 'differences']) {
      assert.deepEqual(decision[key], finding[key], `${entry.name}: ${key} is not the grounded decision`);
    }
    assert.ok(decision.differences.length > 0, `${entry.name}: source differences are missing`);
    assert.doesNotMatch(decision.targetWave, /not assigned|generic deferral/i);
  }
});

test('byte-identical drift summaries agree with entrypoint measurements', () => {
  const inv = readJson('runtime-inventory.json');
  for (const summary of inv.drift.byteIdenticalInBothTrees) {
    assert.equal(summary.identical, true, `${summary.name} is listed as byte-identical`);
    const name = summary.name.split('/').pop();
    const entry = inv.entrypoints.find((ep) => ep.name === name);
    if (!entry) continue;
    assert.equal(entry.identical, true, `${name}: summary disagrees with entrypoint`);
    assert.equal(entry.repoSha256, entry.installedSha256, `${name}: hashes differ`);
    assert.equal(summary.sha256_12, entry.repoSha256.slice(0, 12));
    if (summary.measuredThisSlice) {
      const measured = summary.measuredThisSlice;
      assert.ok(measured.paths.every((path) => path.split('/').pop() === name),
        `${name}: measurements name a different file`);
      assert.equal(measured.repo, entry.repoSha256.slice(0, 12));
      assert.equal(measured.installed, entry.installedSha256.slice(0, 12));
    }
  }
});

test('scorer classifier edge records a subprocess launch', () => {
  const inv = readJson('runtime-inventory.json');
  const scorer = inv.entrypoints.find((ep) => ep.name === 'score_jobs_inline.py');
  assert.ok(scorer, 'scorer entrypoint is missing');
  const edge = scorer.callerRelationships.find((rel) =>
    rel.from === `repo:${scorer.repoPath}` && rel.at.includes('CLASSIFIER_CLI'));
  assert.ok(edge, 'scorer classifier edge is missing');
  assert.equal(edge.kind, 'launches');
  assert.equal(edge.to, 'repo:skills/job-hunter/scripts/role-classifier-cli.mjs');
  const source = readFileSync(join(ROOT, scorer.repoPath), 'utf8');
  assert.match(source, /subprocess\.run\(\s*\["node",\s*str\(CLASSIFIER_CLI\)/);
  assert.ok(existsSync(join(ROOT, edge.to.slice('repo:'.length))));
});

test('drift block carries the file-level totals and the three drift classes', () => {
  const inv = readJson('runtime-inventory.json');
  assert.ok(inv.drift, 'runtime-inventory.json must carry a drift block');
  assert.deepEqual(inv.drift.summary, { same: 96, diff: 71, repoOnly: 3, installedOnly: 223 });
  assert.equal(inv.drift.repoOnly.length, 3);
  assert.ok(inv.drift.classes.length >= 3, 'the three reconciliation classes must be recorded');
  for (const cls of inv.drift.classes) {
    assert.ok(typeof cls.kind === 'string' && cls.kind.length > 0, 'drift class needs a name');
    const evidence = (typeof cls.example === 'string' && cls.example.length > 0)
      || (typeof cls.note === 'string' && cls.note.length > 0)
      || cls.skillMdLineCountsRepoVsInstalled;
    assert.ok(evidence, `drift class ${cls.kind} needs an example or a recorded measurement`);
  }
  assert.ok(inv.drift.perEntrypointDecisionClasses, 'per-entry point decision classes must be summarised');
  const total = Object.values(inv.drift.perEntrypointDecisionClasses).reduce((a, b) => a + b, 0);
  assert.equal(total, inv.entrypoints.length, 'every entry point must fall into one drift decision class');
});

test('runtime inventory separates observed execution from static capability', () => {
  const inv = readJson('runtime-inventory.json');
  assert.ok(Array.isArray(inv.observedExecution) && inv.observedExecution.length > 0);
  assert.ok(Array.isArray(inv.staticCapability) && inv.staticCapability.length > 0);
  assert.ok(inv.interpreters && inv.interpreters.node, 'interpreters.node missing');
  // The authoritative scorer interpreter is the Homebrew python3. It is derived
  // from os.homedir() instead of a literal machine path so this file stays free
  // of machine-absolute paths, which scripts/check-release-safety.mjs rejects.
  const suffix = join('.brew', 'bin', 'python3');
  const recorded = inv.interpreters.authoritativeScorerInterpreter;
  assert.ok(typeof recorded === 'string' && recorded.endsWith(suffix),
    `authoritativeScorerInterpreter must name the .brew/bin/python3 interpreter, got ${recorded}`);
  assert.equal(inv.interpreters.authoritativeScorerInterpreterVersion, '3.14.7');
  assert.equal(inv.interpreters.python3Path.canExecuteScorer, false);
  const onThisMachine = join(homedir(), suffix);
  if (existsSync(onThisMachine)) {
    assert.equal(recorded, onThisMachine, 'the recorded interpreter is not the one on this machine');
  }
  for (const line of inv.observedExecution) {
    for (const staticLine of inv.staticCapability) {
      assert.notEqual(line, staticLine, 'observed execution must not duplicate a static capability');
    }
  }
});

test('checksum manifest recomputes to the recorded digest with no drift', (t) => {
  const text = readText('checksum-manifest.txt');
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  assert.equal(lines.length, 400, `expected 400 manifest lines, got ${lines.length}`);
  for (const line of lines) {
    assert.match(line, /^[0-9a-f]{64}  \S/, `malformed manifest line: ${line.slice(0, 80)}`);
  }
  assert.deepEqual([...lines].sort(), lines, 'manifest lines must be sorted');

  // The recorded digest is the sha256 of the manifest bytes (400 "hash  path"
  // lines joined by newlines, no trailing newline). See baseline-check.json
  // checksumDigestConventionNote for the with/without-newline pair.
  const raw = readFileSync(join(ART, 'checksum-manifest.txt'));
  assert.equal(sha256(raw), MANIFEST_SHA256, 'manifest digest drifted from the recorded before-research value');

  // Recompute against the live trees where the referenced files are present.
  // Scratch needs go to mkdtempSync, never into the repository.
  const scratch = mkdtempSync(join(tmpdir(), 'us001-manifest-'));
  try {
    const missing = [];
    const drifted = [];
    let checked = 0;
    const report = [];
    for (const line of lines) {
      const [want, path] = [line.slice(0, 64), line.slice(66)];
      const full = isAbsolute(path) ? path : resolve(ROOT, path);
      if (!existsSync(full)) {
        missing.push(path);
        continue;
      }
      checked += 1;
      const got = sha256(readFileSync(full));
      if (got !== want) drifted.push(path);
    }
    report.push(`checked=${checked} missing=${missing.length} drifted=${drifted.length}`);
    writeFileSync(join(scratch, 'recount.txt'), report.join('\n') + '\n');
    if (checked === 0) {
      // A checkout with no private evidence trees at all re-hashes nothing; it
      // is reported, not passed. Any partial evidence set must re-hash clean.
      t.skip('no checksummed tree is present on this machine; nothing was re-hashed');
      return;
    }
    assert.equal(missing.length, 0,
      `${missing.length} of ${lines.length} manifest paths are absent, so the before/after digest comparison is incomplete: ${missing.slice(0, 5).join(', ')}`);
    assert.deepEqual(drifted, [], `hash drift in the checksummed trees: ${drifted.slice(0, 5).join(', ')}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('baseline-check records a clean, read-only slice', () => {
  const chk = readJson('baseline-check.json');
  assert.equal(chk.linkedinRequests, 0);
  assert.equal(chk.jobhunterHomeWrites, 0);
  assert.equal(chk.installedTreeWrites, 0);
  assert.equal(chk.integrityCheck, 'ok');
  assert.equal(chk.checksumManifestSha256Before, MANIFEST_SHA256);
  assert.equal(chk.checksumManifestSha256After, MANIFEST_SHA256);
  assert.equal(chk.checksumManifestSha256Before, chk.checksumManifestSha256After);
  assert.equal(chk.gitCommandsRunInSandbox, 0);
  assert.equal(chk.gitStateCapturedBy, 'supervisor-host-side');
});

test('caller inventory carries the six marker strings', () => {
  const md = readText('caller-inventory.md');
  for (const marker of MARKERS) {
    assert.ok(md.includes(marker), `missing marker: ${marker}`);
  }
});

test('baseline carries the source backup digest and the 20-row slice', () => {
  const base = readJson('baseline.json');
  assert.equal(base.sourceBackupSha256, BACKUP_SHA256);
  assert.equal(base.sliceRowCount, 20);
  assert.equal(base.rows.length, 20);
  assert.equal(base.integrityCheck, 'ok');
  for (const row of base.rows) {
    assert.match(row.descriptionSha256, /^[0-9a-f]{64}$/, 'digests only, never description text');
  }
  const corpus = base.corpusTotals;
  assert.equal(corpus.jobs, 3308);
  assert.equal(corpus.linkedin, 2725);
  assert.equal(corpus.linkedinWithDescription, 2492);
  assert.equal(corpus.linkedinCanonicalJobsViewUrl, 2701);
  assert.equal(corpus.indeed, 556);
  assert.equal(base.schemaGaps.jobFetchStateTablePresent, false);
  assert.equal(base.schemaGaps.jobSponsorshipObservationsTablePresent, false);
  assert.equal(base.schemaGaps.jobsMissingColumns.includes('fetched_at'), true);
  assert.equal(base.schemaGaps.jobsMissingColumns.includes('content_hash'), true);
});

test('no published file under skills/ gained a machine-absolute path', () => {
  const skillsDir = join(ROOT, 'skills');
  const offenders = [];
  const prefix = `/${'Users'}/`;
  for (const file of walk(skillsDir)) {
    const st = statSync(file);
    if (st.size > 1024 * 1024) continue;
    const body = readFileSync(file, 'latin1');
    if (body.includes(prefix)) offenders.push(relative(ROOT, file));
  }
  assert.deepEqual(offenders, [], `machine-absolute path leaked: ${offenders.join(', ')}`);
});

// ---- round 3: citation truth is machine-checkable -------------------------
// Acceptance criterion 1 is only worth anything while a machine can tell a real
// citation from an invented one, so every file:line range recorded in
// runtime-inventory.json is re-checked against the two real trees below. The
// installed root is derived rather than written down: PI_AGENT_SKILLS_DIR
// first, otherwise the user home directory plus .pi/agent/skills. That keeps
// this file free of machine-absolute paths, which scripts/check-release-safety
// .mjs rejects in any published file.

const LAUNCH_TOKENS = [
  'spawn(',
  'spawnSync(',
  'execFile(',
  'execFileSync(',
  'execSync(',
  'fork(',
  'subprocess.run(',
  'Popen(',
];
const LAUNCH_KINDS = new Set(['spawned-by', 'launches', 'launched-by']);
const INSTALLED_ROOT = process.env.PI_AGENT_SKILLS_DIR
  || join(homedir(), '.pi', 'agent', 'skills');

const treeRoot = (tree) => (tree === 'repo' ? ROOT : (tree === 'installed' ? INSTALLED_ROOT : null));

function relationships(inv) {
  const out = [];
  for (const ep of inv.entrypoints) {
    for (const rel of ep.callerRelationships) out.push({ ep, rel });
  }
  return out;
}

function rangeHits(lines, ranges, predicate) {
  for (const [start, end] of ranges) {
    for (let i = Math.max(1, start); i <= Math.min(lines.length, end); i += 1) {
      if (predicate(lines[i - 1])) return true;
    }
  }
  return false;
}

function notePathChecks(owner, entry, installedAvailable, disagreements) {
  assert.ok(typeof entry.existsInRepo === 'boolean', `${owner}: existsInRepo must be an explicit boolean`);
  assert.ok(typeof entry.existsInstalled === 'boolean', `${owner}: existsInstalled must be an explicit boolean`);
  assert.ok(Array.isArray(entry.checkedPaths) && entry.checkedPaths.length > 0,
    `${owner}: the paths that were checked must be recorded`);
  for (const check of entry.checkedPaths) {
    const root = treeRoot(check.tree);
    const full = root === null ? resolve(check.path) : join(root, check.path);
    if (root !== null && !existsSync(root)) continue;
    if (check.tree === 'installed' && !installedAvailable) continue;
    const actual = existsSync(full);
    assert.equal(check.exists, actual,
      `${owner}: ${check.tree}:${check.path} records exists=${check.exists} but existsSync reports ${actual}`);
  }
}

function noteFlagChecks(owner, entry) {
  const pairs = [['existsInRepo', 'repo'], ['existsInstalled', 'installed']];
  for (const [flag, tree] of pairs) {
    const own = entry.checkedPaths.filter((c) => c.tree === tree && c.path.endsWith(entry.name));
    if (own.length === 0) continue;
    const anyExists = own.some((c) => c.exists);
    assert.equal(entry[flag], anyExists,
      `${owner}: ${flag}=${entry[flag]} contradicts the recorded checked paths for ${entry.name}`);
  }
}

test('every caller relationship carries a well-formed citations array', () => {
  const inv = readJson('runtime-inventory.json');
  let rels = 0;
  let cites = 0;
  for (const { ep, rel } of relationships(inv)) {
    rels += 1;
    assert.ok(Array.isArray(rel.citations), `${ep.name}: relationship on ${rel.from} carries no citations array`);
    if (rel.citations.length === 0) {
      assert.equal(rel.kind, 'truncated',
        `${ep.name}: only a truncated scan entry may carry no citation, found kind ${rel.kind}`);
      continue;
    }
    for (const cite of rel.citations) {
      cites += 1;
      assert.ok(['repo', 'installed'].includes(cite.tree), `${ep.name}: citation tree ${cite.tree} is neither repo nor installed`);
      assert.ok(typeof cite.path === 'string' && cite.path.length > 0, `${ep.name}: citation without a path`);
      assert.ok(!isAbsolute(cite.path) && !cite.path.startsWith('~'),
        `${ep.name}: citation path must stay tree-relative, got ${cite.path}`);
      assert.ok(Array.isArray(cite.lines) && cite.lines.length > 0,
        `${ep.name}: citation ${cite.path} needs at least one [start, end] range`);
      for (const range of cite.lines) {
        assert.equal(range.length, 2, `${ep.name}: line range ${JSON.stringify(range)} is not a pair`);
        assert.ok(range[0] >= 1 && range[1] >= range[0],
          `${ep.name}: line range ${JSON.stringify(range)} is not an ordered positive pair`);
      }
    }
    if (LAUNCH_KINDS.has(rel.kind)) {
      assert.ok(rel.citations.every((c) => c.lines.length > 0),
        `${ep.name}: a ${rel.kind} relationship must cite line ranges, not prose`);
    }
  }
  assert.ok(rels >= 150, `the caller graph must stay populated, found ${rels} relationships`);
  assert.ok(cites >= 100, `the citation set must stay populated, found ${cites} citations`);
});

test('every cited file exists, every cited range fits, and each launch relationship cites a real launch site', (t) => {
  const inv = readJson('runtime-inventory.json');
  const installedAvailable = existsSync(INSTALLED_ROOT);
  const missing = [];
  const outOfRange = [];
  const noLaunchToken = [];
  let checked = 0;
  let skippedInstalled = 0;
  for (const { ep, rel } of relationships(inv)) {
    for (const cite of rel.citations) {
      const root = treeRoot(cite.tree);
      assert.ok(root !== null, `${ep.name}: unknown citation tree ${cite.tree}`);
      const full = join(root, cite.path);
      if (!existsSync(full)) {
        if (cite.tree === 'installed' && !installedAvailable) {
          skippedInstalled += 1;
          continue;
        }
        missing.push(`${cite.tree}:${cite.path}`);
        continue;
      }
      const lines = readFileSync(full, 'utf8').split('\n');
      checked += 1;
      for (const [start, end] of cite.lines) {
        if (start < 1 || end > lines.length) {
          outOfRange.push(`${cite.tree}:${cite.path} ${start}-${end} of ${lines.length} lines`);
        }
      }
      if (LAUNCH_KINDS.has(rel.kind)) {
        const hit = rangeHits(lines, cite.lines, (line) => LAUNCH_TOKENS.some((tok) => line.includes(tok)));
        if (!hit) noLaunchToken.push(`${ep.name} <- ${cite.tree}:${cite.path} ${JSON.stringify(cite.lines)}`);
      }
    }
  }
  assert.deepEqual(missing, [], `cited files that do not exist: ${missing.join(', ')}`);
  assert.deepEqual(outOfRange, [], `cited ranges outside the cited file: ${outOfRange.join(', ')}`);
  assert.deepEqual(noLaunchToken, [],
    `launch relationships with no ${LAUNCH_TOKENS.join(', ')} token inside a cited range: ${noLaunchToken.join(', ')}`);
  assert.ok(checked > 0, 'not one citation could be checked on this machine');
  if (!installedAvailable) {
    t.diagnostic(`installed skill root ${INSTALLED_ROOT} is absent; ${skippedInstalled} installed citations were not verified here`);
  }
});

test('the jh-search gate chain cites spawn sites and never a classifySearchOutcome verdict', (t) => {
  const inv = readJson('runtime-inventory.json');
  const installedAvailable = existsSync(INSTALLED_ROOT);
  const offenders = [];
  for (const name of ['jh-doctor.mjs', 'cdp-preflight.mjs', 'search-linkedin-jobs.mjs', 'search-indeed-jobs.mjs']) {
    const ep = inv.entrypoints.find((e) => e.name === name);
    assert.ok(ep, `${name} must be inventoried`);
    for (const rel of ep.callerRelationships.filter((r) => r.from.endsWith('job-hunter/scripts/jh-search.mjs'))) {
      for (const cite of rel.citations) {
        const full = join(treeRoot(cite.tree), cite.path);
        if (!existsSync(full)) continue;
        const lines = readFileSync(full, 'utf8').split('\n');
        const verdictLine = rangeHits(lines, cite.lines, (line) => /return \{ verdict:/.test(line));
        const launchLine = rangeHits(lines, cite.lines, (line) => LAUNCH_TOKENS.some((tok) => line.includes(tok)));
        if (verdictLine || !launchLine) {
          offenders.push(`${name} <- ${cite.tree}:${cite.path} ${JSON.stringify(cite.lines)}`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [], `jh-search citations that name no launch site: ${offenders.join(', ')}`);
  const wrapper = join(INSTALLED_ROOT, 'job-hunter', 'scripts', 'jh-search.mjs');
  if (!existsSync(wrapper)) {
    t.diagnostic('the installed jh-search.mjs wrapper is not reachable on this machine');
    return;
  }
  const lines = readFileSync(wrapper, 'utf8').split('\n');
  const spawnLines = lines
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => LAUNCH_TOKENS.some((tok) => line.includes(tok)))
    .map(([n]) => n);
  assert.deepEqual(spawnLines, [277, 288, 380, 395],
    'the installed wrapper spawn sites moved; the recorded citations must be re-derived');
  assert.ok(installedAvailable, 'guard reached only when the installed tree exists');
});

test('missingEntrypointNotes is present, non-empty and agrees with the filesystem', (t) => {
  const inv = readJson('runtime-inventory.json');
  assert.ok(Array.isArray(inv.missingEntrypointNotes),
    'missingEntrypointNotes must stay present: it is the block that separates a dev-path reference from a real entry point');
  assert.ok(inv.missingEntrypointNotes.length > 0, 'missingEntrypointNotes must not be empty');
  const installedAvailable = existsSync(INSTALLED_ROOT);
  for (const note of inv.missingEntrypointNotes) {
    notePathChecks(note.name, note, installedAvailable, []);
    noteFlagChecks(note.name, note);
    for (const mate of note.counterpartFiles || []) {
      const owner = `${note.name} -> ${mate.name}`;
      notePathChecks(owner, mate, installedAvailable, []);
      noteFlagChecks(owner, mate);
      const repoHas = mate.checkedPaths.some((c) => c.tree === 'repo' && c.exists);
      const installedHas = mate.checkedPaths.some((c) => c.tree === 'installed' && c.exists);
      if (mate.classification === 'installed-only') {
        assert.ok(installedHas, `${owner}: claims installed-only while no installed copy was found`);
        assert.equal(repoHas, false,
          `${owner}: claims installed-only but a repository copy was found`);
      }
      if (mate.classification === 'both') {
        assert.ok(repoHas && installedHas,
          `${owner}: claims both but the checked paths do not show a copy in each tree`);
      }
      if (mate.classification === 'repo-only') {
        assert.ok(repoHas, `${owner}: claims repo-only while no repository copy was found`);
        assert.equal(installedHas, false,
          `${owner}: claims repo-only but an installed copy was found`);
      }
    }
  }
  // The round 2 defect was a note asserting an installed-only file that the
  // repository also carries. Assert that shape cannot come back, either as a
  // false recorded flag or as a copy the note simply failed to look at.
  const publishedFiles = walk(join(ROOT, 'skills')).concat(walk(join(ROOT, 'scripts')));
  const lies = [];
  for (const note of inv.missingEntrypointNotes) {
    for (const mate of note.counterpartFiles || []) {
      if (mate.classification !== 'installed-only') continue;
      const found = publishedFiles.filter((f) => f.endsWith(`/${mate.name}`));
      if (found.length > 0) {
        lies.push(`${note.name}: ${mate.name} is recorded installed-only but ${found.length} repository copy/copies exist (${found.slice(0, 2).join(', ')})`);
      }
    }
  }
  assert.deepEqual(lies, [], `installed-only claims contradicted by the repository tree: ${lies.join(' | ')}`);
  if (!installedAvailable) {
    t.diagnostic('installed skill root absent; installed-side note checks were skipped on this machine');
  }
});

test('runtime inventory and caller inventory state the same installed jh-search chain', () => {
  const md = readText('caller-inventory.md');
  assert.ok(md.includes('277 / 283-288 / 355-368 / 380 / 395'),
    'caller-inventory.md must keep the installed wrapper chain');
  const inv = readJson('runtime-inventory.json');
  const expected = {
    'search-linkedin-jobs.mjs': 380,
    'search-indeed-jobs.mjs': 395,
    'jh-doctor.mjs': 277,
    'cdp-preflight.mjs': 288,
  };
  for (const [name, spawnLine] of Object.entries(expected)) {
    const ep = inv.entrypoints.find((e) => e.name === name);
    const installed = ep.callerRelationships.filter((r) => r.from === 'installed:job-hunter/scripts/jh-search.mjs');
    assert.ok(installed.length > 0, `${name}: the installed wrapper relationship must stay recorded`);
    for (const rel of installed) {
      assert.ok(rel.citations.some((c) => c.path.endsWith('jh-search.mjs')
        && c.lines.some(([start, end]) => spawnLine >= start && spawnLine <= end)),
      `${name}: the installed citation must cover the real spawn line ${spawnLine}, not a verdict statement`);
    }
  }
});
