#!/usr/bin/env node
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';

const args = process.argv.slice(2);
const input = args[0] || '/tmp/linkedin-session.json';
const output = args[1] || '/tmp/linkedin-cookies.txt';

const secret = JSON.parse(readFileSync(input, 'utf8'));
const lines = ['# Netscape HTTP Cookie File'];
for (const c of secret.cookies || []) {
  const domain = c.domain || 'www.linkedin.com';
  const includeSubdomains = domain.startsWith('.') ? 'TRUE' : 'FALSE';
  const path = c.path || '/';
  const secure = c.secure ? 'TRUE' : 'FALSE';
  const expires = Number.isFinite(c.expires) ? Math.floor(c.expires) : 0;
  lines.push([domain, includeSubdomains, path, secure, expires, c.name, c.value].join('\t'));
}
writeFileSync(output, lines.join('\n') + '\n');
chmodSync(output, 0o600);
console.log(`Cookie file created: ${output} (${(secret.cookies || []).length} cookies)`);
