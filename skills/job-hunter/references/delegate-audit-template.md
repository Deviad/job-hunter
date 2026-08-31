# Delegate audit template (job-hunter pipeline)

Remediation R7 (`references/search-safety-contract.md`): review-tier
delegate audits for job-search/discovery work must use artifact and structured-summary
acceptance, never semantic `requiredSubstrings`. Matching exact strings against a
delegate's free-form prose caused `REQUIRED_TEXT_MISSING` blocks on the 2026-07-20
GB/NL/IE run even when the delegate's findings were correct — the delegate phrased a
true finding differently than the literal string the acceptance block demanded.

Copy the shape below for every review-tier delegate dispatched against a job-hunter
story. Fill in the bracketed fields; do not add a `requiredSubstrings` key.

## Dispatch shape

```json
{
  "task": "<full self-contained task text — see body below>",
  "tier": "review",
  "difficulty": "hard",
  "background": true,
  "acceptance": {
    "requiredArtifacts": [
      "<absolute path the delegate must produce or reference, e.g. the ledger dir>"
    ],
    "requireStructuredSummary": true,
    "successCriteria": [
      "Every 'Verified: yes' claim in the ledger has evidence that actually supports it",
      "No two ledger entries assert contradictory facts",
      "Any stated aggregate (count, percentage, total) is recomputed from its components, not trusted",
      "No 'unverified' or 'unverified-recall' claim was used to gate an action or presented as settled fact",
      "Outcome lines (accepted/blocked/failed) match the claim content in the same file"
    ],
    "constraints": [
      "Do not edit any file outside the ledger/report paths named in the task",
      "Report findings as a numbered list; end with a '## Summary' section"
    ]
  }
}
```

## Task body template

```text
Audit the delegate evidence ledger at <ledger-dir-absolute-path> against the format
the current Pi supervisor evidence-ledger contract. Work file-by-file in sequence order (01, 02, ...):

1. For every 'Verified: yes' claim, check that its Evidence: line(s) actually support
   the claim — read the cited file/command output yourself, don't take the claim at
   face value.
2. Check cross-file consistency: no two ledger entries should assert contradictory
   facts about the same job, source, or run.
3. Recompute any stated aggregate (counts, percentages, totals) from its components
   using a tool, not mental arithmetic.
4. Confirm no claim flagged 'unverified' or 'unverified-recall' was used elsewhere in
   this story to gate an action or presented to the user as settled fact.
5. Confirm each entry's Outcome: line (accepted/blocked/failed) matches its claim
   content — a "completed successfully" claim body paired with Outcome: blocked is
   itself a finding.

Output: PASS, or a numbered findings list (one finding per violated check above, with
the ledger file and claim it applies to). End your response with a '## Summary'
section stating the overall verdict and finding count.
```

## Why this shape survives model phrasing variance

- `requiredArtifacts` checks that the delegate touched/produced the right file paths —
  a structural fact, not wording.
- `requireStructuredSummary` checks that a `## Summary` section exists — a structural
  fact.
- `successCriteria` is evaluated semantically (by the reviewing harness or the
  supervisor reading the response), not by literal substring match, so a delegate that
  says "the totals do not reconcile" satisfies "aggregates are recomputed" even though
  neither string appears in the other.

Never add `forbiddenSubstrings` or `requiredSubstrings` to a job-hunter review-tier
acceptance block for this reason. If a future acceptance check seems to need exact
wording, that is a signal the check belongs in `successCriteria` as a criterion
description instead.
