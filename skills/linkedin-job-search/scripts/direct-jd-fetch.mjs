import { Database, WebSocket } from '../../job-hunter/scripts/workspace-dependencies.mjs';
// Direct CDP JD backfill for jobs the batch script couldn't extract.
// Opens each LinkedIn job URL, extracts JD via DOM, saves to DB.

import http from 'http';

import { writeFileSync } from 'node:fs';
import { startCdpKeepAlive } from './cdp-keepalive.mjs';

const JH = process.env.JOBHUNTER_HOME || `${process.env.HOME}/.job-hunter`;
const DB = process.env.JOBHUNTER_DB || `${JH}/jobhunter.sqlite`;
const CDP_PORT = 9225;
const JOBS = process.argv.slice(2);
if (JOBS.length === 0) { console.error('Usage: node direct-jd-fetch.mjs <job_id1> [job_id2] ...'); process.exit(1); }

const db = new Database(DB);

function httpJson(method, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ method, host: '127.0.0.1', port: CDP_PORT, path }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch { reject(new Error(d.slice(0,200))); }
      });
    });
    req.on('error', reject); req.end();
  });
}

class Cdp {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.nid = 1; this.pending = new Map(); }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('WS open timeout')), 10000);
      this.ws.on('open', () => { clearTimeout(t); resolve(); });
      this.ws.on('error', e => { clearTimeout(t); reject(e); });
    });
    this.ws.on('message', raw => {
      try {
        const m = JSON.parse(raw);
        const p = this.pending.get(m.id);
        if (!p) return;
        clearTimeout(p.t);
        this.pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error.message));
        else p.resolve(m.result);
      } catch {}
    });
  }
  send(method, params = {}, timeout = 20000) {
    const id = this.nid++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, timeout);
      this.pending.set(id, { resolve, reject, t });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expr, timeout = 20000) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: false }, timeout);
    if (r?.result?.value !== undefined) return r.result.value;
    if (r?.result?.result?.value !== undefined) return r.result.result.value;
    if (r?.exceptionDetails) throw new Error('JS: ' + JSON.stringify(r.exceptionDetails).slice(0,200));
    return r?.result;
  }
  close() { try { this.ws.close(); } catch {} }
}

const delay = ms => new Promise(r => setTimeout(r, ms));

async function fetchOne(jobId) {
  // Look up URL from DB
  const row = db.prepare('SELECT url, title, company FROM jobs WHERE source = ? AND job_id = ?').get('linkedin', jobId);
  if (!row) { console.log(`  ${jobId}: not in DB`); return { jobId, status: 'not_in_db' }; }
  const url = row.url;
  // Strip /uk prefix to get the canonical /jobs/view/ form
  let jobUrl = url;
  const m = url.match(/linkedin\.com\/jobs\/view\/\d+/);
  if (m) jobUrl = 'https://www.' + m[0];

  console.log(`  ${jobId} (${row.title?.slice(0,30)}): navigating to ${jobUrl.slice(0,80)}`);
  const tab = await httpJson('PUT', `/json/new?url=${encodeURIComponent(jobUrl)}`);
  const tabId = tab.id;
  const cdp = new Cdp(tab.webSocketDebuggerUrl);
  let keepAlive;
  let result = { jobId, status: 'unknown' };
  try {
    await cdp.connect();
    keepAlive = startCdpKeepAlive(cdp, {
      intervalMs: Math.max(0, Number(process.env.CDP_KEEPALIVE_SECONDS ?? 15) || 0) * 1000,
      label: 'LinkedIn direct-JD CDP',
    });
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: jobUrl });
    await delay(7000);

    // Extract JD text — try multiple selectors
    const jd = await cdp.eval(`(function() {
      // LinkedIn JD containers (multiple variants across redesigns)
      const selectors = [
        '.jobs-description__content .jobs-box__html',
        '.jobs-description__content',
        '.jobs-description .jobs-box__html',
        '.description__text--rich',
        '.description__text',
        'article.jobs-description',
        '[data-testid="expandable-text-box"]',
        'div[class*="jobs-description"]',
        'div[class*="show-more-less-html"]',
        'div[class*="job-details"]',
        '#job-details',
      ];
      let best = '';
      let bestLen = 0;
      for (const sel of selectors) {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          const txt = (el.innerText || el.textContent || '').trim();
          if (txt.length > bestLen && txt.length > 200) { best = txt; bestLen = txt.length; }
        }
      }
      // Fallback: largest text block on page
      if (bestLen < 200) {
        const all = Array.from(document.querySelectorAll('div, section, article'));
        for (const el of all) {
          const txt = (el.innerText || '').trim();
          if (txt.length > bestLen && txt.length > 500 && txt.length < 50000) { best = txt; bestLen = txt.length; }
        }
      }
      return { jd: best, jd_len: best.length, title: document.title, url: location.href };
    })()`);

    if (jd.jd && jd.jd.length > 200) {
      // Save to DB
      db.prepare('UPDATE jobs SET description_text = ?, description_raw = ?, language_filter_reason = COALESCE(language_filter_reason, ?) WHERE source = ? AND job_id = ?')
        .run(jd.jd, jd.jd, 'PASS: extracted via direct CDP', 'linkedin', jobId);
      console.log(`    ✓ saved ${jd.jd_len} chars`);
      result = { jobId, status: 'ok', jd_len: jd.jd_len };
    } else {
      console.log(`    ✗ extracted only ${jd.jd_len} chars (title: ${jd.title?.slice(0,60)})`);
      // Save screenshot
      try {
        const ss = await cdp.send('Page.captureScreenshot', { format: 'png' });
        writeFileSync(`/tmp/jd-FAIL-${jobId}.png`, Buffer.from(ss.data, 'base64'));
      } catch {}
      result = { jobId, status: 'fail', jd_len: jd.jd_len, page_title: jd.title, page_url: jd.url };
    }
  } catch (e) {
    console.log(`    ✗ ERR: ${e.message}`);
    result = { jobId, status: 'error', err: e.message };
  } finally {
    keepAlive?.stop();
    cdp.close();
    // Close tab
    try {
      await httpJson('PUT', `/json/close/${tabId}`);
    } catch {}
  }
  return result;
}

async function main() {
  const results = [];
  for (const jid of JOBS) {
    const r = await fetchOne(jid);
    results.push(r);
    await delay(2000); // human-like pause
  }
  console.log('\n=== Summary ===');
  for (const r of results) {
    console.log(`  ${r.jobId}: ${r.status}` + (r.jd_len ? ` (${r.jd_len} chars)` : '') + (r.err ? ` — ${r.err}` : ''));
  }
  process.exit(0);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
