# LinkedIn Job Search — Selectors & Patterns

> These selectors and patterns were validated against fixture HTML via the TDD test harness (`scripts/test-extraction-and-filter.mjs`). LinkedIn changes their DOM periodically — if extraction fails, update the patterns in `scripts/linkedin-extractor.mjs` and re-run tests.

## URL Patterns

| Purpose | URL |
|---------|-----|
| Job search (keyword + location) | `https://www.linkedin.com/jobs/search/?keywords={keywords}&location={location}` |
| Job detail | `https://www.linkedin.com/jobs/view/{jobId}` |
| Login (if session bridge fails) | `https://www.linkedin.com/uas/login` |

## CSS Selectors (for Obscura `wait` / `click` / `type`)

### Job Detail Page (current working selectors)

| Element | Selector | Notes |
|---------|----------|-------|
| Title | `h1.top-card-layout__title` | Large heading at top of detail page |
| Company | `a.topcard__org-name-link` | Link next to company logo |
| Location | `span.topcard__flavor--bullet` | Bullet-separated location text |
| Applicants | `figure.num-applicants__figure` | Contains applicant count text |
| Description | `div.description__text` | Main content block with paragraphs |
| Posting date | `span.job-posted-date` | Text like "Posted 2 weeks ago" |
| Apply button | `.apply-button`, `.apply-link`, `.easy-apply` | |
| Recruiter/hirer | `.hirer-info` > `.hirer-name` | May be absent |
| Recruiter email | `.hirer-email` | Email address in hiring panel |
| Recruiter profile link | `a.hirer-name` | `href` attribute on hirer name link |

### Job Search Results (still valid)

| Element | Selector | Notes |
|---------|----------|-------|
| Search keywords input | `#search-jobs-keywords` or `input[aria-label*="keyword"]` | |
| Search location input | `#search-jobs-location` or `input[aria-label*="location"]` | |
| Search submit button | `button[aria-label*="Search"]` or `.jobs-search-box__submit-button` | |
| Job card in results | `.job-card-container` | Each card is a container |
| Job title link | `.job-card-list__title` or `a.job-title` | Contains the job detail URL |
| Company name | `.job-card-list__company-name` | |
| Location | `.job-card-list__location` | |
| Applicant count | `.job-card-list__applicant-count` | May be empty |

### Deprecated Selectors (kept as fallbacks)

| Element | Old Selector | New Replacement |
|---------|-------------|----------------|
| Title | `.job-details-jobs-v2__main-job-title` | `h1.top-card-layout__title` |
| Company | `.job-details-jobs-v2__company-name` | `a.topcard__org-name-link` |
| Location | `.job-details-jobs-v2__location` | `span.topcard__flavor--bullet` |
| Applicants | `.job-details-jobs-v2__applicant-count` | `figure.num-applicants__figure` |
| Description | `.show-more-less__description` | `div.description__text` |

## Extraction Patterns (for Obscura `extract` with JS eval)

Use these JavaScript expressions with `obscura_browse_session` action `extract` or `obscura_browse_page` with `eval`.

### Extract all job cards from search results

```js
// Get all job card containers and extract their data
Array.from(document.querySelectorAll('.job-card-container')).map(card => ({
  title: card.querySelector('.job-card-list__title')?.textContent?.trim(),
  company: card.querySelector('.job-card-list__company-name')?.textContent?.trim(),
  location: card.querySelector('.job-card-list__location')?.textContent?.trim(),
  applicants: card.querySelector('.job-card-list__applicant-count')?.textContent?.trim(),
  url: card.querySelector('.job-card-list__title')?.href || card.querySelector('a')?.href,
  recruiter: card.querySelector('.hirer-name')?.textContent?.trim(),
}))
```

### Extract detail from a single job page (current selectors)

```js
// Extract all fields from the job detail page using current LinkedIn DOM
({
  title: document.querySelector('h1.top-card-layout__title')?.textContent?.trim(),
  company: document.querySelector('a.topcard__org-name-link')?.textContent?.trim(),
  location: document.querySelector('span.topcard__flavor--bullet')?.textContent?.trim(),
  applicants: document.querySelector('figure.num-applicants__figure')?.textContent?.trim(),
  description: document.querySelector('div.description__text')?.textContent?.trim(),
  applyLinks: Array.from(document.querySelectorAll('.apply-link, .apply-button')).map(a => a.href || a.textContent),
  recruiter: document.querySelector('.hirer-name')?.textContent?.trim(),
  jobPostingDate: document.querySelector('span.job-posted-date')?.textContent?.trim(),
  recruiterEmail: document.querySelector('.hirer-email')?.textContent?.trim(),
  recruiterProfileLink: document.querySelector('a.hirer-name')?.href,
})
```

### Fallback extraction (old selectors — kept for compatibility)

```js
// Fallback: old LinkedIn DOM selectors
({
  title: document.querySelector('.job-details-jobs-v2__main-job-title')?.textContent?.trim(),
  company: document.querySelector('.job-details-jobs-v2__company-name')?.textContent?.trim(),
  location: document.querySelector('.job-details-jobs-v2__location')?.textContent?.trim(),
  applicants: document.querySelector('.job-details-jobs-v2__applicant-count')?.textContent?.trim(),
  description: document.querySelector('.show-more-less__description')?.textContent?.trim(),
  applyLinks: Array.from(document.querySelectorAll('.apply-link, .apply-button')).map(a => a.href || a.textContent),
  recruiter: document.querySelector('.hirer-name')?.textContent?.trim(),
  jobPostingDate: document.querySelector('.job-posted-date')?.textContent?.trim(),
  recruiterEmail: document.querySelector('.hirer-email')?.textContent?.trim(),
  recruiterProfileLink: document.querySelector('a.hirer-name')?.href,
})
```

## Language Requirement Patterns

These regex patterns (validated in `scripts/linkedin-extractor.mjs`) detect language requirements in job descriptions:

### Required language indicators
- `Required: {Language}`
- `Requirements: {Language}`
- `Must speak {Language}`
- `Fluent in {Language}`
- `{Language} is required`
- `Proficient in {Language}`
- `Mandatory: {Language}`
- `Essential: {Language}`

### Nice-to-have indicators
- `Nice to have: {Language}`
- `{Language} is a plus`
- `{Language} is nice to have`
- `Bonus: {Language}`
- `Preferred: {Language}`
- `Optional: {Language}`
- `Good to have: {Language}`

### Filter logic (validated in tests)

A job **passes** the language filter if:
1. No required languages are specified → pass
2. All required languages match the user's specified language → pass
3. Any required language does NOT match → skip

A "nice to have" language is **not** a requirement — jobs with only nice-to-have languages that differ from the user's language still pass.

## Known LinkedIn Behaviors

- Job search results are dynamically loaded — wait for `.job-card-container` to appear after search
- Some job descriptions are truncated with "Show more" — may need to click that button
- "Easy Apply" jobs have an inline application form; external apply links go to the employer's site
- Applicant count may be hidden or show "Be one of the first applicants"
- Recruiter info is often absent or shows "Hiring team" instead of a named person
- LinkedIn may show a login wall if the session cookie is not properly injected
