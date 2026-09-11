# Role Preferences

Job Hunter does not assume a sector, career level, acceptable adjacent role or excluded profession.

## Confirmation Workflow

1. Upload the CV to `$JOBHUNTER_HOME/CV.docx` (default `~/.job-hunter`).
2. Run `jh-profile.mjs review --json`. The model reviews the CV evidence and asks which target roles, adjacent roles, languages and exclusions the user wants.
3. Save the answers in `personal-info-cache.json`. Empty adjacency and exclusion lists are valid.
4. Review again after saving. After the user confirms the answers, run `jh-profile.mjs confirm --expected-profile-sha <hash-from-review>`.
5. Search and score using the confirmed configuration.

A CV upload refreshes derived evidence automatically. It never overwrites answers. Changes to the CV, answers, reference data or search configuration invalidate confirmation; ask targeted follow-ups and reconfirm. A stale review hash cannot be confirmed. Direct role/language flags are explicit per-run choices, not inferred preferences.

## Configuration

`rolePreferences.preferredPrimaryRoles` lists target titles.
`rolePreferences.adjacentRoles.acceptedRoles` lists accepted adjacent titles.
`rolePreferences.adjacentRoles.leadershipProgression` lists accepted leadership titles.
The older `adjacentTechnicalLeadership` key remains readable for compatibility.
`rolePreferences.conditionalRoles` lists titles requiring additional discussion.
`rolePreferences.queryExclusionTerms` lists literal title phrases to exclude.
`rolePreferences.excludedResponsibilityTerms` lists literal responsibility phrases to exclude.
`rolePreferences.excludedTitleFamilies` selects bundled reference families or literal title phrases. Families are never selected automatically.
`rolePreferences.taxonomy.queryExpansions` may contain additional search phrases approved by the user.

`languages` maps language names to confirmed proficiency levels. `none` is an explicit negative answer. Missing languages are unknown. Search retains unknown language requirements for review; scoring does not recommend applying without confirmed mandatory-language proficiency.

## Classification

The matcher emits Primary role, Adjacent role, Leadership progression, Conditional, Out of scope or Unclassified. It matches literal phrases with word boundaries in the actual job title. Only explicit exclusions produce Out of scope. An unmatched title stays Unclassified, and requires review before an application recommendation. Query text never supplies classification evidence.

Descriptions can establish explicitly excluded responsibilities. Matching is deliberately conservative: it does not invent semantic equivalences, years of experience, leadership scope or skill gaps. The model can propose additional aliases during follow-up, but only confirmed preferences affect matching.

Listing-only confidence is capped. Scoring establishes fit from evidenced mandatory requirements independently of the role label. Unknown mandatory sentences remain in the denominator. Generic reference vocabulary recognizes terms but does not establish possession; skills-section terms from any sector carry literal CV spans.

Historical classification labels remain readable. Historical free-form titles need reclassification rather than a guessed mapping. No runtime module loads the AI-architect example.

## Identity and Storage

The effective profile hash covers the CV hash, curated answers, search config, extractor version and reference-data hash. Confirmation timestamps do not change it. Wrapper checkpoints record it and refuse incompatible or legacy resumptions. The Python adapter delegates to the same loader, so refresh, confirmation and hashing have one implementation.

The SQLite writer reclassifies with confirmed local preferences. Without those preferences it can retain job evidence as Unclassified; it never trusts a posting's claimed category or embedded taxonomy.
