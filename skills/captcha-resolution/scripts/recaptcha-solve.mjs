#!/usr/bin/env node
import { WebSocketModule } from '../../job-hunter/scripts/workspace-dependencies.mjs';
/**
 * Google reCAPTCHA Enterprise image-grid solver for Brave CDP pipe proxy.
 *
 * Correctness rules baked in:
 * - Use Chromium CDP on 127.0.0.1:9225 (override with --cdp-port).
 * - Click the anchor checkbox from the parent page using real mouse events.
 * - Treat image-grid visibility, not aria-checked, as the checkbox-click signal.
 * - Capture the live bframe grid via canvas inside the bframe; do not download
 *   short-lived image URLs.
 * - After every VERIFY/NEXT press, assume failure and re-click the checkbox.
 *   If a grid reappears, solve it. If no grid reappears, try submitting.
 *
 * Usage:
 *   node recaptcha-solve.mjs --submit
 *   node recaptcha-solve.mjs --cdp-port 9225 --submit
 *   node recaptcha-solve.mjs --page-filter review-module --site-key 6Ldn8Qwp
 *   node recaptcha-solve.mjs --tiles 0,3,4
 *   node recaptcha-solve.mjs --check
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

const DEFAULT_SITE_KEY = '6Ldn8Qwp';
const DEFAULT_MODEL = 'qwen3.6-35b-a3b-holo3-qwopus-instruct-qx64-hi-mlx';
const CDP_HOST = '127.0.0.1';
const CDP_PORT = 9225;
const VLM_HOST = '127.0.0.1';
const VLM_PORT = 1234;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function loadWebSocket() {
  const homeDir = process.env.HOME || os.homedir();
  const candidates = [
    () => { const ws = WebSocketModule; return ws.WebSocket || ws; },
    () => { const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(); return require(path.join(globalRoot, 'ws')); },
    () => require(path.join(homeDir, '.local/share/pi/agent/skills/auto-job-application/scripts/node_modules/ws')),
  ];
  const errors = [];
  for (const loader of candidates) {
    try {
      const ws = loader();
      return ws.WebSocket || ws;
    } catch (e) {
      errors.push(e.message);
    }
  }
  throw new Error(`Cannot load ws module from any known location. Install with: cd ../../captcha-resolution/scripts && npm install\nErrors: ${errors.join('; ')}`);
}

const WebSocket = loadWebSocket();

function parseArgs(argv) {
  const opts = {
    siteKey: DEFAULT_SITE_KEY,
    pageFilter: 'review-module',
    model: DEFAULT_MODEL,
    maxAttempts: 20,
    checkboxClicks: 8,
    tilePasses: 8,
    submit: false,
    check: false,
    manualTiles: null,
    cdpPort: CDP_PORT,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--submit') opts.submit = true;
    else if (arg === '--check' || arg === '--dry-run') opts.check = true;
    else if (arg === '--cdp-port') { const p = Number(next()); if (Number.isFinite(p)) opts.cdpPort = p; }
    else if (arg.startsWith('--cdp-port=')) { const p = Number(arg.slice('--cdp-port='.length)); if (Number.isFinite(p)) opts.cdpPort = p; }
    else if (arg === '--site-key') opts.siteKey = next() || opts.siteKey;
    else if (arg.startsWith('--site-key=')) opts.siteKey = arg.slice('--site-key='.length);
    else if (arg === '--page-filter') opts.pageFilter = next() || '';
    else if (arg.startsWith('--page-filter=')) opts.pageFilter = arg.slice('--page-filter='.length);
    else if (arg === '--model') opts.model = next() || opts.model;
    else if (arg.startsWith('--model=')) opts.model = arg.slice('--model='.length);
    else if (arg === '--attempts' || arg === '--rounds') opts.maxAttempts = Number(next() || opts.maxAttempts);
    else if (arg.startsWith('--attempts=')) opts.maxAttempts = Number(arg.slice('--attempts='.length));
    else if (arg.startsWith('--rounds=')) opts.maxAttempts = Number(arg.slice('--rounds='.length));
    else if (arg === '--checkbox-clicks') opts.checkboxClicks = Number(next() || opts.checkboxClicks);
    else if (arg.startsWith('--checkbox-clicks=')) opts.checkboxClicks = Number(arg.slice('--checkbox-clicks='.length));
    else if (arg === '--tile-passes') opts.tilePasses = Number(next() || opts.tilePasses);
    else if (arg.startsWith('--tile-passes=')) opts.tilePasses = Number(arg.slice('--tile-passes='.length));
    else if (arg === '--tiles') opts.manualTiles = parseTileList(next() || '');
    else if (arg.startsWith('--tiles=')) opts.manualTiles = parseTileList(arg.slice('--tiles='.length));
  }

  opts.maxAttempts = clampInt(opts.maxAttempts, 1, 50, 20);
  opts.checkboxClicks = clampInt(opts.checkboxClicks, 1, 20, 8);
  opts.tilePasses = clampInt(opts.tilePasses, 1, 6, 3);
  return opts;
}

function clampInt(value, min, max, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function parseTileList(value) {
  const tiles = String(value)
    .split(',')
    .map(v => Number(v.trim()))
    .filter(v => Number.isInteger(v) && v >= 0 && v < 16);
  return Array.from(new Set(tiles));
}

function httpJson(method, requestPath, body = null, port = null, timeout = 15000) {
  const actualPort = port || CDP_PORT;
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const host = actualPort === VLM_PORT ? VLM_HOST : CDP_HOST;
    const req = http.request({
      method,
      host,
      port: actualPort,
      path: requestPath,
      headers: payload ? {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      } : undefined,
      timeout,
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data || '{}'));
        } catch (error) {
          reject(new Error(`Invalid JSON from ${requestPath}: ${error.message}`));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`HTTP timeout for ${requestPath}`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

class CdpClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.ws.on('message', data => {
      const message = JSON.parse(data.toString());
      if (!message.id) return;
      const callback = this.pending.get(message.id);
      if (!callback) return;
      this.pending.delete(message.id);
      callback(message);
    });
  }

  async open() {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
  }

  send(method, params = {}, sessionId = undefined) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const message = { id, method, params };
      if (sessionId) message.sessionId = sessionId;
      this.pending.set(id, response => {
        if (response.error) reject(new Error(`${method}: ${response.error.message}`));
        else resolve(response.result || {});
      });
      this.ws.send(JSON.stringify(message), error => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  async attach(targetId) {
    const result = await this.send('Target.attachToTarget', { targetId, flatten: true });
    return result.sessionId;
  }

  async detach(sessionId) {
    if (!sessionId) return;
    try {
      await this.send('Target.detachFromTarget', { sessionId });
    } catch {
      // Target may have navigated/detached after challenge actions.
    }
  }

  async eval(sessionId, expression, options = {}) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: options.awaitPromise ?? false,
      userGesture: options.userGesture ?? false,
    }, sessionId);
    const value = result.result?.value;
    if (typeof value === 'string' && options.json !== false) {
      const trimmed = value.trim();
      if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        try { return JSON.parse(trimmed); } catch { return value; }
      }
    }
    return value;
  }

  close() {
    this.ws.close();
  }
}

async function withTarget(cdp, targetId, fn) {
  const sessionId = await cdp.attach(targetId);
  try {
    return await fn(sessionId);
  } finally {
    await cdp.detach(sessionId);
  }
}

async function getTargets(cdp) {
  const result = await cdp.send('Target.getTargets');
  return result.targetInfos || [];
}

function targetMatches(target, filter) {
  if (!filter) return true;
  const haystack = `${target.url || ''}\n${target.title || ''}`.toLowerCase();
  return haystack.includes(filter.toLowerCase());
}

function pickPageTarget(targets, pageFilter) {
  const pages = targets.filter(t => t.type === 'page' && t.url && !t.url.startsWith('devtools://'));
  return pages.find(t => targetMatches(t, pageFilter))
    || pages.find(t => /indeed|smartapply|review-module/i.test(`${t.url}\n${t.title || ''}`))
    || pages[pages.length - 1];
}

function pickIframeTarget(targets, siteKey, kind) {
  const needle = kind === 'anchor' ? '/anchor' : '/bframe';
  const matches = targets.filter(t => {
    if (t.type !== 'iframe') return false;
    const url = t.url || '';
    return url.includes('/recaptcha/') && url.includes(needle) && (!siteKey || url.includes(siteKey));
  });
  return matches[matches.length - 1] || null;
}

async function dispatchClick(cdp, sessionId, x, y) {
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x,
    y,
    button: 'none',
    buttons: 0,
  }, sessionId);
  await sleep(25);
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  }, sessionId);
  await sleep(35);
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  }, sessionId);
}

async function clickAnchorFromPage(cdp, pageTarget, siteKey) {
  await cdp.send('Target.activateTarget', { targetId: pageTarget.targetId }).catch(() => {});
  return withTarget(cdp, pageTarget.targetId, async pageSession => {
    const coords = await cdp.eval(pageSession, `(() => {
      const siteKey = ${JSON.stringify(siteKey)};
      const frames = Array.from(document.querySelectorAll('iframe[src*="recaptcha"][src*="anchor"]'))
        .filter(frame => !siteKey || frame.src.includes(siteKey));
      const candidates = frames.map((frame, index) => {
        const rect = frame.getBoundingClientRect();
        return { frame, index, rect, area: Math.max(0, rect.width) * Math.max(0, rect.height) };
      }).filter(item => item.area > 0);
      if (!candidates.length) return JSON.stringify({ ok: false, reason: 'no visible anchor iframe' });
      let chosen = candidates.find(item => item.rect.bottom > 0 && item.rect.right > 0 && item.rect.top < innerHeight && item.rect.left < innerWidth)
        || candidates[candidates.length - 1];
      let rect = chosen.frame.getBoundingClientRect();
      if (rect.bottom < 0 || rect.right < 0 || rect.top > innerHeight || rect.left > innerWidth) {
        chosen.frame.scrollIntoView({ block: 'center', inline: 'center' });
        rect = chosen.frame.getBoundingClientRect();
      }
      const x = Math.round(rect.left + Math.min(28, Math.max(12, rect.width * 0.18)));
      const y = Math.round(rect.top + rect.height / 2);
      const under = document.elementFromPoint(x, y);
      return JSON.stringify({
        ok: true,
        x,
        y,
        rect: { left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) },
        under: under?.tagName || '',
        underSrcHasSiteKey: under?.tagName === 'IFRAME' ? under.src.includes(siteKey) : false,
      });
    })()`, { json: true });

    if (!coords?.ok) throw new Error(coords?.reason || 'Could not find reCAPTCHA anchor iframe on page');
    if (coords.x < 0 || coords.y < 0) throw new Error(`Anchor click coordinates outside viewport: ${JSON.stringify(coords)}`);
    await dispatchClick(cdp, pageSession, coords.x, coords.y);
    return coords;
  });
}

async function probeChallenge(cdp, siteKey) {
  const targets = await getTargets(cdp);
  const bframe = pickIframeTarget(targets, siteKey, 'bframe');
  if (!bframe) return { visible: false, reason: 'no bframe' };
  try {
    return await withTarget(cdp, bframe.targetId, async session => {
      const state = await cdp.eval(session, `(() => {
        const bodyText = document.body?.innerText || '';
        const table = document.querySelector('.rc-imageselect-table-33,.rc-imageselect-table-44');
        const tiles = Array.from(document.querySelectorAll('.rc-imageselect-tile'));
        const challenge = document.querySelector('.rc-imageselect-challenge, .rc-imageselect');
        const button = document.querySelector('#recaptcha-verify-button');
        const rect = challenge?.getBoundingClientRect?.();
        const style = challenge ? getComputedStyle(challenge) : null;
        const visible = !!table && tiles.length > 0 && !!rect && rect.width > 10 && rect.height > 10 && style?.display !== 'none' && style?.visibility !== 'hidden';
        return JSON.stringify({
          visible,
          expired: /expired|verification expired|try again/i.test(bodyText),
          text: bodyText.slice(0, 260),
          grid: table?.className?.includes('44') ? 4 : table?.className?.includes('33') ? 3 : 0,
          tileCount: tiles.length,
          buttonText: (button?.innerText || button?.textContent || '').trim(),
        });
      })()`, { json: true });
      return { ...state, targetId: bframe.targetId };
    });
  } catch (error) {
    return { visible: false, reason: error.message };
  }
}

async function clickCheckboxUntilGrid(cdp, pageTarget, siteKey, maxClicks) {
  for (let click = 1; click <= maxClicks; click++) {
    const coords = await clickAnchorFromPage(cdp, pageTarget, siteKey);
    console.log(`Checkbox click ${click}: parent page ${coords.x},${coords.y}`);
    await sleep(3000);
    const state = await probeChallenge(cdp, siteKey);
    if (state.visible) {
      console.log(`Image grid appeared: ${state.grid}x${state.grid}, ${state.tileCount} tiles`);
      return true;
    }
    if (state.expired) {
      await reloadChallenge(cdp, siteKey);
      await sleep(1500);
    }
  }
  return false;
}

async function clickCheckboxOnceAndProbe(cdp, pageTarget, siteKey) {
  const coords = await clickAnchorFromPage(cdp, pageTarget, siteKey);
  console.log(`Post-verify checkbox re-click: parent page ${coords.x},${coords.y}`);
  await sleep(3000);
  const state = await probeChallenge(cdp, siteKey);
  return state.visible;
}

/**
 * After pressing VERIFY/NEXT, determine whether a new challenge exists or
 * the CAPTCHA is solved.
 *
 * Priority:
 *   1. Check anchor aria-checked — if "true", CAPTCHA is solved
 *   2. VLM visual check — screenshot bframe/parent, ask Qwen if grid visible
 *   3. If VLM says no grid AND anchor is NOT checked — challenge is in a
 *      transitional state; wait and re-probe before concluding
 *   4. DOM probe as final fallback
 */
async function checkPostVerify(cdp, pageTarget, siteKey, opts) {
  // Wait for reCAPTCHA to process the VERIFY/NEXT response
  await sleep(3000);

  // Step 1: Check anchor checkbox state — the most reliable solved signal
  const targets = await getTargets(cdp);
  const anchor = pickIframeTarget(targets, siteKey, 'anchor');
  if (anchor) {
    try {
      const checked = await withTarget(cdp, anchor.targetId, async session => {
        const result = await cdp.eval(session, `document.getElementById('recaptcha-anchor')?.getAttribute('aria-checked') || 'unknown'`, { json: false });
        return result;
      });
      console.log(`Post-VERIFY: anchor aria-checked = ${checked}`);
      if (checked === 'true') {
        console.log('Post-VERIFY: anchor shows checked — CAPTCHA solved');
        return { gridVisible: false, vlmConfirmed: false, expired: false };
      }
    } catch (error) {
      console.log(`Post-VERIFY: anchor check failed: ${error.message}`);
    }
  }

  // Step 2: DOM probe for visible grid (fast, no VLM cost)
  const domProbe = await probeChallenge(cdp, siteKey);
  if (domProbe.visible) {
    console.log(`Post-VERIFY: DOM shows visible grid (${domProbe.grid}x${domProbe.grid}, ${domProbe.tileCount} tiles)`);
    return { gridVisible: true, vlmConfirmed: false, expired: false };
  }
  if (domProbe.expired) {
    console.log('Post-VERIFY: DOM shows expired challenge');
    return { gridVisible: false, vlmConfirmed: false, expired: true };
  }

  // Step 3: VLM visual check — screenshot bframe/parent, ask Qwen
  console.log('Post-VERIFY: no DOM grid and anchor not checked; asking Qwen VLM...');
  try {
    const screenshotResult = await captureBframeScreenshot(cdp, siteKey);
    if (screenshotResult) {
      // If the bframe canvas capture found a grid, skip VLM — we already know
      if (screenshotResult.hasGrid) {
        console.log('Post-VERIFY: bframe canvas capture shows grid present');
        return { gridVisible: true, vlmConfirmed: false, expired: false };
      }
      const vlmResult = await askVlmGridCheck(screenshotResult.imagePath, opts.model);
      console.log(`Post-VERIFY: VLM says grid_visible=${vlmResult.gridVisible}, checkbox_checked=${vlmResult.checkboxChecked}`);
      if (vlmResult.gridVisible) {
        return { gridVisible: true, vlmConfirmed: true, expired: false };
      }
      // VLM says no grid — check if VLM also saw a checked checkbox (CAPTCHA solved)
      if (vlmResult.checkboxChecked) {
        console.log('Post-VERIFY: VLM reports checkbox checked — CAPTCHA solved');
        return { gridVisible: false, vlmConfirmed: true, expired: false };
      }
      // VLM says no grid AND anchor is not checked — transitional state
      // Wait and re-probe once before concluding
      console.log('Post-VERIFY: VLM says no grid but anchor not checked; waiting 3s and re-probing...');
      await sleep(3000);
      const reprobe = await probeChallenge(cdp, siteKey);
      if (reprobe.visible) {
        console.log(`Post-VERIFY: re-probe shows grid (${reprobe.grid}x${reprobe.grid}) — new challenge appeared`);
        return { gridVisible: true, vlmConfirmed: false, expired: false };
      }
      if (reprobe.expired) {
        return { gridVisible: false, vlmConfirmed: false, expired: true };
      }
      // Re-check anchor after wait
      const targets2 = await getTargets(cdp);
      const anchor2 = pickIframeTarget(targets2, siteKey, 'anchor');
      if (anchor2) {
        const checked2 = await withTarget(cdp, anchor2.targetId, async session => {
          return cdp.eval(session, `document.getElementById('recaptcha-anchor')?.getAttribute('aria-checked') || 'unknown'`, { json: false });
        });
        console.log(`Post-VERIFY: re-checked anchor aria-checked = ${checked2}`);
        if (checked2 === 'true') {
          return { gridVisible: false, vlmConfirmed: false, expired: false };
        }
      }
    }
  } catch (error) {
    console.log(`Post-VERIFY: VLM check failed: ${error.message}`);
  }

  // No grid, no solved state — CAPTCHA may be in transition or solved
  console.log('Post-VERIFY: no grid found, anchor not checked — transitional state');
  return { gridVisible: false, vlmConfirmed: false, expired: false };
}

async function reloadChallenge(cdp, siteKey) {
  const targets = await getTargets(cdp);
  const bframe = pickIframeTarget(targets, siteKey, 'bframe');
  if (!bframe) return false;
  try {
    return await withTarget(cdp, bframe.targetId, async session => {
      const coords = await cdp.eval(session, `(() => {
        const button = document.querySelector('#recaptcha-reload-button');
        if (!button) return JSON.stringify({ ok: false, reason: 'no reload button' });
        const rect = button.getBoundingClientRect();
        if (!rect.width || !rect.height) return JSON.stringify({ ok: false, reason: 'reload button hidden' });
        if (button.disabled) button.disabled = false;
        return JSON.stringify({ ok: true, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) });
      })()`, { json: true });
      if (!coords?.ok) return false;
      await dispatchClick(cdp, session, coords.x, coords.y);
      console.log('Clicked Get a new challenge');
      return true;
    });
  } catch (error) {
    console.log(`Reload unavailable: ${error.message}`);
    return false;
  }
}

/**
 * Capture a PNG screenshot of the bframe iframe or parent page.
 * Uses Runtime.evaluate to render bframe content into a canvas (since
 * Page.captureScreenshot fails on iframe targets). Includes anchor
 * checkbox state in the canvas for VLM to interpret.
 */
async function captureBframeScreenshot(cdp, siteKey) {
  const targets = await getTargets(cdp);
  const bframe = pickIframeTarget(targets, siteKey, 'bframe');

  // First, check the anchor checkbox state for context
  let anchorChecked = 'unknown';
  const anchor = pickIframeTarget(targets, siteKey, 'anchor');
  if (anchor) {
    try {
      anchorChecked = await withTarget(cdp, anchor.targetId, async session => {
        return cdp.eval(session, `document.getElementById('recaptcha-anchor')?.getAttribute('aria-checked') || 'unknown'`, { json: false });
      });
    } catch {}
  }

  // Try canvas capture inside the bframe
  if (bframe) {
    try {
      const result = await withTarget(cdp, bframe.targetId, async session => {
        const canvasResult = await cdp.eval(session, `(() => {
          const body = document.body;
          if (!body) return JSON.stringify({ ok: false, reason: 'no body' });
          const bodyText = (body.innerText || '');
          // If no challenge grid visible, create a status canvas with checkbox info
          const table = document.querySelector('.rc-imageselect-table-33,.rc-imageselect-table-44');
          const tiles = Array.from(document.querySelectorAll('.rc-imageselect-tile'));
          if (!table || !tiles.length) {
            // No active grid — render a status canvas
            const canvas = document.createElement('canvas');
            canvas.width = 400;
            canvas.height = 200;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, 400, 200);
            ctx.fillStyle = '#333333';
            ctx.font = 'bold 16px sans-serif';
            ctx.fillText('reCAPTCHA status (no grid visible)', 10, 30);
            ctx.font = '14px sans-serif';
            ctx.fillText('Checkbox: ' + (${JSON.stringify(anchorChecked)} === 'true' ? 'CHECKED (solved)' : 'NOT CHECKED'), 10, 60);
            ctx.fillText(bodyText.slice(0, 300).replace(/\\n/g, ' '), 10, 90);
            return JSON.stringify({ ok: true, hasGrid: false, dataUrl: canvas.toDataURL('image/png'), text: bodyText.slice(0, 300) });
          }
          // Grid is visible — use the full canvas capture
          return (${captureGridInFrame.toString()})();
        })()`, { awaitPromise: true, json: true });
        return canvasResult;
      });
      if (result?.ok && result.dataUrl) {
        const base64 = result.dataUrl.replace(/^data:image\/png;base64,/, '');
        const filePath = `/tmp/recaptcha-bframe-${Date.now()}.png`;
        fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
        console.log(`Bframe canvas capture saved: ${filePath} (hasGrid=${!!result.hasGrid}, anchor=${anchorChecked})`);
        return { imagePath: filePath, hasGrid: !!result.hasGrid };
      }
    } catch (error) {
      console.log(`Bframe canvas capture failed: ${error.message}`);
    }
  }

  // Fallback: screenshot the parent page
  const pageTarget = pickPageTarget(targets, '');
  if (!pageTarget) {
    console.log('No page target for fallback screenshot');
    return null;
  }
  try {
    return await withTarget(cdp, pageTarget.targetId, async session => {
      const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', quality: 80 }, session);
      if (screenshot?.data) {
        const filePath = `/tmp/recaptcha-page-${Date.now()}.png`;
        fs.writeFileSync(filePath, Buffer.from(screenshot.data, 'base64'));
        console.log(`Parent page screenshot saved: ${filePath}`);
        return { imagePath: filePath };
      }
      return null;
    });
  } catch (error) {
    console.log(`Parent page screenshot failed: ${error.message}`);
    return null;
  }
}

/**
 * Ask the VLM whether a CAPTCHA challenge grid is visible in the screenshot.
 * Returns true if the VLM sees a grid, false otherwise.
 */
async function askVlmGridCheck(imagePath, model) {
  const base64 = fs.readFileSync(imagePath).toString('base64');
  const prompt = `You are inspecting a webpage screenshot to determine the state of a reCAPTCHA challenge.

Look carefully at this screenshot and answer ALL of these questions:

1. Is there a VISIBLE reCAPTCHA image challenge grid — meaning tiles with images arranged in a grid AND a challenge instruction like "Select all images with..." that the user must solve RIGHT NOW?
2. Is the reCAPTCHA checkbox checked (green checkmark) indicating the challenge is already solved?
3. Does the page show any text like "verified", "solved", or a green checkmark icon?

Important distinctions:
- A green checkmark on the reCAPTCHA checkbox means the challenge is SOLVED — no further action needed
- An empty/unchecked checkbox with NO grid visible means the challenge is in a transitional state
- A grid with images and a challenge instruction means there IS an active challenge to solve

Reply ONLY valid JSON: {"grid_visible": true or false, "checkbox_checked": true or false, "reasoning": "brief explanation of what you see"}`;

  const payload = {
    model,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } },
        { type: 'text', text: prompt },
      ],
    }],
    max_tokens: 200,
    temperature: 0.05,
  };

  const response = await httpJson('POST', '/v1/chat/completions', payload, VLM_PORT, 120000);
  const raw = response.choices?.[0]?.message?.content || '';
  const cleaned = String(raw).replace(/<think[^>]*>[\s\S]*?<\/think>/gi, '').trim();
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.log(`VLM grid-check raw response: ${raw.slice(0, 200)}`);
    return { gridVisible: false, checkboxChecked: false };
  }
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    console.log(`VLM grid-check: grid_visible=${parsed.grid_visible}, checkbox_checked=${parsed.checkbox_checked}, reasoning=${(parsed.reasoning || '').slice(0, 100)}`);
    return { gridVisible: !!parsed.grid_visible, checkboxChecked: !!parsed.checkbox_checked };
  } catch {
    console.log(`VLM grid-check parse error: ${cleaned.slice(0, 160)}`);
    return { gridVisible: false, checkboxChecked: false };
  }
}

async function captureCanvasGrid(cdp, siteKey) {
  const targets = await getTargets(cdp);
  const bframe = pickIframeTarget(targets, siteKey, 'bframe');
  if (!bframe) throw new Error('No bframe target found for capture');
  return withTarget(cdp, bframe.targetId, async session => {
    const result = await cdp.eval(session, `(${captureGridInFrame.toString()})()`, { awaitPromise: true, json: true });
    if (!result?.ok) throw new Error(result?.reason || 'Canvas capture failed');
    const base64 = result.dataUrl.replace(/^data:image\/png;base64,/, '');
    const safeTarget = (result.target || 'challenge').replace(/[^a-z0-9-]+/gi, '-').slice(0, 40) || 'challenge';
    const filePath = `/tmp/recaptcha-${Date.now()}-${result.grid}x${result.grid}-${safeTarget}.png`;
    fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
    return { ...result, dataUrl: undefined, imagePath: filePath };
  });
}

async function captureGridInFrame() {
  const waitForImages = async imgs => {
    await Promise.all(imgs.map(img => {
      if (img.complete && img.naturalWidth > 0) return Promise.resolve();
      return new Promise(resolve => {
        const done = () => resolve();
        img.addEventListener('load', done, { once: true });
        img.addEventListener('error', done, { once: true });
        setTimeout(done, 2500);
      });
    }));
  };

  const bodyText = document.body?.innerText || '';
  if (/expired|verification expired|try again/i.test(bodyText)) {
    return JSON.stringify({ ok: false, reason: 'challenge expired' });
  }

  const table = document.querySelector('.rc-imageselect-table-33,.rc-imageselect-table-44');
  const tiles = Array.from(document.querySelectorAll('.rc-imageselect-tile'));
  if (!table || !tiles.length) return JSON.stringify({ ok: false, reason: 'no image grid' });

  const tableClass = table.className || '';
  const grid = tableClass.includes('44') ? 4 : tableClass.includes('33') ? 3 : Math.round(Math.sqrt(tiles.length));
  if (!grid || grid < 2) return JSON.stringify({ ok: false, reason: `unknown grid from ${tableClass}` });

  const instructionNode = document.querySelector('.rc-imageselect-instructions, .rc-imageselect-desc-wrapper, .rc-imageselect-desc-no-canonical, .rc-imageselect-desc');
  const instruction = (instructionNode?.innerText || bodyText).replace(/\s+/g, ' ').trim();
  const strong = document.querySelector('.rc-imageselect-desc-no-canonical strong, .rc-imageselect-desc strong, .rc-imageselect-instructions strong');
  const target = (strong?.innerText || instruction.match(/(?:images|squares) with ([^.]+?)(?:\.|$| click| verify)/i)?.[1] || '').replace(/\s+/g, ' ').trim();
  const imgs = tiles.map(tile => tile.querySelector('img')).filter(Boolean);
  await waitForImages(imgs);

  const tileRects = tiles.map(tile => tile.getBoundingClientRect());
  const sourceTileWidth = Math.max(70, Math.round(Math.max(...tileRects.map(rect => rect.width || 0))));
  const sourceTileHeight = Math.max(70, Math.round(Math.max(...tileRects.map(rect => rect.height || 0))));
  const tileWidth = Math.max(140, sourceTileWidth);
  const tileHeight = Math.max(140, sourceTileHeight);
  const canvas = document.createElement('canvas');
  canvas.width = grid * tileWidth;
  canvas.height = grid * tileHeight;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const tileIds = [];
  for (let fallbackIndex = 0; fallbackIndex < tiles.length; fallbackIndex++) {
    const tile = tiles[fallbackIndex];
    const img = tile.querySelector('img');
    const id = Number.isInteger(Number(tile.id)) ? Number(tile.id) : fallbackIndex;
    tileIds.push(id);
    if (!img || !img.naturalWidth || !img.naturalHeight) continue;

    const tileRect = tile.getBoundingClientRect();
    const imgRect = img.getBoundingClientRect();
    const row = Math.floor(id / grid);
    const col = id % grid;
    const dx = col * tileWidth;
    const dy = row * tileHeight;

    const scaleX = imgRect.width ? img.naturalWidth / imgRect.width : 1;
    const scaleY = imgRect.height ? img.naturalHeight / imgRect.height : 1;
    let sx = Math.max(0, (tileRect.left - imgRect.left) * scaleX);
    let sy = Math.max(0, (tileRect.top - imgRect.top) * scaleY);
    let sw = Math.min(img.naturalWidth - sx, Math.max(1, tileRect.width * scaleX));
    let sh = Math.min(img.naturalHeight - sy, Math.max(1, tileRect.height * scaleY));

    if (!Number.isFinite(sx) || !Number.isFinite(sy) || sw <= 1 || sh <= 1) {
      sx = 0;
      sy = 0;
      sw = img.naturalWidth;
      sh = img.naturalHeight;
    }

    ctx.drawImage(img, sx, sy, sw, sh, dx, dy, tileWidth, tileHeight);
  }

  ctx.lineWidth = 3;
  ctx.font = 'bold 24px sans-serif';
  ctx.textBaseline = 'top';
  for (let id = 0; id < grid * grid; id++) {
    const row = Math.floor(id / grid);
    const col = id % grid;
    const x = col * tileWidth;
    const y = row * tileHeight;
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.strokeRect(x + 1, y + 1, tileWidth - 2, tileHeight - 2);
    ctx.fillStyle = 'rgba(0,0,0,0.72)';
    ctx.fillRect(x + 4, y + 4, id < 10 ? 34 : 48, 32);
    ctx.fillStyle = '#7CFF00';
    ctx.fillText(String(id), x + 10, y + 8);
  }

  let dataUrl;
  try {
    dataUrl = canvas.toDataURL('image/png');
  } catch (error) {
    return JSON.stringify({ ok: false, reason: `canvas export failed: ${error.message}` });
  }

  const selected = tiles
    .filter(tile => tile.classList.contains('rc-imageselect-tileselected'))
    .map(tile => Number.isInteger(Number(tile.id)) ? Number(tile.id) : tiles.indexOf(tile));
  const button = document.querySelector('#recaptcha-verify-button');

  return JSON.stringify({
    ok: true,
    grid,
    tileIds,
    selected,
    target,
    instruction,
    buttonText: (button?.innerText || button?.textContent || '').trim(),
    dataUrl,
  });
}

function targetHint(target) {
  const t = (target || '').toLowerCase();
  if (/bus|buses/.test(t)) return 'Select every visible bus, including distant, blurry, partial, side, front, rear, red/orange/green/white buses, and bus-like public transit vehicles with large rectangular bodies/windows. Exclude ordinary cars, roads, traffic lights, signs, and buildings.';
  if (/car|cars|vehicle/.test(t)) return 'Select cars/passenger vehicles only when visible, including partial cars. Exclude buses, trucks, motorcycles, roads, signs, and buildings.';
  if (/motorcycle|motorbike/.test(t)) return 'Select motorcycles/motorbikes and riders on motorcycles. Exclude bicycles, cars, and scooters unless clearly motorized motorcycle-like vehicles.';
  if (/traffic light/.test(t)) return 'Select tiles containing traffic light hardware or illuminated traffic signals, including partial signal heads or poles attached to them.';
  if (/crosswalk|pedestrian crossing|crossing/.test(t)) return 'Select only zebra/striped pedestrian crossing markings. Exclude roads, sidewalks, cars, and signs without visible crossing stripes.';
  if (/stair|stairs|steps/.test(t)) return 'Select only visible stairs or steps. Exclude railings, floors, ramps, and walls unless the step surfaces are visible.';
  if (/bridge/.test(t)) return 'Select bridge structure only, including bridge decks, supports, railings, and arches. Exclude normal roads or buildings without bridge structure.';
  if (/hydrant/.test(t)) return 'Select fire hydrants only. Exclude poles, traffic lights, cones, bins, and signs.';
  if (/bicycle|bike/.test(t)) return 'Select bicycles only. Exclude motorcycles, cars, street furniture, and riders without visible bicycle parts.';
  return 'Select every tile containing any visible part of the requested object, even if only partially visible. Exclude lookalikes and background objects.';
}

async function askVlm(imagePath, grid, target, instruction, model) {
  const maxTile = grid * grid - 1;
  const base64 = fs.readFileSync(imagePath).toString('base64');
  const prompt = `${grid}x${grid} Google reCAPTCHA grid. Tiles are labeled 0-${maxTile}.\n\nInstruction: ${instruction || `Select all images with ${target}`}.\nTarget object: ${target || 'the requested object'}.\n${targetHint(target)}\n\nAnalyze EACH tile before selecting. A tile counts if any part of the target object is inside that tile. For small/blurry target objects, put likely matches in uncertainTiles instead of dropping them.\n\nReply ONLY valid JSON with this shape:\n{"descriptions":{"0":"...","1":"..."},"tiles":[0],"uncertainTiles":[1],"reasoning":"brief"}`;
  const payload = {
    model,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } },
        { type: 'text', text: prompt },
      ],
    }],
    max_tokens: 650,
    temperature: 0.05,
  };

  const response = await httpJson('POST', '/v1/chat/completions', payload, VLM_PORT, 120000);
  const raw = response.choices?.[0]?.message?.content || '';
  const parsed = parseVlmJson(raw, grid);
  if (!parsed) throw new Error(`VLM did not return parseable tile JSON: ${raw.slice(0, 160)}`);
  return parsed;
}

function parseVlmJson(raw, grid) {
  const cleaned = String(raw)
    .replace(/<think[^>]*>[\s\S]*?<\/think>/gi, '')
    .replace(/```(?:json)?/gi, '')
    .replace(/```/g, '')
    .trim();
  const objectMatch = cleaned.match(/\{[\s\S]*\}/);
  let parsed = null;
  if (objectMatch) {
    try { parsed = JSON.parse(objectMatch[0]); } catch { parsed = null; }
  }
  if (!parsed) {
    const arrayMatch = cleaned.match(/\[[\d,\s]+\]/);
    if (!arrayMatch) return null;
    try { parsed = { tiles: JSON.parse(arrayMatch[0]) }; } catch { return null; }
  }
  const max = grid * grid;
  const tiles = Array.from(new Set((parsed.tiles || [])
    .map(value => Number(value))
    .filter(value => Number.isInteger(value) && value >= 0 && value < max)))
    .sort((a, b) => a - b);
  const uncertainTiles = Array.from(new Set((parsed.uncertainTiles || [])
    .map(value => Number(value))
    .filter(value => Number.isInteger(value) && value >= 0 && value < max)))
    .sort((a, b) => a - b);
  return { ...parsed, tiles, uncertainTiles };
}

function shouldIncludeUncertainTiles(target, instruction) {
  const text = `${target || ''} ${instruction || ''}`.toLowerCase();
  return /bus|buses|motorcycle|motorbike|traffic light/.test(text);
}

async function clickBframePointFromPage(cdp, pageTarget, siteKey, x, y) {
  await cdp.send('Target.activateTarget', { targetId: pageTarget.targetId }).catch(() => {});
  return withTarget(cdp, pageTarget.targetId, async pageSession => {
    const coords = await cdp.eval(pageSession, `(() => {
      const siteKey = ${JSON.stringify(siteKey)};
      const frame = Array.from(document.querySelectorAll('iframe[src*="recaptcha"][src*="bframe"]'))
        .filter(iframe => !siteKey || iframe.src.includes(siteKey))
        .pop();
      if (!frame) return JSON.stringify({ ok: false, reason: 'no bframe iframe in parent page' });
      const rect = frame.getBoundingClientRect();
      const px = Math.round(rect.left + ${Math.round(x)});
      const py = Math.round(rect.top + ${Math.round(y)});
      const under = document.elementFromPoint(px, py);
      return JSON.stringify({ ok: true, x: px, y: py, under: under?.tagName || '', rect: { left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) } });
    })()`, { json: true });
    if (!coords?.ok) {
      console.log(`Parent-coordinate fallback unavailable: ${coords?.reason || 'unknown reason'}`);
      return false;
    }
    console.log(`Parent-coordinate fallback click: ${coords.x},${coords.y} over ${coords.under || 'unknown'}`);
    await dispatchClick(cdp, pageSession, coords.x, coords.y);
    return true;
  });
}

async function tileSelectedState(cdp, session, tileId) {
  return cdp.eval(session, `(() => {
    const tile = Array.from(document.querySelectorAll('.rc-imageselect-tile')).find((item, fallbackIndex) => {
      const id = Number.isInteger(Number(item.id)) ? Number(item.id) : fallbackIndex;
      return id === ${Number(tileId)};
    });
    if (!tile) return JSON.stringify({ found: false, selected: false });
    const img = tile.querySelector('img');
    return JSON.stringify({
      found: true,
      selected: tile.classList.contains('rc-imageselect-tileselected'),
      srcTail: (img?.src || '').slice(-24),
    });
  })()`, { json: true });
}

async function clickTileViaRuntimeEvents(cdp, session, tileId) {
  return cdp.eval(session, `(() => {
    const tileId = ${Number(tileId)};
    const tile = Array.from(document.querySelectorAll('.rc-imageselect-tile')).find((item, fallbackIndex) => {
      const id = Number.isInteger(Number(item.id)) ? Number(item.id) : fallbackIndex;
      return id === tileId;
    });
    if (!tile) return JSON.stringify({ ok: false, reason: 'tile not found' });
    const target = tile.querySelector('img') || tile;
    const rect = target.getBoundingClientRect();
    const clientX = Math.round(rect.left + rect.width / 2);
    const clientY = Math.round(rect.top + rect.height / 2);
    const common = { bubbles: true, cancelable: true, composed: true, view: window, clientX, clientY, screenX: clientX, screenY: clientY, button: 0 };
    for (const type of ['pointerover', 'mouseover', 'pointermove', 'mousemove']) {
      target.dispatchEvent(new MouseEvent(type, { ...common, buttons: 0 }));
    }
    for (const type of ['pointerdown', 'mousedown']) {
      target.dispatchEvent(new MouseEvent(type, { ...common, buttons: 1 }));
    }
    for (const type of ['pointerup', 'mouseup', 'click']) {
      target.dispatchEvent(new MouseEvent(type, { ...common, buttons: 0 }));
    }
    return JSON.stringify({ ok: true, selected: tile.classList.contains('rc-imageselect-tileselected') });
  })()`, { json: true, userGesture: true });
}

async function clickTiles(cdp, siteKey, pageTarget, tiles) {
  if (!tiles.length) return 0;
  const targets = await getTargets(cdp);
  const bframe = pickIframeTarget(targets, siteKey, 'bframe');
  if (!bframe) throw new Error('No bframe target found for tile click');
  return withTarget(cdp, bframe.targetId, async session => {
    const rects = await cdp.eval(session, `(() => {
      return JSON.stringify(Array.from(document.querySelectorAll('.rc-imageselect-tile')).map((tile, fallbackIndex) => {
        const rect = tile.getBoundingClientRect();
        const id = Number.isInteger(Number(tile.id)) ? Number(tile.id) : fallbackIndex;
        return {
          id,
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
          selected: tile.classList.contains('rc-imageselect-tileselected'),
          visible: rect.width > 5 && rect.height > 5,
        };
      }));
    })()`, { json: true });
    let clicked = 0;
    for (const tileId of tiles) {
      const rect = rects.find(item => item.id === tileId && item.visible);
      if (!rect || rect.selected) continue;
      const before = await tileSelectedState(cdp, session, tileId);
      await dispatchClick(cdp, session, rect.x, rect.y);
      await sleep(260);
      let state = await tileSelectedState(cdp, session, tileId);
      let changed = !!before?.srcTail && !!state?.srcTail && before.srcTail !== state.srcTail;
      if (!state?.selected && !changed) {
        const fallbackClicked = await clickBframePointFromPage(cdp, pageTarget, siteKey, rect.x, rect.y);
        if (fallbackClicked) {
          await sleep(260);
          state = await tileSelectedState(cdp, session, tileId);
          changed = !!before?.srcTail && !!state?.srcTail && before.srcTail !== state.srcTail;
        }
      }
      if (!state?.selected && !changed) {
        const runtime = await clickTileViaRuntimeEvents(cdp, session, tileId);
        await sleep(260);
        state = await tileSelectedState(cdp, session, tileId);
        changed = !!before?.srcTail && !!state?.srcTail && before.srcTail !== state.srcTail;
        if (runtime?.ok) console.log(`Runtime event fallback for tile ${tileId}: selected=${!!runtime.selected}`);
      }
      console.log(`Tile ${tileId} selected=${!!state?.selected} changed=${changed}`);
      clicked++;
      await sleep(120);
    }
    return clicked;
  });
}

async function solveVisibleChallenge(cdp, pageTarget, siteKey, opts) {
  for (let pass = 1; pass <= opts.tilePasses; pass++) {
    let capture;
    try {
      capture = await captureCanvasGrid(cdp, siteKey);
    } catch (error) {
      console.log(`Canvas capture failed: ${error.message}`);
      await reloadChallenge(cdp, siteKey);
      await sleep(1800);
      capture = await captureCanvasGrid(cdp, siteKey);
    }

    console.log(`Challenge pass ${pass}: ${capture.grid}x${capture.grid}, target="${capture.target || 'unknown'}", image=${capture.imagePath}`);
    let tiles = opts.manualTiles;
    let vision = null;
    if (!tiles) {
      vision = await askVlm(capture.imagePath, capture.grid, capture.target, capture.instruction, opts.model);
      tiles = vision.tiles;
      if (vision.uncertainTiles?.length && shouldIncludeUncertainTiles(capture.target, capture.instruction)) {
        tiles = Array.from(new Set([...tiles, ...vision.uncertainTiles])).sort((a, b) => a - b);
      }
    }

    console.log(`Tiles selected by ${opts.manualTiles ? 'manual mode' : 'VLM'}: ${tiles.join(',') || '(none)'}`);
    if (vision?.uncertainTiles?.length) console.log(`VLM uncertain tiles: ${vision.uncertainTiles.join(',')}`);
    if (vision?.reasoning) console.log(`VLM reasoning: ${String(vision.reasoning).slice(0, 180)}`);

    if (!tiles.length) break;

    // Check how many tiles are already selected before clicking
    const preSelected = await getSelectedTileCount(cdp, siteKey);
    const clicked = await clickTiles(cdp, siteKey, pageTarget, tiles);
    console.log(`Clicked ${clicked} tile(s) (previously selected: ${preSelected})`);

    // If 0 tiles were clicked and some were already selected, we may be in a
    // stale state from a previous challenge round. Click the checkbox to get
    // a completely fresh challenge instead of trying to reload within the stale one.
    if (clicked === 0 && preSelected > 0) {
      console.log('All target tiles already selected but 0 new clicks — stale state detected.');
      console.log('Clicking checkbox to get a fresh challenge.');
      const freshGrid = await clickCheckboxUntilGrid(cdp, pageTarget, siteKey, 3);
      if (freshGrid) {
        // Restart the challenge loop with the fresh grid
        capture = await captureCanvasGrid(cdp, siteKey);
        pass--; // retry this pass with the fresh grid
        continue;
      }
      // No fresh grid appeared — the CAPTCHA may be solved
      break;
    }

    await sleep(1300);

    const dynamic = /none left|new images|verify once/i.test(capture.instruction || '');
    if (!dynamic) break;
  }

  await pressChallengeButton(cdp, siteKey);
}

async function getSelectedTileCount(cdp, siteKey) {
  const targets = await getTargets(cdp);
  const bframe = pickIframeTarget(targets, siteKey, 'bframe');
  if (!bframe) return 0;
  try {
    return await withTarget(cdp, bframe.targetId, async session => {
      const count = await cdp.eval(session, `document.querySelectorAll('.rc-imageselect-tileselected').length`, { json: false });
      return Number(count) || 0;
    });
  } catch {
    return 0;
  }
}

/**
 * Unselect all currently-selected tiles by clicking them (reCAPTCHA tiles are toggles).
 * This clears stale selections before reloading a fresh challenge.
 */
async function unselectAllTiles(cdp, siteKey, pageTarget) {
  const targets = await getTargets(cdp);
  const bframe = pickIframeTarget(targets, siteKey, 'bframe');
  if (!bframe) return 0;
  try {
    return await withTarget(cdp, bframe.targetId, async session => {
      const selected = await cdp.eval(session, `(() => {
        return Array.from(document.querySelectorAll('.rc-imageselect-tileselected')).map(tile => {
          const rect = tile.getBoundingClientRect();
          return {
            id: Number.isInteger(Number(tile.id)) ? Number(tile.id) : -1,
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
          };
        }).filter(t => t.id >= 0);
      })()`, { json: true });
      if (!Array.isArray(selected) || selected.length === 0) return 0;
      console.log(`Unselecting ${selected.length} stale tiles: ${selected.map(t => t.id).join(',')}`);
      for (const tile of selected) {
        await dispatchClick(cdp, session, tile.x, tile.y);
        await sleep(200);
      }
      // Verify tiles are now unselected
      const stillSelected = await cdp.eval(session, `document.querySelectorAll('.rc-imageselect-tileselected').length`, { json: false });
      console.log(`After unselect: ${stillSelected} tiles still selected`);
      return selected.length;
    });
  } catch (error) {
    console.log(`Unselect via bframe failed: ${error.message}; trying parent-page coordinates`);
    return 0;
  }
}

async function pressChallengeButton(cdp, siteKey) {
  const targets = await getTargets(cdp);
  const bframe = pickIframeTarget(targets, siteKey, 'bframe');
  if (!bframe) throw new Error('No bframe target found for verify button');
  return withTarget(cdp, bframe.targetId, async session => {
    const button = await cdp.eval(session, `(() => {
      const candidates = [
        document.querySelector('#recaptcha-verify-button'),
        ...Array.from(document.querySelectorAll('button')),
      ].filter(Boolean);
      const visible = candidates.find(button => {
        const rect = button.getBoundingClientRect();
        const style = getComputedStyle(button);
        return rect.width > 5 && rect.height > 5 && style.display !== 'none' && style.visibility !== 'hidden';
      });
      if (!visible) return JSON.stringify({ ok: false, reason: 'no visible challenge button' });
      if (visible.disabled) visible.disabled = false;
      const rect = visible.getBoundingClientRect();
      return JSON.stringify({
        ok: true,
        text: (visible.innerText || visible.textContent || '').trim(),
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
      });
    })()`, { json: true });
    if (!button?.ok) throw new Error(button?.reason || 'No verify button');
    await dispatchClick(cdp, session, button.x, button.y);
    console.log(`Pressed challenge button: ${button.text || 'VERIFY/NEXT'}`);
    await sleep(4500);
    return button.text;
  });
}

async function trySubmit(cdp, pageTarget) {
  return withTarget(cdp, pageTarget.targetId, async session => {
    const state = await cdp.eval(session, `(() => {
      const candidates = Array.from(document.querySelectorAll('button, [role="button"]')).map((button, index) => {
        const text = (button.innerText || button.textContent || '').replace(/\s+/g, ' ').trim();
        const rect = button.getBoundingClientRect();
        const disabled = !!button.disabled || button.getAttribute('aria-disabled') === 'true';
        return { index, text, disabled, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), width: rect.width, height: rect.height };
      }).filter(button => button.width > 5 && button.height > 5);
      const submit = candidates.find(button => /submit your application|submit application|send application|apply now|apply/i.test(button.text));
      const body = (document.body?.innerText || '').slice(0, 1000);
      return JSON.stringify({
        hasSuccessText: /application submitted|application was submitted|your application has been submitted|thank you for applying|you applied/i.test(body),
        submit,
        url: location.href,
      });
    })()`, { json: true });

    if (state?.hasSuccessText) {
      console.log('Application already appears submitted.');
      return true;
    }
    if (!state?.submit) {
      console.log('No submit/apply button found on page.');
      return false;
    }
    console.log(`Submit button: "${state.submit.text}" disabled=${state.submit.disabled}`);
    if (state.submit.disabled) return false;

    await dispatchClick(cdp, session, state.submit.x, state.submit.y);
    await sleep(5500);
    const post = await cdp.eval(session, `(() => {
      const body = (document.body?.innerText || '').slice(0, 1500);
      return JSON.stringify({
        success: /application submitted|application was submitted|your application has been submitted|thank you for applying|you applied/i.test(body),
        text: body.slice(0, 400),
        url: location.href,
      });
    })()`, { json: true });
    console.log(`Post-submit success=${!!post?.success}`);
    if (!post?.success && post?.text) console.log(post.text.replace(/\s+/g, ' ').slice(0, 300));
    return !!post?.success;
  });
}

async function runCheck(cdp, opts) {
  const targets = await getTargets(cdp);
  const page = pickPageTarget(targets, opts.pageFilter);
  const anchor = pickIframeTarget(targets, opts.siteKey, 'anchor');
  const bframe = pickIframeTarget(targets, opts.siteKey, 'bframe');
  console.log(`CDP targets: pages=${targets.filter(t => t.type === 'page').length}, iframes=${targets.filter(t => t.type === 'iframe').length}`);
  console.log(`Page target: ${page ? `${page.targetId.slice(0, 12)} ${page.title || page.url}` : 'not found'}`);
  console.log(`Anchor target: ${anchor ? anchor.targetId.slice(0, 12) : 'not found'}`);
  console.log(`Bframe target: ${bframe ? bframe.targetId.slice(0, 12) : 'not found'}`);
  try {
    const modelResponse = await httpJson('GET', '/v1/models', null, VLM_PORT);
    const names = (modelResponse.data || []).map(model => model.id).slice(0, 5);
    console.log(`LM Studio models: ${names.join(', ') || 'endpoint reachable'}`);
  } catch (error) {
    console.log(`LM Studio check failed: ${error.message}`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cdpPort = opts.cdpPort || CDP_PORT;
  console.log(`Connecting to CDP at ${CDP_HOST}:${cdpPort}...`);
  const version = await httpJson('GET', '/json/version', null, cdpPort);
  if (!version.webSocketDebuggerUrl) throw new Error(`No browser WebSocket at ${CDP_HOST}:${cdpPort}. Start Chromium with --remote-debugging-port=${cdpPort}.`);
  const cdp = new CdpClient(version.webSocketDebuggerUrl);
  await cdp.open();

  try {
    if (opts.check) {
      await runCheck(cdp, opts);
      return;
    }

    const targets = await getTargets(cdp);
    const pageTarget = pickPageTarget(targets, opts.pageFilter);
    if (!pageTarget) throw new Error(`No page target found matching ${opts.pageFilter || '(any page)'}`);
    console.log(`Using page target: ${pageTarget.title || pageTarget.url}`);

    let gridAlreadyVisible = false;
    for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
      console.log(`\n=== CAPTCHA attempt ${attempt}/${opts.maxAttempts} ===`);

      const existingGrid = gridAlreadyVisible ? { visible: true } : await probeChallenge(cdp, opts.siteKey);
      const gridReady = existingGrid.visible || await clickCheckboxUntilGrid(cdp, pageTarget, opts.siteKey, opts.checkboxClicks);
      gridAlreadyVisible = false;
      if (!gridReady) {
        console.log('No grid appeared after checkbox clicks; checking whether submission is now possible.');
        if (opts.submit && await trySubmit(cdp, pageTarget)) return;
        continue;
      }

      // Detect stale tile selections from previous sessions/attempts.
      // If tiles are already selected when we start solving, the challenge is
      // likely stale or expired. Click the checkbox to get a completely fresh
      // challenge instead of trying to unselect stale tiles.
      const preSelected = await getSelectedTileCount(cdp, opts.siteKey);
      if (preSelected > 0) {
        console.log(`Detected ${preSelected} pre-selected tiles (stale state); clicking checkbox for fresh challenge.`);
        const freshGrid = await clickCheckboxUntilGrid(cdp, pageTarget, opts.siteKey, opts.checkboxClicks);
        if (!freshGrid) {
          console.log('No grid after fresh checkbox click; checking submission.');
          if (opts.submit && await trySubmit(cdp, pageTarget)) return;
          continue;
        }
      }

      await solveVisibleChallenge(cdp, pageTarget, opts.siteKey, opts);

      // Post-VERIFY check: do NOT re-click the checkbox.
      // Instead, probe the bframe for a visible grid, check anchor state,
      // and use VLM for visual confirmation if needed. Only re-click the
      // checkbox as a last resort if the submit button is still disabled.
      const postVerify = await checkPostVerify(cdp, pageTarget, opts.siteKey, opts);
      if (postVerify.expired) {
        console.log('Challenge expired after VERIFY; reloading and continuing.');
        await reloadChallenge(cdp, opts.siteKey);
        await sleep(1800);
        gridAlreadyVisible = true;
        continue;
      }
      if (postVerify.gridVisible) {
        console.log('New challenge grid visible after VERIFY; continuing with the next challenge.');
        gridAlreadyVisible = true;
        continue;
      }

      console.log('No grid visible after VERIFY; trying parent-page submit.');
      if (!opts.submit) {
        console.log('Run again with --submit to click the enabled application submit button.');
        return;
      }
      const submitted = await trySubmit(cdp, pageTarget);
      if (submitted) return;

      // Submit button still disabled — try one checkbox re-click as last resort
      console.log('Submit still disabled; trying one checkbox re-click as last resort.');
      const gridReappeared = await clickCheckboxOnceAndProbe(cdp, pageTarget, opts.siteKey);
      if (gridReappeared) {
        console.log('Grid appeared after last-resort checkbox click; continuing.');
        gridAlreadyVisible = true;
        continue;
      }
      console.log('No grid after last-resort checkbox click; final submit attempt.');
      if (await trySubmit(cdp, pageTarget)) return;
      console.log('Submit still unavailable; continuing to next attempt.');
    }

    throw new Error('CAPTCHA was not solved within max attempts');
  } finally {
    cdp.close();
  }
}

main().catch(error => {
  console.error(`ERROR: ${error.message}`);
  process.exit(1);
});
