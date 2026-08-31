# Security and Privacy

## Local Data Locations

All job-hunting data lives under `$JOBHUNTER_HOME` (default `~/.job-hunter`):

| File | Content | Sensitive? |
|------|---------|------------|
| `jobhunter.sqlite` | Jobs, scores, salary, applications | Yes — contains work history, salary expectations |
| `personal-info-cache.json` | Work auth, salary, notice, demographics | Yes — PII and employment details |
| `CV.docx` | Resume | Yes |
| `optional_documents/` | Cover letters, uploads | Yes |
| `apply_logs/` | Per-application run logs | May contain form answers |
| `backups/` | Timestamped DB snapshots | Yes — mirror of DB |

None of these files are tracked in Git. `.gitignore` excludes them.

## Sensitive-File Exclusions

The release-safety gate (`scripts/check-release-safety.mjs`) scans all tracked files and rejects:

- Filepaths matching personal-data patterns (`.sqlite`, `.docx` outside `examples/`, `.env`, `personal-info`)
- File content containing real email addresses, phone numbers, API keys, or tokens
- Absolute host-specific paths (`/Users/`, `/home/`) in bundled skill files

## Credential Handling

- Credentials live in `personal-info-cache.json` and authenticated browser cookies — never in this repository.
- The installer copies only skill code, never workspace data.
- Docker Compose binds `$JOBHUNTER_HOME` into the Selenium container for CV uploads; the Compose file itself contains no credentials.

## Authenticated-Browser Boundaries

- LinkedIn and Indeed sessions are user-managed. The project does not store, export, or replay credentials.
- CAPTCHA, MFA, and access-control challenges are the user's responsibility. The `captcha-resolution` skill provides a local-vision assist for image-grid CAPTCHAs but does not bypass site security measures.
- Brave-to-Obscura cookie relay (`brave-obscura-session`) operates on same-origin cookies within the user's own browser session. It never transmits cookies to third parties.

## CAPTCHA and Access-Control Policy

- `captcha-resolution` uses a local Qwen VLM (LM Studio) to identify image-grid tiles. It runs entirely on your machine.
- The project does not use third-party CAPTCHA-solving services.
- If a site blocks automation, the skill halts and surfaces the block. No retries that could violate terms of service.

## Backup Expectations

- `jh-backup.mjs` creates timestamped snapshots in `$JOBHUNTER_HOME/backups/`.
- Backups are local-only. The project never uploads backups anywhere.
- The installer does not create or modify backups.

## Disclosure Implications

- Applying to jobs is an externally visible action. The project applies only when the user instructs it to.
- Outreach emails (via Apple Mail MCP or manual) are sent only with explicit user authorization.
- No application data is shared with this project's maintainers or any third party.
