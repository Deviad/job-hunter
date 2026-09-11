// Shared standard-library DOCX parser. Buffer input keeps text and CV hash atomic.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const parser = fileURLToPath(new URL('./docx_text.py', import.meta.url));
export function extractDocxText(input) {
  const bytes = Buffer.isBuffer(input) ? input : readFileSync(input);
  return execFileSync('python3', [parser], { input: bytes, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 30000 });
}
