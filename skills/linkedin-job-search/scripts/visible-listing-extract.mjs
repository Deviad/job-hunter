#!/usr/bin/env node
import { WebSocketModule } from '../../job-hunter/scripts/workspace-dependencies.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let WebSocket;
try { WebSocket = WebSocketModule; }
catch { WebSocket = createRequire(process.env.JOBHUNTER_HOME ? path.join(process.env.JOBHUNTER_HOME, 'package.json') : path.join(process.env.HOME, '.job-hunter/package.json'))('ws'); }

function argValue(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 && idx + 1 < process.argv.length ? process.argv[idx + 1] : fallback;
}
function splitList(value, fallback) {
  return String(value || '').split(/[;,]/).map(s => s.trim()).filter(Boolean).length
    ? String(value).split(/[;,]/).map(s => s.trim()).filter(Boolean)
    : fallback;
}
const RUN_DIR = argValue('--run-dir', process.env.RUN_DIR || process.cwd());
const OUT = argValue('--out', path.join(RUN_DIR, 'visible-listings.json'));
const SUMMARY = argValue('--summary', path.join(RUN_DIR, 'visible-listings-summary.json'));
const PORT = Number(argValue('--cdp-port', process.env.BROWSER_CDP_PORT || 9225));
const locations = splitList(argValue('--locations', process.env.LOCATIONS || ''), ['United Kingdom', 'Ireland', 'Denmark', 'Netherlands']);
const queries = splitList(argValue('--queries', process.env.QUERIES || ''), ['AI Architect', 'AI Solution Architect', 'Enterprise AI Architect', 'Generative AI Architect']);
const countryByLocation = new Map([
  ['United Kingdom', 'GB'], ['Ireland', 'IE'], ['Denmark', 'DK'], ['Netherlands', 'NL'],
]);

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function jget(url) { const r = await fetch(url); if (!r.ok) throw new Error(`${url} HTTP ${r.status}`); return r.json(); }
async function openTab(url) {
  const list = await jget(`http://127.0.0.1:${PORT}/json/list`);
  let tab = list.find(t => (t.url || '').includes('linkedin.com/jobs/search') && t.webSocketDebuggerUrl);
  if (!tab) {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/new?url=${encodeURIComponent(url)}`, { method: 'PUT' });
    tab = await r.json();
  }
  return tab;
}
class Cdp {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 1; this.pending = new Map(); }
  async init() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((res, rej) => { this.ws.on('open', res); this.ws.on('error', rej); });
    this.ws.on('message', raw => {
      let msg; try { msg = JSON.parse(raw); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id); clearTimeout(p.t); this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(msg.error.message || JSON.stringify(msg.error))) : p.resolve(msg.result);
      }
    });
  }
  send(method, params = {}, timeout = 30000) {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`timeout ${method}`)); }, timeout);
      this.pending.set(id, { resolve, reject, t });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { try { this.ws?.close(); } catch {} }
}

function searchUrl(query, location) {
  const u = new URL('https://www.linkedin.com/jobs/search/');
  u.searchParams.set('keywords', query);
  u.searchParams.set('location', location);
  u.searchParams.set('f_TPR', 'r604800');
  return u.toString();
}

async function evalJson(cdp, expression, timeout = 30000) {
  const res = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeout);
  if (res.exceptionDetails) throw new Error(`Runtime exception: ${res.exceptionDetails.text || JSON.stringify(res.exceptionDetails)}`);
  const val = res.result?.value;
  return typeof val === 'string' ? JSON.parse(val) : val;
}

const blockerExpr = `JSON.stringify((() => {
  const text = (document.body?.innerText || '').slice(0, 3000);
  const title = document.title || '';
  const lower = (title + '\\n' + text).toLowerCase();
  const visibleRecaptcha = Array.from(document.querySelectorAll('iframe[src*="recaptcha"], iframe[src*="checkpoint"], iframe[src*="challenge"]')).some(f => {
    const r = f.getBoundingClientRect(); return r.width > 20 && r.height > 20;
  });
  const blocked = visibleRecaptcha || /security verification|unusual activity|captcha|verify you|verify your|checkpoint|sign in to linkedin|join linkedin|authwall|login/.test(lower);
  return { title, href: location.href, blocked, visibleRecaptcha, text: text.slice(0, 500) };
})())`;

const extractExpr = `JSON.stringify((() => {
  const candidates = Array.from(document.querySelectorAll('li[data-occludable-job-id], [data-job-id], div.job-card-container, li.jobs-search-results__list-item, main li')).slice(0, 500);
  const rows = [];
  function cleanLines(text) { return (text || '').split(String.fromCharCode(10)).map(s => s.trim()).filter(Boolean); }
  function idFromHref(href) {
    const path = (() => { try { return new URL(href, location.href).pathname; } catch { return href || ''; } })();
    const nums = path.split(/[^0-9]+/).filter(s => s.length >= 6);
    return nums.length ? nums[nums.length - 1] : '';
  }
  for (const el of candidates) {
    const link = el.querySelector('a[href*="/jobs/view/"]');
    let href = link ? new URL(link.href, location.href).href.split('?')[0].split('#')[0] : '';
    if (href.endsWith('/')) href = href.slice(0, -1);
    const idFromAttr = el.getAttribute('data-job-id') || el.getAttribute('data-occludable-job-id') || '';
    const id = idFromAttr || idFromHref(href);
    if (!href && id) href = 'https://www.linkedin.com/jobs/view/' + id;
    const txt = cleanLines(el.innerText);
    let title = (el.querySelector('a.job-card-container__link, a.job-card-list__title, a[href*="/jobs/view/"]')?.innerText || '').trim();
    if (!title) title = txt.find(s => s.length > 2 && !/^Promoted$|^Viewed$|^Saved$|Easy Apply|applicant/i.test(s)) || '';
    let company = (el.querySelector('.artdeco-entity-lockup__subtitle, .job-card-container__primary-description, h4')?.innerText || '').trim();
    if (!company) company = txt.find(s => s !== title && !/ago|applicant|Easy Apply|Promoted|Viewed|Saved|Remote|Hybrid|United Kingdom|Ireland|Denmark|Netherlands/i.test(s)) || '';
    let loc = (el.querySelector('.job-card-container__metadata-item, .job-card-container__metadata-wrapper')?.innerText || '').trim();
    if (!loc) loc = txt.find(s => /Remote|Hybrid|United Kingdom|Ireland|Denmark|Netherlands|UK|,/.test(s)) || '';
    const applicants = txt.find(s => /applicant/i.test(s)) || '';
    const posted = txt.find(s => /ago|reposted|promoted/i.test(s)) || '';
    if (id && title && href) rows.push({ id, title, company, locationRaw: loc, applicantsRaw: applicants, jobPostingDate: posted, url: href, text: txt.slice(0, 10) });
  }
  const seen = new Set();
  return rows.filter(r => !seen.has(r.id) && seen.add(r.id)).slice(0, 50);
})())`;

async function dismissOverlays(cdp) {
  await cdp.send('Runtime.evaluate', { expression: `(() => {
    for (const b of Array.from(document.querySelectorAll('button, [role=button]'))) {
      const t = (b.innerText || b.ariaLabel || '').trim();
      if (/^(dismiss|close|maybe later|not now|skip)$/i.test(t)) { try { b.click(); } catch {} }
    }
  })()`, returnByValue: true }, 10000).catch(() => {});
}

async function scrollAndExtract(cdp) {
  const all = [];
  for (let i = 0; i < 7; i++) {
    const rows = await evalJson(cdp, extractExpr, 20000).catch(e => { console.log(`[extract-warn] ${e.message}`); return []; });
    all.push(...rows);
    await cdp.send('Runtime.evaluate', { expression: `(() => {
      const scrollers = [document.querySelector('.jobs-search-results-list'), document.querySelector('.scaffold-layout__list'), document.querySelector('main'), document.scrollingElement].filter(Boolean);
      for (const s of scrollers) { try { s.scrollTop = (s.scrollTop || 0) + 900; } catch {} }
      window.scrollBy(0, 500);
    })()`, returnByValue: true }, 10000).catch(() => {});
    await sleep(1200);
  }
  const seen = new Set();
  return all.filter(r => !seen.has(r.id) && seen.add(r.id));
}

const startUrl = searchUrl(queries[0], locations[0]);
const tab = await openTab(startUrl);
const cdp = new Cdp(tab.webSocketDebuggerUrl);
await cdp.init();
await cdp.send('Page.enable', {}, 10000).catch(() => {});

const recordsById = new Map();
const searchSummaries = [];
for (const location of locations) {
  for (const query of queries) {
    const url = searchUrl(query, location);
    console.log(`\n=== visible fallback: ${query} / ${location} ===`);
    console.log(url);
    await cdp.send('Page.navigate', { url }, 30000).catch(e => console.log(`[navigate-warn] ${e.message}`));
    await sleep(7500);
    await dismissOverlays(cdp);
    const state = await evalJson(cdp, blockerExpr, 15000).catch(e => ({ blocked: true, error: e.message }));
    console.log(`[state] title=${JSON.stringify(state.title)} blocked=${state.blocked} visibleRecaptcha=${state.visibleRecaptcha || false}`);
    if (state.blocked) {
      console.log(`[blocked-visible] ${JSON.stringify(state).slice(0, 1000)}`);
      searchSummaries.push({ query, location, blocked: true, state });
      continue;
    }
    const rows = await scrollAndExtract(cdp);
    console.log(`[extract] ${rows.length} unique visible cards`);
    searchSummaries.push({ query, location, blocked: false, count: rows.length, ids: rows.map(r => r.id).slice(0, 20) });
    for (const r of rows) {
      if (recordsById.has(r.id)) continue;
      const textJoined = (r.text || []).join(' | ');
      const modes = [];
      if (/remote/i.test(`${r.locationRaw} ${textJoined}`)) modes.push({ mode: 'remote', isPrimary: true });
      if (/hybrid/i.test(`${r.locationRaw} ${textJoined}`)) modes.push({ mode: 'hybrid', isPrimary: modes.length === 0 });
      if (!modes.length && /onsite|on-site/i.test(`${r.locationRaw} ${textJoined}`)) modes.push({ mode: 'onsite', isPrimary: true });
      recordsById.set(r.id, {
        source: 'linkedin',
        job_id: r.id,
        url: r.url,
        title: r.title,
        company: r.company || null,
        locationRaw: r.locationRaw || location,
        countryCode: countryByLocation.get(location) || null,
        region: null,
        city: null,
        applicantsRaw: r.applicantsRaw || null,
        applicantsCount: r.applicantsRaw ? Number((r.applicantsRaw.match(/\d+/)||[])[0] || 0) || null : null,
        descriptionRaw: '',
        descriptionText: '',
        applicationLinks: [r.url],
        recruiter: null,
        recruiterEmail: null,
        recruiterProfileLink: null,
        jobPostingDate: r.jobPostingDate || null,
        languageRequirements: { required: [], niceToHave: [] },
        workModes: modes,
        languageFilterReason: 'listing-only visible LinkedIn fallback; JD backfill pending',
        roleFamilyInferred: null,
        roleFamilyReason: 'visible LinkedIn search card fallback after CDP runner security/backoff signal',
        searchedKeywords: query,
        searchedLocation: location,
      });
    }
    await sleep(1500);
  }
}
cdp.close();
const records = Array.from(recordsById.values());
fs.writeFileSync(OUT, JSON.stringify(records, null, 2));
fs.writeFileSync(SUMMARY, JSON.stringify({ generatedAt: new Date().toISOString(), count: records.length, searches: searchSummaries }, null, 2));
console.log(`\nWrote ${OUT} (${records.length} records)`);
console.log(`Wrote ${SUMMARY}`);
