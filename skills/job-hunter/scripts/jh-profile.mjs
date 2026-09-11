#!/usr/bin/env node
// jh-profile.mjs — the single loader every skill uses for user-specific values.
//
// Layers (curated wins over derived on conflict):
//   1. $JOBHUNTER_HOME/personal-info-cache.json  — human-curated (rolePreferences,
//      workAuthorization, applicationPreferences, optional languages/skills).
//   2. $JOBHUNTER_HOME/profile-derived.json      — machine-derived from CV.docx by
//      jh-profile-extract.mjs; keyed by the CV's SHA-256 and extractor version.
//   3. $JOBHUNTER_HOME/search-config.json        — target countries and Indeed domains.
//   4. skills/job-hunter/data/*.json             — generic reference data.
//
// Refresh contract: loadProfile() compares the derived file's cvSha256 and
// extractorVersion with the current CV; on mismatch it re-extracts before
// returning (refresh: 'auto'), reports staleness without touching anything
// (refresh: 'never'), or always rebuilds (refresh: 'force'). A missing CV with
// a present derived file is usable but cannot refresh. No derived profile and
// no CV is an error: there are no built-in personal defaults.
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  DERIVED_FILE, EXTRACTOR_VERSION, extractProfile, loadDataFile, loadReferenceData, resolveHome, sha256File,
} from './jh-profile-extract.mjs';

export class ProfileError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export const DEFAULT_FIT_THRESHOLD = 60;

export function configuredFitThreshold(home) {
  const cache = readJson(path.join(resolveHome(home), 'personal-info-cache.json'));
  if (cache === undefined) throw new ProfileError('CACHE_INVALID', 'personal-info-cache.json is not valid JSON');
  const value = Number(cache?.applicationPreferences?.fitScoreThreshold);
  return Number.isFinite(value) && value > 0 && value <= 100 ? value : DEFAULT_FIT_THRESHOLD;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
const digest = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

function readJson(file) {
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return undefined; }
}

function list(value) {
  return Array.isArray(value) ? value.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim()) : [];
}

function uniqueCaseInsensitive(values) {
  const seen = new Set();
  return values.filter((value) => { const key = value.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; });
}

/** Persisted search configuration; created with generic defaults on first use. */
export function loadSearchConfig(home, { create = true } = {}) {
  const resolvedHome = resolveHome(home);
  const file = path.join(resolvedHome, 'search-config.json');
  const reference = loadDataFile('indeed-domains.json');
  const existing = readJson(file);
  if (existing === undefined) throw new ProfileError('SEARCH_CONFIG_INVALID', `${file} is not valid JSON`);
  if (existing) return { path: file, created: false, config: existing, reference };
  const config = { schemaVersion: 1, countries: {}, knownLocations: [] };
  if (create) {
    mkdirSync(resolvedHome, { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
    renameSync(tmp, file);
  }
  return { path: file, created: create, config, reference };
}

/** Country defaults: user search-config wins, generic reference data fills in. */
export function resolveCountry(code, home) {
  const key = String(code || '').toUpperCase();
  const { config, reference } = loadSearchConfig(home, { create: false });
  const user = config.countries?.[key] || {};
  const generic = reference.countries[key] || {};
  return {
    code: key,
    location: user.location || generic.location || key,
    indeedDomain: user.indeedDomain || generic.indeedDomain || null,
    userConfigured: Boolean(config.countries?.[key]),
  };
}

/** current | stale | missing | no-cv, plus the reasons. */
export function profileStatus({ home, cvPath, derivedPath } = {}) {
  const resolvedHome = resolveHome(home);
  const cv = cvPath || path.join(resolvedHome, 'CV.docx');
  const derivedFile = derivedPath || path.join(resolvedHome, DERIVED_FILE);
  const derived = readJson(derivedFile);
  const cvPresent = existsSync(cv);
  const reference = loadReferenceData();
  if (derived === undefined) return { state: 'missing', reason: 'derived profile is not valid JSON', cvPresent, derivedFile, cv };
  if (!derived) return { state: cvPresent ? 'missing' : 'no-cv', reason: cvPresent ? 'derived profile has not been extracted' : 'no CV and no derived profile', cvPresent, derivedFile, cv };
  if (!cvPresent) return { state: 'no-cv', reason: 'derived profile present but CV.docx is missing; refresh is impossible', cvPresent, derivedFile, cv, derived };
  const reasons = [];
  const cvSha256 = sha256File(cv);
  if (derived.cvSha256 !== cvSha256) reasons.push('CV changed since extraction');
  if (derived.extractorVersion !== EXTRACTOR_VERSION) reasons.push(`extractor changed (${derived.extractorVersion} → ${EXTRACTOR_VERSION})`);
  if (derived.referenceDataSha256 !== reference.sha256) reasons.push('reference vocabulary changed');
  return { state: reasons.length ? 'stale' : 'current', reason: reasons.join('; ') || null, cvPresent, derivedFile, cv, derived, cvSha256 };
}

function mergeLanguages(derived, cache, reference) {
  const byName = new Map();
  // CV language mentions are suggestions; only saved user answers govern filtering.
  const raw = cache?.languages;
  const add = (name, level) => {
    const canonical = String(name).trim();
    if (!canonical) return;
    const normalizedLevel = level === null || level === undefined ? 'unspecified' : String(level).trim().toLowerCase();
    byName.set(canonical, { name: canonical, level: normalizedLevel, source: 'cache' });
  };
  if (Array.isArray(raw)) for (const item of raw) { if (typeof item === 'string') add(item, null); else if (item && typeof item === 'object') add(item.language || item.name, item.level || item.proficiency); }
  else if (raw && typeof raw === 'object') for (const [name, level] of Object.entries(raw)) add(name, level);
  const usable = new Set(reference.languages.usableLevels);
  const unusable = new Set(['none', 'no', 'false', 'a1', 'a2', 'basic', 'beginner', 'elementary']);
  const languages = [...byName.values()];
  const speaks = languages.filter((l) => !unusable.has(l.level) && (l.level === 'unspecified' || usable.has(l.level) || l.source === 'cache')).map((l) => l.name);
  return { languages, speaks };
}

/**
 * Load the merged profile. Throws ProfileError when nothing usable exists.
 * @param {{ home?: string, cvPath?: string, cachePath?: string, derivedPath?: string, refresh?: 'auto'|'never'|'force', log?: (line: string) => void }} options
 */
export function loadProfile({ home, cvPath, cachePath, derivedPath, refresh = 'auto', requireConfirmed = false, allowIncomplete = false, log = (line) => console.error(line) } = {}) {
  const resolvedHome = resolveHome(home);
  const cacheFile = cachePath || path.join(resolvedHome, 'personal-info-cache.json');
  const reference = loadReferenceData();
  let status = profileStatus({ home: resolvedHome, cvPath, derivedPath });
  let refreshed = false;
  if (status.state === 'no-cv' && !status.derived) {
    throw new ProfileError('PROFILE_MISSING', `No CV.docx and no ${DERIVED_FILE} under ${resolvedHome}: add the CV and run jh-profile-extract.mjs`);
  }
  const needsExtract = status.state === 'missing' || status.state === 'stale' || refresh === 'force';
  if (needsExtract && status.cvPresent) {
    if (refresh === 'never') {
      if (status.state === 'missing') throw new ProfileError('PROFILE_MISSING', `${DERIVED_FILE} has not been extracted; run jh-profile-extract.mjs`);
    } else {
      extractProfile({ home: resolvedHome, cvPath: status.cv, outPath: status.derivedFile, reference });
      refreshed = true;
      log(`[profile] derived profile rebuilt from ${path.basename(status.cv)} (${status.state === 'stale' ? status.reason : status.state === 'missing' ? 'first extraction' : 'forced'})`);
      status = profileStatus({ home: resolvedHome, cvPath, derivedPath });
    }
  }
  const derived = status.derived;
  const cache = readJson(cacheFile);
  if (cache === undefined) throw new ProfileError('CACHE_INVALID', `${cacheFile} is not valid JSON`);
  const preferences = cache?.rolePreferences && typeof cache.rolePreferences === 'object' ? cache.rolePreferences : {};
  const primary = uniqueCaseInsensitive(list(preferences.preferredPrimaryRoles));
  const adjacent = uniqueCaseInsensitive([...list(preferences.adjacentRoles?.acceptedRoles), ...list(preferences.adjacentRoles?.adjacentTechnicalLeadership)]);
  const leadership = uniqueCaseInsensitive(list(preferences.adjacentRoles?.leadershipProgression));
  const roles = {
    primary,
    adjacent,
    leadership,
    source: primary.length ? 'cache' : 'none',
  };
  roles.all = uniqueCaseInsensitive([...roles.primary, ...adjacent, ...leadership]);
  if (!roles.all.length && !allowIncomplete) throw new ProfileError('ROLES_MISSING', 'No target roles: add rolePreferences.preferredPrimaryRoles to personal-info-cache.json');
  const { languages, speaks } = mergeLanguages(derived, cache, reference);
  const cacheSkills = list(cache?.skills).map((term) => ({ term: term.toLowerCase(), kind: 'curated', source: 'cache' }));
  const skills = [];
  const seenSkills = new Set();
  for (const skill of [...(derived?.skills || []).map((s) => ({ ...s, source: 'cv' })), ...cacheSkills]) {
    const key = skill.term.toLowerCase();
    if (seenSkills.has(key)) continue;
    seenSkills.add(key);
    skills.push(skill);
  }
  const certifications = (derived?.certifications || []).map((c) => ({ ...c, source: 'cv' }));
  const { config: searchConfig, path: searchConfigPath } = loadSearchConfig(resolvedHome, { create: false });
  const targetCountries = Object.keys(searchConfig.countries || {}).map((c) => c.toUpperCase());
  const threshold = Number(cache?.applicationPreferences?.fitScoreThreshold);
  const { profileConfirmation, ...answers } = cache || {};
  const profileSha256 = digest({ answers, searchConfig, cvSha256: status.cvSha256 || derived?.cvSha256 || null, extractorVersion: derived?.extractorVersion, referenceDataSha256: reference.sha256 });
  const recordedConfirmation = readJson(path.join(resolvedHome, 'profile-confirmation.json'));
  const confirmation = { state: recordedConfirmation?.profileSha256 === profileSha256 ? 'confirmed' : recordedConfirmation ? 'needs-review' : 'unconfirmed', profileSha256, confirmedAt: recordedConfirmation?.confirmedAt || null };
  const profile = {
    schemaVersion: 1,
    home: resolvedHome,
    roles,
    excludedTitleFamilies: uniqueCaseInsensitive(list(preferences.excludedTitleFamilies)),
    taxonomy: {
      ...(preferences.taxonomy && typeof preferences.taxonomy === 'object' ? preferences.taxonomy : {}),
      primaryTitles: roles.primary,
      adjacentTitles: roles.adjacent,
      leadershipTitles: roles.leadership,
      conditionalTitles: list(preferences.conditionalRoles),
      excludedResponsibilityTerms: list(preferences.excludedResponsibilityTerms),
      queryExclusionTerms: uniqueCaseInsensitive(list(preferences.queryExclusionTerms)),
      excludedTitleFamilies: uniqueCaseInsensitive(list(preferences.excludedTitleFamilies)),
    },
    languages,
    speaks,
    excludeLanguages: languages.filter((language) => ['none', 'no', 'false'].includes(language.level)).map((language) => language.name),
    skills,
    skillTerms: skills.map((s) => s.term.toLowerCase()),
    certifications,
    targetCountries,
    fitThreshold: Number.isFinite(threshold) && threshold > 0 && threshold <= 100 ? threshold : DEFAULT_FIT_THRESHOLD,
    workAuthorization: cache?.workAuthorization && typeof cache.workAuthorization === 'object' ? cache.workAuthorization : {},
    reference,
    cache: cache || {},
    derived: derived || null,
    confirmation,
    provenance: {
      status: status.state,
      refreshed,
      cvPath: status.cv,
      cvSha256: status.cvSha256 || derived?.cvSha256 || null,
      cacheSha256: existsSync(cacheFile) ? sha256File(cacheFile) : null,
      derivedGeneratedAt: derived?.generatedAt || null,
      extractorVersion: derived?.extractorVersion || null,
      referenceDataSha256: reference.sha256,
      searchConfigPath,
      profileSha256,
      layers: { roles: roles.source, languages: languages.length ? 'cache' : 'none' },
    },
  };
  const exclusions = titleExclusionRules(profile);
  profile.taxonomy.exclusionRules = [...exclusions.families, ...exclusions.literals.map((term) => ({ name: term, titleTerms: [term], exemptTerms: [] }))];
  if (requireConfirmed && confirmation.state !== 'confirmed') throw new ProfileError('PROFILE_REVIEW_REQUIRED', 'Review the CV and preferences with the user, then run jh-profile.mjs confirm with the reviewed profile hash');
  return profile;
}

export function reviewProfile(options = {}) {
  const profile = loadProfile({ ...options, allowIncomplete: true });
  return { confirmation: profile.confirmation, roles: profile.roles, languages: profile.languages, exclusions: profile.taxonomy.exclusionRules,
    suggestions: { titles: profile.derived?.titles?.values || [], languages: profile.derived?.languages || [], skills: profile.skillTerms },
    questions: ['Which target roles and adjacent roles would you accept?', 'Which title families or responsibilities should exclude a role? None is a valid answer.', 'Which languages can you work in, at what proficiency, and which do you explicitly not speak?'] };
}

export function confirmProfile({ expectedProfileSha256, ...options } = {}) {
  const profile = loadProfile(options);
  if (!expectedProfileSha256 || expectedProfileSha256 !== profile.provenance.profileSha256) throw new ProfileError('PROFILE_CHANGED', 'Preferences or CV changed; review the current profile before confirming');
  if (!profile.roles.primary.length || !profile.languages.length) throw new ProfileError('PREFERENCES_INCOMPLETE', 'Confirm target roles and language preferences first');
  const preferences = profile.cache.rolePreferences;
  if (!Array.isArray(preferences.excludedTitleFamilies) || !Array.isArray(preferences.queryExclusionTerms) || !preferences.adjacentRoles) throw new ProfileError('PREFERENCES_INCOMPLETE', 'Record adjacent roles and exclusion lists; empty lists are valid');
  const file = path.join(profile.home, 'profile-confirmation.json');
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify({ profileSha256: expectedProfileSha256, confirmedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  return loadProfile({ ...options, requireConfirmed: true });
}

/** Title-exclusion rules selected for this profile (families + literal phrases). */
export function titleExclusionRules(profile) {
  const families = profile.reference.exclusions.families;
  const selected = new Map();
  const literals = [];
  for (const entry of profile.excludedTitleFamilies) {
    const key = entry.toLowerCase().replace(/\s+/g, '-');
    if (families[key]) selected.set(key, families[key]);
    else literals.push(entry.toLowerCase());
  }
  return { families: [...selected.entries()].map(([name, family]) => ({ name, ...family })), literals };
}

/** True when a job title should be excluded for this profile, with the reason. */
export function titleExcluded(profile, title) {
  const text = String(title || '').toLowerCase();
  const rules = titleExclusionRules(profile);
  const containsPhrase = (phrase) => new RegExp(`(?<![\\p{L}\\p{N}])${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}(?![\\p{L}\\p{N}])`, 'iu').test(text);
  for (const family of rules.families) {
    if (family.titleTerms.some(containsPhrase) && !family.exemptTerms.some(containsPhrase)) return { excluded: true, family: family.name, reason: family.summary };
  }
  for (const literal of rules.literals) if (containsPhrase(literal)) return { excluded: true, family: 'literal', reason: `title matches excluded phrase "${literal}"` };
  return { excluded: false, family: null, reason: null };
}

function summarize(profile) {
  return {
    ok: true,
    status: profile.provenance.status,
    refreshed: profile.provenance.refreshed,
    confirmation: profile.confirmation,
    roles: profile.roles,
    speaks: profile.speaks,
    languages: profile.languages.map((l) => ({ name: l.name, level: l.level, source: l.source })),
    skills: profile.skillTerms.length,
    certifications: profile.certifications.map((c) => c.term),
    targetCountries: profile.targetCountries,
    fitThreshold: profile.fitThreshold,
    provenance: { ...profile.provenance },
  };
}

export function main(argv = process.argv.slice(2)) {
  const action = argv[0];
  const options = { home: null, json: false };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--home') options.home = argv[++i];
    else if (argv[i] === '--json') options.json = true;
    else if (argv[i] === '--cv') options.cvPath = argv[++i];
    else if (argv[i] === '--cache') options.cachePath = argv[++i];
    else if (argv[i] === '--derived') options.derivedPath = argv[++i];
    else if (argv[i] === '--refresh') options.refresh = argv[++i];
    else if (argv[i] === '--require-confirmed') options.requireConfirmed = true;
    else if (argv[i] === '--expected-profile-sha') options.expectedProfileSha256 = argv[++i];
    else { console.error(`Unknown option: ${argv[i]}`); return 1; }
  }
  if (!['status', 'show', 'refresh', 'export', 'review', 'confirm', '--help', '-h', undefined].includes(action)) { console.error(`Unknown action: ${action}`); return 1; }
  if (!action || action === '--help' || action === '-h') {
    console.log('Usage: jh-profile.mjs status|show|refresh|review|confirm [--home DIR] [--json] [--expected-profile-sha SHA]');
    return 0;
  }
  try {
    if (action === 'status') {
      const status = profileStatus(options);
      const { derived, ...rest } = status;
      if (derived) rest.confirmation = loadProfile({ ...options, refresh: 'never', allowIncomplete: true }).confirmation;
      console.log(options.json ? JSON.stringify(rest) : `profile: ${status.state}${status.reason ? ` — ${status.reason}` : ''}`);
      return status.state === 'current' ? 0 : 3;
    }
    if (action === 'review') { console.log(JSON.stringify(reviewProfile(options))); return 0; }
    const profile = action === 'confirm' ? confirmProfile(options) : loadProfile({ ...options, refresh: action === 'refresh' ? 'force' : options.refresh || 'auto' });
    console.log(JSON.stringify(action === 'export' ? profile : summarize(profile), null, options.json ? 0 : 2));
    return 0;
  } catch (error) {
    console.error(`${error.code || 'PROFILE_ERROR'}: ${error.message}`);
    return 2;
  }
}

if (process.argv[1] && existsSync(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exitCode = main();
