#!/usr/bin/env node
/**
 * Unit tests for target-registry.mjs — pure module, no CDP/browser/network.
 */
import assert from 'node:assert/strict';
import { createTargetRegistry, createCleanup } from './target-registry.mjs';

// ── Helpers ──────────────────────────────────────────────────────────
function fakeClient() {
  const closed = [];
  const calls = [];
  let disconnected = false;
  return {
    closed,
    calls,
    async send(method, params) {
      if (disconnected) throw new Error('WebSocket is not open');
      calls.push({ method, params });
      return {};
    },
    disconnect() { disconnected = true; },
  };
}

// ── Registry: register/unregister owned ──────────────────────────────
{
  const reg = createTargetRegistry();
  assert.deepStrictEqual(reg.getOwned(), [], 'no owned targets initially');

  reg.registerOwned('t1', 'search page');
  reg.registerOwned('t2', 'detail page');
  assert.deepStrictEqual(reg.getOwned().sort(), ['t1', 't2'], 'two owned registered');

  reg.unregister('t1');
  assert.deepStrictEqual(reg.getOwned(), ['t2'], 'unregister removes owned');
}

// ── Registry: register/unregister borrowed ───────────────────────────
{
  const reg = createTargetRegistry();
  reg.registerBorrowed('tab-1');
  reg.registerBorrowed('tab-2');
  assert.deepStrictEqual(reg.getBorrowed().sort(), ['tab-1', 'tab-2'], 'two borrowed');

  reg.unregister('tab-1');
  assert.deepStrictEqual(reg.getBorrowed(), ['tab-2'], 'unregister removes borrowed');
}

// ── Registry: isOwned / isBorrowed ───────────────────────────────────
{
  const reg = createTargetRegistry();
  reg.registerOwned('a');
  reg.registerBorrowed('b');
  assert.equal(reg.isOwned('a'), true);
  assert.equal(reg.isOwned('b'), false);
  assert.equal(reg.isBorrowed('b'), true);
  assert.equal(reg.isBorrowed('a'), false);
  assert.equal(reg.isOwned('unknown'), false);
  assert.equal(reg.isBorrowed('unknown'), false);
}

// ── Registry: null/undefined targetId is a no-op ─────────────────────
{
  const reg = createTargetRegistry();
  reg.registerOwned(null);
  reg.registerOwned(undefined);
  reg.registerBorrowed(null);
  assert.deepStrictEqual(reg.getOwned(), []);
  assert.deepStrictEqual(reg.getBorrowed(), []);
}

// ── Cleanup: owned targets are closed ────────────────────────────────
{
  const reg = createTargetRegistry();
  reg.registerOwned('to-close-1');
  reg.registerOwned('to-close-2');
  reg.registerBorrowed('keep-me');

  const client = fakeClient();
  const cleanup = createCleanup({ registry: reg, client });

  await cleanup();

  // Verify owned targets were closed via CDP
  const closeCalls = client.calls.filter((c) => c.method === 'Target.closeTarget');
  assert.equal(closeCalls.length, 2, 'two closeTarget calls');
  const closedIds = closeCalls.map((c) => c.params.targetId).sort();
  assert.deepStrictEqual(closedIds, ['to-close-1', 'to-close-2'], 'owned targets closed');

  // Borrowed target was never touched
  assert.deepStrictEqual(reg.getBorrowed(), ['keep-me'], 'borrowed target preserved');
  assert.deepStrictEqual(reg.getOwned(), [], 'owned targets drained after cleanup');
}

// ── Cleanup: idempotent — second call is a no-op ─────────────────────
{
  const reg = createTargetRegistry();
  reg.registerOwned('once');

  const client = fakeClient();
  const cleanup = createCleanup({ registry: reg, client });

  await cleanup();
  assert.equal(client.calls.length, 1, 'one call on first cleanup');

  // Second call — should be a no-op
  await cleanup();
  assert.equal(client.calls.length, 1, 'no extra calls on second cleanup (idempotent)');
}

// ── Cleanup: swallows "browser already gone" errors ──────────────────
{
  const reg = createTargetRegistry();
  reg.registerOwned('ghost');

  const client = fakeClient();
  client.disconnect(); // simulate dead browser

  const cleanup = createCleanup({ registry: reg, client });

  // Must not throw
  await cleanup();
  // Registry still drains
  assert.deepStrictEqual(reg.getOwned(), [], 'owned drained even when browser is gone');
}

// ── Cleanup: keepalive stop invoked ──────────────────────────────────
{
  const reg = createTargetRegistry();
  let keepaliveStopped = false;
  const stopKeepalive = () => { keepaliveStopped = true; };

  const cleanup = createCleanup({ registry: reg, stopKeepalive });
  await cleanup();
  assert.equal(keepaliveStopped, true, 'keepalive stop was called');
}

// ── Cleanup: client close invoked ────────────────────────────────────
{
  const reg = createTargetRegistry();
  let clientClosed = false;
  const closeClient = () => { clientClosed = true; };

  const cleanup = createCleanup({ registry: reg, closeClient });
  await cleanup();
  assert.equal(clientClosed, true, 'client close was called');
}

// ── Cleanup: handles missing client/stop/close gracefully ────────────
{
  const reg = createTargetRegistry();
  reg.registerOwned('orphan');

  // No client provided — cleanup must still work (best-effort, no throw).
  // Owned targets remain in registry because CDP closure is unavailable.
  const cleanup = createCleanup({ registry: reg });
  await cleanup();
  assert.deepStrictEqual(reg.getOwned(), ['orphan'], 'owned remains when no client available');
}

// ── Cleanup: partial failure in one target does not block others ─────
{
  const reg = createTargetRegistry();
  reg.registerOwned('ok');
  reg.registerOwned('bad');
  reg.registerOwned('also-ok');

  // Client that fails for 'bad' but succeeds for others
  const client = {
    closed: [],
    calls: [],
    async send(method, params) {
      this.calls.push({ method, params });
      if (params.targetId === 'bad') throw new Error('Target not found');
    },
  };
  const cleanup = createCleanup({ registry: reg, client });
  await cleanup();

  const closedIds = client.calls
    .filter((c) => c.method === 'Target.closeTarget')
    .map((c) => c.params.targetId)
    .sort();
  assert.deepStrictEqual(closedIds, ['also-ok', 'bad', 'ok'], 'all three targets attempted');
  assert.deepStrictEqual(reg.getOwned(), [], 'all owned drained');
}

console.log('target-lifecycle tests: PASS');
