---
name: job-match-scorer
description: Scores saved jobs against the installing user's CV and local profile, persists fit and blocker evidence, and produces deterministic Apply/Skip recommendations. Use after job search and before salary enrichment or application.
allowed-tools: read bash
---

# Job Match Scorer

Score only from the installing user's local evidence. The repository contains no maintainer CV, work authorization, languages, salary, notice, relocation, or disclosure defaults.

## Inputs

Resolve `JOBHUNTER_HOME`, defaulting to `~/.job-hunter`:

- `CV.docx`
- `personal-info-cache.json`
- `jobhunter.sqlite`

Read the cache before evaluating languages, location, work authorization, sponsorship, relocation, notice, or other eligibility. Unknown values remain unknown.

## Workflow

### 1. Select Candidates

Score jobs saved by the current search that have a non-empty title and description. Do not rescore an existing result for the same search unless the caller requested it.

External discoveries require a successfully backfilled description. Report rows with missing descriptions rather than assigning a confident score.

### 2. Classify the Role

Use the shared classifier in `../job-hunter/scripts/role-taxonomy.mjs`. Query text is discovery context, not evidence. Listing-only classifications are provisional; refresh from the full job description when possible.

Keep the classifier label, confidence, reason, and taxonomy version with the result. Generic AI/cloud role taxonomy is product code; user eligibility and experience are runtime data.

### 3. Extract Requirements

Separate:

- mandatory skills and experience;
- preferred or nice-to-have criteria;
- language requirements;
- location and work-mode requirements;
- work-authorization, citizenship, clearance, and sponsorship requirements;
- compensation or travel constraints.

Do not turn a preferred criterion into a blocker. Preserve the source text supporting every mandatory requirement. Note that the inline scorer only recognizes a mandatory term when it appears in its requirement vocabulary or in an `experience with` / `knowledge of` phrase; a requirement worded outside both is not counted in the denominator, so review unassessed mandatory sentences rather than treating the score as complete.

### 4. Match Against Runtime Evidence

A criterion is matched only when supported by the CV or explicit cache data. Do not infer a technology, employer, certification, language, citizenship, or authorization from related experience.

Work-authorization logic is country-specific:

- read the user's value for the job's country;
- explicit no-sponsorship or citizenship requirements are blockers only when they conflict with that value;
- ambiguous eligibility wording remains unresolved;
- never derive authorization from nationality or residence.

Mandatory language requirements become blockers only when the user's cache does not support the language. Nice-to-have languages are gaps, not blockers.

### 5. Calculate the Score

Use the actual criterion counts produced by the scorer. Recompute every ratio and percentage from those counts before persisting or presenting it. Do not narrate a score separately from the formula.

The default application handoff threshold is `fit_score >= 60` when no hard blocker exists. Role-family labels and tailoring gaps inform the recommendation but do not silently override the numeric threshold.

### 6. Persist Evidence

Store the result in `match_results` with:

- `fit_score`
- `cta` (`Apply` or `Skip`)
- `stretch_label`
- blocker list
- mandatory criteria found and matched
- missing or unclear must-haves
- tailoring suggestions
- scoring basis and role-classification evidence

JSON columns must contain stringified JSON arrays or objects, not language-native arrays passed directly to SQLite.

### 7. Hand Off

After scoring:

1. Enrich salary evidence with `salary-calculator`.
2. Exclude stale jobs through the Job Hunter freshness gate.
3. Present every visible row with fit/category, role, salary provenance, posting age, reason/gaps, location/source, and clickable URL.
4. Hand application candidates to `auto-job-application` only after blockers and unknown required answers are resolved.

## Commands

The deterministic scorer is `scripts/score_jobs_inline.py`. It reads jobs from JSON and writes scored JSON; callers should use temporary files or pipes and then persist through argv-safe database code.

Run its focused tests with:

```bash
python3 scripts/test-score_jobs_inline.py
```

## References

- [Adjacent role threshold policy](references/adjacent-role-threshold-policy.md)
- [Adjacent AI role evidence](references/adjacent-ai-roles-title-gate.md)
- [Application handoff threshold](references/user-threshold-ge60-application-handoff.md)
