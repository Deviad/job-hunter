# Replace application automation with a minimal fail-closed surface

Parents: #1, #2

## Goal

Resolve the issue #2 attempt circuit breaker by removing the copied, profile-specific ATS mutation scripts instead of continuing to patch their many implicit defaults.

## Approach

- Publish `auto-job-application` as an agent-driven workflow with cache/authorization rules and read-only browser inspection, not a collection of copied one-off form mutators.
- Remove ATS scripts that click, select, or answer fields with embedded defaults.
- Retain only read-only/generic diagnostic helpers that do not submit forms or answer screening questions.
- Replace real job/employer identifiers in search tests with visibly synthetic identifiers and extend release gates to reject real-looking identifiers and composed Indeed job URLs.

## Acceptance Criteria

- [ ] `skills/auto-job-application/scripts/test-safe-application-surface.mjs` exits zero and proves the published script allowlist contains no form-submission or screening-answer helper.
- [ ] `node scripts/check-release-safety.mjs` exits zero and focused tests prove real-looking LinkedIn/Indeed job identifiers fail closed while reserved synthetic identifiers pass.
- [ ] `npm test`, `npm run test:skills`, and `npm run verify:release` exit zero.
- [ ] A fresh-context read-only audit reports no blocker or major privacy/release-surface finding.

## Non-Goals

- Rebuilding a generic ATS framework in this release.
- Publishing historical application scripts or evidence.
- Adding new application behavior.
