#!/usr/bin/env node
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const home = mkdtempSync(join(tmpdir(), 'job-hunter-installed-tests-'));
const env = {
  ...process.env,
  HOME: home,
  PI_AGENT_HOME: join(home, '.pi', 'agent'),
  JOBHUNTER_HOME: join(home, '.job-hunter'),
};

function testFiles(directory) {
  const files = [];
  function walk(current) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/(^test.*|.*\.test)\.(mjs|js|py)$/.test(basename(path))) files.push(path);
    }
  }
  walk(directory);
  return files.sort();
}

try {
  const install = spawnSync(process.execPath, [join(root, 'scripts', 'install.mjs')], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 300_000,
  });
  if (install.status !== 0) {
    process.stderr.write(install.stdout || '');
    process.stderr.write(install.stderr || '');
    throw new Error(`fresh installer exited ${install.status}`);
  }

  const ensureSchema = spawnSync('npm', [
    'run', 'ensure-schema', '--', '--db', join(env.JOBHUNTER_HOME, 'jobhunter.sqlite'), '--json',
  ], {
    cwd: env.JOBHUNTER_HOME,
    env,
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (ensureSchema.status !== 0) {
    process.stderr.write(ensureSchema.stdout || '');
    process.stderr.write(ensureSchema.stderr || '');
    throw new Error(`installed ensure-schema command exited ${ensureSchema.status}`);
  }

  const skillsRoot = join(env.PI_AGENT_HOME, 'skills');
  const results = [];
  for (const file of testFiles(skillsRoot)) {
    const executable = extname(file) === '.py' ? 'python3' : process.execPath;
    const result = spawnSync(executable, [file], {
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: 90_000,
    });
    results.push({ file: relative(home, file), result });
  }

  const failures = results.filter(({ result }) => result.status !== 0);
  for (const { file, result } of failures) {
    console.error(`\n[FAIL] ${file} (exit ${result.status}, signal ${result.signal || 'none'})`);
    const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim().split('\n');
    console.error(output.slice(-20).join('\n'));
  }

  console.log(`Installed skill tests: ${results.length - failures.length}/${results.length} passed.`);
  if (failures.length > 0) process.exitCode = 1;
} finally {
  rmSync(home, { recursive: true, force: true });
}
