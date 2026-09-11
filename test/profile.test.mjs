// Profile derivation, refresh and merge contract (jh-profile-extract.mjs,
// jh-profile.mjs, jh_profile.py). Uses synthetic DOCX fixtures built in
// temporary directories; no personal CV, cache or network access.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { deflateRawSync } from 'node:zlib';
import { extractDocxText } from '../skills/job-hunter/scripts/docx-text.mjs';
import { deriveProfile, extractProfile, extractTitles, loadReferenceData, EXTRACTOR_VERSION, DERIVED_FILE, main as extractMain } from '../skills/job-hunter/scripts/jh-profile-extract.mjs';
import { loadProfile, profileStatus, resolveCountry, titleExcluded, ProfileError, reviewProfile, confirmProfile, main as profileMain } from '../skills/job-hunter/scripts/jh-profile.mjs';
import { classifyRole } from '../skills/job-hunter/scripts/role-taxonomy.mjs';
import { buildQueryPlan } from '../skills/linkedin-job-search/scripts/search-linkedin-jobs.mjs';

const extractorCli = path.resolve('skills/job-hunter/scripts/jh-profile-extract.mjs');
const profileCli = path.resolve('skills/job-hunter/scripts/jh-profile.mjs');
const pythonTwin = path.resolve('skills/job-match-scorer/scripts/jh_profile.py');

// ── Minimal zip writer (stored or deflated) so fixtures need no Python ──
const CRC_TABLE = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
function crc32(buffer) { let crc = -1; for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8); return (crc ^ -1) >>> 0; }
function zip(entries, { deflate = false } = {}) {
  const locals = [], centrals = []; let offset = 0;
  for (const [name, content] of entries) {
    const raw = Buffer.from(content, 'utf8');
    const data = deflate ? deflateRawSync(raw) : raw;
    const nameBuffer = Buffer.from(name, 'utf8');
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0, 6); header.writeUInt16LE(deflate ? 8 : 0, 8);
    header.writeUInt32LE(crc32(raw), 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(raw.length, 22); header.writeUInt16LE(nameBuffer.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc32(raw), 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(nameBuffer.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(header, nameBuffer, data); centrals.push(central, nameBuffer);
    offset += header.length + nameBuffer.length + data.length;
  }
  const centralStart = offset;
  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralBuffer.length, 12); end.writeUInt32LE(centralStart, 16);
  return Buffer.concat([...locals, centralBuffer, end]);
}
function docx(text, options) {
  const paragraphs = text.split('\n').map((line) => `<w:p><w:r><w:t xml:space="preserve">${line.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</w:t></w:r></w:p>`).join('');
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}</w:body></w:document>`;
  return zip([['[Content_Types].xml', '<Types/>'], ['word/document.xml', xml]], options);
}

const CV_ONE = `Alex Testerson
Senior Platform Engineer
Summary
Platform engineer with Kubernetes, Terraform & Go experience; migrated services to AWS.
Experience
Lead Platform Engineer | Example Corp | 2021 – 2024
Built CI/CD pipelines with GitHub Actions and deployed workloads on k8s.
Certifications
AWS Certified Solutions Architect, CKA
Languages
English — native
Spanish: B2 (upper intermediate)
German (basic)`;

const CV_TWO = `Sam Testerson
Embedded Software Engineer
Firmware in Embedded C and Rust on FreeRTOS; CAN bus diagnostics.
Languages
Dutch: native
English (fluent)`;

function home(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'jh-profile-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function readyCache(extra = {}) {
  return JSON.stringify({ schemaVersion: 2, languages: { English: 'native', Spanish: 'b2' }, rolePreferences: { preferredPrimaryRoles: ['Platform Architect', 'Cloud Architect'], adjacentRoles: { adjacentTechnicalLeadership: ['Lead Platform Engineer'], leadershipProgression: ['Head of Platform'] }, excludedTitleFamilies: ['early-career'] }, ...extra });
}
const quiet = () => {};

test('title suggestions do not treat skills or language entries as roles', () => {
  assert.deepEqual(extractTitles('Synthetic Person\nRegistered Nurse\nSkills\nWound care\nLanguages\nEnglish - native\nExperience\nClinical Educator | Example Hospital'), ['Registered Nurse', 'Clinical Educator']);
});

test('confirmation is bound to CV, preferences and search configuration in both runtimes', (t) => {
  const dir = home(t);
  writeFileSync(path.join(dir, 'CV.docx'), docx(CV_ONE));
  const cacheFile = path.join(dir, 'personal-info-cache.json');
  writeFileSync(cacheFile, readyCache());
  const cache = JSON.parse(readFileSync(cacheFile));
  cache.rolePreferences.queryExclusionTerms = [];
  writeFileSync(cacheFile, JSON.stringify(cache));
  const options = { home: dir, log: quiet };
  const initial = reviewProfile(options);
  const linkedCli = path.join(dir, 'profile-cli.mjs');
  symlinkSync(profileCli, linkedCli);
  const linkedReview = spawnSync(process.execPath, [linkedCli, 'review', '--home', dir, '--json'], { encoding: 'utf8' });
  assert.equal(linkedReview.status, 0, linkedReview.stderr);
  assert.equal(JSON.parse(linkedReview.stdout).confirmation.profileSha256, initial.confirmation.profileSha256, 'symlink invocation actually executes the CLI');
  const answersBeforeConfirmation = readFileSync(cacheFile, 'utf8');
  assert.equal(initial.confirmation.state, 'unconfirmed');
  assert.throws(() => loadProfile({ ...options, requireConfirmed: true }), { code: 'PROFILE_REVIEW_REQUIRED' });
  let confirmed = confirmProfile({ ...options, expectedProfileSha256: initial.confirmation.profileSha256 });
  assert.equal(confirmed.confirmation.state, 'confirmed');
  assert.equal(readFileSync(cacheFile, 'utf8'), answersBeforeConfirmation, 'confirmation never rewrites user answers');
  assert.equal(confirmed.provenance.profileSha256, initial.confirmation.profileSha256, 'confirmation timestamp does not invalidate itself');
  for (const mutate of [
    () => { const value = JSON.parse(readFileSync(cacheFile)); value.rolePreferences.adjacentRoles.acceptedRoles = ['Clinical Educator']; writeFileSync(cacheFile, JSON.stringify(value)); },
    () => { const value = JSON.parse(readFileSync(cacheFile)); value.languages.Dutch = 'none'; writeFileSync(cacheFile, JSON.stringify(value)); },
    () => writeFileSync(path.join(dir, 'search-config.json'), JSON.stringify({ countries: { NL: {} } })),
    () => writeFileSync(path.join(dir, 'CV.docx'), docx(CV_TWO)),
  ]) {
    const oldHash = confirmed.provenance.profileSha256;
    mutate();
    assert.throws(() => loadProfile({ ...options, requireConfirmed: true }), { code: 'PROFILE_REVIEW_REQUIRED' });
    assert.throws(() => confirmProfile({ ...options, expectedProfileSha256: oldHash }), { code: 'PROFILE_CHANGED' });
    const updated = reviewProfile(options);
    confirmed = confirmProfile({ ...options, expectedProfileSha256: updated.confirmation.profileSha256 });
    assert.notEqual(confirmed.provenance.profileSha256, oldHash);
  }
  const twin = spawnSync('python3', ['-c', `import sys,json; sys.path.insert(0,${JSON.stringify(path.dirname(pythonTwin))}); import jh_profile; print(json.dumps(jh_profile.load_profile(home=${JSON.stringify(dir)}, require_confirmed=True)['provenance']))`], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(twin.status, 0, twin.stderr);
  assert.equal(JSON.parse(twin.stdout).profileSha256, confirmed.provenance.profileSha256);
});

test('healthcare and construction profiles pass actual query, classifier and scoring paths', (t) => {
  for (const [role, adjacent, skill] of [['Registered Nurse', 'Clinical Educator', 'Wound care'], ['Civil Engineer', 'Structural Engineer', 'Structural analysis']]) {
    const dir = home(t);
    writeFileSync(path.join(dir, 'CV.docx'), docx(`Alex Example\n${role}\nSkills\n${skill}\nLanguages\nEnglish: fluent`));
    writeFileSync(path.join(dir, 'personal-info-cache.json'), JSON.stringify({ languages: { English: 'fluent' }, rolePreferences: { preferredPrimaryRoles: [role], adjacentRoles: { acceptedRoles: [adjacent] }, excludedTitleFamilies: [], queryExclusionTerms: [] } }));
    let profile = loadProfile({ home: dir, log: quiet });
    assert.ok(profile.derived.titles.values.includes(role), 'title suggestions are not limited to technology roles');
    profile = confirmProfile({ home: dir, expectedProfileSha256: profile.provenance.profileSha256, log: quiet });
    assert.deepEqual(buildQueryPlan({ role }, profile).queries, [role, adjacent]);
    assert.equal(classifyRole({ title: `Senior ${role}`, descriptionText: 'Saved job description', taxonomy: profile.taxonomy }).label, 'Primary role');
    assert.equal(classifyRole({ title: adjacent, taxonomy: profile.taxonomy }).label, 'Adjacent role');
    const jobs = path.join(dir, 'jobs.json');
    const output = path.join(dir, 'scores.json');
    writeFileSync(jobs, JSON.stringify([{ source: 'fixture', job_id: 'one', title: role, description: `Experience with ${skill} required. Fluent English required.` }]));
    const result = spawnSync('python3', [path.resolve('skills/job-match-scorer/scripts/score_jobs_inline.py')], { encoding: 'utf8', env: { ...process.env, JOBHUNTER_HOME: dir, SCORE_CV_PATH: path.join(dir, 'CV.docx'), SCORE_CACHE_PATH: path.join(dir, 'personal-info-cache.json'), SCORE_JOBS_PATH: jobs, SCORE_OUTPUT_PATH: output, SCORE_SEARCH_ID: '', SCORE_TARGET_ROLE: '' } });
    assert.equal(result.status, 0, result.stderr);
    const [score] = JSON.parse(readFileSync(output));
    assert.equal(score.role_family_inferred, 'Primary role');
    assert.ok(score.must_have_total >= 2, score.mandatory_skills_found_json);
    assert.equal(score.cta, 'Apply', score.blockers_json);
    assert.equal(score.fit_score, 100);
  }
});

test('extractor derives skills, certifications, languages and titles from a synthetic CV', (t) => {
  const dir = home(t);
  const cv = path.join(dir, 'CV.docx');
  writeFileSync(cv, docx(CV_ONE));
  writeFileSync(path.join(dir, 'CV-deflate.docx'), docx(CV_ONE, { deflate: true }));
  assert.equal(extractDocxText(cv), extractDocxText(path.join(dir, 'CV-deflate.docx')));
  assert.match(extractDocxText(cv), /Terraform & Go experience/);
  const reference = loadReferenceData();
  const derived = deriveProfile({ cvText: extractDocxText(cv), cvPath: cv, cvSha256: 'x', reference, now: new Date('2026-09-11T00:00:00Z') });
  const skills = Object.fromEntries(derived.skills.map((s) => [s.term, s]));
  assert.ok(skills.kubernetes && skills.terraform && skills.go && skills.aws && skills['github actions'], JSON.stringify(Object.keys(skills)));
  assert.equal(skills.kubernetes.matched, 'kubernetes');
  assert.match(skills.kubernetes.evidence, /^cv-span:\d+:.*Kubernetes/);
  assert.equal(skills.go.matched, 'go');
  assert.ok(!skills.golang, 'alias collapses onto the canonical term');
  assert.deepEqual(derived.certifications.map((c) => c.term).sort(), ['aws certified solutions architect', 'cka']);
  assert.deepEqual(derived.languages.map((l) => [l.name, l.level]), [['English', 'native'], ['Spanish', 'b2'], ['German', 'a1']]);
  assert.ok(derived.titles.heuristic);
  assert.ok(derived.titles.values.includes('Senior Platform Engineer'));
  assert.ok(derived.titles.values.includes('Lead Platform Engineer'));
  assert.ok(!derived.titles.values.some((v) => /Testerson/.test(v)));
  assert.equal(derived.extractorVersion, EXTRACTOR_VERSION);
  assert.equal(derived.referenceDataSha256, reference.sha256);
  assert.equal(derived.generatedAt, '2026-09-11T00:00:00.000Z');
  // CLI writes the derived file with private mode and reports counts.
  const cli = spawnSync(process.execPath, [extractorCli, '--home', dir, '--json'], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  const output = JSON.parse(cli.stdout);
  assert.equal(output.outPath, path.join(dir, DERIVED_FILE));
  assert.deepEqual(output.languages, ['English', 'Spanish', 'German']);
  assert.equal(extractMain(['--home', path.join(dir, 'nowhere'), '--quiet']), 2);
});

test('loadProfile extracts on first use and refreshes when the CV changes', (t) => {
  const dir = home(t);
  writeFileSync(path.join(dir, 'CV.docx'), docx(CV_ONE));
  writeFileSync(path.join(dir, 'personal-info-cache.json'), readyCache());
  assert.equal(profileStatus({ home: dir }).state, 'missing');
  const logs = [];
  const first = loadProfile({ home: dir, log: (line) => logs.push(line) });
  assert.equal(first.provenance.refreshed, true);
  assert.equal(first.provenance.status, 'current');
  assert.match(logs[0], /rebuilt from CV\.docx \(first extraction\)/);
  assert.ok(first.skillTerms.includes('kubernetes'));
  assert.deepEqual(first.speaks, ['English', 'Spanish']);
  assert.deepEqual(first.roles.primary, ['Platform Architect', 'Cloud Architect']);
  assert.equal(first.roles.source, 'cache');
  const derivedBefore = JSON.parse(readFileSync(path.join(dir, DERIVED_FILE), 'utf8'));
  // Same CV: no refresh, same derived bytes.
  const second = loadProfile({ home: dir, log: quiet });
  assert.equal(second.provenance.refreshed, false);
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, DERIVED_FILE), 'utf8')), derivedBefore);
  // New CV uploaded: stale is visible without side effects, then rebuilt automatically.
  writeFileSync(path.join(dir, 'CV.docx'), docx(CV_TWO));
  const stale = profileStatus({ home: dir });
  assert.equal(stale.state, 'stale');
  assert.match(stale.reason, /CV changed/);
  const never = loadProfile({ home: dir, refresh: 'never', log: quiet });
  assert.equal(never.provenance.status, 'stale');
  assert.ok(never.skillTerms.includes('kubernetes'), 'refresh: never keeps the old derived values');
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, DERIVED_FILE), 'utf8')), derivedBefore);
  const auto = loadProfile({ home: dir, log: (line) => logs.push(line) });
  assert.equal(auto.provenance.refreshed, true);
  assert.match(logs.at(-1), /CV changed since extraction/);
  assert.ok(auto.skillTerms.includes('rust') && auto.skillTerms.includes('embedded c') && auto.skillTerms.includes('freertos'));
  assert.ok(!auto.skillTerms.includes('kubernetes'));
  assert.deepEqual(auto.speaks, ['English', 'Spanish'], 'new CV preserves confirmed language preferences');
  assert.ok(auto.derived.languages.some((language) => language.name === 'Dutch'), 'new language remains available for follow-up');
  assert.equal(profileStatus({ home: dir }).state, 'current');
  // Forced rebuild changes generatedAt even when nothing else changed.
  const forced = loadProfile({ home: dir, refresh: 'force', log: quiet });
  assert.equal(forced.provenance.refreshed, true);
  // Extractor version drift is also stale.
  const derived = JSON.parse(readFileSync(path.join(dir, DERIVED_FILE), 'utf8'));
  writeFileSync(path.join(dir, DERIVED_FILE), JSON.stringify({ ...derived, extractorVersion: 'cv-v0' }));
  assert.match(profileStatus({ home: dir }).reason, /extractor changed/);
  // No CV and no derived profile: loud failure, no built-in personal defaults.
  const empty = home(t);
  writeFileSync(path.join(empty, 'personal-info-cache.json'), readyCache());
  assert.throws(() => loadProfile({ home: empty, log: quiet }), (error) => error instanceof ProfileError && error.code === 'PROFILE_MISSING');
  assert.equal(profileStatus({ home: empty }).state, 'no-cv');
  // Derived present but CV removed: usable, cannot refresh.
  rmSync(path.join(dir, 'CV.docx'));
  const noCv = loadProfile({ home: dir, log: quiet });
  assert.equal(noCv.provenance.status, 'no-cv');
  assert.ok(noCv.skillTerms.includes('rust'));
});

test('curated cache wins over derived values and missing roles fail loudly', (t) => {
  const dir = home(t);
  writeFileSync(path.join(dir, 'CV.docx'), docx(CV_ONE));
  writeFileSync(path.join(dir, 'personal-info-cache.json'), readyCache({
    languages: { Spanish: 'none', Italian: 'c1' },
    skills: ['Kubernetes', 'Ansible'],
    applicationPreferences: { fitScoreThreshold: 70 },
  }));
  writeFileSync(path.join(dir, 'search-config.json'), JSON.stringify({ countries: { GB: { location: 'United Kingdom' }, NL: {} } }));
  const profile = loadProfile({ home: dir, log: quiet });
  assert.deepEqual(profile.speaks, ['Italian'], 'only saved language preferences govern filtering');
  assert.deepEqual(profile.excludeLanguages, ['Spanish']);
  const bySource = Object.fromEntries(profile.languages.map((l) => [l.name, l.source]));
  assert.deepEqual(bySource, { Spanish: 'cache', Italian: 'cache' });
  assert.equal(profile.skills.find((s) => s.term === 'kubernetes').source, 'cv', 'derived evidence kept when curated duplicates it');
  assert.equal(profile.skills.find((s) => s.term === 'ansible').source, 'cache');
  assert.equal(profile.fitThreshold, 70);
  assert.deepEqual(profile.targetCountries, ['GB', 'NL']);
  assert.deepEqual(resolveCountry('nl', dir), { code: 'NL', location: 'Netherlands', indeedDomain: 'https://nl.indeed.com', userConfigured: true });
  assert.equal(resolveCountry('JP', dir).indeedDomain, 'https://jp.indeed.com');
  assert.equal(resolveCountry('ZZ', dir).indeedDomain, null);
  // CV titles do not become target roles without user confirmation.
  writeFileSync(path.join(dir, 'personal-info-cache.json'), JSON.stringify({ schemaVersion: 2 }));
  assert.throws(() => loadProfile({ home: dir, log: quiet }), (error) => error.code === 'ROLES_MISSING');
  // No roles anywhere: fail loudly.
  writeFileSync(path.join(dir, 'CV.docx'), docx('Alex Testerson\nLanguages\nEnglish: native'));
  assert.throws(() => loadProfile({ home: dir, log: quiet }), (error) => error.code === 'ROLES_MISSING');
  // Invalid cache JSON is an error, never silently ignored.
  writeFileSync(path.join(dir, 'CV.docx'), docx(CV_ONE));
  writeFileSync(path.join(dir, 'personal-info-cache.json'), '{not json');
  assert.throws(() => loadProfile({ home: dir, log: quiet }), (error) => error.code === 'CACHE_INVALID');
});

test('title exclusions follow the profile roles and curated families', (t) => {
  const dir = home(t);
  writeFileSync(path.join(dir, 'CV.docx'), docx(CV_ONE));
  writeFileSync(path.join(dir, 'personal-info-cache.json'), readyCache());
  const architect = loadProfile({ home: dir, log: quiet });
  assert.equal(titleExcluded(architect, 'Architekt (m/w/d) Hochbau').excluded, false);
  assert.equal(titleExcluded(architect, 'Interior Architect').excluded, false, 'architect does not imply exclusion of construction roles');
  assert.equal(titleExcluded(architect, 'AI Solution Architect').excluded, false, 'exempt term keeps software architecture');
  assert.equal(titleExcluded(architect, 'Working Student Platform').family, 'early-career', 'curated family applies');
  assert.equal(titleExcluded(architect, 'Assistant Director Platform').excluded, false);
  assert.equal(titleExcluded(architect, 'Account Executive').excluded, false, 'sales family not selected');
  writeFileSync(path.join(dir, 'personal-info-cache.json'), JSON.stringify({ rolePreferences: { preferredPrimaryRoles: ['Embedded Software Engineer'], excludedTitleFamilies: ['sales', 'Field Application Engineer'] } }));
  const embedded = loadProfile({ home: dir, log: quiet });
  assert.equal(titleExcluded(embedded, 'Architekt Hochbau').excluded, false, 'building family only applies to architect profiles');
  assert.equal(titleExcluded(embedded, 'Sales Executive').family, 'sales');
  assert.equal(titleExcluded(embedded, 'Field Application Engineer').family, 'literal');
});

test('python twin agrees with the loader and triggers the same refresh', (t) => {
  const dir = home(t);
  writeFileSync(path.join(dir, 'CV.docx'), docx(CV_ONE));
  writeFileSync(path.join(dir, 'personal-info-cache.json'), readyCache({ languages: { Italian: 'c1' } }));
  const js = loadProfile({ home: dir, log: quiet });
  const script = `import json, sys; sys.path.insert(0, ${JSON.stringify(path.dirname(pythonTwin))}); import jh_profile as p
profile = p.load_profile(home=${JSON.stringify(dir)})
print(json.dumps({"status": profile["provenance"]["status"], "refreshed": profile["provenance"]["refreshed"], "speaks": profile["speaks"], "skills": profile["skillTerms"], "roles": profile["roles"], "certs": [c["term"] for c in profile["certifications"]], "cvSha256": profile["provenance"]["cvSha256"], "fit": profile["fitThreshold"], "families": [f["name"] for f in p.title_exclusion_rules(profile)["families"]]}))`;
  const py = spawnSync('python3', ['-c', script], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(py.status, 0, py.stderr);
  const twin = JSON.parse(py.stdout);
  assert.equal(twin.status, 'current');
  assert.equal(twin.refreshed, false);
  assert.deepEqual(twin.speaks, js.speaks);
  assert.deepEqual(twin.skills, js.skillTerms);
  assert.deepEqual(twin.roles, js.roles);
  assert.deepEqual(twin.certs, js.certifications.map((c) => c.term));
  assert.equal(twin.cvSha256, js.provenance.cvSha256);
  assert.equal(twin.fit, js.fitThreshold);
  assert.deepEqual(twin.families, ['early-career']);
  // Python detects the changed CV and delegates extraction to the JS extractor.
  writeFileSync(path.join(dir, 'CV.docx'), docx(CV_TWO));
  const refreshed = spawnSync('python3', ['-c', script], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(refreshed.status, 0, refreshed.stderr);
  const after = JSON.parse(refreshed.stdout);
  assert.equal(after.refreshed, true);
  assert.ok(after.skills.includes('rust'));
  assert.equal(profileStatus({ home: dir }).state, 'current');
  assert.equal(existsSync(path.join(path.dirname(pythonTwin), '__pycache__')), false);
});

test('profile CLI reports status and shows the merged profile without personal defaults', (t) => {
  const dir = home(t);
  writeFileSync(path.join(dir, 'personal-info-cache.json'), readyCache());
  const missing = spawnSync(process.execPath, [profileCli, 'status', '--home', dir, '--json'], { encoding: 'utf8' });
  assert.equal(missing.status, 3);
  assert.equal(JSON.parse(missing.stdout).state, 'no-cv');
  assert.equal(spawnSync(process.execPath, [profileCli, 'show', '--home', dir], { encoding: 'utf8' }).status, 2);
  writeFileSync(path.join(dir, 'CV.docx'), docx(CV_ONE));
  const show = spawnSync(process.execPath, [profileCli, 'show', '--home', dir, '--json'], { encoding: 'utf8' });
  assert.equal(show.status, 0, show.stderr);
  const summary = JSON.parse(show.stdout);
  assert.equal(summary.refreshed, true);
  assert.deepEqual(summary.speaks, ['English', 'Spanish']);
  assert.match(show.stderr, /rebuilt from CV\.docx/);
  const status = spawnSync(process.execPath, [profileCli, 'status', '--home', dir], { encoding: 'utf8' });
  assert.equal(status.status, 0);
  assert.equal(status.stdout.trim(), 'profile: current');
  assert.equal(profileMain(['bogus']), 1);
  assert.equal(profileMain(['--help']), 0);
  // The derived file never carries cache or vocabulary contents, only CV evidence.
  const derived = JSON.parse(readFileSync(path.join(dir, DERIVED_FILE), 'utf8'));
  assert.deepEqual(Object.keys(derived).sort(), ['certifications', 'counts', 'cvPath', 'cvSha256', 'extractorVersion', 'generatedAt', 'languages', 'referenceDataSha256', 'schemaVersion', 'skills', 'titles']);
  mkdirSync(path.join(dir, 'unused'));
});
