# Privacy-hardening the public release surface

Parent: #1

## Goal

Finish the privacy-safe publication slice after the third independent audit found that copied active skills still contained profile-specific defaults, real application evidence, and dangling references.

## Approach

- Make retained application helpers fail closed on unmapped screening controls; no first-option or implicit yes/no fallback.
- Replace profile-specific scorer/search skill prose with runtime-cache rules and generic examples while preserving tested role-classification code.
- Remove dated application evidence, real job URLs/identifiers, and company-specific run narratives from every bundled skill.
- Remove or repair references to files excluded from the release.
- Expand the release-safety scanner across every bundled skill, not only auto-application paths.

## Acceptance Criteria

- [ ] `node skills/auto-job-application/scripts/test-no-default-screening-answers.mjs` exits zero and proves unmapped Easy Apply radio/select controls are not clicked.
- [ ] `node scripts/check-release-safety.mjs` exits zero on the repository and focused tests prove it rejects dated skill references, real-looking job URLs, hardcoded sensitive answers, and dangling local references.
- [ ] `node scripts/check-local-profile-leaks.mjs` exits zero against the maintainer's canonical CV/cache.
- [ ] `npm test` and `npm run test:skills` exit zero.
- [ ] A fresh-context read-only audit reports no blocker or major privacy/release-surface findings; the JSON report is stored in the local ignored evidence ledger.

## Non-Goals

- Changing the tested role-classification algorithms.
- Adding new ATS automation behavior.
- Publishing historical application evidence.
