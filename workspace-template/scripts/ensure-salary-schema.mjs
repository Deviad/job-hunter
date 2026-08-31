#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

/** Forward schema maintenance to the installed salary-calculator skill. */
const agentHome = process.env.PI_AGENT_HOME || join(process.env.HOME, '.pi', 'agent');
const script = join(agentHome, 'skills', 'salary-calculator', 'scripts', 'ensure-salary-schema.mjs');
const result = spawnSync(process.execPath, [script, ...process.argv.slice(2)], {
  env: process.env,
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
