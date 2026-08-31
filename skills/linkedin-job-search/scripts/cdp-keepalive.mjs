function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function startCdpKeepAlive(client, options = {}) {
  const intervalMs = Math.max(0, Number(options.intervalMs ?? 15000));
  const timeoutMs = Math.max(1000, Number(options.timeoutMs ?? 5000));
  const label = options.label || 'CDP';
  const stats = { sent: 0, failed: 0, lastSuccessAt: null, lastError: null };
  let stopped = false;
  let busy = false;
  let timer = null;

  const beat = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      await withTimeout(client.send('Browser.getVersion', {}), timeoutMs, `${label} keepalive`);
      stats.sent++;
      stats.lastSuccessAt = new Date().toISOString();
      stats.lastError = null;
    } catch (error) {
      stats.failed++;
      stats.lastError = error?.message || String(error);
      options.onFailure?.(error, { ...stats });
    } finally {
      busy = false;
    }
  };

  if (intervalMs > 0) {
    void beat();
    timer = setInterval(() => { void beat(); }, intervalMs);
    timer.unref?.();
    options.onStart?.({ intervalMs, timeoutMs });
  }

  return {
    stats,
    async beat() { await beat(); },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
