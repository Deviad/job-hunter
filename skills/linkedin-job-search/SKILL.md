---
name: linkedin-job-search
description: Searches LinkedIn jobs through the user's authorized Chromium CDP session, extracts job evidence, filters configured blockers, and saves normalized results to the canonical Job Hunter database. Use for LinkedIn-specific search and refresh work.
allowed-tools: read bash
---

# LinkedIn Job Search

Use the logged-in Chromium session on `127.0.0.1:9225`. Do not use raw HTTP, exported cookies, or a second browser for routine search.

## Normal Entry Point

Run through the Job Hunter wrapper:

```bash
node ~/.pi/agent/skills/job-hunter/scripts/jh-search.mjs \
  --source linkedin \
  --country <country-code> \
  --role "<role>"
```

The wrapper performs the doctor check, exact-search-URL CDP preflight, bounded query expansion, checkpointing, and blocker handling described in `../job-hunter/references/search-safety-contract.md`.

Direct calls to `scripts/search-linkedin-jobs.mjs` are for focused debugging and tests.

## Workspace

Resolve `JOBHUNTER_HOME`, defaulting to `~/.job-hunter`. Save to `jobhunter.sqlite`; never resolve job data from the launch directory.

## Search Contract

- Run one source and one country per invocation.
- Keep query batches bounded and resumable.
- Probe the exact search URL, not merely an already-open job-detail tab.
- Send CDP keepalives during long browser work.
- Stop on LinkedIn security checks, login walls, CAPTCHA, or verification pages.
- Do not report a blocker as zero results.

## Extraction

LinkedIn search pages are client-rendered and may expose IDs through HTML or embedded data even when cards are incomplete. Extract unique job IDs from the authorized browser target, then fetch detail evidence through the same CDP session.

For each job preserve:

- source and job ID;
- title, company, location, and posting date;
- description text;
- application URL and external ATS URL when visible;
- applicant count and recruiter evidence when visible;
- language and work-mode evidence;
- extraction timestamp and search ID.

Query text is not role-classification evidence. Listing-only role classifications remain provisional until detail extraction succeeds.

## Filters

Filter only from the installing user's runtime policy:

- mandatory unsupported language;
- explicit location/work-mode exclusions;
- stale posting cutoff;
- clearly irrelevant role family.

Do not encode maintainer citizenship, authorization, sponsorship, relocation, salary, or language defaults in this skill. Pass eligibility evidence to `job-match-scorer`.

## Persistence

Use `scripts/save-to-sqlite.mjs` for normalized writes. It loads shared packages from the canonical workspace and preserves existing detail evidence on sparse updates.

Run focused tests with the scripts named `test-*.mjs` under `scripts/` and the taxonomy tests under `tests/`.

## Blockers and Recovery

- LinkedIn security or verification page: stop and ask the user to resolve it in Chromium.
- CDP unavailable: run `obscura-mcp-repair` only when the user chose an Obscura path; routine search remains direct Chromium CDP.
- Unclear page state: use `qwen-screenshot-debug` before retrying navigation.
- Application action: hand off to `auto-job-application`; the search skill does not answer screening questions.

## Research-Safety Gates

Every LinkedIn entrypoint in this skill reads the persisted access state (`jh_meta` key `source.linkedin.access`, owned by the sibling `job-hunter` skill) before any browser or CDP contact: `cdp-preflight.mjs`, `search-linkedin-jobs.mjs --strict-owner`, and `batch-fetch-jds.mjs` stop with a sanitized `SOURCE_PAUSED` / `ACCESS_STATE_UNAVAILABLE` result. The first canonical restriction (`active_challenge`, `blocked`, `rate_limited`, `login_required`; the single source of truth is `RESTRICTION_STATES` in `linkedin-page-state.mjs`) is persisted as a pause at the observation site, before the owner releases, by the collector's strict owner and by the backfill. Every automated navigation, including stored `jobs.url` values, is validated by `researchNavigationDecision` against the LinkedIn jobs-route allowlist immediately before it is sent; non-jobs destinations are excluded with a reason and never navigated. This skill therefore requires the `job-hunter` skill installed beside it.

## References

- [LinkedIn selectors](references/linkedin-selectors.md)
- [Public listing fallback](references/public-listing-fallback.md)
- [International screening evidence](references/us-remote-international-screening.md)
- [Easy Apply interest loop](references/linkedin-easy-apply-interest-loop.md)
- [Profile review privacy](references/linkedin-profile-review-cdp.md)
