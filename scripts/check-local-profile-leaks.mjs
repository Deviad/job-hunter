import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', '__pycache__']);
const CONTENT_EXCEPTIONS = new Set([
  'scripts/check-local-profile-leaks.mjs',
  'test/local-profile-leaks.test.mjs',
]);
// Exclude metadata and generic role-taxonomy vocabulary that is intentionally product code.
const EXCLUDED_ROOTS = new Set([
  'schemaVersion',
  'lastUpdated',
  'purpose',
  'rolePreferences',
]);
const GENERIC_VALUES = new Set([
  'yes', 'no', 'true', 'false', 'remote', 'hybrid', 'onsite', 'english',
  'united kingdom', 'switzerland', 'ireland', 'bachelor', 'master',
]);

function collectStrings(value, key = '', output = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectStrings(item, `${key}[${index}]`, output));
    return output;
  }
  if (value && typeof value === 'object') {
    for (const [childKey, child] of Object.entries(value)) {
      collectStrings(child, key ? `${key}.${childKey}` : childKey, output);
    }
    return output;
  }
  if (typeof value !== 'string') return output;
  const root = key.split(/[.[]/, 1)[0];
  if (EXCLUDED_ROOTS.has(root)) return output;
  const keyLower = key.toLowerCase();
  if (key.startsWith('workHistory') && (keyLower.includes('title') || keyLower.includes('role'))) return output;
  const text = value.trim();
  if (text.length >= 6 && !GENERIC_VALUES.has(text.toLowerCase())) {
    const variants = new Set([
      text,
      text.replace(/\s+/g, '_'),
      text.replace(/\s+/g, '-'),
      text.replace(/\s+/g, ''),
    ]);
    output.push({ key, texts: [...variants] });
  }
  return output;
}

function collectCvStrings(cvPath) {
  const python = String.raw`
import json, re, sys, zipfile
from xml.etree import ElementTree as ET
with zipfile.ZipFile(sys.argv[1]) as archive:
    root = ET.fromstring(archive.read('word/document.xml'))
paragraphs = []
for paragraph in root.iter():
    if not paragraph.tag.endswith('}p'):
        continue
    text = ''.join(node.text or '' for node in paragraph.iter() if node.tag.endswith('}t')).strip()
    if text:
        paragraphs.append(text)
values = paragraphs[:2]
joined = '\n'.join(paragraphs)
values.extend(re.findall(r'https?://\S+|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b', joined, re.I))
print(json.dumps(values))
`;
  const result = spawnSync('python3', ['-c', python, cvPath], { encoding: 'utf8', timeout: 15_000 });
  if (result.status !== 0) return [];
  return JSON.parse(result.stdout).flatMap((text, index) => {
    const normalized = String(text).trim();
    if (normalized.length < 6) return [];
    const variants = new Set([
      normalized,
      normalized.replace(/\s+/g, '_'),
      normalized.replace(/\s+/g, '-'),
      normalized.replace(/\s+/g, ''),
    ]);
    return [{ key: `cv.header[${index}]`, texts: [...variants] }];
  });
}

async function filesUnder(rootDir) {
  const files = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else files.push(full);
    }
  }
  await walk(rootDir);
  return files;
}

/** Compare publishable text with the maintainer's local profile values without printing those values. */
export async function run(rootDir, jobHunterHome = process.env.JOBHUNTER_HOME || join(process.env.HOME, '.job-hunter')) {
  const cachePath = join(jobHunterHome, 'personal-info-cache.json');
  const cacheStat = await stat(cachePath).catch(() => null);
  if (!cacheStat?.isFile()) {
    return {
      exitCode: 0,
      skipped: true,
      findings: [],
      output: [`[SKIP] local profile leak gate: ${cachePath} not found`],
    };
  }

  const cache = JSON.parse(await readFile(cachePath, 'utf8'));
  const values = collectStrings(cache);
  const cvPath = join(jobHunterHome, 'CV.docx');
  if ((await stat(cvPath).catch(() => null))?.isFile()) values.push(...collectCvStrings(cvPath));
  const findings = [];

  for (const filePath of await filesUnder(rootDir)) {
    const rel = relative(rootDir, filePath).split('\\').join('/');
    if (CONTENT_EXCEPTIONS.has(rel)) continue;
    let data;
    try {
      data = await readFile(filePath);
    } catch {
      continue;
    }
    if (data.includes(0)) continue;
    const content = data.toString('utf8');
    const matchedKeys = [...new Set(values.filter(({ texts }) => texts.some((text) => content.includes(text))).map(({ key }) => key))];
    if (matchedKeys.length > 0) findings.push({ path: rel, keys: matchedKeys });
  }

  if (findings.length === 0) {
    return {
      exitCode: 0,
      skipped: false,
      findings,
      output: [`Local profile leak gate: checked ${values.length} sensitive values; no exact matches found.`],
    };
  }

  const output = findings.map(({ path, keys }) =>
    `[FAIL] local-profile-value: ${path} — matches ${keys.length} private cache field(s): ${keys.join(', ')}`
  );
  output.push(`Local profile leak gate: ${findings.length} file(s) matched private cache values.`);
  return { exitCode: 1, skipped: false, findings, output };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] || process.cwd();
  const { exitCode, output } = await run(root);
  output.forEach((line) => console.log(line));
  process.exit(exitCode);
}
