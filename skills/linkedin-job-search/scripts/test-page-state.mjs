#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  detectLinkedInBlockPage,
  classifyLinkedInPage,
  PAGE_STATE,
  classifyRunStatus,
  isBlockingState,
  isCircuitBreakerState,
} from './linkedin-page-state.mjs';

// ── Existing invariants (must keep passing) ──────────────────────────

const passiveRecaptcha = `
<html><body><main>AI Architect jobs in Ireland</main>
<iframe src="https://www.google.com/recaptcha/enterprise/anchor?k=test"></iframe>
<script>window.recaptchaConfig = { challenge: true };</script>
<a href="/jobs/view/9000001002">AI Architect</a></body></html>`;
assert.equal(detectLinkedInBlockPage(passiveRecaptcha).blocked, false, 'passive invisible reCAPTCHA must not block a healthy jobs page');

const activeCaptcha = '<html><body><main>Please solve the CAPTCHA challenge to continue</main></body></html>';
const captchaResult = detectLinkedInBlockPage(activeCaptcha);
assert.equal(captchaResult.blocked, true);
assert.equal(captchaResult.isCaptcha, true);

const securityCheck = detectLinkedInBlockPage('Security verification required. Verify you are a real person.');
assert.equal(securityCheck.blocked, true);
assert.equal(securityCheck.isCaptcha, false);

const healthyFixture = classifyLinkedInPage({
  title: 'Example Role Jobs in Example Region | LinkedIn',
  url: 'https://www.linkedin.com/jobs/search/?keywords=Example%20Role',
  text: 'Home My Network Jobs Messaging Notifications Example Role results',
});
assert.equal(healthyFixture.state, 'healthy');

const login = classifyLinkedInPage({
  title: 'LinkedIn Login',
  url: 'https://www.linkedin.com/login',
  text: 'Sign in to LinkedIn',
});
assert.equal(login.state, 'login_required');

// ── New: page state model extensions ─────────────────────────────────

// active_challenge (was captcha)
const challenge = classifyLinkedInPage({
  title: 'Security Check | LinkedIn',
  url: 'https://www.linkedin.com/checkpoint/challenge/',
  text: 'Please solve the CAPTCHA challenge to verify you are human. This is required to continue.',
});
assert.equal(challenge.state, PAGE_STATE.ACTIVE_CHALLENGE, 'CAPTCHA page => active_challenge');
assert.equal(challenge.blocked, true);
assert.equal(challenge.isCaptcha, true);

// challengePlatform marker in LinkedIn checkpoint markup still detected
const challengePlatform = classifyLinkedInPage({
  title: 'Security Verification | LinkedIn',
  url: 'https://www.linkedin.com/checkpoint/challenge/',
  text: 'window.challengePlatform = { type: "captcha" };',
});
assert.equal(challengePlatform.state, PAGE_STATE.ACTIVE_CHALLENGE, 'challengePlatform => active_challenge');

// Job-description prose must NOT trip challenge detection. Real text from a
// Celonis posting that tripped the old /challenge.{0,30}(platform|verification)/
// rule and broke a healthy 32-card search page via the 3-strike circuit breaker.
const jdProse = classifyLinkedInPage({
  title: '(16) Artificial Intelligence Architect Jobs in United Kingdom | LinkedIn',
  url: 'https://www.linkedin.com/jobs/search/?keywords=AI%20Architect&start=56',
  text: 'Translate customer business challenges into Celonis platform strategies, '
      + 'identifying high-impact use cases and defining success metrics. Support pre-sales '
      + 'by providing technical credibility in complex deals.',
  isSearch: true,
  hasResults: true,
});
assert.equal(jdProse.blocked, false, 'JD prose "challenges into <vendor> platform" must not be blocked');
assert.equal(jdProse.isCaptcha, false, 'JD prose must not be flagged as CAPTCHA');
assert.equal(jdProse.state, PAGE_STATE.HEALTHY, 'healthy search page with JD prose => healthy');

// A page carrying job-result markers is serving content, so block signatures
// appearing in JD prose must not classify it as a wall. Real case: a posting
// mentioning "security verification" on a page with 32 job cards.
const securityProse = classifyLinkedInPage({
  title: '(16) Enterprise AI Architect Jobs in United Kingdom | LinkedIn',
  url: 'https://www.linkedin.com/jobs/search/?keywords=Enterprise%20AI%20Architect&start=161',
  text: '<html><body><div class="job-card-container" data-job-id="9000000001">'
      + 'Lead security verification workflows for enterprise identity platforms.'
      + '</div>"job_id":9000000001</body></html>',
  isSearch: true,
});
assert.equal(securityProse.blocked, false, 'page with job results must not be blocked by JD prose');
assert.equal(securityProse.state, PAGE_STATE.HEALTHY, 'page with job-result markers => healthy');

// The results guard must NOT mask a real interstitial: /checkpoint/ URLs stay
// blocked even if result-shaped markers appear in the payload.
const realCheckpoint = classifyLinkedInPage({
  title: 'Security Verification | LinkedIn',
  url: 'https://www.linkedin.com/checkpoint/challenge/AgFxyz',
  text: 'Security verification required. data-job-id="123" Please verify you are human.',
  isSearch: true,
});
assert.equal(realCheckpoint.blocked, true, 'checkpoint URL must stay blocked despite result markers');

// Rendered JD page: UK security-clearance boilerplate must not read as a wall.
// Real case: "Lead AI Architect" at Synthetic Grid Operator, whose JD
// says "The level of clearance associated with the role is Security Check (SC)".
const clearanceProse = classifyLinkedInPage({
  title: 'Lead AI Architect | Synthetic Grid Operator | LinkedIn',
  url: 'https://linkedin.example/jobs/view/9999999999/',
  text: 'About the job. This role is designated as requiring a National Security '
      + 'Vetting (NSV) clearance. The level of clearance associated with the role is '
      + 'Security Check (SC). You will usually need to have been a resident in the UK '
      + 'for the last five years to apply for an SC clearance.',
});
assert.equal(clearanceProse.blocked, false, 'JD clearance boilerplate must not be blocked');
assert.equal(clearanceProse.state, PAGE_STATE.HEALTHY, 'rendered JD page => healthy');

// A real interstitial with no JD markers must still block.
const detailWall = classifyLinkedInPage({
  title: 'Security Verification | LinkedIn',
  url: 'https://linkedin.example/jobs/view/9999999999/',
  text: 'Security verification required. Please verify you are human to continue.',
});
assert.equal(detailWall.blocked, true, 'detail-page wall without JD markers must stay blocked');

// hasResults===true is an explicit caller signal that results rendered.
const explicitResults = classifyLinkedInPage({
  title: 'AI Architect Jobs | LinkedIn',
  url: 'https://www.linkedin.com/jobs/search/?keywords=AI%20Architect',
  text: 'Manage unusual activity detection for the fraud platform.',
  isSearch: true,
  hasResults: true,
});
assert.equal(explicitResults.state, PAGE_STATE.HEALTHY, 'hasResults=true => healthy despite prose match');

// rate_limited
const rateLimited = classifyLinkedInPage({
  title: 'Too Many Requests | LinkedIn',
  url: 'https://www.linkedin.com/jobs/search/',
  text: 'You have made too many requests. Please try again later.',
});
assert.equal(rateLimited.state, PAGE_STATE.RATE_LIMITED, 'rate-limit page => rate_limited');

// blocked (generic)
const genericBlock = classifyLinkedInPage({
  title: 'LinkedIn',
  url: 'https://www.linkedin.com/',
  text: 'We detected unusual activity from your network. Please verify your identity to continue.',
});
assert.equal(genericBlock.state, PAGE_STATE.BLOCKED, 'unusual activity => blocked');
assert.equal(genericBlock.isCaptcha, false);

// empty search results
const emptySearch = classifyLinkedInPage({
  title: 'No matching jobs in Example Location 013 for AI Architect | LinkedIn',
  url: 'https://www.linkedin.com/jobs/search/?keywords=AI%20Architect&location=Example Location 013&start=0',
  text: 'AI Architect jobs in Example Location 013. No matching jobs found. Try adjusting your search.',
  isSearch: true,
  hasResults: false,
});
assert.equal(emptySearch.state, PAGE_STATE.EMPTY, 'empty search page => empty');

// empty with explicit "0 results" text
const zeroResults = classifyLinkedInPage({
  title: '0 results for AI Architect in Mauritius | LinkedIn',
  url: 'https://www.linkedin.com/jobs/search/?keywords=AI%20Architect&location=Mauritius',
  text: '0 results for AI Architect in Mauritius. Check your spelling or try broader keywords.',
  isSearch: true,
});
assert.equal(zeroResults.state, PAGE_STATE.EMPTY, '0 results page => empty');

// login wall on detail page
const loginDetail = classifyLinkedInPage({
  title: 'Sign In | LinkedIn',
  url: 'https://www.linkedin.com/jobs/view/12345',
  text: 'Sign in to LinkedIn to view this job.',
});
assert.equal(loginDetail.state, PAGE_STATE.LOGIN_REQUIRED);

// login page BUT with logged-in nav bar (should be healthy)
const loggedInHomepage = classifyLinkedInPage({
  title: 'LinkedIn',
  url: 'https://www.linkedin.com/feed/',
  text: 'Home My Network Jobs Messaging Notifications Sign out',
});
assert.equal(loggedInHomepage.state, PAGE_STATE.HEALTHY, 'logged-in nav => healthy, not login_required');

// ── New: classifyRunStatus ───────────────────────────────────────────

assert.equal(classifyRunStatus([PAGE_STATE.HEALTHY, PAGE_STATE.HEALTHY]), PAGE_STATE.HEALTHY);
assert.equal(classifyRunStatus([PAGE_STATE.HEALTHY, PAGE_STATE.EMPTY]), PAGE_STATE.EMPTY);
assert.equal(classifyRunStatus([PAGE_STATE.ACTIVE_CHALLENGE]), PAGE_STATE.ACTIVE_CHALLENGE);
assert.equal(classifyRunStatus([PAGE_STATE.HEALTHY, PAGE_STATE.ACTIVE_CHALLENGE]), PAGE_STATE.ACTIVE_CHALLENGE);
assert.equal(classifyRunStatus([PAGE_STATE.HEALTHY, PAGE_STATE.RATE_LIMITED]), PAGE_STATE.RATE_LIMITED);
assert.equal(classifyRunStatus([PAGE_STATE.HEALTHY, PAGE_STATE.LOGIN_REQUIRED]), PAGE_STATE.LOGIN_REQUIRED);
assert.equal(classifyRunStatus([PAGE_STATE.HEALTHY, PAGE_STATE.TRANSIENT_ERROR]), PAGE_STATE.TRANSIENT_ERROR);
assert.equal(classifyRunStatus([]), PAGE_STATE.EMPTY);

// ── New: isBlockingState / isCircuitBreakerState ─────────────────────

assert.equal(isBlockingState(PAGE_STATE.ACTIVE_CHALLENGE), true);
assert.equal(isBlockingState(PAGE_STATE.BLOCKED), true);
assert.equal(isBlockingState(PAGE_STATE.RATE_LIMITED), true);
assert.equal(isBlockingState(PAGE_STATE.TRANSIENT_ERROR), true);
assert.equal(isBlockingState(PAGE_STATE.HEALTHY), false);
assert.equal(isBlockingState(PAGE_STATE.EMPTY), false);
assert.equal(isBlockingState(PAGE_STATE.LOGIN_REQUIRED), false);

assert.equal(isCircuitBreakerState(PAGE_STATE.ACTIVE_CHALLENGE), true);
assert.equal(isCircuitBreakerState(PAGE_STATE.BLOCKED), true);
assert.equal(isCircuitBreakerState(PAGE_STATE.RATE_LIMITED), true);
assert.equal(isCircuitBreakerState(PAGE_STATE.TRANSIENT_ERROR), false);
assert.equal(isCircuitBreakerState(PAGE_STATE.HEALTHY), false);

console.log('page-state tests: PASS');
