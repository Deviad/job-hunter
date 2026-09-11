# Personal Information Cache Contract

`$JOBHUNTER_HOME/personal-info-cache.json` contains user-provided application answers. It is local user data and must never be committed, logged, or printed.

## Minimal Shape

```json
{
  "schemaVersion": 2,
  "profile": {
    "firstName": "",
    "lastName": "",
    "email": "",
    "phone": "",
    "website": "",
    "linkedinUrl": "",
    "githubUrl": "",
    "address": {}
  },
  "workHistory": [],
  "education": [],
  "applicationPreferences": {},
  "workAuthorization": {},
  "companySpecific": {},
  "portalCredentials": {},
  "rolePreferences": {}
}
```

Empty strings mean unknown. Helpers must ask for required unknown values and leave optional unknown values blank.

## Role Preferences and Curated Overrides

`rolePreferences` is the curated search/scoring layer read by `skills/job-hunter/scripts/jh-profile.mjs` (and its Python twin `jh_profile.py`):

```json
{
  "rolePreferences": {
    "preferredPrimaryRoles": ["Platform Architect"],
    "adjacentRoles": { "adjacentTechnicalLeadership": [], "leadershipProgression": [] },
    "excludedTitleFamilies": ["early-career"],
    "taxonomy": { "schemaVersion": 1, "name": "...", "domainTokens": [], "disciplineTokens": [], "adjacentTitles": [], "leadershipTitles": [], "gapSkills": [], "queryExpansions": [], "queryExclusionTerms": [], "excludedTitleFamilies": [] }
  },
  "languages": { "English": "native", "German": "b1" },
  "skills": ["ansible"],
  "applicationPreferences": { "fitScoreThreshold": 60 }
}
```

`excludedTitleFamilies` names explicitly selected families from `skills/job-hunter/data/title-exclusions.json` or literal title phrases. No family is selected from the sector or a word in a target title. `rolePreferences.queryExclusionTerms` contains literal phrases confirmed during follow-up questions about acceptable adjacent roles. `taxonomy` is optional classifier vocabulary; examples must never supply default query preferences.

`languages` is the user's confirmed language configuration under `JOBHUNTER_HOME` (normally `~/.job-hunter/personal-info-cache.json`). CV-extracted languages are suggestions for follow-up questions and never automatically replace this configuration. `none` explicitly records a language the user does not speak; an absent language remains unknown. The model must confirm target roles, accepted adjacent roles, exclusions and languages before the first search, then save the user's answers. On CV refresh, preserve those answers and ask about changed or conflicting evidence. Curated skills are added to derived evidence.

Use `jh-profile.mjs review --json` to obtain suggestions, questions and an effective profile hash. After saving and confirming answers with the user, run `jh-profile.mjs confirm --expected-profile-sha <reviewed-hash>`. Confirmation writes only the private `profile-confirmation.json`, never rewrites answers, and fails if the reviewed profile changed. Search and scoring require a current confirmation. `adjacentRoles.acceptedRoles`, `conditionalRoles` and `excludedResponsibilityTerms` express sector-neutral preferences. CV, answer, reference-data and search-config changes require renewed review and invalidate incompatible checkpoints.

## Derived Profile

`$JOBHUNTER_HOME/profile-derived.json` is machine-generated from `CV.docx` by `jh-profile-extract.mjs`; never hand-edit it. It records `cvSha256`, `extractorVersion`, `referenceDataSha256`, `generatedAt`, and the extracted `skills`, `certifications`, `languages` (each with a `cv-span` evidence reference) and heuristic `titles`. The loader compares the recorded hash with the current CV on every use: a changed CV makes the profile `stale`, and the next search or scoring run rebuilds it before proceeding (`refresh: 'auto'`), `jh-profile.mjs refresh` rebuilds on demand, and `jh-doctor.mjs` reports the state. The file is private (mode 600) and is rejected by the release gate if it ever appears in the repository.

## Precedence

1. Company-specific answer for the current employer or ATS.
2. Explicit global profile or application preference.
3. A fact directly supported by the local CV when the field is factual and unambiguous.
4. Ask the user.

Do not derive work authorization from citizenship, disclosure answers from demographics, salary expectations from salary history, or consent from any unrelated answer.

## Sensitive Fields

Treat portal credentials, work authorization, salary history, demographic answers, disability information, and voluntary disclosures as sensitive. Keep them out of console output, application logs, screenshots, fixtures, and repository examples.

## Synthetic Examples

Repository tests and examples use reserved domains and visibly synthetic people, employers, phone numbers, and addresses. Real application records do not belong in skill references.
