/**
 * rules-loader.mjs - Load, validate, and cache normalization rules
 *
 * Parses references/normalization.md once at first use, validates every required section,
 * runs the stopword/seniority intersection assertion, and caches in memory.
 *
 * Exports:
 * - NORMALIZER_VERSION: 1 (hardcoded constant, validated against rules file header)
 * - loadRules(yamlText) → RulesData
 * - loadRulesFromFile(path) → RulesData (cached)
 * - getCachedRules() → RulesData (lazy-load on first call)
 * - forceReloadForTests() → RulesData (test-only escape hatch)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseYaml, parseSectionedMarkdown } from './yaml-mini.mjs';

export const NORMALIZER_VERSION = 1;

// Module-scope cache
let cached = null;

/**
 * RulesData shape (returned to Plan 03)
 * {
 *   compoundPhrases: Map<string, string>,
 *   synonymMap: Map<string, string>,
 *   seniorityTable: Array<{bucket: string, keywords: Set<string>}>,
 *   industryList: Map<string, string[]>,
 *   stopwords: Set<string>,
 *   fillerAdjectives: Set<string>,
 *   remoteMarkers: Set<string>,
 *   locationTokens: Set<string>,
 *   version: number,
 * }
 */

/**
 * Load rules from YAML text, validate, and return RulesData
 * Throws fatal errors on parse failure, missing sections, or validation violations
 */
export function loadRules(yamlText) {
  const { header, sections } = parseSectionedMarkdown(yamlText);

  // Validate required sections (check this before version to catch malformed files)
  const requiredSections = [
    'compound_phrases',
    'synonym_map',
    'seniority_table',
    'industry_list',
    'stopwords',
    'filler_adjectives',
    'remote_markers',
    'locations',
  ];
  for (const section of requiredSections) {
    if (!(section in sections)) {
      throw new Error(`rules file missing required section: ${section}`);
    }
  }

  // Extract version from header
  const versionMatch = header.match(/NORMALIZER_VERSION:\s*(\d+)/);
  if (!versionMatch) {
    throw new Error('rules file missing "NORMALIZER_VERSION: <int>" in header');
  }

  const fileVersion = parseInt(versionMatch[1], 10);
  if (fileVersion !== NORMALIZER_VERSION) {
    throw new Error(
      `references/normalization.md version (${fileVersion}) does not match scripts/lib/normalize/rules-loader.mjs NORMALIZER_VERSION (${NORMALIZER_VERSION}). Bump one to match the other in the same commit.`
    );
  }

  // Parse each section
  const compoundPhrasesYaml = parseYaml(sections.compound_phrases);
  const synonymMapYaml = parseYaml(sections.synonym_map);
  const seniorityTableYaml = parseYaml(sections.seniority_table);
  const industryListYaml = parseYaml(sections.industry_list);
  const stopwordsYaml = parseYaml(sections.stopwords);
  const fillerAdjectivesYaml = parseYaml(sections.filler_adjectives);
  const remoteMarkersYaml = parseYaml(sections.remote_markers);
  const locationsYaml = parseYaml(sections.locations);

  // Validate seniority_table structure and order
  if (!Array.isArray(seniorityTableYaml)) {
    throw new Error('seniority_table must be an array of {bucket, keywords} objects');
  }

  const expectedSeniorityOrder = ['cxo', 'vp', 'director', 'manager', 'lead', 'principal', 'staff', 'senior', 'mid', 'junior', 'intern', '_any'];
  const actualSeniorityOrder = seniorityTableYaml.map((entry) => entry.bucket || entry);

  // Deep-equal check for order
  if (actualSeniorityOrder.length !== expectedSeniorityOrder.length || !actualSeniorityOrder.every((val, idx) => val === expectedSeniorityOrder[idx])) {
    throw new Error(
      `seniority_table bucket order does not match expected order.\nExpected: ${expectedSeniorityOrder.join(', ')}\nActual: ${actualSeniorityOrder.join(', ')}`
    );
  }

  // Validate industry_list structure
  if (typeof industryListYaml !== 'object' || Array.isArray(industryListYaml)) {
    throw new Error('industry_list must be an object mapping code -> keywords array');
  }

  const expectedIndustryCodes = [
    'software',
    'finance',
    'healthcare',
    'manufacturing',
    'retail',
    'education',
    'consulting',
    'government',
    'media',
    'energy',
    'biotech',
    'telecom',
    'transportation',
    'insurance',
    '_any',
  ];
  const actualIndustryCodes = Object.keys(industryListYaml).sort();
  const expectedCodesSet = new Set(expectedIndustryCodes);
  const actualCodesSet = new Set(actualIndustryCodes);

  const missingCodes = expectedIndustryCodes.filter((c) => !actualCodesSet.has(c));
  const extraCodes = actualIndustryCodes.filter((c) => !expectedCodesSet.has(c));

  if (missingCodes.length > 0 || extraCodes.length > 0) {
    let errMsg = 'industry_list codes mismatch.';
    if (missingCodes.length > 0) {
      errMsg += ` Missing: ${missingCodes.join(', ')}.`;
    }
    if (extraCodes.length > 0) {
      errMsg += ` Extra: ${extraCodes.join(', ')}.`;
    }
    throw new Error(errMsg);
  }

  // Lowercase all keys and values
  const compoundPhrasesMap = new Map();
  for (const [key, value] of Object.entries(compoundPhrasesYaml)) {
    compoundPhrasesMap.set(key.toLowerCase(), String(value).toLowerCase());
  }

  const synonymMapObj = {};
  for (const [key, value] of Object.entries(synonymMapYaml)) {
    synonymMapObj[key.toLowerCase()] = String(value).toLowerCase();
  }

  // Build seniority table with lowercased keywords
  const seniorityTableArray = seniorityTableYaml.map((entry) => {
    const keywordSet = new Set();
    const keywords = entry.keywords || [];
    if (Array.isArray(keywords)) {
      for (const kw of keywords) {
        keywordSet.add(String(kw).toLowerCase());
      }
    }
    return {
      bucket: String(entry.bucket).toLowerCase(),
      keywords: keywordSet,
    };
  });

  // Build industry list with lowercased entries
  const industryListMap = new Map();
  for (const [code, keywords] of Object.entries(industryListYaml)) {
    const keywordArray = Array.isArray(keywords)
      ? keywords.map((kw) => String(kw).toLowerCase())
      : [];
    industryListMap.set(code.toLowerCase(), keywordArray);
  }

  const stopwordsSet = new Set();
  if (Array.isArray(stopwordsYaml)) {
    for (const word of stopwordsYaml) {
      stopwordsSet.add(String(word).toLowerCase());
    }
  }

  const fillerAdjectivesSet = new Set();
  if (Array.isArray(fillerAdjectivesYaml)) {
    for (const adj of fillerAdjectivesYaml) {
      fillerAdjectivesSet.add(String(adj).toLowerCase());
    }
  }

  const remoteMarkersSet = new Set();
  if (Array.isArray(remoteMarkersYaml)) {
    for (const marker of remoteMarkersYaml) {
      remoteMarkersSet.add(String(marker).toLowerCase());
    }
  }

  const locationTokensSet = new Set();
  if (Array.isArray(locationsYaml)) {
    for (const loc of locationsYaml) {
      locationTokensSet.add(String(loc).toLowerCase());
    }
  }

  // CRITICAL: Intersection guard - stopwords ∩ seniority keywords
  const allSeniorityKeywords = new Set();
  for (const entry of seniorityTableArray) {
    for (const kw of entry.keywords) {
      allSeniorityKeywords.add(kw);
    }
  }

  const stopwordSeniorityIntersection = Array.from(stopwordsSet).filter((token) =>
    allSeniorityKeywords.has(token)
  );

  if (stopwordSeniorityIntersection.length > 0) {
    throw new Error(
      `Stopwords and seniority keywords overlap: ${stopwordSeniorityIntersection.join(', ')}. This would cause normalizeSeniority to lose signal. Edit references/normalization.md to remove the conflict.`
    );
  }

  // CRITICAL: Intersection guard - filler_adjectives ∩ seniority keywords
  const fillerSeniorityIntersection = Array.from(fillerAdjectivesSet).filter((token) =>
    allSeniorityKeywords.has(token)
  );

  if (fillerSeniorityIntersection.length > 0) {
    throw new Error(
      `Filler adjectives and seniority keywords overlap: ${fillerSeniorityIntersection.join(', ')}. This would cause normalizeSeniority to lose signal. Edit references/normalization.md to remove the conflict.`
    );
  }

  // Build and return RulesData
  return {
    compoundPhrases: compoundPhrasesMap,
    synonymMap: new Map(Object.entries(synonymMapObj)),
    seniorityTable: seniorityTableArray,
    industryList: industryListMap,
    stopwords: stopwordsSet,
    fillerAdjectives: fillerAdjectivesSet,
    remoteMarkers: remoteMarkersSet,
    locationTokens: locationTokensSet,
    version: NORMALIZER_VERSION,
  };
}

/**
 * Resolve the path to the rules file relative to the project root
 */
function resolveRulesPath(rulesPath = 'references/normalization.md') {
  if (path.isAbsolute(rulesPath)) {
    return rulesPath;
  }

  // Find project root by walking up from this file's directory
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (dir !== path.dirname(dir)) {
    // Keep walking up
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      // Found project root
      return path.join(dir, rulesPath);
    }
    dir = path.dirname(dir);
  }

  throw new Error(`Could not find project root (no package.json found). Cannot resolve rules file path: ${rulesPath}`);
}

/**
 * Load rules from file, cache the result, and return
 * Subsequent calls return the same cached object
 */
export function loadRulesFromFile(rulesPath = 'references/normalization.md') {
  if (cached !== null) {
    return cached;
  }
  const resolvedPath = resolveRulesPath(rulesPath);
  const text = fs.readFileSync(resolvedPath, 'utf8');
  cached = loadRules(text);
  return cached;
}

/**
 * Get cached rules, loading on first call
 * Lazy-load on first touch; deterministic since the file is on disk
 */
export function getCachedRules() {
  if (cached === null) {
    cached = loadRulesFromFile();
  }
  return cached;
}

/**
 * Force reload from file (test-only escape hatch)
 * Used by tests that need to reload after a fixture edit
 */
export function forceReloadForTests() {
  cached = null;
  return getCachedRules();
}
