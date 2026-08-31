# ATS Helper Observability

Helpers should expose enough state to diagnose failures without logging application answers.

## Structured Events

Record:

- ATS and job identifiers supplied by the caller;
- page stage and URL origin;
- required-field counts, filled-field counts, and unknown-field labels;
- upload attempted/accepted state;
- submit attempted/confirmed state;
- blocker category and elapsed time.

Do not record field values, credentials, cookies, demographic answers, disclosures, salary history, work authorization, screenshots containing personal data, or raw page HTML.

## Completion States

Use explicit states such as:

- `filled_no_submit`
- `submitted_confirmed`
- `blocked_unknown_required_answer`
- `blocked_authentication`
- `blocked_captcha`
- `failed_validation`
- `unconfirmed`

A click without a visible state change is `unconfirmed`, not success.
