---
name: indeed-job-search
description: Searches Indeed through the user's authorized Chromium CDP session, extracts normalized job evidence, and saves results to the canonical Job Hunter database. Use for Indeed-specific search and refresh work.
allowed-tools: read bash
---

# Indeed Job Search

Use the logged-in Chromium session on `127.0.0.1:9225`. Indeed search and listing pages must be read through the authorized browser, not raw HTTP.

## Normal Entry Point

```bash
node ~/.pi/agent/skills/job-hunter/scripts/jh-search.mjs \
  --source indeed \
  --country <country-code> \
  --query "<role>"
```

The wrapper derives the regional Indeed domain, runs the Job Hunter doctor, probes the exact search URL, bounds the run, and checkpoints progress. See `../job-hunter/references/search-safety-contract.md`.

Direct calls to `scripts/search-indeed-jobs.mjs` are for focused debugging and tests.

## Workspace

Resolve `JOBHUNTER_HOME`, defaulting to `~/.job-hunter`. Save normalized rows to `jobhunter.sqlite` through the LinkedIn skill's shared SQLite saver.

## Search Contract

- Run one country and source per invocation.
- Use the country-appropriate Indeed domain.
- Probe the exact listing URL before navigation.
- Keep browser heartbeats active during long extraction.
- Stop on login, verification, CAPTCHA, or access-denied pages.
- Report blocked access explicitly; do not call it zero results.

## Extraction

Preserve source evidence for each job:

- Indeed job key and canonical URL;
- title, company, location, and posting date;
- salary snippet when posted;
- description text;
- application route and external ATS URL;
- language, work-mode, and location evidence;
- search ID and extraction timestamp.

Use browser-visible details rather than inferring missing facts from the search query.

## Filters

Use only runtime configuration and job evidence. Mandatory unsupported language and explicit location/work-mode conflicts may filter a row. Eligibility, sponsorship, citizenship, salary expectations, and relocation are evaluated later from the installing user's cache by `job-match-scorer`.

## Persistence

When saving, route through `../linkedin-job-search/scripts/save-to-sqlite.mjs` so LinkedIn and Indeed share normalization and schema behavior. Sparse refreshes must not erase richer stored descriptions.

## Blockers

- Search/listing CAPTCHA or verification: pause for the user; do not bypass it.
- SmartApply CAPTCHA inside an authorized application: hand off to `auto-job-application` and `captcha-resolution`.
- Unclear visible state: use `qwen-screenshot-debug` before retrying.

## References

- [Indeed selectors](references/indeed-selectors.md)
- [Apply button semantics](references/apply-button-semantics.md)
