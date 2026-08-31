# ATS observability and question-answer policy

Use this reference for all job-application ATS helpers (LinkedIn external ATS, Ashby, Lever, Workday, SmartRecruiters, and future helpers).

## Workspace rule

Workspace-local files must be resolved from the Pi Agent launch/workspace directory, not hardcoded absolute paths:

- `jobhunter.sqlite`: `${process.cwd()}/jobhunter.sqlite` unless explicitly overridden with `--db`.
- `personal-info-cache.json`: `${process.cwd()}/personal-info-cache.json`.
- CV upload path in Selenium container defaults to `/home/seluser/job-hunter/CV.docx`, with `CV_PATH` / `--cv` override.
- Skill script paths should be derived from the helper file location (`import.meta.url`) rather than hardcoded `~/.pi/...` paths.

## Required-question policy

Before live submit:

1. Answer from `personal-info-cache.json` where the mapping is clear.
2. For voluntary disclosures, answers stored under company-specific sections are reusable global answers unless the user explicitly says a company needs different answers.
3. If a required question cannot be answered from cache or high-confidence derivation, do not submit. Ask the user for the answer.
4. Never submit with unmapped/unanswered required questions.
5. Do not print secrets or raw disclosure answers in terminal logs.

## Observability layer

For each application attempt, persist evidence in the workspace DB:

- `application_runs`: one row per attempt with run id, source, job id, ATS, helper, mode, status, phase, URL, and raw result.
- `application_question_answers`: one row per field/question/action with question text, redacted answer text, answer kind, source, sensitivity flag, and metadata.

Persist at least:

- text field answers,
- select/dropdown answers,
- radio/checkbox/button answers,
- skipped optional voluntary questions,
- unmapped/unanswered questions,
- resume/CV upload evidence,
- final run status/phase.

Redact sensitive values in logs and DB where appropriate:

- email as `[REDACTED]`,
- phone-like values as `[PHONE]` or `[REDACTED]`,
- voluntary-disclosure answer values should not be printed; save a source marker such as `VOLUNTARY_FROM_CACHE` when exact values are sensitive.

## Helper implementation pattern

- Start in `--no-submit` mode for a new ATS or new tenant variant.
- Record Q/A evidence even in `--no-submit` mode.
- Inspect saved Q/A rows before allowing live submit.
- In submit mode, block with a `*_needs_user_answers` phase if any required Q/A row is `unanswered` or clearly unmapped.
- Only mark DB `applied` after a real submitted/success confirmation.

## Lessons from Ashby, Lever, and SmartRecruiters

Ashby:

- Direct and routed no-submit tests should return `filled_no_submit` / `ashby_filled_no_submit`.
- Live submit should only happen after confirming no unmapped required questions.
- Visible Yes/No button groups need question-label extraction and exact answer logging.

Lever:

- Lever forms can expose demographic survey radios that look like normal required radios. Do not select the first radio blindly.
- Skip optional demographic survey groups unless explicitly mapped to cached voluntary answers.
- Avoid over-broad label extraction that fills Twitter/GitHub/Google Scholar/portfolio fields with the LinkedIn URL.
- Prefer relevant location choices (e.g. London/UK/remote/Switzerland) rather than first option.

SmartRecruiters:

- Route SmartRecruiters URLs from the main runner instead of returning `ats_not_supported` once a helper exists, even if the helper currently blocks on verification.
- The “I'm interested” transition can lead to a SmartRecruiters/DataDome sliding CAPTCHA. DOM/CDP may show a blank page while a screenshot shows the verification slider.
- Classify this state as `smartrecruiters_needs_user_verification` (or equivalent), save an `application_runs` row, and do not mark the ATS unsupported or the job as a normal application failure.
- After the user or a verified CAPTCHA recipe clears the gate, resume in `--no-submit` mode first to validate field fill, CV upload, city autocomplete, consent checkboxes, and Q/A observability.
- SmartRecruiters city/location fields must select from autocomplete suggestions, not merely type text.
- Ensure CV upload code avoids profile-image/photo file inputs.
