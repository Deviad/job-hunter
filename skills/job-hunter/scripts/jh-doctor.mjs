#!/usr/bin/env node
// jh-doctor.mjs — health check for the job-hunter stack.
// Checks: home dir, DB, cache, CV, skill roots, CDP 9225, Selenium 4444,
//   noVNC 7900, container mount, SearXNG, stale writer lock, stale runs/ scripts.
// Required checks use fail(); optional/degraded checks use warn().
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  JOBHUNTER_HOME, DB_PATH, CACHE_PATH, CV_PATH,
} from './jh-common.mjs';

const checks = [];
const ok = (name, msg = '') => checks.push(`[OK]   ${name}${msg ? ' — ' + msg : ''}`);
const warn = (name, msg) => checks.push(`[WARN] ${name} — ${msg}`);
const fail = (name, msg) => checks.push(`[FAIL] ${name} — ${msg}`);

// The job-hunter pipeline may only load helper scripts from the
// installation skill root.  Detect the root from this script's own
// location so it works regardless of whether skills were installed
// globally ($PI_AGENT_HOME/skills), project-locally, or cloned.
const PIPELINE_SKILL_DIRS = ['job-hunter', 'linkedin-job-search', 'indeed-job-search', 'salary-calculator', 'auto-job-application'];
function checkSkillRoots() {
  const thisScriptDir = path.dirname(fileURLToPath(import.meta.url));
  const thisSkillDir = path.dirname(thisScriptDir);   // .../skills/job-hunter
  const skillsRoot = path.dirname(thisSkillDir);        // .../skills
  const missing = PIPELINE_SKILL_DIRS.filter(
    (name) => !existsSync(path.join(skillsRoot, name)),
  );
  if (missing.length) {
    fail('skill roots', `missing pipeline skill dirs under ${skillsRoot}: ${missing.join(', ')}`);
  } else {
    ok('skill roots', `all pipeline helper dirs present under ${skillsRoot}`);
  }
}
checkSkillRoots();


function findRunScriptsOlderThan(root, days = 7) {
  const runsDir = `${root}/runs`;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const out = [];
  function walk(dir) {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(full);
      else if (/\.(?:mjs|js|py|sh)$/i.test(entry.name)) {
        try {
          const st = statSync(full);
          if (st.mtimeMs < cutoff) out.push(full);
        } catch {}
      }
    }
  }
  walk(runsDir);
  return out;
}

function probe(port, pathName = '/') {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathName, timeout: 3000 }, (res) => {
      res.resume(); resolve(res.statusCode);
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

existsSync(JOBHUNTER_HOME) ? ok('home', JOBHUNTER_HOME) : fail('home', `${JOBHUNTER_HOME} missing — run jh-init.mjs`);
existsSync(DB_PATH) ? ok('db', DB_PATH) : fail('db', `${DB_PATH} missing — run jh-init.mjs`);
existsSync(CACHE_PATH) ? ok('personal-info-cache') : fail('personal-info-cache', `${CACHE_PATH} missing`);
existsSync(CV_PATH) ? ok('CV.docx') : warn('CV.docx', `${CV_PATH} missing — uploads will fail`);

// Derived profile (skills/languages/titles extracted from the CV): stale means
// the CV changed since extraction; it is rebuilt automatically by the next
// search/score run, or now with `jh-profile.mjs refresh`.
try {
  // Loaded lazily so a partial installation still gets the other checks.
  const { profileStatus, loadProfile } = await import('./jh-profile.mjs');
  const profile = profileStatus();
  if (profile.state === 'current') ok('derived profile', 'current for CV.docx');
  else if (profile.state === 'stale') warn('derived profile', `stale — ${profile.reason}; run jh-profile.mjs refresh`);
  else warn('derived profile', `${profile.state} — ${profile.reason}; run jh-profile-extract.mjs`);
  if (profile.derived) {
    const { confirmation } = loadProfile({ refresh: 'never', allowIncomplete: true });
    if (confirmation.state === 'confirmed') ok('profile preferences', 'confirmed');
    else warn('profile preferences', `${confirmation.state}; run jh-profile.mjs review and confirm answers with the user`);
  }
} catch (error) {
  warn('derived profile', `could not evaluate (${error.message})`);
}

// Stale run-dir scripts: first drafts belong in runs/, confirmed scripts belong in skills.
const staleRunScripts = findRunScriptsOlderThan(JOBHUNTER_HOME, 7);
if (staleRunScripts.length) {
  warn('runs/ scripts', `${staleRunScripts.length} script file(s) older than 7 days — promote to the owning skill or delete; first: ${staleRunScripts[0]}`);
} else {
  ok('runs/ scripts', 'no stale script files older than 7 days');
}

// Stale salary writer lock
if (existsSync(DB_PATH)) {
  try {
    const out = execFileSync('sqlite3', [DB_PATH, "SELECT COUNT(*) FROM salary_writer_lock WHERE acquired_at < datetime('now','-1 hour')"], { encoding: 'utf8' }).trim();
    Number(out) > 0 ? warn('salary_writer_lock', `${out} stale lock row(s) >1h old`) : ok('salary_writer_lock', 'no stale locks');
  } catch { warn('salary_writer_lock', 'could not query (table missing or DB busy)'); }
}

const [cdp, grid, novnc, searxng] = await Promise.all([
  probe(9225, '/json/version'),
  probe(4444, '/status'),
  probe(7900, '/vnc.html'),
  probe(8888, '/search?q=pi-job-hunter-health&format=json'),
]);
cdp ? ok('CDP 9225', `HTTP ${cdp}`) : fail('CDP 9225', 'browser session not reachable — start Selenium Chromium container');
grid ? ok('Selenium 4444', `HTTP ${grid}`) : warn('Selenium 4444', 'grid not reachable');
novnc ? ok('noVNC 7900', `HTTP ${novnc}`) : warn('noVNC 7900', 'not reachable (see selenium-vnc-health skill)');
searxng ? ok('SearXNG 8888', `HTTP ${searxng}`) : warn('SearXNG 8888', 'not reachable — external-portal discovery via jh-discover is degraded');

// Container mount check
try {
  const mounts = execFileSync('docker', ['inspect', '-f', '{{range .Mounts}}{{.Source}} -> {{.Destination}}\n{{end}}', 'selenium-chromium'], { encoding: 'utf8' });
  const line = mounts.split('\n').find((l) => l.includes('/home/seluser/job-hunter'));
  if (!line) warn('container mount', 'no /home/seluser/job-hunter mount found');
  else if (line.includes('/.job-hunter')) ok('container mount', line.trim());
  else warn('container mount', `${line.trim()} — still points at old path; recreate container with updated compose`);
  // visual-click-recovery deps (xdotool baked into compose entrypoint 2026-07-06)
  try {
    execFileSync('docker', ['exec', 'selenium-chromium', 'sh', '-lc', 'command -v xdotool && command -v ffmpeg'], { encoding: 'utf8' });
    ok('container xdotool+ffmpeg', 'visual click recovery ready');
  } catch { warn('container xdotool+ffmpeg', 'missing — visual-recover.mjs --capture ffmpeg --click will fail; recreate container or apt-get install xdotool'); }
} catch { warn('container mount', 'docker not available or container not running'); }

// Local Qwen VLM (LM Studio) — needed by the default stuck-flow visual recovery
const vlm = await probe(1234, '/v1/models');
vlm ? ok('Qwen VLM 1234', `HTTP ${vlm}`) : warn('Qwen VLM 1234', 'LM Studio not reachable — visual recovery/captcha solving degraded');

console.log(checks.join('\n'));
process.exitCode = checks.some((c) => c.startsWith('[FAIL]')) ? 1 : 0;
