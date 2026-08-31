# Closed application handling

Session lesson: during UK/Indeed/LinkedIn application passes, some high-fit jobs may have applications closed by the time the apply flow is reached. Treat this as an availability outcome, not a match-quality outcome.

Policy:

1. Detect closed/unavailable pages before spending time filling forms.
2. Closed applications are terminal for that job in the current run; do not repeatedly retry them.
3. Mark the job as `failed` in the current schema because `jobs.application_status` has no dedicated `closed` value.
4. Record the specific phase/reason in `application_runs` when possible, e.g.:
   - `closed_no_longer_accepting`
   - `workday_closed_or_missing`
   - `smartrecruiters_closed_or_missing`
   - `lever_closed_or_missing`
   - `ashby_closed_or_missing`
5. Continue with the next job instead of letting one closed job stall the batch.
6. In the final report, separate closed/unavailable jobs from other failures:
   - applied
   - closed/no longer accepting
   - CAPTCHA/login/verification blocked
   - unsupported/manual ATS
   - still pending

Detection phrases:

- "no longer accepting applications"
- "applications closed"
- "job is no longer available"
- "job has been removed"
- "position filled"
- "not found" / 404 on an ATS job page
- Workday: "page you are looking for doesn't exist"

Important reporting nuance:

If a job scored well but is closed, do not describe it as a bad or discarded match. Say it was a good/eligible match but unavailable at application time.
