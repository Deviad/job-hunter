#!/usr/bin/env node
import { WebSocketServer } from '../../job-hunter/scripts/workspace-dependencies.mjs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';

const DEFAULT_PORT = 9223;
const DEFAULT_BRAVE = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const DEFAULT_USER_DATA = `${homedir()}/Library/Application Support/Brave Software/Brave-Browser`;

function parseArgs(argv) {
  const opts = {
    port: parseInt(process.env.BRAVE_PROXY_PORT, 10) || DEFAULT_PORT,
    bravePath: process.env.BRAVE_PATH || DEFAULT_BRAVE,
    userDataDir: process.env.BRAVE_USER_DATA || DEFAULT_USER_DATA,
    profileDirectory: null,
    launchBrave: true,
    extraArgs: [],
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new Error(`Missing value for ${a}`); return argv[++i]; };
    if (a === '--port') opts.port = parseInt(next(), 10);
    else if (a === '--brave-path') opts.bravePath = next();
    else if (a === '--user-data-dir') opts.userDataDir = next();
    else if (a === '--profile-directory') opts.profileDirectory = next();
    else if (a === '--no-launch') opts.launchBrave = false;
    else if (a === '--verbose' || a === '-v') opts.verbose = true;
    else if (a.startsWith('--')) opts.extraArgs.push(a);
    else throw new Error(`Unknown option: ${a}`);
  }
  return opts;
}

function log(...args) {
  console.error('[brave-cdp-proxy]', ...args);
}

let braveProcess = null;
let pipeBuffer = Buffer.alloc(0);
const pending = new Map();
let proxyIdCounter = 0;
let targetCache = [];
let versionCache = null;

const wsSessions = new Map();

function sendToPipe(msg) {
  if (!braveProcess || !braveProcess.stdin.writable) {
    throw new Error('Brave pipe not available');
  }
  const json = JSON.stringify(msg);
  const byteLen = Buffer.byteLength(json);
  const buf = Buffer.alloc(4 + byteLen);
  buf.writeUInt32BE(byteLen, 0);
  buf.write(json, 4);
  braveProcess.stdin.write(buf);
}

function cdpCall(method, params = {}) {
  const id = --proxyIdCounter;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP ${method} timed out after 8s`));
    }, 8000);
    pending.set(id, { resolve, reject, timer });
    try {
      sendToPipe({ id, method, params });
    } catch (e) {
      clearTimeout(timer);
      pending.delete(id);
      reject(e);
    }
  });
}

function processPipeMessage(parsed) {
  const id = parsed.id;

  if (id !== undefined && pending.has(id)) {
    const entry = pending.get(id);
    clearTimeout(entry.timer);
    pending.delete(id);
    entry.resolve(parsed);
    return;
  }

  const msgSessionId = parsed.sessionId;

  if (parsed.method === 'Target.targetCreated' && parsed.params?.targetInfo) {
    updateTarget(parsed.params.targetInfo);
  } else if (parsed.method === 'Target.targetDestroyed' && parsed.params?.targetId) {
    removeTarget(parsed.params.targetId);
  } else if (parsed.method === 'Target.attachedToTarget' && parsed.params?.targetInfo) {
    updateTarget(parsed.params.targetInfo);
  } else if (parsed.method === 'Target.detachedFromTarget' && parsed.params?.targetId) {
    removeTarget(parsed.params.targetId);
    const entry = findWsBySessionId(parsed.params.sessionId);
    if (entry) {
      delete wsSessions[entry.ws._sessionId];
      entry.ws._sessionId = null;
    }
  } else if (parsed.method === 'Target.targetInfoChanged' && parsed.params?.targetInfo) {
    updateTarget(parsed.params.targetInfo);
  }

  if (msgSessionId) {
    const entry = findWsBySessionId(msgSessionId);
    if (entry) {
      const fwd = { ...parsed };
      delete fwd.sessionId;
      entry.ws.send(JSON.stringify(fwd));
      return;
    }
  }

  for (const [_, entry] of wsSessions) {
    if (entry.ws.readyState === 1) {
      entry.ws.send(JSON.stringify(parsed));
    }
  }
}

function findWsBySessionId(sessionId) {
  for (const [_, entry] of wsSessions) {
    if (entry.sessionId === sessionId) return entry;
  }
  return null;
}

function updateTarget(info) {
  const idx = targetCache.findIndex((t) => t.id === info.targetId);
  const entry = {
    id: info.targetId,
    type: info.type,
    title: info.title || '',
    url: info.url || '',
    webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${info.targetId}`,
  };
  if (idx >= 0) targetCache[idx] = entry;
  else targetCache.push(entry);
}

function removeTarget(targetId) {
  targetCache = targetCache.filter((t) => t.id !== targetId);
}

function onPipeData(chunk) {
  pipeBuffer = Buffer.concat([pipeBuffer, chunk]);
  while (pipeBuffer.length >= 4) {
    const len = pipeBuffer.readUInt32BE(0);
    if (pipeBuffer.length < 4 + len) break;
    const msgStr = pipeBuffer.slice(4, 4 + len).toString('utf8');
    pipeBuffer = pipeBuffer.slice(4 + len);
    try {
      const parsed = JSON.parse(msgStr);
      processPipeMessage(parsed);
    } catch {}
  }
}

function launchBrave(opts) {
  const args = [
    `--remote-debugging-pipe`,
    `--user-data-dir=${opts.userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    ...opts.extraArgs,
  ];
  if (opts.profileDirectory) {
    args.push(`--profile-directory=${opts.profileDirectory}`);
  }

  log(`Launching Brave with --remote-debugging-pipe`);
  if (opts.verbose) log(`  ${opts.bravePath} ${args.join(' ')}`);

  braveProcess = spawn(opts.bravePath, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  braveProcess.stdout.on('data', onPipeData);
  braveProcess.stderr.on('data', () => {});

  braveProcess.on('exit', (code, signal) => {
    log(`Brave exited (code=${code}, signal=${signal})`);
    braveProcess = null;
    for (const [_, entry] of wsSessions) {
      try { entry.ws.close(1011, 'Brave process exited'); } catch {}
    }
    wsSessions.clear();
    process.exit(code || 0);
  });

  braveProcess.on('error', (err) => {
    log(`Failed to launch Brave: ${err.message}`);
    process.exit(1);
  });

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      log('Brave started (continuing)');
      resolve();
    }, 4000);
    const check = () => {
      if (versionCache || !braveProcess) {
        clearTimeout(timeout);
        resolve();
        return;
      }
      setTimeout(check, 100);
    };
    check();
  });
}

async function getTargets() {
  try {
    const result = await cdpCall('Target.getTargets');
    if (result.result?.targetInfos) {
      for (const info of result.result.targetInfos) {
        updateTarget(info);
      }
    }
  } catch (e) {
    log(`Warning: Target.getTargets failed: ${e.message}`);
  }
}

function createHttpServer(port) {
  const server = createServer((req, res) => {
    const respond = (code, data) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };

    if (req.url === '/json/version' || req.url === '/json/version/') {
      respond(200, {
        Browser: 'Brave (pipe-proxy)',
        'Protocol-Version': '1.3',
        'User-Agent': 'Brave',
        'V8-Version': '',
        'WebKit-Version': '',
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser`,
      });
    } else if (req.url === '/json/list' || req.url === '/json/list/') {
      getTargets().then(() => {
        respond(200, targetCache);
      }).catch((err) => {
        respond(500, { error: err.message });
      });
    } else {
      respond(404, { error: 'Not found' });
    }
  });

  return server;
}

async function handleWsConnection(ws, req, port) {
  const path = req.url || '/';
  const pageMatch = path.match(/^\/devtools\/page\/(.+)/);
  const key = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  ws._sessionId = null;
  ws._targetId = null;

  wsSessions.set(key, { ws, sessionId: null, targetId: null });
  log(`WebSocket client connected (path: ${path})`);

  if (pageMatch) {
    const targetId = pageMatch[1];
    ws._targetId = targetId;
    try {
      const result = await cdpCall('Target.attachToTarget', { targetId, flatten: true });
      const sessionId = result.result?.sessionId;
      if (sessionId) {
        ws._sessionId = sessionId;
        const entry = wsSessions.get(key);
        if (entry) entry.sessionId = sessionId;
        log(`Auto-attached to target ${targetId} (session: ${sessionId})`);
      }
    } catch (e) {
      log(`Auto-attach failed for ${targetId}: ${e.message}`);
      ws.send(JSON.stringify({ error: `Auto-attach failed: ${e.message}` }));
    }
  }

  ws.on('message', (data) => {
    if (!braveProcess) {
      ws.send(JSON.stringify({ error: 'Brave not running' }));
      return;
    }
    try {
      let msgStr = data.toString();
      if (ws._sessionId) {
        const msg = JSON.parse(msgStr);
        if (!msg.sessionId) {
          msg.sessionId = ws._sessionId;
        }
        msgStr = JSON.stringify(msg);
      }
      braveProcess.stdin.write(msgStr);
    } catch (e) {
      ws.send(JSON.stringify({ error: e.message }));
    }
  });

  ws.on('close', () => {
    log('WebSocket client disconnected');
    if (ws._sessionId) {
      cdpCall('Target.detachFromTarget', { sessionId: ws._sessionId }).catch(() => {});
    }
    wsSessions.delete(key);
  });

  ws.on('error', () => {
    wsSessions.delete(key);
  });
}

function createWebSocketServer(server, port) {
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws, req) => {
    handleWsConnection(ws, req, port);
  });
  return wss;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const port = opts.port;

  if (opts.launchBrave) {
    if (!existsSync(opts.bravePath)) {
      log(`Brave not found at ${opts.bravePath}. Set BRAVE_PATH or use --brave-path`);
      process.exit(1);
    }
    if (!existsSync(opts.userDataDir)) {
      log(`User data dir not found at ${opts.userDataDir}. Creating it.`);
      mkdirSync(opts.userDataDir, { recursive: true });
    }
    await launchBrave(opts);
  } else {
    log(`--no-launch: expecting existing Brave with --remote-debugging-pipe`);
  }

  const httpServer = createHttpServer(port);
  createWebSocketServer(httpServer, port);

  httpServer.listen(port, '127.0.0.1', () => {
    log(`Proxy listening on http://127.0.0.1:${port}`);
    log(`WebSocket endpoints available at ws://127.0.0.1:${port}/devtools/browser`);
    log(`Tab-specific at ws://127.0.0.1:${port}/devtools/page/<id>`);
  });

  const shutdown = () => {
    log('Shutting down...');
    if (braveProcess) braveProcess.kill();
    httpServer.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[brave-cdp-proxy] Fatal:', err.message);
  process.exit(1);
});
