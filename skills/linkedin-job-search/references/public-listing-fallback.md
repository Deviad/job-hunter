# LinkedIn public listing fallback for exact query searches

Use this when the normal logged-in LinkedIn CDP runner repeatedly hits CAPTCHA/security pages but the user asks for a simple listing-level search such as `AI Architect AND remote`.

## When to use

- The runner logs repeated `[captcha] CAPTCHA detected on search page` and backs off/timeouts.
- The user asked for an exact LinkedIn query and needs candidate listings quickly.
- Full JD extraction/scoring can wait until after the shortlist is identified.

## Pattern

1. Open the public LinkedIn jobs search URL in the browser:

```text
https://www.linkedin.com/jobs/search/?keywords=<urlencoded exact query>&location=<urlencoded location>&f_TPR=r2592000
```

Example:

```text
https://www.linkedin.com/jobs/search/?keywords=AI%20Architect%20AND%20remote&location=Remote&f_TPR=r2592000
```

2. Dismiss any sign-in modal if visible. If a cookie dialog appears, choose the visible preference needed to expose listings.

3. Extract listing cards from the DOM rather than relying on the logged-in runner. A useful browser-console expression is:

```js
Array.from(document.querySelectorAll('main li')).map(li => {
  const jobLink = li.querySelector('a[href*="/jobs/view/"]');
  const title = (li.querySelector('h3')?.innerText || jobLink?.innerText || '').trim();
  const company = (li.querySelector('h4')?.innerText || '').trim();
  const txt = (li.innerText || '').split('\n').map(s => s.trim()).filter(Boolean);
  const loc = txt.find(s => s && s !== title && s !== company && !/ago$|applicant|benefits|insurance/i.test(s)) || '';
  return { title, company, location: loc, text: txt.slice(0, 8), url: jobLink ? new URL(jobLink.href, location.href).href.split('?')[0] : '' };
}).filter(x => x.title && x.url).slice(0, 30)
```

4. Save listing-level results to SQLite as `source='linkedin'` records with:

- native LinkedIn numeric job id extracted from `/jobs/view/...-<id>`
- title, company, location, country code if inferable
- `applicationLinks: [url]`
- `descriptionText` and `descriptionRaw` empty if the JD was not fetched
- `languageFilterReason` clearly noting listing-only extraction
- `workModes: [{ mode: 'remote', isPrimary: true }]` only if the query or title/location explicitly indicates remote
- `searchedKeywords` and `searchedLocation` set to the exact query context

5. Tell the user the result is listing-level only. Do not claim JD/language/application-link extraction succeeded. The next step is detail fetch/backfill, then scoring, then application.

## Pitfalls

- Public LinkedIn may show a large count and visible listings even when the logged-in CDP runner is CAPTCHA-blocked. Do not stop at “runner blocked” if a public listing search can satisfy the user's immediate request.
- Boolean-like query strings such as `AI Architect AND remote` may work well enough in LinkedIn's public keyword field, but treat the results as search-engine matches, not guaranteed Boolean semantics.
- Avoid marking public listing fallback results as fully screened. They need JD fetch/backfill before `job-match-scorer` and `auto-job-application` can safely proceed.
