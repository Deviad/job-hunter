#!/usr/bin/env node
// verify-runtime-dependencies.mjs — report runtime dependency status.
// Categories: required (fail blocks install), conditional (warn), optional (info).
// Exits 0 if all required deps present. Prints deterministic pass/fail/optional report.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// --- PEP 723 parser ---

/** Parse PEP 723 `# /// script ... dependencies = [...] ///` block from file content.
 *  Returns set of top-level package names declared. */
function parsePep723Deps(content) {
  const deps = new Set();
  const block = content.match(/^#\s*\/\/\/\s*script\s*$[\s\S]*?^#\s*\/\/\/\s*$/m);
  if (!block) return deps;
  const depLine = block[0].match(/dependencies\s*=\s*\[([^\]]*)\]/);
  if (!depLine) return deps;
  // Extract package names: e.g. "pypdf>=5", "Pillow>=10" -> pypdf, Pillow
  for (const m of depLine[1].matchAll(/["']([\w-]+)/g)) {
    deps.add(m[1].toLowerCase());
  }
  return deps;
}

/** Map of import-name to declared-package-name for common packages. */
const IMPORT_TO_PACKAGE = {
  'pil': 'pillow',
  'docx': 'python-docx',
  'pysqlite3': 'pysqlite3',
  'cv2': 'opencv-python',
  'bs4': 'beautifulsoup4',
  'yaml': 'pyyaml',
  'dateutil': 'python-dateutil',
};

/** Resolve an import name to its package name for PEP 723 lookup. */
function importToPkgName(importName) {
  const lower = importName.toLowerCase();
  if (IMPORT_TO_PACKAGE[lower]) return IMPORT_TO_PACKAGE[lower];
  return lower;
}

const require = createRequire(import.meta.url);
const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// --- Check helpers ---

function checkCommand(cmd, minVersion, flags = ['--version']) {
  try {
    const out = execSync(`${cmd} ${flags[0]}`, { encoding: 'utf-8', stdio: 'pipe' }).trim();
    return { found: true, version: out.split(/\s+/)[0] || out, raw: out };
  } catch {
    return { found: false };
  }
}

function checkNpmPackage(pkgName) {
  try {
    const pkg = require(pkgName + '/package.json');
    return { found: true, version: pkg.version };
  } catch {
    return { found: false };
  }
}

function checkPythonUv() {
  try {
    const out = execSync('uv --version', { encoding: 'utf-8', stdio: 'pipe' }).trim();
    return { found: true, version: out.split(/\s+/)[0] || out };
  } catch {
    return { found: false };
  }
}

function checkDocker() {
  try {
    const out = execSync('docker --version', { encoding: 'utf-8', stdio: 'pipe' }).trim();
    return { found: true, version: out.match(/[\d.]+/)?.[0] || out };
  } catch {
    return { found: false };
  }
}

function checkDockerCompose() {
  try {
    execSync('docker compose version', { encoding: 'utf-8', stdio: 'pipe' });
    return { found: true };
  } catch {
    return { found: false };
  }
}

// --- Python import scanner ---

const SKILLS_SRC = path.join(PROJECT_ROOT, 'skills');

/** Scan all .py files under SKILLS_SRC, cross-reference imports against
 *  stdlib + each file's own PEP 723 dependency block.
 *  Returns { declared: [...], undeclared: [...] }. */
function scanPythonImportsWithPep723() {
  const declared = [];
  const undeclared = [];
  if (!existsSync(SKILLS_SRC)) return { declared, undeclared };
  const pythonFiles = walkFiles(SKILLS_SRC).filter((file) => file.endsWith('.py'));
  const localModules = new Set(pythonFiles.map((file) => path.basename(file, '.py')));
  for (const file of pythonFiles) {
    if (!file.endsWith('.py')) continue;
    const content = readFileSync(file, 'utf-8');
    const pep723 = parsePep723Deps(content);
    const fileImports = new Set();
    for (const m of content.matchAll(/^\s*import\s+(\w+)/gm)) fileImports.add(m[1]);
    for (const m of content.matchAll(/^\s*from\s+(\w+)/gm)) fileImports.add(m[1]);
    for (const imp of fileImports) {
      if (STDLIB_PY.has(imp) || localModules.has(imp)) continue;
      const pkg = importToPkgName(imp);
      if (pep723.has(pkg)) {
        declared.push(`${path.relative(SKILLS_SRC, file)}: ${imp}`);
      } else {
        undeclared.push(`${imp} (in ${path.relative(SKILLS_SRC, file)})`);
      }
    }
  }
  return { declared, undeclared };
}

const STDLIB_PY = new Set([
  '__future__', 'os', 'sys', 'json', 'path', 're', 'subprocess', 'argparse', 'io',
  'typing', 'dataclasses', 'enum', 'datetime', 'hashlib', 'shutil',
  'tempfile', 'contextlib', 'functools', 'itertools', 'collections',
  'abc', 'copy', 'csv', 'http', 'urllib', 'xml', 'html', 'math',
  'statistics', 'sqlite3', 'struct', 'time', 'logging', 'warnings',
  'importlib', 'zipfile', 'tarfile', 'gzip', 'base64', 'textwrap',
  'string', 'random', 'unittest', 'pathlib', 'filecmp', 'traceback',
  'selectors', 'signal', 'socket', 'ssl', 'threading', 'multiprocessing',
  'concurrent', 'asyncio', 'queue', 'smtplib', 'email', 'ftplib',
  'webbrowser', 'token', 'tokenize', 'ast', 'dis', 'inspect',
]);

// --- Walk ---

function walkFiles(dir) {
  const results = [];
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walkFiles(full));
    else results.push(full);
  }
  return results;
}

// --- Dependency definitions ---

const checks = {
  required: [
    { name: 'node', check: () => checkCommand('node') },
    { name: 'npm', check: () => checkCommand('npm') },
    { name: 'better-sqlite3 (root)', check: () => checkNpmPackage('better-sqlite3') },
    { name: 'ws (root)', check: () => checkNpmPackage('ws') },
  ],
  conditional: [
    { name: 'uv', check: () => checkPythonUv(), hint: 'required for DOCX/PDF helpers' },
    { name: 'docker', check: () => checkDocker(), hint: 'required for Selenium Chromium + SearXNG' },
    { name: 'docker compose', check: () => checkDockerCompose(), hint: 'required for Selenium Chromium + SearXNG' },
  ],
  optional: [
    { name: 'LM Studio (localhost:1234)', check: () => {
      try {
        const http = require('http');
        return new Promise((resolve) => {
          const req = http.get('http://localhost:1234/v1/models', (res) => {
            resolve({ found: res.statusCode < 500 });
          });
          req.on('error', () => resolve({ found: false }));
          req.setTimeout(2000, () => { req.destroy(); resolve({ found: false }); });
        });
      } catch { return { found: false }; }
    }, hint: 'optional: Qwen VLM visual recovery' },
  ],
};

// --- Main ---

async function main() {
  let hasRequiredFailure = false;
  const report = { required: [], conditional: [], optional: [] };

  for (const dep of checks.required) {
    const result = dep.check();
    const status = result.found ? 'PASS' : 'FAIL';
    if (!result.found) hasRequiredFailure = true;
    const entry = `[${status}] ${dep.name}${result.version ? ` (${result.version})` : ''}`;
    report.required.push(entry);
    console.log(entry);
  }

  console.log('');
  for (const dep of checks.conditional) {
    const result = await dep.check();
    const status = result.found ? 'PASS' : 'WARN';
    const entry = `[${status}] ${dep.name}${result.version ? ` (${result.version})` : ''}${!result.found && dep.hint ? ` — ${dep.hint}` : ''}`;
    report.conditional.push(entry);
    console.log(entry);
  }

  console.log('');
  for (const dep of checks.optional) {
    const result = await dep.check();
    const status = result.found ? 'PASS' : 'INFO';
    const entry = `[${status}] ${dep.name}${result.version ? ` (${result.version})` : ''}${!result.found && dep.hint ? ` — ${dep.hint}` : ''}`;
    report.optional.push(entry);
    console.log(entry);
  }

  // Python import scan with PEP 723 cross-reference.
  console.log('');
  const pyFindings = scanPythonImportsWithPep723();
  if (pyFindings.undeclared.length === 0) {
    console.log('[PASS] Python imports: all non-stdlib imports declared via PEP 723');
  } else {
    console.log(`[WARN] Python imports: undeclared non-stdlib imports: ${pyFindings.undeclared.join(', ')}`);
  }

  if (hasRequiredFailure) process.exit(1);
}

main();
