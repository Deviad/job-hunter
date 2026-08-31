import { stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const README_SECTIONS = [
  'prerequisites',
  'installation',
  'initialization',
  'doctor',
  'search',
  'score',
  'salary',
  'apply',
  'update',
  'uninstall',
  'troubleshooting',
];

export const SECURITY_SECTIONS = [
  'local data',
  'sensitive',
  'credential',
  'browser',
  'captcha',
  'backup',
  'disclosure',
];

export const PREREQUISITES_SECTIONS = [
  'auto',
  'host',
  'container',
  'authenticated',
];

/**
 * Verify required documentation sections exist.
 * - README.md has the 11 required sections
 * - docs/security-and-privacy.md exists with required sections
 * - docs/prerequisites.md exists and distinguishes auto-installed vs host tools
 */
export async function run(rootDir) {
  const findings = [];
  const output = [];

  // --- README.md sections ---
  const readmePath = join(rootDir, 'README.md');
  const readmeStat = await stat(readmePath).catch(() => null);
  if (!readmeStat || !readmeStat.isFile()) {
    findings.push({ type: 'missing-readme', path: 'README.md', detail: 'README.md not found' });
  } else {
    const readme = await readFile(readmePath, 'utf8');
    const readmeLower = readme.toLowerCase();

    // Look for heading-level sections (## or ###) containing the keyword
    for (const section of README_SECTIONS) {
      // Match as a markdown heading containing the word
      const headingRe = new RegExp(`^#{1,4}\\s+.*\\b${section}\\b.*$`, 'mi');
      if (!headingRe.test(readme)) {
        findings.push({
          type: 'missing-readme-section',
          path: 'README.md',
          detail: `required section "${section}" not found as a heading`,
        });
      }
    }
  }

  // --- docs/security-and-privacy.md ---
  const secPath = join(rootDir, 'docs', 'security-and-privacy.md');
  const secStat = await stat(secPath).catch(() => null);
  if (!secStat || !secStat.isFile()) {
    findings.push({ type: 'missing-security-doc', path: 'docs/security-and-privacy.md', detail: 'file not found' });
  } else {
    const sec = await readFile(secPath, 'utf8');
    const secLower = sec.toLowerCase();
    for (const section of SECURITY_SECTIONS) {
      if (!secLower.includes(section)) {
        findings.push({
          type: 'missing-security-section',
          path: 'docs/security-and-privacy.md',
          detail: `required content "${section}" not found`,
        });
      }
    }
  }

  // --- docs/prerequisites.md ---
  const prePath = join(rootDir, 'docs', 'prerequisites.md');
  const preStat = await stat(prePath).catch(() => null);
  if (!preStat || !preStat.isFile()) {
    findings.push({ type: 'missing-prerequisites-doc', path: 'docs/prerequisites.md', detail: 'file not found' });
  } else {
    const pre = await readFile(prePath, 'utf8');
    const preLower = pre.toLowerCase();
    for (const section of PREREQUISITES_SECTIONS) {
      if (!preLower.includes(section)) {
        findings.push({
          type: 'missing-prerequisites-section',
          path: 'docs/prerequisites.md',
          detail: `required content "${section}" not found`,
        });
      }
    }
  }

  // --- Report ---
  if (findings.length === 0) {
    output.push('Required doc sections: all present.');
    return { exitCode: 0, output, findings: [] };
  }

  for (const f of findings) {
    output.push(`[FAIL] ${f.type}: ${f.path} — ${f.detail}`);
  }
  output.push(`Required doc sections: ${findings.length} finding(s).`);
  return { exitCode: 1, output, findings };
}

// CLI
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] || process.cwd();
  const { exitCode, output } = await run(root);
  for (const line of output) console.log(line);
  process.exit(exitCode);
}
