#!/usr/bin/env node
// visual-recover.mjs — one-command visual recovery for stuck browser automation.
//
// Default protocol whenever a click / form-fill / submit / navigation cannot progress:
//   1. Capture what the browser ACTUALLY shows (CDP viewport or container X display).
//   2. Ask the local Qwen VLM what state is visible and where the next control is.
//   3. Optionally click that control (coordinate system paired with the capture method).
//   4. Re-capture and verify the state changed.
//
// Usage:
//   node visual-recover.mjs                                  # inspect via CDP (default)
//   node visual-recover.mjs --prompt "Did the CV upload complete?"
//   node visual-recover.mjs --url-substr linkedin.com/jobs   # pick tab by URL fragment
//   node visual-recover.mjs --click                          # inspect + click next control + verify
//   node visual-recover.mjs --capture ffmpeg --click         # container display + xdotool (for modals/alerts CDP can't see)
//   node visual-recover.mjs --ask "Is there a validation error under the email field?"
//
// Coordinate-system contract (the #1 historical failure when mixed):
//   --capture cdp    -> screenshot = viewport px  -> click via CDP Input.dispatchMouseEvent
//   --capture ffmpeg -> screenshot = X display px -> click via xdotool inside the container
//
// Exit codes: 0 ok / progressed, 1 qwen or capture error, 3 clicked but state did not change.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const JH = process.env.JOBHUNTER_HOME || `${process.env.HOME}/.job-hunter`;
const CDP_PORT = Number(process.env.BROWSER_CDP_PORT || 9225);
const CONTAINER = process.env.SELENIUM_CONTAINER || 'selenium-chromium';
const ENDPOINT = process.env.QWEN_VLM_ENDPOINT || 'http://localhost:1234/v1/chat/completions';
const MODEL = process.env.QWEN_VLM_MODEL || 'qwen3.6-35b-a3b-holo3-qwopus-instruct-qx64-hi-mlx';

const args = process.argv.slice(2);
const opt = { capture: 'cdp', click: false, prompt: null, urlSubstr: null, tabId: null };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--capture') opt.capture = args[++i];
  else if (a === '--click') opt.click = true;
  else if (a === '--prompt' || a === '--ask') opt.prompt = args[++i];
  else if (a === '--url-substr') opt.urlSubstr = args[++i];
  else if (a === '--tab-id') opt.tabId = args[++i];
  else if (a === '--cdp-port') { /* override */ }
}

const stamp = Date.now();
const shot = (n) => `/tmp/visual-recover-${stamp}-${n}.png`;

// ---------- capture ----------
function httpJson(port, p) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'GET' }, (res) => {
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.end();
  });
}

let WebSocketImpl = globalThis.WebSocket;
if (!WebSocketImpl) {
  try { WebSocketImpl = createRequire(path.join(JH, 'package.json'))('ws'); } catch { /* noop */ }
}

async function cdpSession() {
  const tabs = await httpJson(CDP_PORT, '/json');
  const pages = tabs.filter((t) => t.type === 'page');
  let tab = opt.tabId ? pages.find((t) => t.id === opt.tabId) : null;
  if (!tab && opt.urlSubstr) tab = pages.find((t) => (t.url || '').includes(opt.urlSubstr));
  if (!tab) tab = pages[0];
  if (!tab) throw new Error('no CDP page tab found');
  const ws = new WebSocketImpl(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data.toString());
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
  };
  const send = (method, params = {}) => new Promise((res, rej) => { const mid = ++id; pending.set(mid, { res, rej }); ws.send(JSON.stringify({ id: mid, method, params })); });
  return { send, close: () => ws.close(), url: tab.url };
}

async function captureCdp(session, file) {
  const r = await session.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
}

function captureFfmpeg(file) {
  execFileSync('docker', ['exec', CONTAINER, 'sh', '-lc',
    `ffmpeg -y -f x11grab -video_size 1920x1080 -i :99.0 -frames:v 1 /tmp/vr.png >/tmp/vr-ffmpeg.log 2>&1`]);
  execFileSync('docker', ['cp', `${CONTAINER}:/tmp/vr.png`, file]);
}

// ---------- qwen ----------
async function askQwen(imageFile, prompt, wantJson = false) {
  const b64 = fs.readFileSync(imageFile).toString('base64');
  const body = {
    model: MODEL,
    messages: [{ role: 'user', content: [
      { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
      { type: 'text', text: prompt },
    ] }],
    max_tokens: Number(process.env.QWEN_VLM_MAX_TOKENS || 400),
    temperature: 0.1,
  };
  const res = await fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`Qwen VLM HTTP ${res.status}: ${text.slice(0, 500)}`);
  const content = JSON.parse(text).choices?.[0]?.message?.content ?? '';
  if (!wantJson) return content;
  const m = content.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`Qwen did not return JSON: ${content.slice(0, 300)}`);
  return JSON.parse(m[0]);
}

const INSPECT_PROMPT = opt.prompt ||
  'Inspect this browser screenshot from a stuck automation flow (a click, form fill, or submit did not visibly progress). Report: (1) what state is visibly shown, (2) any error/validation text verbatim, (3) whether the intended action appears complete, (4) the next visible button or control to click to make progress, if any.';

const CLICK_PROMPT = (base) =>
  `${base}\n\nThe screenshot is ${opt.capture === 'ffmpeg' ? '1920x1080 (full display)' : 'the browser viewport'}. ` +
  'Respond ONLY with strict JSON: {"state": "<one line>", "action_needed": true|false, "label": "<control label or null>", "x": <int center x>, "y": <int center y>}. ' +
  'If no click is needed or no control is visible, use action_needed=false and x=y=0.';

// ---------- main ----------
try {
  let session = null;
  const capture = async (file) => {
    if (opt.capture === 'ffmpeg') return captureFfmpeg(file);
    if (!session) session = await cdpSession();
    return captureCdp(session, file);
  };

  await capture(shot(1));
  console.log(`screenshot: ${shot(1)}${session ? `  (tab: ${session.url.slice(0, 90)})` : ''}`);

  if (!opt.click) {
    const answer = await askQwen(shot(1), INSPECT_PROMPT);
    console.log('\n--- Qwen inspection ---\n' + answer);
    session?.close();
    process.exit(0);
  }

  // click mode
  const plan = await askQwen(shot(1), CLICK_PROMPT(opt.prompt || 'Identify the next control to click to make this stuck flow progress (dismiss modal/alert, press Next/Submit/Continue/OK, close overlay).'), true);
  console.log(`\nQwen: ${JSON.stringify(plan)}`);
  if (!plan.action_needed) { console.log('No click needed per Qwen — inspect output above and handle in DOM.'); session?.close(); process.exit(0); }

  if (opt.capture === 'ffmpeg') {
    execFileSync('docker', ['exec', CONTAINER, 'sh', '-lc', `DISPLAY=:99.0 xdotool mousemove ${plan.x} ${plan.y} click 1`]);
    console.log(`xdotool click at ${plan.x},${plan.y} ("${plan.label}")`);
  } else {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await session.send('Input.dispatchMouseEvent', { type, x: plan.x, y: plan.y, button: 'left', clickCount: 1 });
    }
    console.log(`CDP click at ${plan.x},${plan.y} ("${plan.label}")`);
  }

  await new Promise((r) => setTimeout(r, 2500));
  await capture(shot(2));
  const verify = await askQwen(shot(2),
    `Compare with the previous state: the automation just clicked "${plan.label}" at ${plan.x},${plan.y}. ` +
    'Respond ONLY with strict JSON: {"changed": true|false, "state": "<one line describing the current visible state>"}.', true);
  console.log(`verify: ${JSON.stringify(verify)}  (screenshot: ${shot(2)})`);
  session?.close();
  process.exit(verify.changed ? 0 : 3);
} catch (err) {
  console.error(`visual-recover error: ${err.message}`);
  process.exit(1);
}
