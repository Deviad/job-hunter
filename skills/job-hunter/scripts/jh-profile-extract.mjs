#!/usr/bin/env node
// jh-profile-extract.mjs — derive a machine-readable profile from the user's CV.
//
// Reads $JOBHUNTER_HOME/CV.docx once, matches it against the generic
// vocabulary/language data files bundled with this skill, and writes
// $JOBHUNTER_HOME/profile-derived.json atomically. The file records the CV's
// SHA-256 and the extractor version so every consumer can detect staleness
// (see jh-profile.mjs). Nothing here is hand-edited; curated preferences
// stay in personal-info-cache.json.
//
// Usage:
//   node jh-profile-extract.mjs [--home DIR] [--cv PATH] [--out PATH] [--force] [--json] [--quiet]
//   status/refresh decisions live in jh-profile.mjs; this CLI always extracts.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { extractDocxText } from './docx-text.mjs';

export const EXTRACTOR_VERSION = 'cv-v2';
export const DERIVED_SCHEMA_VERSION = 1;
export const DERIVED_FILE = 'profile-derived.json';

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');

export function resolveHome(home) {
  return home || process.env.JOBHUNTER_HOME || path.join(process.env.HOME || homedir(), '.job-hunter');
}

export function loadDataFile(name) {
  return JSON.parse(readFileSync(path.join(DATA_DIR, name), 'utf8'));
}

export function loadReferenceData() {
  const vocabulary = loadDataFile('technology-vocabulary.json');
  const languages = loadDataFile('language-aliases.json');
  const exclusions = loadDataFile('title-exclusions.json');
  const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  return { vocabulary, languages, exclusions, sha256: sha({ vocabulary, languages, exclusions }) };
}

export function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

// Terms may start or end with symbols (c++, .net, c#), so plain \b does not
// work; require a non-term character (or edge) on both sides instead.
export function termPattern(term) {
  const escaped = String(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`(?<![\\p{L}\\p{N}+#.])${escaped}(?![\\p{L}\\p{N}+#])`, 'iu');
}

function snippetAt(text, index, length) {
  const start = Math.max(index - 30, 0);
  const end = Math.min(index + length + 30, text.length);
  return text.slice(start, end).replace(/\s+/g, ' ').trim().slice(0, 90);
}

/** Vocabulary matches with literal CV evidence spans. Pure. */
export function extractSkills(cvText, vocabulary) {
  const skills = [];
  const certifications = [];
  for (const entry of vocabulary.terms) {
    for (const candidate of [entry.term, ...(entry.aliases || [])]) {
      const match = termPattern(candidate).exec(cvText);
      if (!match) continue;
      const record = {
        term: entry.term,
        kind: entry.kind,
        matched: candidate,
        evidence: `cv-span:${match.index}:${snippetAt(cvText, match.index, match[0].length)}`,
      };
      (entry.kind === 'certification' ? certifications : skills).push(record);
      break;
    }
  }
  // Explicit skills sections can name any sector's vocabulary. Keep literal spans.
  let inSkills = false;
  let sectionKind = 'skill';
  let offset = 0;
  const seen = new Set([...skills, ...certifications].map((skill) => skill.term.toLowerCase()));
  for (const line of cvText.split('\n')) {
    const heading = line.trim().match(/^(skills|key skills|technical skills|competencies|expertise|technologies|certifications|licenses|licences|credentials)\s*:?\s*(.*)$/i);
    if (heading) { inSkills = true; sectionKind = /certifications|licen[cs]es|credentials/i.test(heading[1]) ? 'certification' : 'skill'; }
    else if (/^(?:experience|employment|education|languages|summary|profile|interests|awards)\b/i.test(line.trim())) inSkills = false;
    if (inSkills) {
      for (const item of (heading ? heading[2] : line).split(/[,;|•]/)) {
        const term = item.trim().replace(/^[-*]\s*/, '').toLowerCase();
        if (term.length < 2 || term.length > 80 || term.split(/\s+/).length > 8 || seen.has(term) || /[@:]|\b\d{4}\b/.test(term)) continue;
        const local = line.toLowerCase().indexOf(term);
        if (local < 0) continue;
        seen.add(term);
        (sectionKind === 'certification' ? certifications : skills).push({ term, kind: sectionKind, matched: line.slice(local, local + term.length), evidence: `cv-span:${offset + local}:${snippetAt(cvText, offset + local, term.length)}` });
      }
    }
    offset += line.length + 1;
  }
  return { skills, certifications };
}

function levelFor(line, languages) {
  const lower = line.toLowerCase();
  for (const [level, words] of Object.entries(languages.proficiencyLevels)) {
    if (words.some((word) => termPattern(word).test(lower))) return level;
  }
  return null;
}

/**
 * Language evidence: a CV line naming a language together with a proficiency
 * word, or a line that starts with the language name in a list layout
 * ("Italian — native", "German: B1"). Lines without any level are recorded
 * with level "unspecified" only when they sit in a languages section.
 */
export function extractLanguages(cvText, languages) {
  const found = new Map();
  const lines = cvText.split('\n').map((line) => line.trim()).filter(Boolean);
  let inLanguageSection = false;
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (/^(languages?|sprachen|lingue|langues|idiomas)\b[:\s]*$/i.test(lower)) { inLanguageSection = true; continue; }
    if (/^[a-z][a-z &/-]{2,40}$/i.test(line) && !inLanguageSection) { /* other section headings */ }
    else if (/^(experience|education|skills|projects|summary|profile|certifications?|employment|work history)\b/i.test(lower)) inLanguageSection = false;
    for (const [name, aliases] of Object.entries(languages.languages)) {
      if (found.has(name)) continue;
      if (!aliases.some((alias) => termPattern(alias).test(lower))) continue;
      const level = levelFor(line, languages);
      const listLayout = aliases.some((alias) => new RegExp(`^\\s*${alias}\\s*[:\\-–—(]`, 'i').test(lower));
      if (level || (inLanguageSection && (listLayout || line.length <= 40))) {
        found.set(name, { name, level: level || 'unspecified', evidence: `cv-span:line:${line.slice(0, 80)}` });
      }
    }
  }
  return [...found.values()];
}


/** Short CV lines that read as job titles. Heuristic, so marked as such. */
export function extractTitles(cvText) {
  const titles = [];
  const seen = new Set();
  let section = 'header';
  for (const [index, raw] of cvText.split('\n').filter((line) => line.trim()).entries()) {
    const line = raw.replace(/\s+/g, ' ').trim();
    const heading = line.match(/^(skills|key skills|technical skills|competencies|expertise|technologies|languages|certifications|licenses|licences|credentials|experience|employment|work history|education|summary|profile|projects)\s*:?.*$/i);
    if (heading) { section = heading[1].toLowerCase(); continue; }
    if (!line || line.length > 90 || index === 0) continue;
    if (section !== 'header' && !['experience', 'employment', 'work history'].includes(section)) continue;
    if (index > 3 && !/\s[|–—]\s|^(?:role|title):/i.test(line)) continue;
    if (/@|https?:/.test(line) || /[.;]$/.test(line)) continue;
    // Keep the title part of "Title | Company | 2021 – 2024" style lines.
    const title = line.replace(/^(?:role|title):\s*/i, '').replace(/\s*[|@–—]\s*.*$/, '').replace(/\s+-\s+.*$/, '').replace(/\s*\(.*\)$/, '').trim();
    const key = title.toLowerCase();
    if (!title || title.length > 60 || /\d{4}/.test(title) || title.split(' ').length > 8) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    titles.push(title);
    if (titles.length >= 15) break;
  }
  return titles;
}

/** Build a derived profile record from CV text. Pure. */
export function deriveProfile({ cvText, cvPath, cvSha256, reference, now = new Date() }) {
  const { skills, certifications } = extractSkills(cvText, reference.vocabulary);
  return {
    schemaVersion: DERIVED_SCHEMA_VERSION,
    extractorVersion: EXTRACTOR_VERSION,
    referenceDataSha256: reference.sha256,
    cvPath,
    cvSha256,
    generatedAt: now.toISOString(),
    skills,
    certifications,
    languages: extractLanguages(cvText, reference.languages),
    titles: { heuristic: true, values: extractTitles(cvText) },
    counts: { skills: skills.length, certifications: certifications.length },
  };
}

export function writeDerivedProfile(outPath, derived) {
  mkdirSync(path.dirname(outPath), { recursive: true });
  const tmp = `${outPath}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(derived, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, outPath);
}

/** Extract from a CV file and write the derived profile. Returns the record. */
export function extractProfile({ home, cvPath, outPath, reference = loadReferenceData(), now } = {}) {
  const resolvedHome = resolveHome(home);
  const cv = cvPath || path.join(resolvedHome, 'CV.docx');
  const out = outPath || path.join(resolvedHome, DERIVED_FILE);
  if (!existsSync(cv)) throw new Error(`CV not found: ${cv}`);
  const bytes = readFileSync(cv);
  const cvText = extractDocxText(bytes);
  const derived = deriveProfile({ cvText, cvPath: cv, cvSha256: createHash('sha256').update(bytes).digest('hex'), reference, now });
  writeDerivedProfile(out, derived);
  return { derived, outPath: out };
}

export function parseArgs(argv) {
  const options = { home: null, cv: null, out: null, force: false, json: false, quiet: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => { const value = argv[++i]; if (value === undefined) throw new Error(`Missing value for ${arg}`); return value; };
    if (arg === '--home') options.home = next();
    else if (arg === '--cv') options.cv = next();
    else if (arg === '--out') options.out = next();
    else if (arg === '--force') options.force = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--quiet') options.quiet = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

export function main(argv = process.argv.slice(2)) {
  let options;
  try { options = parseArgs(argv); } catch (error) { console.error(error.message); return 1; }
  if (options.help) {
    console.log('Usage: jh-profile-extract.mjs [--home DIR] [--cv PATH] [--out PATH] [--force] [--json] [--quiet]');
    return 0;
  }
  try {
    const { derived, outPath } = extractProfile({ home: options.home, cvPath: options.cv, outPath: options.out });
    if (options.json) console.log(JSON.stringify({ ok: true, outPath, cvSha256: derived.cvSha256, counts: derived.counts, languages: derived.languages.map((l) => l.name), titles: derived.titles.values.length }));
    else if (!options.quiet) console.log(`Derived profile written: ${outPath} (${derived.counts.skills} skills, ${derived.counts.certifications} certifications, ${derived.languages.length} languages, ${derived.titles.values.length} title lines)`);
    return 0;
  } catch (error) {
    console.error(`profile extraction failed: ${error.message}`);
    return 2;
  }
}

if (process.argv[1] && existsSync(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exitCode = main();
