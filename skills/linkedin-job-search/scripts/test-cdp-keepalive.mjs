#!/usr/bin/env node
import assert from 'node:assert/strict';
import { startCdpKeepAlive } from './cdp-keepalive.mjs';

const calls = [];
const client = {
  async send(method, params) {
    calls.push({ method, params });
    return { product: 'SyntheticBrowser/1.0' };
  },
};

const keepAlive = startCdpKeepAlive(client, { intervalMs: 20, timeoutMs: 100 });
await new Promise((resolve) => setTimeout(resolve, 75));
keepAlive.stop();
const stoppedAt = calls.length;
await new Promise((resolve) => setTimeout(resolve, 45));

assert.ok(stoppedAt >= 3, `expected at least 3 heartbeat calls, got ${stoppedAt}`);
assert.equal(calls.length, stoppedAt, 'stop must prevent later heartbeat calls');
assert.ok(calls.every((call) => call.method === 'Browser.getVersion'));
assert.equal(keepAlive.stats.failed, 0);
console.log('cdp-keepalive tests: PASS');
