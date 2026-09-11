# Profile Generalisation Handoff

Date: 2026-09-11. Branch: `issue-profile-generalisation`, based on `d0f3c54`.
Implementation is uncommitted and has not received independent acceptance review.

## Implemented

- CV evidence is derived into `profile-derived.json`, with CV, extractor and
  reference-data hashes. Standard-library ZIP/XML parsing reads the same CV
  snapshot that is hashed. JavaScript and Python callers share one loader.
- User answers in `personal-info-cache.json` control target roles, accepted
  adjacent roles, title/responsibility exclusions and language preferences.
  CV suggestions never silently become preferences. No title family is
  automatically excluded because the user works in a particular sector.
- The model-facing workflow asks follow-up questions after CV analysis. An
  explicit confirmation records the reviewed effective hash in a separate
  `profile-confirmation.json`; confirming never rewrites user answers.
- CV, preferences or search-configuration changes invalidate confirmation.
  Profile-backed entrypoints refresh evidence and require review again.
  Search resume checks both effective profile identity and search options.
- Search, collection, persistence and scoring use the same explicit taxonomy.
  Unmatched titles remain Unclassified rather than receiving a technology-role
  default. Unknown language requirements remain review items, not invented
  language exclusions. Scoring retains unknown mandatory requirements.
- Reporting uses shared category labels and configured fit thresholds.
  Documentation, templates, dependency declarations and synthetic tests updated.

## Verification

All verification used local synthetic fixtures. No LinkedIn access, canonical
workspace modification, live installation, application, commit or push occurred.
Installed-skill tests installed only into disposable test directories.

- `npm test`: 116 passed, zero failures or skips.
- `npm run test:skills`: 22 of 22 installed-skill suites passed.
- `npm run verify:release`: passed all six checks.
- `git diff --check`: passed.
- Healthcare and construction fixtures exercise actual extraction, query,
  classification and scorer paths. Other taxonomy fixtures cover additional
  sectors. Tests also cover changed CV/preferences/configuration, stale
  confirmation, JS/Python parity and symlink-invoked confirmation CLI behavior.

## Limits and Remaining Review

- Matching is deliberately literal and conservative. Synonyms and acceptable
  adjacent roles must be captured through user follow-up, not sector assumptions.
  CV section extraction is heuristic; extracted titles are suggestions only.
- Independent code review and release approval remain outstanding. Green local
  commands are not acceptance of the wider research-safety PRD or Part C.
- The privacy gate still retains its historical `rolePreferences` exemption;
  removing it needs a separate distinction between private preference text and
  public role phrases in synthetic fixtures/examples. Current gate success does
  not prove that every role-related string is free of profile influence.
- External discovery's country-label normalization still has its older limited
  alias map. Search targets themselves come from user configuration; broader
  normalization coverage remains a follow-up.
- Fully specified legacy CLI paths retain compatibility where no profile exists;
  they do not acquire personal defaults. Review these explicit bypass paths before
  declaring a universal profile-confirmation requirement.
