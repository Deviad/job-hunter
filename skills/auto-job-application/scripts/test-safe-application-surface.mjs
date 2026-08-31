#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const allowed = [
  'brave-cdp-proxy.mjs',
  'test-safe-application-surface.mjs',
];
const actual = readdirSync(scriptsDir).filter((name) => /\.(mjs|js)$/.test(name)).sort();
assert.deepEqual(actual, allowed);

const mutationPatterns = [
  /\.click\s*\(/,
  /DOM\.setFileInputFiles/,
  /Input\.dispatchMouseEvent/,
  /submit\s*\(/i,
  /screening.{0,80}(?:yes|no)/i,
];
for (const name of allowed.filter((entry) => !entry.startsWith('test-'))) {
  const source = readFileSync(join(scriptsDir, name), 'utf8');
  for (const pattern of mutationPatterns) {
    assert.doesNotMatch(source, pattern, `${name} contains a form-mutation primitive`);
  }
}

console.log('safe application surface tests: PASS');
