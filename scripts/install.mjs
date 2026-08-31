#!/usr/bin/env node
// install.mjs — idempotent global installer for Job Hunter skill closure.
// Installs skills under ${PI_AGENT_HOME}/skills/ and creates workspace at ${JOBHUNTER_HOME}.
// Supports --dry-run, --uninstall. Rolls back on failure. Preserves user data.
import {
  cpSync, existsSync, mkdirSync, readFileSync, readdirSync,
  rmSync, statSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);

const PROJECT_ROOT = process.env.JOBHUNTER_SOURCE_ROOT
  ? path.resolve(process.env.JOBHUNTER_SOURCE_ROOT)
  : path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SKILLS_SRC = path.join(PROJECT_ROOT, 'skills');
const TEMPLATE_SRC = path.join(PROJECT_ROOT, 'workspace-template');
const MANIFEST_NAME = '.install-manifest.json';

// User data files the installer must never overwrite or remove.
const PRESERVED_FILES = new Set([
  'CV.docx', 'personal-info-cache.json', 'jobhunter.sqlite',
]);

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const uninstall = args.includes('--uninstall');

const PI_AGENT_HOME = process.env.PI_AGENT_HOME || path.join(process.env.HOME, '.pi', 'agent');
const PI_SKILLS_HOME = path.join(PI_AGENT_HOME, 'skills');
const JOBHUNTER_HOME = process.env.JOBHUNTER_HOME || path.join(process.env.HOME, '.job-hunter');
const TEST_FAIL_AFTER_COPIES = process.env.NODE_ENV === 'test'
  ? Number.parseInt(process.env.JOBHUNTER_TEST_FAIL_AFTER_COPIES || '0', 10)
  : 0;

// --- Logging ---

const logLines = [];
function log(msg) { logLines.push(msg); }
function flush() { for (const line of logLines) console.log(line); }

// --- Manifest ---

function manifestPath() {
  return path.join(JOBHUNTER_HOME, MANIFEST_NAME);
}

function readManifest() {
  const p = manifestPath();
  if (!existsSync(p)) return { version: 0, installedFiles: [], installedDirs: [] };
  return JSON.parse(readFileSync(p, 'utf-8'));
}

function writeManifest(manifest) {
  ensureDirSafe(JOBHUNTER_HOME);
  writeFileSync(manifestPath(), JSON.stringify(manifest, null, 2) + '\n');
}

function fileHash(filePath) {
  try {
    return createHash('sha256').update(readFileSync(filePath)).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

// --- Filesystem helpers (dry-run aware) ---

function ensureDirSafe(dir) {
  if (existsSync(dir)) return;
  if (dryRun) { log(`  mkdir ${dir}`); return; }
  mkdirSync(dir, { recursive: true });
  log(`  created ${dir}`);
}

function copyFileSafe(src, dest) {
  if (dryRun) { log(`  copy ${src} -> ${dest}`); return; }
 cpSync(src, dest);
}

function removeFileSafe(filePath) {
  if (!existsSync(filePath)) return;
  if (dryRun) { log(`  rm ${filePath}`); return; }
  rmSync(filePath, { force: true });
  log(`  removed ${filePath}`);
}

function removeDirSafe(dirPath) {
  if (!existsSync(dirPath)) return;
  if (dryRun) { log(`  rmdir ${dirPath}`); return; }
  rmSync(dirPath, { recursive: true, force: true });
  log(`  removed ${dirPath}`);
}

// --- Walk files ---

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

// --- Collect install targets ---

function collectSkillFiles() {
  const files = [];
  if (!existsSync(SKILLS_SRC)) return files;
  for (const entry of readdirSync(SKILLS_SRC, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const srcDir = path.join(SKILLS_SRC, entry.name);
    const destDir = path.join(PI_SKILLS_HOME, entry.name);
    for (const file of walkFiles(srcDir)) {
      files.push({
        src: file,
        dest: path.join(destDir, path.relative(srcDir, file)),
      });
    }
  }
  return files;
}

function collectTemplateFiles() {
  const files = [];
  if (!existsSync(TEMPLATE_SRC)) return files;
  for (const file of walkFiles(TEMPLATE_SRC)) {
    const rel = path.relative(TEMPLATE_SRC, file);
    if (rel === 'package.json') continue; // handled separately
    const destRel = rel === 'personal-info-cache.example.json'
      ? 'personal-info-cache.json'
      : rel;
    files.push({
      src: file,
      dest: path.join(JOBHUNTER_HOME, destRel),
      preserved: PRESERVED_FILES.has(path.basename(destRel)),
    });
  }
  return files;
}

function collectDirs(files) {
  const dirs = new Set();
  for (const { dest } of files) {
    let d = path.dirname(dest);
    while (d.length > 1) { dirs.add(d); d = path.dirname(d); }
  }
  for (const sub of ['backups', 'logs', 'apply_logs', 'optional_documents', 'chromium-profile', 'searxng']) {
    dirs.add(path.join(JOBHUNTER_HOME, sub));
  }
  return [...dirs].sort();
}

// --- Install ---

function doInstall(transaction) {
  const skillFiles = collectSkillFiles();
  const templateFiles = collectTemplateFiles();
  const allFiles = [...skillFiles, ...templateFiles];
  const dirs = collectDirs(allFiles);
  transaction.managedDirs = dirs;

  if (skillFiles.length === 0) throw new Error('no bundled skill files found');
  if (!existsSync(path.join(TEMPLATE_SRC, 'package.json')) || !existsSync(path.join(TEMPLATE_SRC, 'package-lock.json'))) {
    throw new Error('workspace package.json and package-lock.json are required');
  }

  if (dryRun) log('[DRY RUN] No changes will be made.\n');

  // 1. Create directories.
  for (const d of dirs) {
    if (!existsSync(d)) {
      ensureDirSafe(d);
      if (!dryRun) transaction.createdDirs.push(d);
    }
  }

  // 2. Copy files with preservation check.
  for (const { src, dest, preserved } of allFiles) {
    if (preserved && existsSync(dest)) {
      log(`  preserved ${dest} (user file)`);
      continue;
    }
    const existed = existsSync(dest);
    copyFileSafe(src, dest);
    if (!dryRun) transaction.managedFiles.push(dest);
    if (!dryRun && !existed) transaction.createdFiles.push(dest);
    if (!dryRun && TEST_FAIL_AFTER_COPIES > 0 && transaction.createdFiles.length >= TEST_FAIL_AFTER_COPIES) {
      throw new Error('injected copy failure for rollback verification');
    }
  }

  // 3. Write workspace package.json from template (only if absent).
  const wsPkgPath = path.join(JOBHUNTER_HOME, 'package.json');
  const wsPkgTemplate = path.join(TEMPLATE_SRC, 'package.json');
  if (!existsSync(wsPkgPath) && existsSync(wsPkgTemplate)) {
    copyFileSafe(wsPkgTemplate, wsPkgPath);
    if (!dryRun) {
      transaction.managedFiles.push(wsPkgPath);
      transaction.createdFiles.push(wsPkgPath);
    }
  } else if (existsSync(wsPkgPath)) {
    transaction.managedFiles.push(wsPkgPath);
  }

  // 4. Initialize DB from schema if absent.
  const dbPath = path.join(JOBHUNTER_HOME, 'jobhunter.sqlite');
  const schemaSrc = path.join(TEMPLATE_SRC, 'schema.sql');
  if (!existsSync(dbPath) && existsSync(schemaSrc)) {
    if (!dryRun) {
      try {
        const Database = require('better-sqlite3');
        const db = new Database(dbPath);
        db.exec(readFileSync(schemaSrc, 'utf-8'));
        db.close();
        log(`  initialized ${dbPath} from schema.sql`);
        // DB is not added to created — it's a preserved file once created.
      } catch (e) {
        // better-sqlite3 native module not available yet — expected on fresh install.
        log(`  WARN: better-sqlite3 unavailable, DB will initialize after workspace npm install`);
      }
    } else {
      log(`  [DRY RUN] would initialize ${dbPath} from schema.sql`);
    }
  } else if (existsSync(dbPath)) {
    log(`  DB present: ${dbPath}`);
  }

  // 5. Install workspace npm dependencies.
  if (existsSync(wsPkgPath) && !dryRun) {
    const nodeModulesPath = path.join(JOBHUNTER_HOME, 'node_modules');
    const nodeModulesExisted = existsSync(nodeModulesPath);
    const npm = spawnSync('npm', ['ci'], {
      cwd: JOBHUNTER_HOME,
      encoding: 'utf8',
      timeout: 120_000,
    });
    if (!nodeModulesExisted && existsSync(nodeModulesPath)) {
      transaction.createdRuntimeDirs.push(nodeModulesPath);
    }
    if (!nodeModulesExisted || transaction.managedRuntimeDirs.includes(nodeModulesPath)) {
      transaction.managedRuntimeDirs.push(nodeModulesPath);
    }
    if (npm.status !== 0) {
      throw new Error(`workspace npm ci failed: ${(npm.stderr || npm.stdout || '').trim().split('\n')[0]}`);
    }
    if (process.env.NODE_ENV === 'test' && process.env.JOBHUNTER_TEST_FAIL_AFTER_NPM_CI === '1') {
      throw new Error('injected failure after workspace npm ci');
    }
    log('  npm ci succeeded in workspace');
  }

  // 6. Write manifest.
  if (!dryRun) {
    writeManifest({
      version: 1,
      installedFiles: [...new Set(transaction.managedFiles)].map((f) => ({ path: f, hash: fileHash(f) })),
      installedDirs: transaction.managedDirs,
      installedRuntimeDirs: [...new Set(transaction.managedRuntimeDirs)],
      timestamp: new Date().toISOString(),
    });
    log(`  wrote manifest: ${manifestPath()}`);
  } else {
    log(`  [DRY RUN] would write manifest to ${manifestPath()}`);
  }

  log('\nInstallation complete.');
  flush();
}

// --- Uninstall ---

function doUninstall() {
  const manifest = readManifest();
  if (!manifest.installedFiles?.length && !manifest.installedDirs?.length) {
    console.log('Nothing to uninstall (no manifest found or manifest is empty).');
    return;
  }

  if (dryRun) log('[DRY RUN] No changes will be made.\n');

  for (const entry of [...(manifest.installedFiles || [])].reverse()) {
    const p = entry.path || entry;
    if (PRESERVED_FILES.has(path.basename(p))) {
      log(`  preserved ${p} (user file)`);
      continue;
    }
    removeFileSafe(p);
  }

  for (const runtimeDir of [...(manifest.installedRuntimeDirs || [])].reverse()) {
    removeDirSafe(runtimeDir);
  }

  for (const d of [...(manifest.installedDirs || [])].reverse()) {
    if (!existsSync(d)) continue;
    try {
      if (readdirSync(d).length === 0) removeDirSafe(d);
      else log(`  skipped ${d} (not empty)`);
    } catch {
      removeDirSafe(d);
    }
  }

  removeFileSafe(manifestPath());
  log('\nUninstall complete.');
  flush();
}

// --- Rollback ---

function takeSnapshot() {
  const snap = { files: new Map(), dirs: new Set() };
  for (const base of [PI_AGENT_HOME, JOBHUNTER_HOME]) {
    if (!existsSync(base)) continue;
    for (const entry of walkFiles(base)) {
      snap.files.set(entry, fileHash(entry));
    }
    let d = base;
    while (d.length > 1) {
      if (existsSync(d)) snap.dirs.add(d);
      d = path.dirname(d);
    }
  }
  return snap;
}

function rollback(snap, transaction) {
  for (const runtimeDir of [...transaction.createdRuntimeDirs].reverse()) {
    removeDirSafe(runtimeDir);
  }

  for (const filePath of [...transaction.createdFiles].reverse()) {
    if (!snap.files.has(filePath)) removeFileSafe(filePath);
  }

  for (const dirPath of [...transaction.createdDirs].reverse()) {
    if (!snap.dirs.has(dirPath) && existsSync(dirPath)) {
      try {
        if (readdirSync(dirPath).length === 0) removeDirSafe(dirPath);
      } catch { /* leave it */ }
    }
  }

  const mp = manifestPath();
  if (!snap.files.has(mp)) removeFileSafe(mp);
  console.log('Rollback complete.');
}

// --- Entry ---

function main() {
  if (uninstall) { doUninstall(); return; }
  const preSnapshot = takeSnapshot();
  const existingManifest = readManifest();
  const transaction = {
    createdFiles: [],
    createdDirs: [],
    createdRuntimeDirs: [],
    managedFiles: [],
    managedDirs: [],
    managedRuntimeDirs: [...(existingManifest.installedRuntimeDirs || [])],
  };
  try {
    doInstall(transaction);
  } catch (err) {
    console.error(`\nInstallation failed: ${err.message}`);
    console.error('Rolling back...');
    rollback(preSnapshot, transaction);
    process.exit(1);
  }
}

main();
