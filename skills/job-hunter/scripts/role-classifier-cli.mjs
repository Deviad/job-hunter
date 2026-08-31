#!/usr/bin/env node
/**
 * Deterministic stdin/stdout batch bridge for the shared role taxonomy.
 * Input is a JSON array of classifier inputs; output is the same-sized array.
 */
import {
  assertRoleClassification,
  classifyRole,
} from './role-taxonomy.mjs';

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return chunks.join('');
}

function fail(message) {
  console.error(`role-classifier-cli: ${message}`);
  process.exitCode = 1;
}

function descriptionTextFor(input) {
  for (const key of ['descriptionText', 'description', 'description_text']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

try {
  const raw = await readStdin();
  const parsed = JSON.parse(raw || 'null');
  const inputs = Array.isArray(parsed)
    ? parsed
    : parsed && Array.isArray(parsed.jobs)
      ? parsed.jobs
      : null;
  if (!inputs) throw new TypeError('input must be a JSON array or an object with a jobs array');

  const results = inputs.map((input, index) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new TypeError(`input[${index}] must be an object`);
    }
    return assertRoleClassification(classifyRole({
      ...input,
      descriptionText: descriptionTextFor(input),
    }));
  });
  process.stdout.write(JSON.stringify(results));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
