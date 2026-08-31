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
