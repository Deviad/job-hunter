# ATS Helper Hardening

Reusable ATS helpers must be deterministic, cache-driven, and fail closed.

## Requirements

- Resolve user data from `$JOBHUNTER_HOME`, never from the launch directory.
- Pass URLs, paths, and SQL through argv arrays rather than interpolated shell commands.
- Keep one browser tab per application and close only the tab the helper created.
- Read required identity and application answers from `personal-info-cache.json`.
- Leave unknown optional answers blank and report unknown required answers.
- Never embed work authorization, sponsorship, employment history, salary, demographic, disclosure, consent, or product-use answers in source.
- Verify file upload state and visible submission confirmation.
- Emit structured status without answer values, credentials, or page secrets.

## Promotion Gate

A helper is reusable only after a no-submit test against its real ATS demonstrates field discovery, framework event handling, upload behavior, validation repair, and safe unknown-question handling. Keep application-specific evidence outside the skill repository.
