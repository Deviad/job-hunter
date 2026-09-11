#!/usr/bin/env node
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyLinkedInPage, PAGE_STATE, RESTRICTION_STATES, researchNavigationDecision } from './linkedin-page-state.mjs';
import { DB_PATH } from '../../job-hunter/scripts/jh-common.mjs';
import { readLinkedInAccess, pauseLinkedInAccess } from '../../job-hunter/scripts/linkedin-access.mjs';

const restrictions = new Set(RESTRICTION_STATES);

function parseArgs(argv) {
  const opts = {
    port: Number(process.env.BROWSER_CDP_PORT || process.env.LINKEDIN_CDP_PORT || 9225) || 9225,
    json: false,
    watchSeconds: 0,
    keepAliveSeconds: Number(process.env.CDP_KEEPALIVE_SECONDS || 15) || 15,
    probeUrls: [],
    waitMs: 3000,
    db: process.env.JOBHUNTER_DB || DB_PATH,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[++i];
    };
    if (arg === '--port' || arg === '--cdp-port') opts.port = Number(next()) || opts.port;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--db') opts.db = next();
    else if (arg === '--watch-seconds') opts.watchSeconds = Math.max(0, Number(next()) || 0);
    else if (arg === '--keepalive-seconds') opts.keepAliveSeconds = Math.max(1, Number(next()) || 15);
    else if (arg === '--probe-url') opts.probeUrls.push(next());
    else if (arg === '--wait-ms') opts.waitMs = Math.max(500, Number(next()) || 3000);
    else if (arg === '--help' || arg === '-h') opts.help = true; else throw new Error(`Unknown option: ${arg}`);
  }
  return opts;
}

function siteForUrl(url) {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return 'other';
    const host = parsed.hostname;
    if (['linkedin.com', 'www.linkedin.com'].includes(host)) return 'linkedin';
    if (host === 'indeed.com' || host.endsWith('.indeed.com')) return 'indeed';
  } catch {}
  return 'other';
}

function requestJson(port, path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, timeout: 5000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (error) { reject(new Error(`Invalid CDP JSON at ${path}: ${error.message}`)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`CDP timeout at ${path}`)));
    req.on('error', reject);
    req.end();
  });
}

function getJson(port, path) {
  return requestJson(port, path, 'GET');
}

async function evaluateTarget(target) {
  if (!target.webSocketDebuggerUrl) throw new Error('Target WebSocket is unavailable');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let seq = 0;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('target WebSocket open timeout')), 5000);
    ws.onopen = () => { clearTimeout(timer); resolve(); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('target WebSocket error')); };
  });
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    message.error ? item.reject(new Error(message.error.message || JSON.stringify(message.error))) : item.resolve(message.result);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timeout`));
    }, 5000);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
  try {
    const result = await send('Runtime.evaluate', {
      expression: 'JSON.stringify({title:document.title||"",url:location.href,text:(document.body?.innerText||"").slice(0,5000)})',
      returnByValue: true,
    });
    return JSON.parse(result.result?.value || '{}');
  } finally {
    ws.close();
  }
}

function classifyIndeedPage(page) {
  const joined = `${page?.title || ''}\n${page?.text || ''}`;
  if (/verify you are human|unusual traffic|security check|additional verification|required verification/i.test(joined)) {
    return { state: 'blocked', reason: 'Indeed verification page detected' };
  }
  if (/indeed\.com/i.test(page?.url || '') && page?.text) return { state: 'healthy', reason: null };
  return { state: 'unknown', reason: 'No readable Indeed page body' };
}

async function browserKeepAlive(wsUrl, durationMs, intervalMs) {
  if (!durationMs) return { sent: 0, failed: 0 };
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  let sent = 0;
  let failed = 0;
  const pending = new Map();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('browser WebSocket open timeout')), 5000);
    ws.onopen = () => { clearTimeout(timer); resolve(); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('browser WebSocket error')); };
  });
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    message.error ? item.reject(new Error(message.error.message || JSON.stringify(message.error))) : item.resolve(message.result);
  };
  const ping = () => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('heartbeat timeout'));
    }, 5000);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    ws.send(JSON.stringify({ id, method: 'Browser.getVersion', params: {} }));
  });
  const deadline = Date.now() + durationMs;
  try {
    while (Date.now() < deadline) {
      try { await ping(); sent++; }
      catch { failed++; }
      const wait = Math.min(intervalMs, Math.max(0, deadline - Date.now()));
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    }
  } finally {
    ws.close();
  }
  return { sent, failed };
}

async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log('Usage: cdp-preflight.mjs [--db PATH] [--port 9225] [--json] [--probe-url URL] [--wait-ms 3000] [--watch-seconds N] [--keepalive-seconds N]');
    return 0;
  }
  const indeedOnly = opts.probeUrls.length > 0 && opts.probeUrls.every((url) => siteForUrl(url) === 'indeed');
  if (!indeedOnly) {
    const access = readLinkedInAccess(opts.db);
    if (!access.ok || !access.allowed) {
      console.log(JSON.stringify({ ok: false, admitted: false, code: access.ok ? 'SOURCE_PAUSED' : 'ACCESS_STATE_UNAVAILABLE', state: access.record?.state || null }));
      return 3;
    }
  }
  for (const url of opts.probeUrls) {
    if (siteForUrl(url) === 'indeed') continue;
    const decision = researchNavigationDecision(url);
    if (!decision.allowed) {
      console.log(JSON.stringify({ ok: false, admitted: true, code: decision.code, reason: decision.reason }));
      return 3;
    }
  }
  const version = await getJson(opts.port, '/json/version');
  const targets = await getJson(opts.port, '/json/list');
  const relevant = targets.filter((target) => target.type === 'page' && (indeedOnly ? siteForUrl(target.url) === 'indeed' : siteForUrl(target.url) !== 'other'));
  const pages = [];
  let stopped = false;
  let paused = false;
  let accessError;
  const observe = (site, page, metadata = {}) => {
    let check = site === 'linkedin' ? classifyLinkedInPage(page) : classifyIndeedPage(page);
    if (site === 'linkedin' && siteForUrl(page.url) === 'linkedin' && /^\/checkpoint(?:\/|$)/.test(new URL(page.url).pathname) && !restrictions.has(check.state)) {
      check = { state: PAGE_STATE.BLOCKED, reason: 'LinkedIn checkpoint requires operator review' };
    }
    pages.push({ site, state: check.state, reason: check.reason, title: page.title, url: page.url, ...metadata });
    if (site === 'linkedin' && restrictions.has(check.state)) {
      const pause = pauseLinkedInAccess(opts.db, { reason: `preflight observed ${check.state}` });
      stopped = true;
      paused = pause.ok;
      if (!pause.ok) accessError = pause.error.code;
    }
  };
  for (const target of relevant) {
    if (stopped) break;
    const site = siteForUrl(target.url);
    if (site === 'linkedin' && !researchNavigationDecision(target.url).allowed) {
      if (/^\/(?:login|checkpoint|authwall)(?:\/|$)/.test(new URL(target.url).pathname)) observe(site, { title: target.title, url: target.url });
      continue;
    }
    try {
      const page = await evaluateTarget(target);
      observe(site, { ...page, title: page?.title || target.title, url: page?.url || target.url });
    } catch {
      pages.push({ site, state: 'error', reason: 'Page evaluation failed', title: target.title, url: target.url });
    }
  }
  for (const url of opts.probeUrls) {
    if (stopped) break;
    let target;
    const site = siteForUrl(url);
    try {
      target = await requestJson(opts.port, `/json/new?${encodeURIComponent(url)}`, 'PUT');
      await new Promise((resolve) => setTimeout(resolve, opts.waitMs));
      const page = await evaluateTarget(target);
      observe(site, { ...page, title: page?.title || target.title, url: page?.url || url }, { probe: true });
    } catch {
      pages.push({ site, state: 'error', reason: 'Probe evaluation failed', title: '', url, probe: true });
    } finally {
      if (target?.id) await requestJson(opts.port, `/json/close/${target.id}`, 'PUT').catch(() => {});
    }
  }
  const heartbeat = stopped ? { sent: 0, failed: 0 } : await browserKeepAlive(
    version.webSocketDebuggerUrl,
    opts.watchSeconds * 1000,
    opts.keepAliveSeconds * 1000,
  );
  const result = {
    ok: Boolean(version.webSocketDebuggerUrl) && !stopped && !pages.some((page) => restrictions.has(page.state) || ['captcha', 'error'].includes(page.state)),
    paused,
    ...(accessError ? { accessError } : {}),
    port: opts.port,
    browser: version.Browser || version.browser || null,
    pageCount: targets.filter((target) => target.type === 'page').length,
    pages,
    heartbeat,
  };
  if (opts.json) console.log(JSON.stringify(result));
  else {
    console.log(`CDP ${result.port}: ${result.browser || 'reachable'}; ${result.pageCount} page target(s)`);
    for (const page of pages) console.log(`${page.site.toUpperCase()} ${page.state}: ${page.title} — ${page.url}${page.reason ? ` — ${page.reason}` : ''}`);
    if (opts.watchSeconds) console.log(`Heartbeat: ${heartbeat.sent} sent, ${heartbeat.failed} failed`);
  }
  return result.ok ? 0 : 3;
}

export { parseArgs, researchNavigationDecision, main };

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then((code) => { process.exitCode = code; }).catch(() => {
    console.error(JSON.stringify({ ok: false, error: 'CDP preflight failed' }));
    process.exitCode = 2;
  });
}
