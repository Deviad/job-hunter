# Job Hunter

Complete job-search pipeline for [Pi Agent](https://github.com/earendil-works/pi) — search, score, salary enrichment, and assisted applications.

## Prerequisites

| Layer | Requirement | Stage |
|-------|-------------|-------|
| Runtime | Node.js ≥ 22, `uv` ≥ 0.4 | Install |
| Code | `npm ci` in repo root | Install |
| Workspace | `$JOBHUNTER_HOME` (default `~/.job-hunter`) with `jobhunter.sqlite`, `CV.docx`, `personal-info-cache.json` | Init |
| Browser | Chromium CDP on `127.0.0.1:9225` (Selenium container) | Search, Apply |
| Search | SearXNG on `127.0.0.1:8888` | Discover |
| Vision (optional) | LM Studio on `127.0.0.1:1234` with Qwen VLM | CAPTCHA, Debug |
| MCP (optional) | Obscura, Apple Mail MCP servers | Browse, Outreach |

Host tools (`docker`, `sqlite3`, `python3`) must be installed and on `PATH` — the doctor (`jh-doctor`) diagnoses which are missing but does not install them.

## Installation

```bash
git clone https://github.com/Deviad/job-hunter.git && cd job-hunter
npm ci
node scripts/install.mjs          # copies skills into ${PI_AGENT_HOME:-~/.pi/agent}/skills/
node scripts/install.mjs --dry-run  # preview without writing
```

Re-run is idempotent and never overwrites `CV.docx`, `personal-info-cache.json`, or `jobhunter.sqlite`.

## Initialization

```bash
node ~/.pi/agent/skills/job-hunter/scripts/jh-init.mjs
```

Before applying, populate `~/.job-hunter/CV.docx` and the `profile.firstName`, `profile.lastName`, `profile.email`, and `profile.phone` fields in `~/.job-hunter/personal-info-cache.json`. Application helpers fail closed when required identity fields are absent; the repository contains no maintainer identity defaults.

### Profile

Search, filtering and scoring read the user's roles, languages and skills from one profile loader instead of built-in defaults. Two layers feed it:

- `~/.job-hunter/personal-info-cache.json` holds confirmed preferences: target titles, accepted adjacent roles, excluded families and literal `rolePreferences.queryExclusionTerms`, plus `languages` (language-to-proficiency map) and optional skills. After analyzing the CV, the model asks follow-up questions and saves the user's answers here. Missing languages remain unknown; `none` records an explicit negative answer. No sector's roles are excluded by default from query expansion.
- `~/.job-hunter/profile-derived.json` holds skills, certifications, language suggestions and title lines extracted from `CV.docx`. Its CV hash triggers automatic re-extraction after an upload. Confirmed language and role preferences survive refresh; changed evidence prompts follow-up questions rather than replacing user answers.

```bash
node ~/.pi/agent/skills/job-hunter/scripts/jh-profile.mjs status    # current | stale | missing | no-cv
node ~/.pi/agent/skills/job-hunter/scripts/jh-profile.mjs show      # merged profile (no personal defaults)
node ~/.pi/agent/skills/job-hunter/scripts/jh-profile.mjs refresh   # force re-extraction now
```

Country and Indeed-domain defaults come from `~/.job-hunter/search-config.json` (its `countries` keys are the target countries) over the generic table in `skills/job-hunter/data/indeed-domains.json`. Every script accepts explicit flags that override the profile; none falls back to a built-in personal value.

### Doctor

Run the doctor before each search or application session. It distinguishes required failures from optional degraded capabilities.

```bash
node ~/.pi/agent/skills/job-hunter/scripts/jh-doctor.mjs
```

## External Services

Start Selenium and SearXNG:

```bash
export SEARXNG_SECRET="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")"
docker compose up -d
bash scripts/rehearse-compose.sh    # isolated health-check rehearsal with teardown
```

See `docs/prerequisites.md` for full host-tool list and `docs/security-and-privacy.md` for security boundaries.

## Workflow

### Search

```bash
node ~/.pi/agent/skills/job-hunter/scripts/jh-search.mjs --source linkedin --country GB --role "Software Engineer"
node ~/.pi/agent/skills/job-hunter/scripts/jh-search.mjs --source indeed --country GB --query "Software Engineer"
node ~/.pi/agent/skills/job-hunter/scripts/jh-discover.mjs --locations "United Kingdom" --queries "Software Engineer"
```

### Score

Ask Pi to score the saved jobs. The `job-match-scorer` skill reads the user's CV and workspace profile rather than repository defaults.

### Salary

```bash
node ~/.pi/agent/skills/salary-calculator/scripts/enrich-job-salary.mjs --db ~/.job-hunter/jobhunter.sqlite --all-unsalaried
```

### Apply

Ask Pi to apply to a scored job. The `auto-job-application` skill uses the user's local CV, cache, and authenticated Chromium session; there is no repository-level submit command.

### Pipeline status and backup

```bash
node ~/.pi/agent/skills/job-hunter/scripts/jh-status.mjs
node ~/.pi/agent/skills/job-hunter/scripts/jh-backup.mjs
```

## Development checks

Run `npm test` for regression tests and `npm run verify:release` for publication checks. Neither requires private research-baseline artifacts; the profile comparison explicitly skips when no local maintainer cache is available.

`npm run verify:research-baseline` is a separate acquisition checkpoint. It requires the private US-001 evidence and original repository/installed runtime sources. Run it before intentional runtime edits, not as a regression gate against changed sources. Its assertions remain strict; historical reports retain the paths used when they were recorded.

## Update

```bash
git pull && npm ci && node scripts/install.mjs
```

## Uninstall

```bash
node scripts/install.mjs --uninstall
```

Removes only files recorded in the installation manifest. User data (`CV.docx`, DB, cache) is untouched.

## Troubleshooting

```bash
node ~/.pi/agent/skills/job-hunter/scripts/jh-doctor.mjs    # full diagnostic
```

Common issues:

- **CDP not reachable**: ensure `docker compose up -d` ran and `curl -s http://127.0.0.1:9225/json/version` returns JSON.
- **SearXNG 502**: SearXNG needs a few seconds after container start; retry after 5s.
- **better-sqlite3 build failure**: ensure `python3` and a C compiler (Xcode CLT on macOS) are installed.
- **MCP "Not connected"**: run the repair skill or `bash scripts/rehearse-compose.sh` to verify transport.

## Security and Privacy

- All job-search data, credentials, and browser sessions stay on your machine.
- The installer never reads or transmits personal files.
- Authenticated browser sessions (LinkedIn, Indeed) belong to you — this project does not bypass MFA, or site access controls.
- See `docs/security-and-privacy.md` for the full policy.

## License

MIT — see `LICENSE`.
