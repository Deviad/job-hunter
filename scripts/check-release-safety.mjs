import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', 'agent-output']);
const CONTENT_EXCEPTIONS = new Set([
  'scripts/check-release-safety.mjs',
  'scripts/check-local-profile-leaks.mjs',
  'test/release-safety.test.mjs',
  'test/local-profile-leaks.test.mjs',
  'test/doctor-publication.test.mjs',
]);

const FORBIDDEN_FILENAME = [
  /^\.DS_Store$/i,
  /^CV\.(docx|pdf|txt|md)$/i,
  /^resume\./i,
  /^personal-info-cache\.json$/i,
  /\.(?:sqlite|sqlite3|db)(?:-wal|-shm)?$/i,
  /^\.env(?:\.|$)/i,
  /\.pem$/i,
  /\.key$/i,
  /^id_(?:rsa|ed25519)/i,
  /^cookies/i,
  /^browser-state/i,
  /\.pyc$/i,
  /\.bak$/i,
];

const FORBIDDEN_DIRECTORY = [
  /^screenshots$/i,
  /^logs$/i,
  /^apply_logs$/i,
  /^backups$/i,
  /^__pycache__$/i,
];

const CONTENT_PATTERNS = [
  { name: 'hardcoded-user-path', regex: /\/Users\/(?!example(?:\/|\b))[A-Za-z0-9._-]+/ },
  { name: 'hermes-path', regex: /\.hermes\b/ },
  { name: 'private-key', regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'github-token', regex: /\bgh[opsu]_[A-Za-z0-9]{20,}\b/ },
  { name: 'non-example-email', regex: /\b[A-Z0-9._%+-]+@(?!example\.(?:com|org|invalid)\b)[A-Z0-9.-]+\.[A-Z]{2,}\b/i },
  { name: 'internal-spec-reference', regex: /\b(?:PRODUCT(?:_V\d+)?|REQUIREMENTS)\.md\b|\.planning\//i },
];

function explicitSkillReferences(rel, text) {
  const references = new Set();
  const skillMatch = rel.match(/^skills\/([^/]+)\//);
  const currentSkill = skillMatch?.[1];
  const extension = String.raw`(?:mjs|js|py|md|sql|json)`;

  for (const match of text.matchAll(new RegExp(String.raw`~\/\.pi\/agent\/skills\/([a-z0-9-]+\/(?:scripts|references|fixtures|test|tests)\/[a-z0-9._/-]+\.${extension})(?![a-z])`, 'gi'))) {
    references.add(`skills/${match[1]}`);
  }
  for (const match of text.matchAll(new RegExp(String.raw`(?:\.\.\/)+([a-z0-9-]+)\/((?:scripts|references|fixtures|test|tests)\/[a-z0-9._/-]+\.${extension})(?![a-z])`, 'gi'))) {
    references.add(`skills/${match[1]}/${match[2]}`);
  }
  if (currentSkill) {
    for (const match of text.matchAll(new RegExp(String.raw`(?<![a-z0-9_./-])((?:scripts|references|fixtures|test|tests)\/[a-z0-9._/-]+\.${extension})(?![a-z])`, 'gi'))) {
      references.add(`skills/${currentSkill}/${match[1]}`);
    }
  }
  return references;
}

/** Scan a proposed release tree while ignoring generated VCS and dependency directories. */
export async function run(rootDir) {
  const findings = [];
  const files = [];

  async function walk(dir, prefix = '') {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) continue;
        for (const pattern of FORBIDDEN_DIRECTORY) {
          if (pattern.test(entry.name)) {
            findings.push({
              type: 'forbidden-directory',
              path: rel,
              detail: `directory ${entry.name} must not be released`,
            });
          }
        }
        await walk(full, rel);
        continue;
      }

      for (const pattern of FORBIDDEN_FILENAME) {
        if (pattern.test(entry.name)) {
          findings.push({
            type: 'forbidden-file',
            path: rel,
            detail: `filename ${entry.name} matches a forbidden pattern`,
          });
        }
      }
      if (rel.startsWith('skills/') && rel.includes('/references/') && /20\d{2}/.test(entry.name)) {
        findings.push({
          type: 'dated-application-reference',
          path: rel,
          detail: 'dated application evidence must remain outside the published skill',
        });
      }
      files.push(full);
    }
  }

  await walk(rootDir);

  const publishedPaths = new Set(files.map((filePath) => relative(rootDir, filePath).split('\\').join('/')));

  for (const filePath of files) {
    const rel = relative(rootDir, filePath).split('\\').join('/');
    if (CONTENT_EXCEPTIONS.has(rel)) continue;

    let content;
    try {
      content = await readFile(filePath);
    } catch {
      continue;
    }
    if (content.includes(0)) continue;

    const text = content.toString('utf8');
    for (const { name, regex } of CONTENT_PATTERNS) {
      if (regex.test(text)) {
        findings.push({ type: 'forbidden-content', path: rel, detail: `contains ${name}` });
      }
    }
    if (rel.startsWith('skills/') && /(?:application|applied|submitted).{0,120}20\d{2}-\d{2}-\d{2}|20\d{2}-\d{2}-\d{2}.{0,120}(?:application|applied|submitted)/i.test(text)) {
      findings.push({ type: 'dated-application-evidence', path: rel, detail: 'contains dated application-run evidence' });
    }
    if (rel.startsWith('skills/') && /linkedin\.com\/jobs\/view\/\d{6,}/i.test(text)) {
      findings.push({ type: 'application-record', path: rel, detail: 'contains a real-looking LinkedIn job URL' });
    }
    if (rel.startsWith('skills/') && /(?:job[_ -]?id|jobId|refresh(?:-job-ids?)?|jobs\/view\/|jk=)[^\n]{0,40}(?:\b(?!9)\d{7,10}\b|\b(?!f)[a-f0-9]{16}\b)/i.test(text)) {
      findings.push({ type: 'real-looking-job-identifier', path: rel, detail: 'contains a non-synthetic job identifier' });
    }
    if (rel.startsWith('skills/') && /(?:authorized|right to work|sponsor|visa|current salary|current employer).{0,120}(?:ans|want|val)\s*[:=]\s*['"][^'"]+['"]/i.test(text)) {
      findings.push({ type: 'hardcoded-sensitive-answer', path: rel, detail: 'contains a hardcoded sensitive application answer' });
    }
    for (const reference of explicitSkillReferences(rel, text)) {
      if (!publishedPaths.has(reference)) {
        findings.push({ type: 'dangling-skill-reference', path: rel, detail: `references missing ${reference}` });
      }
    }
  }

  if (findings.length === 0) {
    return { exitCode: 0, output: ['Release safety: no forbidden files or content found.'], findings };
  }

  const output = findings.map((finding) =>
    `[FAIL] ${finding.type}: ${finding.path} — ${finding.detail}`
  );
  output.push(`Release safety: ${findings.length} finding(s).`);
  return { exitCode: 1, output, findings };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] || process.cwd();
  const { exitCode, output } = await run(root);
  for (const line of output) console.log(line);
  process.exit(exitCode);
}
