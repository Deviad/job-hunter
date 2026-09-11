#!/usr/bin/env node
import path from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { readLinkedInAccess, pauseLinkedInAccess, resumeLinkedInAccess } from './linkedin-access.mjs';

const diagnostic = 'Invalid LinkedIn access arguments. Use --help for usage.';
const usage = `Usage: jh-linkedin-access.mjs status [--db PATH]
       jh-linkedin-access.mjs pause --reason TEXT [--run-id ID] [--db PATH]
       jh-linkedin-access.mjs resume --acknowledge --reason TEXT [--db PATH]
       jh-linkedin-access.mjs --help`;

export function parseArgs(argv) {
  const invalid = () => { throw new Error(diagnostic); };
  if (!Array.isArray(argv) || argv.some((arg) => typeof arg !== 'string')) invalid();
  const options = { help: false, action: null, db: null, reason: null, runId: null, acknowledge: null };
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { ...options, help: true };
  const action = argv[0];
  if (!['status', 'pause', 'resume'].includes(action)) invalid();
  options.action = action;
  options.db = process.env.JOBHUNTER_DB || path.join(process.env.JOBHUNTER_HOME || path.join(process.env.HOME || homedir(), '.job-hunter'), 'jobhunter.sqlite');
  if (action === 'resume') options.acknowledge = false;
  const permitted = new Set(['--db', ...(action === 'pause' ? ['--reason', '--run-id'] : action === 'resume' ? ['--reason', '--acknowledge'] : [])]);
  const seen = new Set();
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    if (!permitted.has(flag) || seen.has(flag)) invalid();
    seen.add(flag);
    if (flag === '--acknowledge') { options.acknowledge = true; continue; }
    const value = argv[++i];
    if (value === undefined || value.startsWith('--')) invalid();
    options[{ '--db': 'db', '--reason': 'reason', '--run-id': 'runId' }[flag]] = value;
  }
  if (action !== 'status' && options.reason === null) invalid();
  if (action === 'resume' && options.acknowledge !== true) invalid();
  return options;
}

export function main(argv = process.argv.slice(2)) {
  let options;
  try { options = parseArgs(argv); } catch {
    console.error(diagnostic);
    return 1;
  }
  if (options.help) { console.log(usage); return 0; }
  const result = options.action === 'status' ? readLinkedInAccess(options.db) :
    options.action === 'pause' ? pauseLinkedInAccess(options.db, options) : resumeLinkedInAccess(options.db, options);
  if (result.error?.code === 'INVALID_ARGUMENT') { console.error(diagnostic); return 1; }
  console.log(JSON.stringify(result));
  return result.ok ? 0 : 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) process.exitCode = main();
