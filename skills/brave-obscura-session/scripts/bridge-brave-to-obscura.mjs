#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const DEFAULT_BRAVE_PORT = 9223;
const DEFAULT_OBSCURA_PORT = parsePort(process.env.OBSCURA_CDP_PORT || process.env.OBSCURA_PORT, 9222);
const COMMON_OBSCURA_PORTS = [9222, 9225, 9224, 9226, 9227, 9228, 9230];
const DEFAULT_BRAVE_APP = 'Brave Browser';
const DEFAULT_LAUNCH_TIMEOUT_MS = 20000;
const REQUEST_TIMEOUT_MS = 15000;

function usage(exitCode = 0) {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(`Brave → Obscura CDP session bridge\n\n`);
  stream.write(`Usage:\n`);
  stream.write(`  bridge-brave-to-obscura.mjs --url <url> [options]\n\n`);
  stream.write(`Options:\n`);
  stream.write(`  --url <url>              Site URL/origin to copy session for (required)\n`);
  stream.write(`  --brave-port <port>      Brave CDP port (default: ${DEFAULT_BRAVE_PORT})\n`);
  stream.write(`  --obscura-port <port>    Obscura CDP port to use/check (default: ${DEFAULT_OBSCURA_PORT}; auto-detects common running ports)\n`);
  stream.write(`  --launch-brave           Launch Brave with local CDP if port is not reachable\n`);
  stream.write(`  --brave-app <name>       macOS Brave app name for --launch-brave (default: ${DEFAULT_BRAVE_APP})\n`);
  stream.write(`  --launch-timeout <ms>    Wait for launched Brave CDP (default: ${DEFAULT_LAUNCH_TIMEOUT_MS})\n`);
  stream.write(`  --include-storage        Also copy localStorage and sessionStorage from Brave\n`);
  stream.write(`  --inject                 Inject copied cookies/localStorage into Obscura CDP\n`);
  stream.write(`  --out <path>             Secret export path (default: /tmp/brave-obscura-session-<host>-<ts>.json)\n`);
  stream.write(`  --no-open-brave-tab      Do not open a Brave tab if no matching target exists\n`);
  stream.write(`  --verbose                Print non-secret diagnostics, including cookie/key names\n`);
  stream.write(`  -h, --help               Show this help\n\n`);
  stream.write(`Security:\n`);
  stream.write(`  Secret values are written only to --out with chmod 0600. They are not printed.\n`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const opts = {
    bravePort: DEFAULT_BRAVE_PORT,
    obscuraPort: DEFAULT_OBSCURA_PORT,
    obscuraPortExplicit: false,
    includeStorage: false,
    inject: false,
    openBraveTab: true,
    launchBrave: false,
    braveApp: DEFAULT_BRAVE_APP,
    launchTimeoutMs: DEFAULT_LAUNCH_TIMEOUT_MS,
    verbose: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[++i];
    };
    if (arg === '--url') opts.url = next();
    else if (arg === '--brave-port') opts.bravePort = Number(next());
    else if (arg === '--obscura-port') {
      opts.obscuraPort = Number(next());
      opts.obscuraPortExplicit = true;
    }
    else if (arg === '--launch-brave') opts.launchBrave = true;
    else if (arg === '--brave-app') opts.braveApp = next();
    else if (arg === '--launch-timeout') opts.launchTimeoutMs = Number(next());
    else if (arg === '--include-storage') opts.includeStorage = true;
    else if (arg === '--inject') opts.inject = true;
    else if (arg === '--out') opts.out = next();
    else if (arg === '--no-open-brave-tab') opts.openBraveTab = false;
    else if (arg === '--verbose') opts.verbose = true;
    else if (arg === '-h' || arg === '--help') usage(0);
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!opts.url) throw new Error('--url is required');
  opts.url = new URL(opts.url).href;
  if (!Number.isInteger(opts.bravePort) || opts.bravePort <= 0) throw new Error('Invalid --brave-port');
  if (!Number.isInteger(opts.obscuraPort) || opts.obscuraPort <= 0) throw new Error('Invalid --obscura-port');
  if (!Number.isFinite(opts.launchTimeoutMs) || opts.launchTimeoutMs < 1000) throw new Error('Invalid --launch-timeout');
  if (!opts.braveApp || typeof opts.braveApp !== 'string') throw new Error('Invalid --brave-app');
  if (!opts.out) {
    const u = new URL(opts.url);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    opts.out = join('/tmp', `brave-obscura-session-${u.hostname}-${stamp}.json`);
  }
  return opts;
}

function parsePort(value, fallback) {
  const port = Number.parseInt(value, 10);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : fallback;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function candidateObscuraPorts(preferred) {
  return unique([
    preferred,
    process.env.OBSCURA_CDP_PORT,
    process.env.OBSCURA_PORT,
    DEFAULT_OBSCURA_PORT,
    ...COMMON_OBSCURA_PORTS,
  ].map((value) => parsePort(value, null)).filter(Boolean));
}

function safeSummaryName(url) {
  const u = new URL(url);
  return `${u.origin}/`;
}

async function getBrowserWsUrl(port, label) {
  const endpoint = `http://127.0.0.1:${port}/json/version`;
  let res;
  try {
    res = await fetch(endpoint);
  } catch (error) {
    throw new Error(`${label} CDP is not reachable at ${endpoint}. Start ${label} with remote debugging enabled. (${error.message})`);
  }
  if (!res.ok) throw new Error(`${label} CDP ${endpoint} returned HTTP ${res.status}`);
  const data = await res.json();
  if (!data.webSocketDebuggerUrl) throw new Error(`${label} CDP did not return webSocketDebuggerUrl`);
  return data.webSocketDebuggerUrl;
}

async function tryGetBrowserWsUrl(port, label) {
  try {
    return await getBrowserWsUrl(port, label);
  } catch {
    return null;
  }
}

async function resolveObscuraPort(opts) {
  for (const port of candidateObscuraPorts(opts.obscuraPort)) {
    if (await tryGetBrowserWsUrl(port, 'Obscura')) {
      if (port !== opts.obscuraPort && opts.verbose) {
        console.error(`[diagnostic] Reusing existing Obscura/CDP browser on 127.0.0.1:${port} instead of ${opts.obscuraPort}`);
      }
      return port;
    }
  }
  const checked = candidateObscuraPorts(opts.obscuraPort).join(', ');
  throw new Error(`Obscura CDP is not reachable on checked port(s): ${checked}. Connect Obscura or pass --obscura-port for the existing instance.`);
}

function launchBraveWithCdp(opts) {
  if (process.platform !== 'darwin') {
    throw new Error('--launch-brave currently supports macOS via the CDP pipe proxy. Launch Brave manually via the sibling auto-job-application skill: node ../auto-job-application/scripts/brave-cdp-proxy.mjs --port ' + opts.bravePort);
  }

  // Resolve the sibling skill relative to this skill, so the skills directory can move between agents.
  const proxyScript = join(dirname(new URL(import.meta.url).pathname), '..', '..', 'auto-job-application', 'scripts', 'brave-cdp-proxy.mjs');

  // Try common proxy locations
  const proxyPaths = [
    proxyScript,
  ];

  const proxyPath = proxyPaths.find(p => {
    try { require('fs').accessSync(p); return true; } catch { return false; }
  });

  if (!proxyPath) {
    // Fallback to direct launch (warns about focus stealing)
    console.error('[WARN] CDP pipe proxy not found. Falling back to --remote-debugging-port (WILL steal macOS focus).');
    const args = [
      '-na', opts.braveApp,
      '--args',
      '--remote-debugging-address=127.0.0.1',
      `--remote-debugging-port=${opts.bravePort}`,
      '--no-first-run',
      opts.url,
    ];
    const child = spawn('open', args, { stdio: 'ignore', detached: true });
    child.unref();
    return;
  }

  console.error(`[brave-obscura-session] Launching Brave via CDP pipe proxy: ${proxyPath}`);
  const child = spawn('node', [proxyPath, '--port', String(opts.bravePort), '--verbose'], {
    stdio: ['ignore', 'inherit', 'inherit'],
    detached: true,
  });
  child.unref();
}

async function waitForBrowserWsUrl(port, label, timeoutMs) {
  const start = Date.now();
  let lastError = null;
  while (Date.now() - start < timeoutMs) {
    try {
      return await getBrowserWsUrl(port, label);
    } catch (error) {
      lastError = error;
      await delay(500);
    }
  }
  throw lastError || new Error(`${label} CDP did not become reachable on port ${port}`);
}

async function ensureBraveWsUrl(opts) {
  const existing = await tryGetBrowserWsUrl(opts.bravePort, 'Brave');
  if (existing) return { wsUrl: existing, launched: false };

  if (!opts.launchBrave) {
    return { wsUrl: await getBrowserWsUrl(opts.bravePort, 'Brave'), launched: false };
  }

  launchBraveWithCdp(opts);
  try {
    const wsUrl = await waitForBrowserWsUrl(opts.bravePort, 'Brave', opts.launchTimeoutMs);
    return { wsUrl, launched: true };
  } catch (error) {
    throw new Error(
      `Launched Brave CDP pipe proxy on 127.0.0.1:${opts.bravePort}, but the CDP endpoint did not become reachable. ` +
      `If Brave was already running, quit Brave fully and restart the pipe proxy from the skills directory: node auto-job-application/scripts/brave-cdp-proxy.mjs --port ${opts.bravePort}. ` +
      `Last error: ${error.message}`
    );
  }
}

class CdpClient {
  constructor(wsUrl, label) {
    this.wsUrl = wsUrl;
    this.label = label;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.label} WebSocket open timed out`)), REQUEST_TIMEOUT_MS);
      this.ws.onopen = () => { clearTimeout(timer); resolve(); };
      this.ws.onerror = () => { clearTimeout(timer); reject(new Error(`${this.label} WebSocket error`)); };
    });
    this.ws.onmessage = (event) => this.#handleMessage(event.data);
    this.ws.onclose = () => {
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error(`${this.label} CDP connection closed`));
      }
      this.pending.clear();
    };
  }

  #handleMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg.id) return;
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.error) {
      entry.reject(new Error(`${msg.error.message || 'CDP error'}${msg.error.data ? `: ${msg.error.data}` : ''}`));
    } else {
      entry.resolve(msg.result || {});
    }
  }

  send(method, params = {}, sessionId) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`${this.label} CDP socket is not open`);
    }
    const id = this.nextId++;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.label} ${method} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.ws.send(JSON.stringify(message));
    return promise;
  }

  close() {
    try { this.ws?.close(); } catch {}
  }
}

function sameOrigin(a, b) {
  try { return new URL(a).origin === new URL(b).origin; } catch { return false; }
}

async function attachPage(client, url, { openIfMissing = true, preferExisting = true } = {}) {
  const targets = (await client.send('Target.getTargets')).targetInfos || [];
  const pages = targets.filter((t) => t.type === 'page' && t.url && !t.url.startsWith('devtools://'));
  let target = preferExisting
    ? pages.find((t) => sameOrigin(t.url, url)) || pages.find((t) => t.url === url)
    : undefined;
  let created = false;

  if (!target) {
    if (!openIfMissing) {
      throw new Error(`No open page target for ${safeSummaryName(url)}`);
    }
    const result = await client.send('Target.createTarget', { url });
    target = { targetId: result.targetId, url };
    created = true;
    await delay(1500);
  }

  const attached = await client.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  const sessionId = attached.sessionId;
  await client.send('Runtime.enable', {}, sessionId).catch(() => {});
  await client.send('Network.enable', {}, sessionId).catch(() => {});
  await client.send('Page.enable', {}, sessionId).catch(() => {});

  if (!sameOrigin(target.url || '', url)) {
    await client.send('Page.navigate', { url }, sessionId).catch(() => {});
    await delay(2500);
  }

  return { targetId: target.targetId, sessionId, created };
}

function normalizeCookie(cookie, fallbackUrl) {
  const out = {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain || new URL(fallbackUrl).hostname,
    path: cookie.path || '/',
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
  };
  if (cookie.sameSite && ['Strict', 'Lax', 'None'].includes(cookie.sameSite)) out.sameSite = cookie.sameSite;
  if (Number.isFinite(cookie.expires) && cookie.expires > 0) out.expires = cookie.expires;
  return out;
}

async function extractStorage(client, sessionId) {
  const expression = `(() => {
    const copy = (store) => {
      const out = {};
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i);
        out[key] = store.getItem(key);
      }
      return out;
    };
    return { href: location.href, localStorage: copy(localStorage), sessionStorage: copy(sessionStorage) };
  })()`;
  const result = await client.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  }, sessionId);
  if (result.exceptionDetails) throw new Error('Runtime.evaluate failed while reading storage');
  return result.result?.value || { localStorage: {}, sessionStorage: {} };
}

function cookieParam(cookie, fallbackUrl) {
  const out = {
    name: cookie.name,
    value: cookie.value,
    url: fallbackUrl,
    domain: cookie.domain,
    path: cookie.path || '/',
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
  };
  if (cookie.sameSite && ['Strict', 'Lax', 'None'].includes(cookie.sameSite)) out.sameSite = cookie.sameSite;
  if (Number.isFinite(cookie.expires) && cookie.expires > 0) out.expires = cookie.expires;
  return out;
}

async function injectIntoObscura(port, url, secret, verbose) {
  const wsUrl = await getBrowserWsUrl(port, 'Obscura');
  const client = new CdpClient(wsUrl, 'Obscura');
  await client.connect();
  try {
    const page = await attachPage(client, url, { openIfMissing: true, preferExisting: false });
    const cookies = secret.cookies.map((c) => cookieParam(c, url));
    if (cookies.length > 0) {
      await client.send('Network.setCookies', { cookies }, page.sessionId);
    }

    await client.send('Page.navigate', { url }, page.sessionId).catch(() => {});
    await delay(2500);

    const localStorage = secret.localStorage || {};
    const sessionStorage = secret.sessionStorage || {};
    if (Object.keys(localStorage).length || Object.keys(sessionStorage).length) {
      const expression = `(() => {
        const local = ${JSON.stringify(localStorage)};
        const session = ${JSON.stringify(sessionStorage)};
        for (const [k, v] of Object.entries(local)) localStorage.setItem(k, String(v));
        for (const [k, v] of Object.entries(session)) sessionStorage.setItem(k, String(v));
        return { localStorageSet: Object.keys(local).length, sessionStorageSet: Object.keys(session).length };
      })()`;
      const result = await client.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      }, page.sessionId);
      if (result.exceptionDetails) throw new Error('Runtime.evaluate failed while injecting storage into Obscura');
      if (verbose) console.error(`[diagnostic] Obscura storage set: ${JSON.stringify(result.result?.value || {})}`);
      await client.send('Page.reload', { ignoreCache: true }, page.sessionId).catch(() => {});
      await delay(2000);
    }

    return {
      cdpPort: port,
      cookies: cookies.length,
      localStorage: Object.keys(localStorage).length,
      sessionStorage: Object.keys(sessionStorage).length,
    };
  } finally {
    client.close();
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const origin = new URL(opts.url).origin;

  const braveEndpoint = await ensureBraveWsUrl(opts);
  const brave = new CdpClient(braveEndpoint.wsUrl, 'Brave');
  await brave.connect();

  let secret;
  try {
    const page = await attachPage(brave, opts.url, { openIfMissing: opts.openBraveTab, preferExisting: true });
    const cookiesResult = await brave.send('Network.getCookies', { urls: [opts.url] }, page.sessionId);
    const cookies = (cookiesResult.cookies || []).map((c) => normalizeCookie(c, opts.url));
    const storage = opts.includeStorage ? await extractStorage(brave, page.sessionId) : { localStorage: {}, sessionStorage: {} };

    secret = {
      exportedAt: new Date().toISOString(),
      source: { browser: 'Brave', cdpPort: opts.bravePort },
      url: opts.url,
      origin,
      cookies,
      localStorage: storage.localStorage || {},
      sessionStorage: storage.sessionStorage || {},
    };
  } finally {
    brave.close();
  }

  mkdirSync(dirname(opts.out), { recursive: true });
  writeFileSync(opts.out, JSON.stringify(secret, null, 2));
  chmodSync(opts.out, 0o600);

  let injection = null;
  if (opts.inject) {
    opts.obscuraPort = await resolveObscuraPort(opts);
    injection = await injectIntoObscura(opts.obscuraPort, opts.url, secret, opts.verbose);
  }

  const summary = {
    ok: true,
    url: opts.url,
    origin,
    exportPath: opts.out,
    brave: {
      cdpPort: opts.bravePort,
      launched: braveEndpoint.launched,
      app: opts.launchBrave ? opts.braveApp : undefined,
    },
    exported: {
      cookies: secret.cookies.length,
      localStorageKeys: Object.keys(secret.localStorage).length,
      sessionStorageKeys: Object.keys(secret.sessionStorage).length,
    },
    injectedIntoObscura: injection,
    secretValuesPrinted: false,
    next: opts.inject
      ? 'Use Obscura MCP normally for this origin; cookies/localStorage were injected into the Obscura CDP browser.'
      : 'Run again with --inject to push this session into Obscura, or manually pass .cookies to Obscura one-shot calls without printing them.',
  };

  if (opts.verbose) {
    summary.names = {
      cookies: secret.cookies.map((c) => c.name),
      localStorage: Object.keys(secret.localStorage),
      sessionStorage: Object.keys(secret.sessionStorage),
    };
  }

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exit(1);
});
