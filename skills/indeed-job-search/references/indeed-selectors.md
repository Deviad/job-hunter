# Indeed Selector Notes

Indeed changes markup frequently. Prefer resilient data attributes and JSON-LD over class names.

## Search result pages

Candidate selectors for job keys:

- `[data-jk]`
- `a[data-jk]`
- `a[href*="jk="]`
- `a[href*="vjk="]`
- `a[href*="/rc/clk"]`

For each search card, derive fields from the closest ancestor with `data-jk`, `td.resultContent`, `div.job_seen_beacon`, or `li`.

Common field selectors:

- Title: `h2 a span[title]`, `h2.jobTitle span[title]`, `[data-testid="jobTitle"]`, `a[data-jk] span`
- Company: `[data-testid="company-name"]`, `.companyName`, `[data-testid="companyName"]`
- Location: `[data-testid="text-location"]`, `.companyLocation`, `[data-testid="job-location"]`
- Salary/snippets: `[data-testid="attribute_snippet_testid"]`, `.salary-snippet`, `.metadata.salary-snippet-container`
- Posted date: `[data-testid="myJobsStateDate"]`, `.date`, `.result-footer`

## Job detail pages

Prefer JSON-LD `JobPosting` from:

```css
script[type="application/ld+json"]
```

Useful JSON-LD fields:

- `title`
- `hiringOrganization.name`
- `jobLocation.address.addressLocality`
- `jobLocation.address.addressRegion`
- `jobLocation.address.addressCountry`
- `description`
- `datePosted`
- `validThrough`
- `baseSalary`

DOM fallbacks:

- Title: `h1`, `[data-testid="jobsearch-JobInfoHeader-title"]`
- Company: `[data-testid="inlineHeader-companyName"]`, `[data-company-name]`, `a[href*="/cmp/"]`
- Location: `[data-testid="job-location"]`, `[data-testid="inlineHeader-companyLocation"]`, `#jobLocationText`
- Description: `#jobDescriptionText`, `[data-testid="jobsearch-JobComponent-description"]`, `[id*="jobDescription"]`
- Salary: `[data-testid="jobsearch-JobInfoHeader-salary"]`, `[aria-label*="Salary"]`
- Apply: `button:has-text("Apply")`, `a[href*="apply"]`, `a[href*="/apply"]`, `[data-testid*="apply"]`

## Verification / stop conditions

Stop extraction and ask the user to intervene if page text contains:

- `verify you are human`
- `unusual traffic`
- `captcha`
- `security check`
- `additional verification required`

## Notes

- Indeed may localize labels and domains. Keep extraction based on structure/attributes where possible.
- Some external apply links are only revealed after clicking Apply. Do not click them during search unless the user explicitly asks to apply.
- If a card lacks a stable job key, skip it rather than saving an unstable URL-derived ID.
