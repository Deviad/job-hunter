import { stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Parse README.md for command references and verify each resolves to a
 * shipped file or package script.
 */
export async function run(rootDir) {
  const findings = [];
  const output = [];
  const readmePath = join(rootDir, 'README.md');

  const s = await stat(readmePath).catch(() => null);
  if (!s || !s.isFile()) {
    findings.push({ type: 'missing-readme', path: 'README.md', detail: 'README.md not found' });
    output.push('[FAIL] missing-readme: README.md — README.md not found');
    return { exitCode: 1, output, findings };
  }

  const content = await readFile(readmePath, 'utf8');

  // Extract file paths from code blocks and inline code
  // Matches: node scripts/foo.mjs, ./scripts/foo.sh, scripts/foo.mjs
  const fileRefRe = /(?:^|\s)(?:node |bash |\.\/)?(scripts\/[\w./-]+\.(?:mjs|js|sh))/gm;
  const refs = new Set();
  let m;
  while ((m = fileRefRe.exec(content)) !== null) {
    refs.add(m[1]);
  }

  // Also match `npm run <script>` — these resolve to package.json scripts
  const npmRunRe = /npm run (\w[\w:-]*)/g;
  const npmRefs = new Set();
  while ((m = npmRunRe.exec(content)) !== null) {
    npmRefs.add(m[1]);
  }

  if (refs.size === 0 && npmRefs.size === 0) {
    findings.push({ type: 'no-commands', path: 'README.md', detail: 'no local script or npm run commands found' });
  }

  // Verify file references exist
  for (const ref of refs) {
    const fullPath = join(rootDir, ref);
    const f = await stat(fullPath).catch(() => null);
    if (!f || !f.isFile()) {
      findings.push({ type: 'missing-script', path: ref, detail: 'referenced script does not exist' });
    }
  }

  // Verify npm run references exist in package.json
  if (npmRefs.size > 0) {
    const pkgPath = join(rootDir, 'package.json');
    const pkgContent = await readFile(pkgPath, 'utf8').catch(() => '{}');
    let pkg;
    try { pkg = JSON.parse(pkgContent); } catch { pkg = {}; }
    const scripts = pkg.scripts || {};
    for (const name of npmRefs) {
      if (!scripts[name]) {
        findings.push({ type: 'missing-npm-script', path: `package.json#scripts.${name}`, detail: `npm run ${name} not defined` });
      }
    }
  }

  if (findings.length === 0) {
    const total = refs.size + npmRefs.size;
    output.push(`Doc commands: all ${total} referenced commands resolve.`);
    return { exitCode: 0, output, findings: [] };
  }

  for (const f of findings) {
    output.push(`[FAIL] ${f.type}: ${f.path} — ${f.detail}`);
  }
  output.push(`Doc commands: ${findings.length} finding(s).`);
  return { exitCode: 1, output, findings };
}

// CLI
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] || process.cwd();
  const { exitCode, output } = await run(root);
  for (const line of output) console.log(line);
  process.exit(exitCode);
}
