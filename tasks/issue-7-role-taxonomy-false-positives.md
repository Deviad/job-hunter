# Stop the role classifier vetoing eligible AI architecture roles

Parents: #1, #2

## Goal

Make `skills/job-hunter/scripts/role-taxonomy.mjs` classify software and AI architecture
postings the way `references/role-taxonomy.md` already specifies, so an eligible role can no
longer be pushed to `Out of scope` — and therefore out of the Apply queue by
`score_jobs_inline.py`'s blocker conversion — on incidental prose wording.

## Approach

Treat it as conformance to the documented boundary rather than a new policy. Three
independent unbounded matches against whole-description prose were producing the vetoes, so
each is bounded to the evidence the doc names, and the rules version is advanced so rows
classified by the defective rules are detectable rather than trusted.

- Require construction evidence to be a qualified discipline (`structural engineering`,
  `landscape design`) or a built-environment artefact (`bim`, `revit`, `autocad`,
  `shop drawings`); leave the title-level pattern alone so explicit construction titles
  still exclude.
- Let body-side construction wording yield to technical AI architecture evidence, and record
  the override as a `descriptionSignals` entry instead of dropping it.
- Require a technical-architecture denial to place the negation next to both an ownership
  noun and a technical noun.
- Accept `technicalOwnership || (aiArchitecture && technicalArchitecture)` in the
  commercial/governance branch, which is the condition its own `Conditional` reason states.
- Bump `ROLE_TAXONOMY_VERSION` to `'2'`; add gold cases from the observed patterns; derive the
  semantic-shadow expectations from the prototype split instead of fixture-size literals.

## Acceptance Criteria

- [x] Qualified construction evidence still excludes. `test-role-taxonomy.mjs` adds
      `qualified construction body evidence still excluded` and
      `interior and landscape design body evidence still excluded`, and the pre-existing
      `AI Building Architect` case is unchanged; `node skills/job-hunter/scripts/test-role-taxonomy.mjs`
      reports `PASS (69 table cases)`.
- [x] Figurative prose no longer vetoes. `structural tests, linting rules` and
      `the fast-evolving AI landscape` cases resolve to an eligible label, encoded as two new
      gold cases (`exact-figurative-structural-tests`, `customer-figurative-ai-landscape`) and
      matching table cases.
- [x] Stated denials still deny. `stated denial of architecture ownership excludes` asserts
      `technicalArchitecture === false` while `governance rule about production is not a
      denial of architecture scope` asserts `true`, so the two discriminate on exactly the
      driving signal.
- [x] Real-data effect, not a hand-picked case. Reclassifying all 213 rows of a live scored
      queue: `Out of scope` 160 → 135, all 25 moves out of exclusion (20 Conditional,
      5 Exact architecture), 0 moves into exclusion, and `Out of scope` on
      AI/architecture-titled rows 11 → 0.
- [x] End to end. The same 11 rows score `cta = Apply` under a throwaway `search_id` that
      wrote zero rows to the database (11/11, six at 100% `Core fit`).
- [x] Version discipline. `ROLE_TAXONOMY_VERSION === '2'` asserted in the taxonomy test;
      `node skills/job-hunter/scripts/jh-classify-audit.mjs --json` reports
      `taxonomyVersion: "2"` with prior rows counted as `staleVersion`, never `currentVersion`.
- [x] Release surface intact. `npm test` 68/68 pass and `npm run verify:release` is clean on
      all six gates, including `check-release-safety` and `check-local-profile-leaks`; the
      added gold and test content carries no real job identifiers, URLs, or host paths, per
      #2's exclusion rule.
- [ ] Published. Branch pushed and pull request opened to `main`, with CI green.

## Non-Goals

- No change to `score_jobs_inline.py`'s blocker semantics.
- No change to the data-stretch boundary. The existing `data-eval` gold case asserts
  `expectedEligible: true` while both the pre-fix and post-fix rules return `Out of scope`
  (`dataDominated=true`); that disagreement predates this work and needs its own adjudication.
- No change to `aiArchitecture` centrality for titles without an AI token, and no extension of
  `PRODUCT_MANAGER_PATTERN` to `Product Owner`. Both are named in the issue as follow-ups;
  this slice removes vetoes, it does not add them.
- No backfill of labels already stored by rules v1.
