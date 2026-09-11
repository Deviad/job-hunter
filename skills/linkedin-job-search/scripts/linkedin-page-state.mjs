const PASSIVE_HTML_RE = /<(?:script|style|iframe|noscript)\b[^>]*>[\s\S]*?<\/(?:script|style|iframe|noscript)>|<(?:iframe|meta|link)\b[^>]*\/?\s*>/gi;

const BLOCK_SIGNATURES = [
  // ── Captcha / active challenge (checked first — these take precedence) ──
  { re: /(?:captcha|recaptcha|hcaptcha).{0,120}(?:solve|verify|verification|challenge|continue)/i, state: 'active_challenge' },
  { re: /(?:solve|verify|verification|challenge).{0,120}(?:captcha|recaptcha|hcaptcha)/i, state: 'active_challenge' },
  { re: /please solve/i, state: 'active_challenge' },
  // Adjacency required: LinkedIn's checkpoint markup uses "challengePlatform" /
  // "challenge verification". A {0,30} gap matched ordinary job-description prose
  // ("challenges into <vendor> platform") and broke healthy pages.
  { re: /challenge[-_\s]?platform\b/i, state: 'active_challenge' },
  { re: /challenge[-_\s]?verification\b/i, state: 'active_challenge' },
  // ── Rate limiting ──
  { re: /too many requests/i, state: 'rate_limited' },
  { re: /rate limit/i, state: 'rate_limited' },
  { re: /temporarily restricted/i, state: 'rate_limited' },
  // ── Other blocks (catch-all) ──
  { re: /security (?:verification|check)/i, state: 'blocked' },
  { re: /verify you.{0,40}(?:human|real person)/i, state: 'blocked' },
  { re: /are you a (?:real person|human)/i, state: 'blocked' },
  { re: /we.{0,30}detected.{0,30}(?:unusual|suspicious)/i, state: 'blocked' },
  { re: /unusual activity/i, state: 'blocked' },
  { re: /sign.?in to confirm you.{0,30}(?:real|not a bot)/i, state: 'blocked' },
];

/**
 * Canonical page state values shared across the runner and its callers.
 */
export const PAGE_STATE = {
  HEALTHY: 'healthy',
  EMPTY: 'empty',
  LOGIN_REQUIRED: 'login_required',
  ACTIVE_CHALLENGE: 'active_challenge',
  RATE_LIMITED: 'rate_limited',
  BLOCKED: 'blocked',
  TRANSIENT_ERROR: 'transient_error',
};

/**
 * Canonical LinkedIn restriction states. One observation of any of these is
 * a source-level restriction for the research workflow: strict retry
 * policies terminate on it, wrappers/preflight persist the pause on it, and
 * collectors report it as a terminal exit. Every caller imports this set
 * instead of keeping its own copy.
 */
export const RESTRICTION_STATES = Object.freeze([
  PAGE_STATE.ACTIVE_CHALLENGE,
  PAGE_STATE.BLOCKED,
  PAGE_STATE.RATE_LIMITED,
  PAGE_STATE.LOGIN_REQUIRED,
]);

export function isRestrictionState(state) {
  return RESTRICTION_STATES.includes(state);
}

const LINKEDIN_RESEARCH_HOSTS = new Set(['linkedin.com', 'www.linkedin.com']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Decide whether an automated research navigation may be sent. Production
 * permits only HTTPS LinkedIn job-search / job-detail routes; member,
 * company, feed and every other destination is rejected before any target
 * is created. Explicit loopback fixture origins are opt-in for tests only.
 *
 * @param {string} url
 * @param {{ fixtureOrigins?: string[] }} [options]
 * @returns {{ allowed: boolean, code: string, reason: string|null }}
 */
export function researchNavigationDecision(url, { fixtureOrigins = [] } = {}) {
  let parsed;
  try { parsed = new URL(url); }
  catch { return { allowed: false, code: 'invalid_url', reason: 'Invalid research URL' }; }
  if (parsed.username || parsed.password) return { allowed: false, code: 'credentials_in_url', reason: 'Research URLs cannot contain credentials' };
  if (['http:', 'https:'].includes(parsed.protocol) && LOOPBACK_HOSTS.has(parsed.hostname) && fixtureOrigins.includes(parsed.origin)) {
    return { allowed: true, code: 'fixture_allowed', reason: null };
  }
  if (parsed.protocol !== 'https:') return { allowed: false, code: 'invalid_url', reason: 'Research URLs require HTTPS' };
  if (!LINKEDIN_RESEARCH_HOSTS.has(parsed.hostname) || parsed.port) return { allowed: false, code: 'disallowed_host', reason: 'Research requires a LinkedIn jobs destination' };
  if (!/^\/jobs(?:\/search|\/view\/\d+)?\/?$/.test(parsed.pathname)) return { allowed: false, code: 'disallowed_route', reason: 'Only LinkedIn jobs routes are allowed' };
  return { allowed: true, code: 'allowed', reason: null };
}

/**
 * Terminal run-level statuses (page states + run-level only).
 */
export const RUN_STATUS = {
  ...PAGE_STATE,
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

function visibleLikeText(input) {
  const raw = String(input || '');
  if (!/<(?:html|body|script|iframe|style)\b/i.test(raw)) return raw;
  return raw
    .replace(PASSIVE_HTML_RE, ' ')
    .replace(/<!--([\s\S]*?)-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&(?:amp|lt|gt|quot);/gi, ' ')
    .replace(/\s+/g, ' ');
}

/**
 * True when the payload carries rendered LinkedIn job-result data. Mirrors the
 * result markers search-linkedin-jobs.mjs uses to accept a search page.
 *
 * @param {string} htmlOrText - raw HTML or visible text of the page
 * @returns {boolean}
 */
export function hasJobResultMarkers(htmlOrText) {
  const raw = String(htmlOrText || '');
  if (!raw) return false;
  return /"job_id":\d+|\/jobs\/view\/\d+|jobCardPrefetchQueries|totalResultSize|data-job-id=|job-card-container/i.test(raw);
}

/**
 * True when the payload is a rendered job-detail page. Mirrors the JD markers
 * search-linkedin-jobs.mjs waits for before accepting detail text.
 *
 * @param {string} htmlOrText - raw HTML or visible text of the page
 * @returns {boolean}
 */
export function hasJobDetailMarkers(htmlOrText) {
  const raw = String(htmlOrText || '');
  if (!raw) return false;
  return /Report this job|Seniority level|About the job|Employment type|Job function/i.test(raw);
}

/**
 * Detect whether a LinkedIn HTML page is a block/warning/challenge.
 * CRITICAL INVARIANT: passive invisible reCAPTCHA scripts/iframes present on
 * HEALTHY pages must NOT be classified as a challenge.
 *
 * @param {string} htmlOrText - raw HTML or visible-text of the page
 * @returns {{ blocked: boolean, isCaptcha: boolean, reason: string|null }}
 *   blocked   = any block/warning page (true for all block types)
 *   isCaptcha = specifically a CAPTCHA challenge (otherwise generic block)
 *   reason    = human-readable explanation
 */
export function detectLinkedInBlockPage(htmlOrText) {
  const hay = visibleLikeText(htmlOrText);
  for (const signature of BLOCK_SIGNATURES) {
    if (signature.re.test(hay)) {
      return {
        blocked: true,
        isCaptcha: signature.state === 'active_challenge',
        reason: `matched visible page text: ${signature.re.source.slice(0, 70)}`,
      };
    }
  }
  return { blocked: false, isCaptcha: false, reason: null };
}

/**
 * Classify a LinkedIn page into one of the canonical PAGE_STATE values.
 * Classification is based on visible/accessible page text and title, never
 * on raw <script>/<iframe> presence alone.
 *
 * @param {{ title?: string, url?: string, text?: string, isSearch?: boolean, hasResults?: boolean }} params
 *   title       - document title
 *   url         - page URL
 *   text        - visible/rendered text of the page
 *   isSearch    - optional hint: is this a search results page?
 *   hasResults  - optional hint: did we extract any job IDs from this page?
 * @returns {{ state: string, blocked: boolean, isCaptcha: boolean, reason: string|null }}
 */
export function classifyLinkedInPage({ title = '', url = '', text = '', isSearch = false, hasResults = undefined } = {}) {
  // A page that rendered job results is serving content, not gating it. Block
  // signatures are single words that also occur in job-description prose, so
  // without this guard one posting's wording can classify a healthy page as a
  // wall and trip the caller's consecutive-blocking-state circuit breaker.
  // LinkedIn serves real interstitials from /checkpoint/ and never alongside
  // job data, so that URL still takes precedence.
  const isCheckpointUrl = /linkedin\.com\/checkpoint\//i.test(String(url));
  const servesResults = hasResults === true || hasJobResultMarkers(text) || hasJobDetailMarkers(text);
  if (servesResults && !isCheckpointUrl) {
    return { state: PAGE_STATE.HEALTHY, blocked: false, isCaptcha: false, reason: null };
  }

  // Block/challenge detection first (takes precedence)
  const block = detectLinkedInBlockPage(`${title}\n${text}`);
  if (block.blocked) {
    // Map to the canonical state from the BLOCK_SIGNATURES table
    const state = block.isCaptcha ? PAGE_STATE.ACTIVE_CHALLENGE : PAGE_STATE.BLOCKED;
    // Re-check for rate_limited signatures specifically
    const hay = visibleLikeText(`${title}\n${text}`);
    if (/too many requests|rate limit|temporarily restricted/i.test(hay)) {
      return { state: PAGE_STATE.RATE_LIMITED, blocked: true, isCaptcha: false, reason: block.reason };
    }
    return { state, blocked: true, isCaptcha: block.isCaptcha, reason: block.reason };
  }

  // Login wall (but not the logged-in homepage with nav)
  const joined = `${title}\n${url}\n${text}`;
  if (/authwall|\/login|sign in to linkedin|join linkedin/i.test(joined) &&
      !/\bHome\b.{0,120}\bMy Network\b.{0,120}\bJobs\b/is.test(text)) {
    return { state: PAGE_STATE.LOGIN_REQUIRED, blocked: true, isCaptcha: false, reason: 'LinkedIn login wall detected' };
  }

  // Empty search results
  if (isSearch || hasResults !== undefined) {
    const hasIds = hasResults === true;
    const titleLower = title.toLowerCase();
    const textLower = text.toLowerCase();
    const isEmpty =
      (!hasIds && (
        /0 results|no .{0,20}(?:jobs?|positions?|openings?|matches?)/i.test(textLower) ||
        /no .{0,20}(?:jobs?|positions?|openings?|matches?) in/i.test(titleLower) ||
        /no matching/i.test(textLower)
      )) ||
      (hasResults === false && /jobs/i.test(titleLower));
    if (isEmpty) {
      return { state: PAGE_STATE.EMPTY, blocked: false, isCaptcha: false, reason: 'No search results' };
    }
    // Search page with no IDs extracted but no explicit "no results" text:
    // could be a rendering issue or an auth-wall; treat as healthy so the
    // caller can count consecutive empties.
    if (hasResults === false && !isEmpty) {
      return { state: PAGE_STATE.HEALTHY, blocked: false, isCaptcha: false, reason: 'Search page; no IDs extracted' };
    }
  }

  return { state: PAGE_STATE.HEALTHY, blocked: false, isCaptcha: false, reason: null };
}

/**
 * Classify a final run-level status from a series of page-level states.
 * Used to produce the terminal report.
 *
 * @param {string[]} states - array of PAGE_STATE values observed during the run
 * @returns {string} a RUN_STATUS value
 */
export function classifyRunStatus(states) {
  if (!states || states.length === 0) return RUN_STATUS.EMPTY;
  const failureStates = new Set([
    PAGE_STATE.ACTIVE_CHALLENGE,
    PAGE_STATE.BLOCKED,
    PAGE_STATE.RATE_LIMITED,
    RUN_STATUS.FAILED,
  ]);
  for (const s of states) {
    if (failureStates.has(s)) return s;
  }
  // If all pages were healthy or empty, the run is healthy
  if (states.every((s) => s === PAGE_STATE.HEALTHY || s === PAGE_STATE.EMPTY)) {
    return states.includes(PAGE_STATE.EMPTY) ? PAGE_STATE.EMPTY : PAGE_STATE.HEALTHY;
  }
  // Login required, transient errors, etc.
  if (states.includes(PAGE_STATE.LOGIN_REQUIRED)) return PAGE_STATE.LOGIN_REQUIRED;
  if (states.includes(PAGE_STATE.TRANSIENT_ERROR)) return PAGE_STATE.TRANSIENT_ERROR;
  return RUN_STATUS.FAILED;
}

/**
 * Returns true if this page state is a "blocking" state that requires retry
 * or circuit-breaking (as opposed to healthy terminal states).
 */
export function isBlockingState(state) {
  return state === PAGE_STATE.ACTIVE_CHALLENGE ||
         state === PAGE_STATE.BLOCKED ||
         state === PAGE_STATE.RATE_LIMITED ||
         state === PAGE_STATE.TRANSIENT_ERROR;
}

/**
 * Returns true if this page state should count toward the circuit breaker.
 * Only states that indicate LinkedIn is treating the session as hostile.
 */
export function isCircuitBreakerState(state) {
  return state === PAGE_STATE.ACTIVE_CHALLENGE ||
         state === PAGE_STATE.BLOCKED ||
         state === PAGE_STATE.RATE_LIMITED;
}
