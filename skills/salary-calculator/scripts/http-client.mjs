/**
 * HTTP Client with Per-Host Rate Limiting, Concurrency Control, and Retry Logic
 *
 * Provides a single HTTP client for all outbound requests with:
 * - Per-host token bucket rate limiting (configurable rps, default 0.5 = 2s between requests)
 * - Per-host FIFO semaphore for concurrency control (configurable, default 1 sequential)
 * - Automatic retry on 429, 5xx, and transient transport errors
 * - Retry-After header parsing (both delta-seconds and HTTP-date RFC 2822 formats)
 * - Exponential backoff with full jitter for retryable errors
 * - AbortSignal support with prompt rejection and no retry budget consumption
 * - Per-source limits override (configured at startup, sealed on first request per host)
 *
 * Main export: createHttpClient(options) → { get(url, opts), getJson(url, opts) }
 *
 * No external dependencies. Node.js 22+ only (uses native fetch, AbortController).
 * Contract enforcement (HTTP-01): focused HTTP client checks ensure
 * no source adapter calls global fetch() directly; all must use ctx.httpClient.get().
 */

/**
 * TokenBucket: Per-host rate limiting via token bucket algorithm
 *
 * Maintains a fixed number of tokens (burst capacity). On each consume(),
 * refills tokens at perHostRps rate, then blocks until sufficient tokens
 * are available.
 *
 * @example
 * const bucket = new TokenBucket({ perHostRps: 0.5, burst: 1 });
 * await bucket.consume(1); // Waits 2s if empty (0.5 rps = 2s per token)
 */
export class TokenBucket {
  /**
   * Create a token bucket with specified rate limit.
   *
   * @param {Object} options - Configuration
   * @param {number} options.perHostRps - Tokens per second (default 0.5 = 2s between requests)
   * @param {number} options.burst - Max token capacity (default 1)
   */
  constructor({ perHostRps = 0.5, burst = 1 } = {}) {
    this.perHostRps = perHostRps;
    this.burst = burst;
    this.tokens = burst; // Start with full capacity
    this.lastRefill = Date.now();
  }

  /**
   * Internal: Refill tokens based on elapsed time since last refill.
   * Tokens are capped at burst capacity.
   */
  refill() {
    const now = Date.now();
    const elapsedSeconds = (now - this.lastRefill) / 1000;
    const tokensToAdd = elapsedSeconds * this.perHostRps;
    this.tokens = Math.min(this.burst, this.tokens + tokensToAdd);
    this.lastRefill = now;
  }

  /**
   * Consume one or more tokens, blocking until available.
   *
   * If insufficient tokens, sleeps until the required tokens are available
   * at the configured perHostRps rate, then decrements and returns.
   *
   * Honors an optional AbortSignal: if signal aborts mid-wait the throttle
   * sleep rejects with AbortError and tokens are NOT decremented.
   *
   * @param {number} count - Number of tokens to consume (default 1)
   * @param {Object} [options] - Options
   * @param {AbortSignal} [options.signal] - Optional abort signal — when aborted,
   *   the throttle-wait rejects promptly with AbortError and no token is consumed.
   */
  async consume(count = 1, { signal } = {}) {
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    }
    this.refill();
    while (this.tokens < count) {
      const deficit = count - this.tokens;
      const waitMs = (deficit / this.perHostRps) * 1000;
      // eslint-disable-next-line no-await-in-loop
      await abortableSleep(waitMs, signal);
      this.refill();
    }
    this.tokens -= count;
  }
}

/**
 * PerHostSemaphore: FIFO concurrency control per host
 *
 * Maintains a queue of pending requests. When inFlight < maxConcurrent,
 * acquire() resolves immediately; otherwise, it waits in a FIFO queue.
 *
 * @example
 * const sem = new PerHostSemaphore({ maxConcurrent: 2 });
 * const release = await sem.acquire();
 * try {
 *   // Do work
 * } finally {
 *   release();
 * }
 */
export class PerHostSemaphore {
  /**
   * Create a semaphore with maximum concurrent acquisitions.
   *
   * @param {Object} options - Configuration
   * @param {number} options.maxConcurrent - Max in-flight requests (default 1)
   */
  constructor({ maxConcurrent = 1 } = {}) {
    this.maxConcurrent = maxConcurrent;
    this.inFlight = 0;
    this.queue = []; // Array of { resolve, reject }
  }

  /**
   * Acquire a slot. Returns a release function to call when done.
   *
   * If inFlight < maxConcurrent, returns immediately.
   * Otherwise, waits in FIFO queue until a slot becomes available.
   *
   * @returns {Promise<Function>} A release function to call when done with the slot
   */
  async acquire() {
    if (this.inFlight < this.maxConcurrent) {
      this.inFlight++;
      // Return a release function that decrements and unblocks next waiter
      return () => {
        this.release();
      };
    }

    // Queue this request and wait for its turn
    return new Promise((resolve) => {
      this.queue.push({
        resolve: () => {
          resolve(() => {
            this.release();
          });
        },
      });
    });
  }

  /**
   * Internal: Release a slot and unblock the next waiter (if any).
   */
  release() {
    this.inFlight--;
    const next = this.queue.shift();
    if (next) {
      this.inFlight++;
      next.resolve();
    }
  }
}

/**
 * Calculate exponential backoff delay with full jitter.
 *
 * Formula: delay = random([0, min(baseMs * 2^(attemptNumber - 1), maxMs)])
 *
 * Full jitter means the entire calculated delay is randomized, not just added
 * as a random amount on top of a fixed base. This prevents thundering herds
 * when many clients retry simultaneously.
 *
 * @param {number} attemptNumber - 1-indexed attempt number (first retry = 1)
 * @param {Object} options - Configuration
 * @param {number} options.baseDelayMs - Base delay in milliseconds (default 500)
 * @param {number} options.maxDelayMs - Maximum delay cap (default 30000)
 * @returns {number} Delay in milliseconds, randomized in [0, capped exponential)
 *
 * @example
 * const delay = calculateBackoffMs(1); // [0, 500)
 * const delay = calculateBackoffMs(2); // [0, 1000)
 * const delay = calculateBackoffMs(3); // [0, 2000)
 */
export function calculateBackoffMs(
  attemptNumber,
  { baseDelayMs = 500, maxDelayMs = 30000 } = {}
) {
  if (attemptNumber < 1) return 0;
  const exponential = baseDelayMs * Math.pow(2, attemptNumber - 1);
  const capped = Math.min(exponential, maxDelayMs);
  return Math.random() * capped;
}

/**
 * Parse Retry-After header (both delta-seconds and HTTP-date formats).
 *
 * RFC 7231 Retry-After can be either:
 * - Delta-seconds: "5" meaning 5 seconds
 * - HTTP-date: "Wed, 21 Oct 2026 07:28:00 GMT" meaning that specific time
 *
 * Returns an object { delayMs, exceededCap } if valid; null if unparseable.
 * If the calculated or server-stated delay exceeds maxDelayMs, sets exceededCap=true
 * to signal that the caller should sleep this long then stop retrying.
 *
 * @param {string|null|undefined} headerValue - The Retry-After header value
 * @param {Object} options - Configuration
 * @param {number} options.maxDelayMs - Maximum acceptable delay (default 30000)
 * @returns {Object|null} { delayMs: number, exceededCap: boolean } or null if unparseable
 *
 * @example
 * parseRetryAfterMs('5') // => { delayMs: 5000, exceededCap: false }
 * parseRetryAfterMs('120', { maxDelayMs: 30000 }) // => { delayMs: 120000, exceededCap: true }
 * parseRetryAfterMs('Wed, 21 Oct 2026 07:28:00 GMT') // => { delayMs: ~10000, exceededCap: false }
 * parseRetryAfterMs(null) // => null
 * parseRetryAfterMs('garbage') // => null
 */
export function parseRetryAfterMs(headerValue, { maxDelayMs = 30000 } = {}) {
  // Handle null, undefined, empty string
  if (!headerValue || headerValue === '') {
    return null;
  }

  // Try parsing as delta-seconds (integer)
  if (/^\s*\d+\s*$/.test(headerValue)) {
    const seconds = parseInt(headerValue, 10);
    const delayMs = seconds * 1000;
    const exceededCap = delayMs > maxDelayMs;
    return {
      delayMs: exceededCap ? maxDelayMs : delayMs,
      exceededCap,
    };
  }

  // Try parsing as HTTP-date (RFC 2822 format)
  const date = new Date(headerValue);
  if (!isNaN(date.getTime())) {
    const delayMs = Math.max(0, date.getTime() - Date.now());
    const exceededCap = delayMs > maxDelayMs;
    return {
      delayMs: exceededCap ? maxDelayMs : delayMs,
      exceededCap,
    };
  }

  // Unparseable
  return null;
}

/**
 * Check if an HTTP status code is retryable.
 *
 * Retryable statuses: 429 (Too Many Requests), all 5xx (server errors).
 * Non-retryable 4xx (400, 401, 403, 404, etc.) fail immediately.
 *
 * @param {number} status - HTTP status code
 * @returns {boolean} True if the request should be retried
 *
 * @example
 * isRetryableStatus(429) // => true
 * isRetryableStatus(503) // => true
 * isRetryableStatus(404) // => false
 * isRetryableStatus(401) // => false
 */
export function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status < 600);
}

/**
 * Check if a thrown error is retryable (transient transport error).
 *
 * Retryable errors: ECONNRESET (connection dropped), ETIMEDOUT (socket timeout),
 * and fetch TypeError (usually network-related).
 *
 * Non-retryable: Invalid URLs, caller abort, etc.
 *
 * @param {Error} err - The thrown error
 * @returns {boolean} True if the request should be retried
 *
 * @example
 * const err = new Error('socket hang up');
 * err.code = 'ECONNRESET';
 * isRetryableError(err) // => true
 *
 * isRetryableError(new TypeError('fetch failed')) // => true
 * isRetryableError(new DOMException('Aborted', 'AbortError')) // => false
 */
export function isRetryableError(err) {
  if (!err) return false;
  if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT') {
    return true;
  }
  if (err instanceof TypeError) {
    return true;
  }
  return false;
}

/**
 * Create a host registry for lazy-instantiating per-host TokenBucket and PerHostSemaphore.
 *
 * Ensures that each unique host has exactly one TokenBucket and one PerHostSemaphore,
 * preventing one slow host from blocking requests to other hosts.
 *
 * @param {Object} options - Default bucket/semaphore options
 * @param {number} options.perHostRps - Tokens per second (passed to TokenBucket)
 * @param {number} options.maxConcurrent - Max concurrent requests per host
 * @returns {Object} { getBucket(host, opts), getSemaphore(host, opts) }
 *
 * @example
 * const registry = createHostRegistry({ perHostRps: 0.5, maxConcurrent: 2 });
 * const bucket = registry.getBucket('example.com'); // Lazy created
 * const bucket2 = registry.getBucket('example.com'); // Same instance
 * const bucket3 = registry.getBucket('other.com'); // Different instance
 */
export function createHostRegistry(
  { perHostRps = 0.5, maxConcurrent = 1 } = {}
) {
  const buckets = new Map();
  const semaphores = new Map();

  return {
    /**
     * Get or create a TokenBucket for the given host.
     *
     * @param {string} host - The host (e.g., 'example.com')
     * @param {Object} opts - Override options { perHostRps, burst }
     * @returns {TokenBucket} The bucket instance for this host
     */
    getBucket(host, opts = {}) {
      if (!buckets.has(host)) {
        buckets.set(
          host,
          new TokenBucket({
            perHostRps: opts.perHostRps ?? perHostRps,
            burst: opts.burst ?? 1,
          })
        );
      }
      return buckets.get(host);
    },

    /**
     * Get or create a PerHostSemaphore for the given host.
     *
     * @param {string} host - The host (e.g., 'example.com')
     * @param {Object} opts - Override options { maxConcurrent }
     * @returns {PerHostSemaphore} The semaphore instance for this host
     */
    getSemaphore(host, opts = {}) {
      if (!semaphores.has(host)) {
        semaphores.set(
          host,
          new PerHostSemaphore({
            maxConcurrent: opts.maxConcurrent ?? maxConcurrent,
          })
        );
      }
      return semaphores.get(host);
    },
  };
}

/**
 * Helper: abortableSleep resolves after ms OR rejects with AbortError if signal aborts first.
 *
 * Clears timers and removes listeners on abort to prevent leaks.
 * If signal is already aborted on entry, rejects synchronously.
 *
 * @param {number} ms - Milliseconds to sleep
 * @param {AbortSignal} [signal] - Optional abort signal
 * @returns {Promise<void>} Resolves after sleep or rejects on abort
 */
function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Create an HTTP client with per-host rate limiting, concurrency control, and retry logic.
 *
 * Usage in a source adapter (e.g., scripts/sources/linkedin.mjs):
 *
 *   export const limits = { perHostRps: 1, maxConcurrent: 2 };
 *   export async function fetchExactSalary(job, ctx) {
 *     const response = await ctx.httpClient.get(`https://www.linkedin.com/jobs/view/${job.id}`);
 *     const html = await response.text();
 *     return parseSalaryCandidates(html, ctx);
 *   }
 *
 * The orchestrator builds the client once at startup:
 *   const httpClient = createHttpClient({ limits: { 'www.linkedin.com': linkedin.limits } });
 *   const ctx = { httpClient, logger };
 *
 * Never call global fetch() from scripts/sources/**; use this client so rate limits and evidence remain consistent.
 *
 * Adapters MUST receive the httpClient via ctx and call ctx.httpClient.get() / ctx.httpClient.getJson().
 * Per-request limits override is NOT supported (D4 resolution). Limits are sealed at first request to each host.
 *
 * @param {Object} options - Configuration
 * @param {number} options.perHostRps - Default tokens per second (default 0.5 = 2s between requests)
 * @param {number} options.maxConcurrent - Default max concurrent requests per host (default 1)
 * @param {number} options.maxRetries - Max retry attempts (default 3)
 * @param {number} options.maxDelayMs - Maximum backoff delay (default 30000)
 * @param {number} options.baseDelayMs - Base exponential backoff delay (default 500)
 * @param {Object} options.limits - Map of host -> { perHostRps, maxConcurrent } overrides
 * @returns {Object} { get(url, opts), getJson(url, opts) }
 */
export function createHttpClient(options = {}) {
  const {
    perHostRps = 0.5,
    maxConcurrent = 1,
    maxRetries = 3,
    maxDelayMs = 30000,
    baseDelayMs = 500,
    limits = {},  // Maps { host: { perHostRps, maxConcurrent } }
  } = options;

  // Create one host registry to cache buckets and semaphores per host
  const registry = createHostRegistry({ perHostRps, maxConcurrent });

  /**
   * Core fetch logic with rate limiting, retry, and abort support.
   *
   * @param {string} url - URL to fetch
   * @param {Object} opts - Request options
   * @param {AbortSignal} [opts.abortSignal] - Optional abort signal. Either `signal` or `abortSignal` is accepted at the call site; both keys are honoured identically by all downstream sites (fetch, retry sleep, throttle wait) via a single hoisted alias inside the function body.
   * @param {Object} opts.fetchInit - Additional fetch() options (headers, method, etc.)
   * @param {Function} opts.logger - Optional logger for structured events
   * @returns {Promise<Response>} The response object
   */
  async function get(url, opts = {}) {
    // Validate per-request limits constraint (D4)
    if (opts.limits !== undefined) {
      throw new Error(
        'Per-request limits override is not supported; configure limits at createHttpClient() time via limits[host]'
      );
    }

    // Hoist a single local alias so both `signal` and `abortSignal` keys are honoured
    // identically by every downstream call site (fetch, abortableSleep, bucket.consume,
    // and the error-classification branches). Adding new sites? Reference `signal` only.
    const signal = opts.signal ?? opts.abortSignal;

    const urlObj = new URL(url);
    const host = urlObj.host;

    // Resolve effective limits: defaults < createHttpClient options < limits[host]
    // Per-host limits are sealed on first request to that host; this is intentional (D4).
    const hostOverride = limits[host];
    const effectiveRps = hostOverride?.perHostRps ?? perHostRps;
    const effectiveConcurrent = hostOverride?.maxConcurrent ?? maxConcurrent;

    // Get the host's bucket and semaphore from the registry
    const bucket = registry.getBucket(host, { perHostRps: effectiveRps });
    const semaphore = registry.getSemaphore(host, { maxConcurrent: effectiveConcurrent });

    // Acquire semaphore slot
    const releaseSlot = await semaphore.acquire();

    try {
      // Await rate limit token consumption (abortable — signal aborts mid-wait reject promptly)
      await bucket.consume(1, { signal });

      // Retry loop
      let attempt = 0;
      while (attempt <= maxRetries) {
        // Check for abort before attempting
        if (signal?.aborted) {
          throw signal.reason ?? new DOMException('Aborted', 'AbortError');
        }

        try {
          // Perform the fetch
          const response = await fetch(url, {
            ...(opts.fetchInit || {}),
            signal,
          });

          // Check response status
          if (response.ok || (response.status >= 400 && response.status !== 429 && response.status < 500)) {
            // 2xx, 3xx, or 4xx (except 429) — return without retry
            return response;
          }

          // Check if status is retryable
          if (!isRetryableStatus(response.status)) {
            return response;
          }

          // Status is retryable (429 or 5xx)
          attempt++;
          if (attempt > maxRetries) {
            // Exhausted retries — throw the response as error
            throw response;
          }

          // Calculate delay
          let delayMs;
          let parsedRetryAfter = null;
          let shouldStopRetrying = false;

          if (response.status === 429) {
            const retryAfterHeader = response.headers.get('retry-after');
            parsedRetryAfter = parseRetryAfterMs(retryAfterHeader, { maxDelayMs });

            if (parsedRetryAfter) {
              delayMs = parsedRetryAfter.delayMs;
              // If server delay exceeds cap, sleep that long then stop retrying
              if (parsedRetryAfter.exceededCap) {
                shouldStopRetrying = true;
                // Log if logger provided
                if (opts.logger) {
                  opts.logger({
                    event: 'retry',
                    host,
                    attempt,
                    status: response.status,
                    retryAfterMs: parsedRetryAfter.delayMs,
                    delayMs,
                    reason: 'exceededCap',
                  });
                }
                // Sleep then throw error
                await abortableSleep(delayMs, signal);
                throw response; // Throw the response as the error
              }
            } else {
              // No Retry-After or unparseable — use backoff
              delayMs = calculateBackoffMs(attempt, { baseDelayMs, maxDelayMs });
            }
          } else {
            // 5xx — use backoff
            delayMs = calculateBackoffMs(attempt, { baseDelayMs, maxDelayMs });
          }

          // Log structured retry event if logger provided
          if (opts.logger) {
            opts.logger({
              event: 'retry',
              host,
              attempt,
              status: response.status,
              retryAfterMs: parsedRetryAfter?.delayMs ?? null,
              delayMs,
            });
          }

          // Sleep with abort support
          await abortableSleep(delayMs, signal);
        } catch (err) {
          // Handle fetch errors
          if (err.name === 'AbortError' || signal?.aborted) {
            // Abort — rethrow immediately without incrementing retry budget
            throw err;
          }

          // Check if error is retryable
          if (!isRetryableError(err)) {
            // Non-retryable error — rethrow
            throw err;
          }

          // Retryable error
          attempt++;
          if (attempt > maxRetries) {
            // Exhausted retries — rethrow
            throw err;
          }

          // Calculate backoff for retryable error
          const delayMs = calculateBackoffMs(attempt, { baseDelayMs, maxDelayMs });

          // Log structured retry event
          if (opts.logger) {
            opts.logger({
              event: 'retry',
              host,
              attempt,
              error: err.code || err.message,
              delayMs,
            });
          }

          // Sleep with abort support
          await abortableSleep(delayMs, signal);
        }
      }

      // Shouldn't reach here, but just in case
      throw new Error('Retry loop exited unexpectedly');
    } finally {
      releaseSlot();
    }
  }

  /**
   * Convenience wrapper that returns parsed JSON.
   *
   * @param {string} url - URL to fetch
   * @param {Object} opts - Request options (same as get())
   * @returns {Promise<any>} Parsed JSON response body
   * @throws {Error} If response is not ok
   */
  async function getJson(url, opts = {}) {
    const response = await get(url, opts);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }
    return response.json();
  }

  return { get, getJson };
}

/**
 * Internal exports for unit testing.
 *
 * Provides access to all primitives via a single __internal namespace,
 * useful when tests prefer to import via destructuring.
 */
export const __internal = {
  TokenBucket,
  PerHostSemaphore,
  calculateBackoffMs,
  parseRetryAfterMs,
  isRetryableStatus,
  isRetryableError,
  createHostRegistry,
  abortableSleep,
  createHttpClient,
};
