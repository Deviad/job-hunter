import { stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIRED_CATEGORIES = [
  'skills',
  'packages',
  'executables',
  'services',
  'mcp',
  'workflow-stage',
];

export const REQUIRED_SERVICES = ['selenium', 'chromium', 'searxng'];

/**
 * Validate docs/dependency-matrix.md contains required structural categories
 * and mentions the required external services.
 */
export async function run(rootDir) {
  const findings = [];
  const output = [];
  const matrixPath = join(rootDir, 'docs', 'dependency-matrix.md');

  const s = await stat(matrixPath).catch(() => null);
  if (!s || !s.isFile()) {
    findings.push({ type: 'missing-matrix', path: 'docs/dependency-matrix.md', detail: 'dependency matrix not found' });
    output.push('[FAIL] missing-matrix: docs/dependency-matrix.md — dependency matrix not found');
    return { exitCode: 1, output, findings };
  }

  const content = await readFile(matrixPath, 'utf8');

  if (content.trim().length === 0) {
    findings.push({ type: 'empty-matrix', path: 'docs/dependency-matrix.md', detail: 'file is empty' });
  }

  // Check for required category headings or table headers
  const lower = content.toLowerCase();
  for (const cat of REQUIRED_CATEGORIES) {
    if (!lower.includes(cat)) {
      findings.push({ type: 'missing-category', path: 'docs/dependency-matrix.md', detail: `category "${cat}" not found` });
    }
  }

  // Check required services are mentioned
  for (const svc of REQUIRED_SERVICES) {
    if (!lower.includes(svc)) {
      findings.push({ type: 'missing-service', path: 'docs/dependency-matrix.md', detail: `service "${svc}" not mentioned` });
    }
  }

  // Check the 14 bundled skills are mentioned
  const { REQUIRED_SKILLS } = await import('./verify-skill-closure.mjs');
  for (const skill of REQUIRED_SKILLS) {
    if (!lower.includes(skill)) {
      findings.push({ type: 'missing-skill-entry', path: 'docs/dependency-matrix.md', detail: `skill "${skill}" not listed` });
    }
  }

  if (findings.length === 0) {
    output.push('Dependency matrix: all required categories, services, and skills present.');
    return { exitCode: 0, output, findings: [] };
  }

  for (const f of findings) {
    output.push(`[FAIL] ${f.type}: ${f.path} — ${f.detail}`);
  }
  output.push(`Dependency matrix: ${findings.length} finding(s).`);
  return { exitCode: 1, output, findings };
}

// CLI
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] || process.cwd();
  const { exitCode, output } = await run(root);
  for (const line of output) console.log(line);
  process.exit(exitCode);
}
