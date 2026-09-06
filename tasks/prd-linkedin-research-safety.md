# PRD: LinkedIn research safety without losing research capability

Status: **Plan only; implementation not started.**

Plan of record: this file, following the repository's `tasks/prd-*.md` convention. No code changes, deployment, application submissions, commits, pushes, or pull requests are authorized by this document. Each story starts at attempt 0. Update its checkbox and evidence in the same implementation slice that satisfies it; update this plan before changing scope.

Research date: 2026-09-06. Repository baseline: `a7054d769fd820aa866d040b010b1fea5ef1c401`, branch `issue-7`; working tree was clean before this document was created. That branch belongs to previous work: choose the new issue branch before implementation rather than mixing features.

## 1. Overview

The user needs automated job research that retains LinkedIn discovery and produces CV-grounded matches, compensation comparisons by company/role/location, and UK sponsorship evidence. The immediate problem is a reported LinkedIn account restriction for unusually high-volume **profile data** access. It has not been established which process caused that restriction.

The objective is to eliminate unnecessary access and inconsistent restriction handling while retaining the research workflow. It is **not** to claim that automation can be made undetectable. A smaller request count is an engineering improvement, not proof that LinkedIn permits the access or will not restrict it.

### Agreed product boundaries

- Preserve LinkedIn as a discovery source; do not silently replace it with another board or shrink requested country/role coverage.
- Fetch a needed posting once, retain usable evidence, and do matching/filtering/reporting against saved data.
- Reuse cached content for salary and sponsorship extraction; use employer/ATS and official sources for additional evidence where accessible and permitted.
- Stop on restrictions instead of retrying through them. Continue local analysis and independently available sources, reporting missing LinkedIn coverage explicitly.
- No automated LinkedIn requests during the current restriction, including diagnostics, salary enrichment, refreshes, and fallback helpers.
- No proxy/account rotation, fingerprint spoofing, simulated-human interactions, CAPTCHA bypass, or alternative sessions to route around a restriction. Existing masking is not a safety guarantee and must not become the basis for acceptance.

### Research findings: observations, not incident attribution

Paths below exist in the repository at the baseline. Line numbers are research pointers and will move after editing.

| Observation | Evidence | Consequence for the plan |
|---|---|---|
| Normal orchestration already bounds source/country runs and preflights the exact search URL. | `skills/job-hunter/scripts/jh-search.mjs`, `runCdpPreflight()` around line 197; `skills/job-hunter/references/search-safety-contract.md`. | Extend existing orchestration; do not invent a second search framework. Guard before preflight because the preflight itself loads a page. |
| Search already skips stored jobs with non-empty descriptions and supports explicit refresh IDs. | `skills/linkedin-job-search/scripts/search-linkedin-jobs.mjs`, `loadExistingJobIds()` around line 271 and query filtering around line 1316. | Improve reuse across consumers; do not describe deduplication as a missing feature. A failed DB lookup currently returns an empty set, which can defeat deduplication. |
| JD backfill repeatedly retries blocked pages without a terminating condition in that branch. | `skills/linkedin-job-search/scripts/batch-fetch-jds.mjs`, `processJob()` around lines 660–676: `while (true)`, blocked check, sleep, `continue`. | First mechanical fix: return a terminal block and stop the batch immediately. |
| Search has a finite retry policy but allows multiple blocking outcomes before its origin circuit breaker trips. | `skills/linkedin-job-search/scripts/retry-policy.mjs`, module contract around lines 7–20; `search-linkedin-jobs.mjs`, `scrapeJob()` around lines 862–906. | LinkedIn restriction states need immediate origin-wide stopping, distinct from transient transport failures. |
| A shared lease/budget implementation already exists and explicitly fails open on several errors. | `skills/linkedin-job-search/scripts/cdp-lease.mjs`, module contract and `createSharedBudget()`; `search-linkedin-jobs.mjs`, `enforceRateLimit()` around lines 541–545. | Reuse the component, but add a strict LinkedIn path that cannot silently continue when coordination fails. |
| The LinkedIn salary adapter independently fetches the job URL. | `skills/salary-calculator/scripts/sources/linkedin.mjs`, `fetchExactSalary()` around lines 50–62; `skills/salary-calculator/scripts/lib/enrich-pipeline.mjs` calls it with a saved job row. | Parse saved description content first; salary-only work must not reopen LinkedIn. The adapter comment claiming a request rate respects terms is not evidence of permission. |
| The inline scorer parses the CV as a sanity check but uses hardcoded skill inventories for matching. | `skills/job-match-scorer/scripts/score_jobs_inline.py`, `CV_SKILLS` near line 39, matching near line 389, and `extract_cv_text(cv_path)` near line 568; compare runtime-evidence requirements in `skills/job-match-scorer/SKILL.md`, sections 4–5. | Include a separate, versioned correctness slice. Preserve capabilities, not incorrect historical scores. Every changed result must be explainable by evidence. |
| Installed and repository versions differ. | Byte comparisons differed for `jh-search.mjs`, `search-linkedin-jobs.mjs`, `batch-fetch-jds.mjs`, and the LinkedIn salary adapter. `linkedin-page-state.mjs` matched. Inspected differences include installed country/search configuration support. | Record and reconcile individual differences before deployment; never overwrite the installed tree blindly or bulk-copy it upstream. |
| A real saved-data slice is available without LinkedIn access. | Read-only SQLite query returned 20 LinkedIn rows with descriptions and populated application-link fields. Workspace CV and existing job, score, salary, and metadata tables were present. | Real offline integration is feasible; fake inputs alone are insufficient for acceptance. Populated links have not been validated as working external destinations. |
| No dedicated sponsorship implementation appeared in the scoped source scan. | Sponsorship matches in the inspected skills were guidance, not a sponsor-register importer/resolver. | Add this as a separate enrichment capability; do not claim it already exists. |

Unknown: actual request history, active scheduled jobs, extensions, connected applications, member-profile navigation, browser background/subresource traffic, and LinkedIn's internal detection threshold. Static code findings are plausible contributors, not proof of the restriction's cause.

### External evidence verified during planning

- LinkedIn User Agreement: <https://www.linkedin.com/legal/user-agreement>. The fetched text prohibits scraping/copying service data, unauthorized automated access, and circumventing access/use limits. There is no verified safe requests-per-minute exception. This plan does not establish access permission or guarantee account safety.
- Official UK sponsor register: <https://www.gov.uk/government/publications/register-of-licensed-sponsors-workers>. The page linked a current CSV. A bounded real fetch returned HTTP 206 and parsed these headers: `Organisation Name`, `Town/City`, `County`, `Type & Rating`, `Route`. The inspected slice contained `Skilled Worker` and another route; route filtering is necessary.
- Skilled Worker job guidance: <https://www.gov.uk/skilled-worker-visa/your-job>. It distinguishes an approved employer, a qualifying job offer, and a certificate of sponsorship. A register match alone is not evidence that a particular vacancy offers sponsorship.
- Search-engine results were irrelevant to the requested queries and were not used as evidence. Official pages above were fetched directly without an authenticated LinkedIn session.

## 2. Goals

1. Every unchanged saved-posting analysis pass performs **zero LinkedIn navigations or HTTP fetches** for CV scoring, compensation parsing, sponsorship extraction, sorting, or report generation.
2. After the first observed restriction, no new LinkedIn job/profile/search navigation is admitted by any covered entrypoint. A persisted pause survives process restart. Already-sent requests cannot be retroactively prevented; identify them separately.
3. Preserve the full requested search scope. Every requested query and discovered job has an explicit completed, cached, excluded-with-reason, failed, or deferred outcome; none disappears because a batch/budget limit was reached.
4. Every matched CV criterion, salary, and sponsorship conclusion retains its evidence and uncertainty. Listing-only records are not presented as fully assessed jobs.
5. Keep implementation small: extend existing SQLite storage, search wrapper, classifier, retry policy, lease/budget, salary parser, scorer, and report gate. No new browser, background service, queue broker, or replacement application workflow.

## 3. User Stories

**Proof convention:** existing test paths are identified below. Paths explicitly marked **new** are deliverables to create under existing directories, not claims that those files already exist. Private evidence belongs under `$JOBHUNTER_HOME/runs/<run-id>/research-safety/`, never in published fixtures. All criteria are currently unchecked. There is no existing root lint/typecheck command in `package.json`; do not invent one. Run the relevant tests plus syntax checks for touched modules.

### US-001: Establish the actual runtime and preserve a baseline

**Description:** As the maintainer, I want a source/runtime inventory so that changes address the scripts actually used without losing installed functionality.

**Implementation steps:**
1. Record repository HEAD/status and checksums of the installed/repository entrypoints named in Overview. Inspect exact differences; classify each as runtime configuration, portability/dependency repair, or behavioral drift.
2. Follow imports and process launches from search, backfill, salary, discovery, visible-listing helpers, and application handoff. Inventory every LinkedIn navigation/fetch path, including preflight and direct/debug commands. Do not execute them against LinkedIn.
3. Inspect available local process/scheduler/log metadata and extension manifests read-only. Do not export cookies, tokens, private cache contents, or full profiles. Missing logs mean unknown, not zero traffic. Do not disable anything without separate operational approval.
4. Use SQLite's backup facility to make a private integration copy, including committed WAL data. Select a deterministic saved slice by source/job ID. Record selected identities privately, description hashes, current scores, and salary provenance. Do not change the canonical DB.
5. Append the finalized caller inventory and reconciliation decisions to this issue before editing affected components. If another navigation path is discovered later, update the inventory and its test coverage first.

**Acceptance Criteria:**
- [ ] Private `runtime-inventory.json` exists with per-file hashes, caller relationships, drift decisions, and evidence references; its summary explicitly distinguishes observed execution from static capability.
- [ ] Private `baseline.json` identifies the bounded real saved-job slice and original source/description/score evidence; a read-only query and backup integrity check are recorded in `baseline-check.json`.
- [ ] Repository/installed checksums after research equal the before-research checksums; `baseline-check.json` records that no LinkedIn page was requested and no source/installed script was edited.

### US-002: Stop the JD backfill loop on the first block

**Description:** As the account owner, I want a detected restriction to terminate backfill rather than cause repeated retries.

**Implementation steps:**
1. Change only the blocked branch and its propagation in `batch-fetch-jds.mjs` first. Replace blocked-page sleep/retry with a structured terminal result containing page state and reason.
2. Stop scheduling the remaining batch. Preserve already successful descriptions; leave blocked/deferred jobs eligible for a later explicitly authorized run without storing the restriction notice as their JD.
3. Keep the existing page classifier as the authority; do not duplicate restriction regexes in the batch runner. Export a side-effect-free seam if needed for tests, without running the CLI on import.
4. Keep transport timeout handling separate. A blocking page must not be caught and reclassified as an ordinary retryable error.

**Acceptance Criteria:**
- [ ] **New** `test/research-backfill-stop.test.mjs`, test `first restriction ends backfill`, runs the actual batch control flow against a local response fixture and observes no second attempt or subsequent job navigation after the block.
- [ ] The same test file's `restriction never replaces a saved description` asserts the saved JD is unchanged and remaining IDs appear as deferred in the terminal result.
- [ ] `node skills/linkedin-job-search/scripts/test-page-state.mjs` and `node --check skills/linkedin-job-search/scripts/batch-fetch-jds.mjs` pass; command results are recorded in the story evidence.

### US-003: Persist a LinkedIn pause and enforce it before all access

**Description:** As the account owner, I want one durable pause that all LinkedIn research entrypoints obey, including after a restart.

**Implementation steps:**
1. Add the source-access state and API described in Technical Considerations using existing `jh_meta`. Add idempotent initialization in `skills/job-hunter/scripts/jh-migrate.mjs`.
2. Add **new** `skills/job-hunter/scripts/linkedin-access.mjs` for reading/transitions and **new** `skills/job-hunter/scripts/jh-linkedin-access.mjs` for explicit operator status/pause/resume actions. CLI status is read-only.
3. Check state before opening a target, navigating, reloading, fetching, or executing an exact-URL preflight. Integrate `jh-search.mjs`, `cdp-preflight.mjs`, `search-linkedin-jobs.mjs`, `batch-fetch-jds.mjs`, and every additional caller documented in US-001. `--skip-preflight` must not skip the access gate.
4. On `blocked`, `rate_limited`, `active_challenge`, or a login-required/manual-intervention state, persist the pause before releasing the active owner; do not automatically reset it after a timer, new country, new query, process restart, or published restriction-expiry time.
5. Restrict automated top-level LinkedIn navigation to the required jobs routes. Reject member/profile/company exploration for this research workflow. Preserve URLs already embedded in a posting without following recruiter/member links. Inventory browser-generated requests separately rather than claiming a top-level allowlist controls all subresources.
6. The known restricted installation must start paused. Resumption is an explicit operator action after manual review that the restriction is cleared; the recorded confirmation does not establish LinkedIn authorization or guarantee future safety.

**Acceptance Criteria:**
- [ ] **New** `test/research-access.test.mjs`, test `pause survives restart and every entrypoint stops before access`, uses real temporary SQLite state and invokes the covered entrypoints in separate processes; the local navigation server receives no requests while paused.
- [ ] Tests `preflight bypass cannot bypass pause`, `missing or corrupt access state fails closed`, and `resume requires explicit operator reason` pass in that file.
- [ ] Test `research navigation rejects member profiles` rejects profile routes and unrecognized destinations before target creation while allowing the local harness's explicitly bound jobs fixture route.
- [ ] `node skills/job-hunter/scripts/test-jh-migrate.mjs` and `node skills/job-hunter/scripts/test-jh-search.mjs` pass, including idempotent migration without clearing a pause.

### US-004: Coordinate LinkedIn activity across processes without failing open

**Description:** As the user, I want separate helpers to share one access owner and budget instead of multiplying activity unintentionally.

**Implementation steps:**
1. Extend `cdp-lease.mjs`; do not create a competing lock/budget implementation. Add an explicit strict mode for LinkedIn with a stable source-level identity shared by search, backfill, preflight, and any remaining fetch path. Keep unrelated callers' behavior unchanged unless separately approved.
2. In strict mode, lease contention, corrupt state, permission errors, or mutex timeout return a structured blocked/deferred result. Remove the LinkedIn caller's catch-and-continue fallback to per-process limits.
3. Hold exclusive ownership across the network phase. A nested wrapper/child must transfer the same verified ownership context rather than acquire a second independent lease. Each new navigation requires a valid owner, an unpaused source, and a reserved slot immediately before sending.
4. A pause detected by the owner stops further admissions before ownership is released. Pending jobs/checkpoints remain durable. Cancel pending waits cleanly; record any requests already in flight.
5. Preserve existing finite transient retry machinery, but set the LinkedIn blocking-state policy to stop immediately. Do not treat CAPTCHA, restriction, login expiry, or ambiguous access failures as transport retries.
6. Report configured limits as operational budgets, not safe LinkedIn thresholds. Do not add fingerprint masking or artificial human-behavior timing as a mitigation. Remove the existing masking calls from the covered collection path without replacing them with another disguise.

**Acceptance Criteria:**
- [ ] Extend existing `skills/linkedin-job-search/scripts/test-cdp-lease.mjs`: `strict LinkedIn callers share one owner` launches real competing subprocesses and proves only the owner reaches a local HTTP target.
- [ ] Tests `strict budget I/O failure prevents navigation` and `paused owner releases without admitting queued work` pass with real filesystem/SQLite operations.
- [ ] Extend existing `skills/linkedin-job-search/scripts/test-retry-policy.mjs`: `first LinkedIn blocking state terminates origin` and a separate bounded transient-error case pass.
- [ ] A local end-to-end collector fixture still extracts the same job fields with the revised navigation path; proof is included in **new** `test/research-access.test.mjs`, not a source-text assertion about removed masking code.

### US-005: Reuse postings across discovery, refresh, and enrichment

**Description:** As the user, I want fresh discovery without repeatedly fetching descriptions already sufficient for analysis.

**Implementation steps:**
1. Keep `jobs` as the description store. Add the small `job_fetch_state` table below; do not create another raw-HTML cache.
2. Retain `(source, job_id)` identity and existing `loadExistingJobIds()` behavior. A failed DB read must stop/defer collection rather than return an empty cache and trigger refetches.
3. Deduplicate exact normalized query/source/country/filter combinations within a scan and reuse completed checkpoint entries on resume. A new explicitly requested scan can discover new IDs; do not impose an undocumented daily search-cache expiry or silently suppress new discovery.
4. New IDs and genuinely missing descriptions are fetch candidates. Existing usable descriptions are reused unless explicit refresh IDs or an approved freshness policy requires new evidence. A CV/filter/salary question is not a refresh reason.
5. Persist content hash and successful-fetch timestamp only after valid content is extracted and saved. Generic `jobs.updated_at` is not a fetch timestamp. Legacy rows with non-empty descriptions but unknown fetch dates remain reusable with `fetch time unknown` provenance; never bulk-refetch them merely to populate metadata.
6. Preserve existing rich descriptions and external links on failed refresh. Advance metadata only on success. Save exclusion and failure reasons separately from the JD.
7. When the wrapper's batch/time budget is reached, checkpoint all remaining requested queries/IDs as deferred. Do not truncate the user's requested scope to make the run appear complete.

**Acceptance Criteria:**
- [ ] **New** `test/research-cache.test.mjs`, test `overlapping queries fetch a new posting once`, executes the real planner/collector against local fixtures and real SQLite; one successful new-ID navigation serves every consumer.
- [ ] Tests `CV or filter changes do not refetch`, `explicit refresh alone invalidates a usable JD`, `cache lookup failure fails closed`, and `failed refresh preserves original description` pass in that file.
- [ ] Test `resume retains every requested query and job` verifies disjoint outcome buckets whose union equals the requested/discovered scope, including deferred work.
- [ ] Existing `test-search-linkedin-jobs.mjs`, `test-extraction-and-filter.mjs`, and `test-jh-search.mjs` pass when invoked from their verified skill directories.

### US-006: Make the inline score depend on actual CV evidence

**Description:** As the user, I want matches to reflect my CV rather than a developer-maintained list of skills assumed to be mine.

**Implementation steps:**
1. Change `skills/job-match-scorer/scripts/score_jobs_inline.py` in a separate correctness slice. Use its real extracted CV text and explicit runtime cache values as possession evidence. A static vocabulary may recognize requirement terms; it must not assert that the user has those skills.
2. Represent extracted mandatory requirements separately from preferred criteria. For each matched item retain the exact job requirement and CV/cache evidence reference. Related technology, generic seniority, citizenship, or residence is not substitute evidence for a missing qualification.
3. Keep the shared role taxonomy and the existing `fit_score >= 60` threshold. Do not change role-classifier boundaries as part of this story.
4. Calculate score from the actual criterion records: matched mandatory count divided by total mandatory count, multiplied by 100. Unknown criteria remain unknown/not matched; preferred items do not enter the denominator. If there are no assessable mandatory criteria, report insufficient evidence instead of a fabricated perfect score. Check existing score-table constraints before choosing the unscored representation and record that choice here before coding.
5. Include CV-content, description-content, relevant cache-data, taxonomy, and scoring-version identities in score reuse/invalidation. Parse the real DOCX once per pass; changing the CV invalidates scores, not job-page content.
6. Preserve old observations; produce a separately identified score run. Do not bulk-overwrite historical scores. Explain each baseline difference as a corrected criterion or evidence change.

**Acceptance Criteria:**
- [ ] Extend existing `skills/job-match-scorer/scripts/test-score_jobs_inline.py`: `same job differs when CV evidence differs` uses DOCX inputs parsed by the actual extractor and verifies criterion evidence, not just CV hashes.
- [ ] Tests `catalog term alone is not CV evidence`, `preferred requirement does not reduce fit`, `unknown authorization is not inferred`, and `score equals persisted mandatory counts` pass.
- [ ] The private real saved-data slice produces `cv-score-diff.json` with evidence for every score change. Repeating the same inputs produces the same criterion records and makes zero LinkedIn requests.
- [ ] The existing Python test file passes via its documented/direct invocation, and `python3 -m py_compile skills/job-match-scorer/scripts/score_jobs_inline.py` succeeds.

### US-007: Extract pay from saved content and compare it honestly

**Description:** As the user, I want to see better-paying roles and companies in the selected location without reloading LinkedIn for salary research.

**Implementation steps:**
1. In `sources/linkedin.mjs`, reuse `parseSalaryCandidates()` on the saved posting's richest available description. Keep parser section-boundary protections. Do not call `httpClient.get(job.url)` for LinkedIn salary-only enrichment.
2. Extend `lib/enrich-pipeline.mjs` to carry cached-content provenance and unchanged-content reuse. If saved content has no salary, move to the existing advertiser/ATS scan when a suitable external application URL exists, then the existing benchmark adapters. No LinkedIn refetch fallback.
3. Decode an already-saved LinkedIn external-application redirect locally rather than visiting it. Validate destination scheme/host and each redirect; reject credentials, local/private network targets, and unexpected LinkedIn destinations in automated external research. Treat a challenge as missing data/blocked, never solve or retry through it.
4. Reuse `job_salary_observations`, `salary_benchmarks`, `lib/salary-db.mjs`, `lib/salary-selector.mjs`, and normalization/annualization code. Preserve the posted-versus-estimated partition and historical benchmark linkage.
5. Compare only compatible currency, pay period, compensation type, and location scope. Keep base salary, total compensation, and contract/day rates separate unless an explicit existing conversion basis is shown. Unknown pay sorts last, not as zero.
6. Rank posted salaries separately from market estimates. For a company/role summary, show the median of comparable posted-range midpoints and the sample count; label it `among collected postings`, not a market-wide company-pay claim. A generic role benchmark cannot establish that one named company pays more than another.

**Acceptance Criteria:**
- [ ] **New** `test/research-salary.test.mjs`, test `saved LinkedIn salary needs no network`, feeds a persisted posting through the actual enrichment pipeline and fails on any LinkedIn request.
- [ ] Tests `cached absence uses external or benchmark evidence`, `similar-job salary is excluded`, `external redirect cannot bypass source pause`, and `posted and estimated rankings remain separate` pass.
- [ ] Test `company comparison uses only comparable posted observations` computes expected aggregates from the underlying fixtures, including sample count and unknown-pay handling.
- [ ] The private real slice produces `salary-reuse.json` with selected observation IDs, provenance, and zero LinkedIn fetches; existing salary parser checks and `node skills/salary-calculator/scripts/test-itjobswatch-parse.mjs` pass.

### US-008: Cache and validate the official UK sponsor register

**Description:** As the user, I want employer sponsorship capability grounded in the official register rather than search snippets.

**Implementation steps:**
1. Add **new** `skills/job-hunter/scripts/uk-sponsors.mjs` with separate fetch/parse/normalize/match operations. Fetch the official publication page, select its worker sponsor CSV link, and validate HTTPS plus the expected government asset host. Do not hardcode the dated CSV URL from this research.
2. Stream/download to a temporary workspace file with size/time bounds; verify the required headers, parse quoted CSV correctly, and retain original values. Publish a new snapshot atomically only after successful validation. Never replace the last good snapshot with a partial or malformed download.
3. Keep snapshot bytes and a manifest under `$JOBHUNTER_HOME/sponsor-register/`. Manifest fields are defined below. Refresh once per batch when explicitly requested or its configured cache policy says due, never per job.
4. Build an in-memory lookup once per batch. Match normalized exact legal names first; only owner-confirmed aliases can produce a confirmed alias match. Preserve punctuation/spacing normalization separately from legal-entity identity. Do not collapse unrelated names merely by stripping corporate suffixes.
5. Filter specifically for the relevant `Skilled Worker` route and retain rating/type information. Fuzzy similarity, staffing agencies, parent/subsidiary assumptions, duplicate names, and conflicting town/city evidence produce candidates/ambiguity, not confirmed employer matches.
6. Use an existing CSV dependency only if declared and appropriate; otherwise add one maintained parser and update the dependency/release documentation in the same slice. Do not implement CSV with `split(',')`.

**Acceptance Criteria:**
- [ ] **New** `test/research-sponsorship.test.mjs`, tests `quoted register rows preserve legal identity`, `wrong route is not Skilled Worker evidence`, and `ambiguous employer remains unresolved` pass.
- [ ] Test `failed refresh retains last good snapshot` exercises real temporary files, checksum verification, and atomic replacement.
- [ ] A bounded real official-register rehearsal produces private `sponsor-register-check.json` with source URL, fetched timestamp, required headers, byte/hash evidence, and parsed row count. Synthetic rows alone do not satisfy this criterion.

### US-009: Distinguish an employer licence from sponsorship for the role

**Description:** As the user scanning the UK, I want an explicit answer about sponsorship evidence for each vacancy, including uncertainty.

**Implementation steps:**
1. Add a `job_sponsorship_observations` table using the data contract below. Link observations to a job and the precise register snapshot/source document used.
2. Parse the saved JD for explicit positive, explicit negative, conditional, or absent sponsorship wording. Store the exact quotation and evidence location. Check negation; `cannot sponsor`, `no sponsorship`, and role-specific right-to-work requirements must not become positive signals.
3. Enrich from an employer's role page/policy only when the available external URL is allowed and the evidence applies to the advertised legal employer and location. Do not follow recruiter profiles or treat a staffing agency's licence as its unnamed client's licence.
4. Combine role evidence and employer-register evidence without collapsing them into one boolean. `Licensed employer; this role unknown` is a valid and useful result. `No confirmed register match` is not a legal conclusion that the company cannot sponsor.
5. Apply the user's country-specific sponsorship need from runtime cache. Unknown need stays unknown. Explicit no-sponsorship is a blocker only when sponsorship is required; ambiguous cases remain visible for review rather than being silently removed.

**Acceptance Criteria:**
- [ ] Extend **new** `test/research-sponsorship.test.mjs`: `licensed employer does not imply role sponsorship`, `explicit role refusal overrides company-wide optimism`, `agency licence is not client evidence`, and `unknown need remains unknown` pass.
- [ ] Every resolved outcome in private `sponsorship-slice.json` has a quote or register snapshot/row reference; unresolved outcomes carry a reason and are not rounded up to sponsored.
- [ ] A report fixture includes confirmed route capability, explicit vacancy sponsorship, explicit refusal, and unknown/ambiguous cases as separate outputs, verified by **new** `test/research-report.test.mjs`.

### US-010: Produce a complete research report from saved evidence

**Description:** As the user, I want CV matches, pay comparisons, sponsorship, and source coverage in one useful report even while LinkedIn is paused.

**Implementation steps:**
1. Add **new** `skills/job-hunter/scripts/jh-research-report.mjs` as a read-only renderer over saved results. It is not another search orchestrator. Proposed CLI inputs: `--search-id`, `--db`, `--json`, and optional explicit output path; validate these against existing CLI conventions during implementation.
2. Preserve the existing presentation columns and `Full facts` labels documented by the installed job pipeline. Add UK sponsorship to each job's reason/evidence details and to the machine-readable row, not by silently deleting existing columns.
3. Include source job URL, description freshness/unknown timestamp, score basis, salary provenance, employer-register state, role sponsorship state, and evidence URLs. Put pay comparisons in a separate location-scoped section.
4. Extend `jh-report-gate.mjs` to enforce requested-run coverage and evidence gaps. A paused/missing requested LinkedIn scan yields a partial report, not zero jobs or a complete search. Locally complete analysis of previously saved jobs may still be shown as complete analysis of that explicit saved subset.
5. Report aggregate counters with precise meanings: attempted/admitted top-level navigations, cache reuse, completed queries, deferred queries/jobs, blocking outcome, and already-in-flight requests at pause. Do not call these LinkedIn's total request/account counters.
6. Retain fit-first shortlist behavior; add an explicit pay comparison rather than allowing a high estimated salary to hide a poor match. Do not initiate applications from this renderer.

**Acceptance Criteria:**
- [ ] **New** `test/research-report.test.mjs`, test `paused LinkedIn still yields an honest saved-data report`, verifies useful rows, CV/pay/UK sponsorship fields, unchanged mandatory presentation columns, and explicit partial source coverage.
- [ ] Tests `every requested query has an outcome`, `report aggregates recompute from rows`, and `read-only report cannot navigate or submit` pass using real SQLite and a network-forbidden test boundary.
- [ ] `node skills/job-hunter/scripts/test-jh-report-gate.mjs` and `node skills/job-hunter/scripts/test-jh-freshness.mjs` pass, preserving stale-posting and salary-provenance behavior.

### US-011: Prove the pipeline on real saved data and roll out reversibly

**Description:** As the maintainer, I want evidence that the actual installed dependencies and saved data work, without testing against the restricted account.

**Implementation steps:**
1. Add **new** `skills/job-hunter/scripts/rehearse-research-safety.mjs` with explicit database/CV/output inputs. It backs up to a private working copy, takes a bounded saved-job slice, calls the actual parser/scorer/salary/sponsorship/report components, and refuses LinkedIn network access throughout.
2. Separate semantic fixtures from real-dependency proof. Local HTML/CDP/HTTP fixtures prove block, ordering, argv, file-descriptor, retry, and exit-code behavior. The real SQLite/CV slice proves the actual computation loads and runs. The official-register fetch proves the external parser on real data. Neither proves LinkedIn's current live page compatibility.
3. Save a private verification summary and compare baseline IDs/evidence. Traffic-only slices must preserve outputs. The CV correctness slice and genuinely new salary/sponsorship evidence may change outputs only with per-row explanations.
4. Run the relevant existing skill tests, new root tests, `npm test`, and `npm run verify:release`. Update affected skill instructions, `README.md`, `docs/security-and-privacy.md`, and `search-safety-contract.md` so they agree with the actual stop/cache behavior. Update dependency documentation only if a dependency changes.
5. Before any installation, review the per-file drift decisions from US-001. Use `node scripts/install.mjs --dry-run` and review its manifest. Deploy only with separate authorization and an installed-tree restore point; never install directly from an unresolved drift state.
6. Leave LinkedIn paused after offline verification. A future live canary requires separate explicit authorization and manual confirmation that the account restriction has cleared. It must be bounded, use the real implementation, and stop on the first warning. No repeated canaries to find an enforcement threshold.
7. Rollback restores the code/installed files and private DB backup when needed. Never roll back a persisted restriction into an unpaused state. Do not discard the evidence explaining why access was stopped.

**Acceptance Criteria:**
- [ ] Private `verification.json` references the real slice, CV parser result, score differences, salary provenance, sponsorship evidence, report path, SQLite integrity result, and zero LinkedIn requests. All referenced artifacts exist and their hashes match.
- [ ] `npm test`, `npm run verify:release`, and the relevant existing skill-test commands listed in this plan pass with captured exit codes; unmet checks remain unchecked with the exact blocker.
- [ ] Private `install-preview.json` records the dry-run manifest and accepted drift decisions; no deployment is claimed from a dry-run result.
- [ ] The final handoff explicitly lists offline verification done, live LinkedIn compatibility unverified, account-safety guarantee unavailable, and deployment status. No live-canary criterion is marked passed by a fixture or by the absence of a notice during a short run.

## 4. Functional Requirements

- **FR-1:** The system must retain requested LinkedIn discovery, CV matching, location-scoped compensation research, and UK sponsorship analysis as distinct capabilities.
- **FR-2:** The system must treat a reported/detected restriction as a durable source-level pause, checked before any new covered LinkedIn access, including preflight, reload, direct helper, and fallback paths.
- **FR-3:** The system must not automatically clear a pause based on elapsed time, retry budget, a new process, a new country, a different session, or another account.
- **FR-4:** The system must stop the origin on the first blocking page state and preserve already collected evidence. Transient errors must remain distinguishable from access controls.
- **FR-5:** The system must use strict shared ownership/budget coordination for LinkedIn and must fail closed when coordination or required cache state is unreadable.
- **FR-6:** The system must not navigate member/recruiter profiles as part of job research. Browser-generated subrequests must not be misreported as controlled top-level requests.
- **FR-7:** The system must reuse valid saved descriptions across CV scoring, filtering, pay parsing, and sponsorship extraction. Reanalysis must not imply a job-page refresh.
- **FR-8:** The system must retain all requested query/job outcomes in checkpoints and reports, including deferred items caused by budgets or restrictions.
- **FR-9:** The system must store successful-fetch metadata separately from general row update timestamps and must not invalidate useful legacy content just because that metadata is absent.
- **FR-10:** The system must ground every matched criterion in the user's actual CV or explicit cache evidence and calculate the score from its recorded criterion counts.
- **FR-11:** The system must distinguish posted pay from estimates and compare only compatible compensation observations with sample/provenance disclosure.
- **FR-12:** The system must parse LinkedIn salary evidence from saved content and use allowed external evidence/benchmarks rather than independently refetching LinkedIn.
- **FR-13:** The system must validate and cache the official UK sponsor register, preserving route, legal-employer identity, snapshot age, and ambiguity.
- **FR-14:** The system must represent employer licensing, role-specific sponsorship, and the user's need for sponsorship separately. A licensed employer must not automatically become a sponsored vacancy.
- **FR-15:** The system must retain explicit unknown/conditional/conflicting evidence rather than inventing pay, CV qualifications, or sponsorship availability.
- **FR-16:** The system must provide useful saved-data results while clearly marking uncompleted requested source coverage as partial.
- **FR-17:** The system must keep credentials, the CV, private job text, and runtime evidence local by default; external requests must not include CV or personal-cache contents merely to enrich a posting.
- **FR-18:** The system must keep migrations idempotent, preserve historical salary/score evidence, support backup-based rollback, and preserve restriction state across rollback.
- **FR-19:** The system must reconcile installed/repository drift before deployment and keep touched code, callers, tests, configuration, and documentation consistent.
- **FR-20:** The system must not claim compliance, a safe request threshold, undetectability, or a no-restriction guarantee from this engineering work.

## 5. Non-Goals

- Bypassing LinkedIn restrictions or making prohibited access appear human.
- A guarantee of no future notices, or a claimed diagnosis of which extension/process caused this notice without runtime evidence.
- Expanding recruiter/member-profile collection, messaging, connection requests, or automated application submissions.
- Replacing LinkedIn without the user's agreement, reducing requested locations/roles silently, or treating listing snippets as full job assessments.
- Rewriting the role taxonomy, all ATS helpers, the browser stack, or the entire scoring/application architecture.
- Building a distributed queue, new daemon, new browser, elaborate event platform, or a generic scraping framework.
- Giving immigration/legal advice or certifying visa eligibility. Sponsorship research is evidence-backed screening, not a visa decision.
- Publishing private CV/job/browser fixtures or bulk-refreshing all historical jobs to populate new metadata.

## 6. Design / Technical Considerations

### Implementation order and ownership

Execute US-001 first and freeze the shared access-state, fetch-metadata, CV-evidence, salary-provenance, sponsorship, and report contracts before parallel implementation. The baseline must identify actual callers and installed drift; workers must not invent competing interfaces from their own assumptions.

#### Parallel tracks and completion dependencies

| Track | Work that can proceed independently after US-001 | Completion dependency |
|---|---|---|
| Access safety and caching | US-002, then US-003, then US-004, then US-005. Keep this track sequential because the stories share collection code. | Each story follows the preceding story's verified handoff. |
| CV-grounded scoring | US-006 can run alongside the safety/cache track. | Requires the baseline and agreed evidence contract, not live LinkedIn access. |
| Cached salary enrichment | Isolated US-007 parser/pipeline work can start alongside safety work against the frozen contracts. | Full-story acceptance must verify integration with completed US-003 through US-005. Early isolated work is not a completed US-007. |
| UK sponsorship | US-008 can run independently; US-009 follows the validated register importer. | US-009 also needs an exclusive migration-writing slot and ownership of its report-test additions. |

US-010 joins completed cache, scoring, salary, and sponsorship work. US-011 follows the integrated report. Independent unit-test success does not satisfy these integration dependencies.

#### Conservative schedule for a wave runner

If the runner waits for every story in a wave before advancing, use this whole-story schedule. Stories listed together may execute in parallel; the next wave starts only after every listed story has met its acceptance criteria and its artifacts have been verified.

| Wave | Stories | Reason |
|---|---|---|
| Baseline | US-001 | Establish evidence, caller inventory, contracts, and path ownership. |
| Parallel foundations | US-002, US-006, US-008 | Backfill stopping, CV scoring, and register import have separate implementation paths. |
| Durable access gate | US-003 | Requires the backfill-stop handoff; owns the access-state migration. |
| Coordination and role sponsorship | US-004, US-009 | Coordination follows the access gate; sponsorship follows US-008. US-009 has the migration slot while US-004 owns lease/retry code. |
| Shared posting reuse | US-005 | Requires completed safety gates and the migration handoff from US-009. |
| Salary integration | US-007 | Validates cached salary work against the completed access/cache implementation. |
| Combined report | US-010 | Joins all required research capabilities. |
| Integrated verification | US-011 | Verifies the actual combined implementation and prepares reversible rollout. |

For more concurrency, the supervisor may split US-007's isolated preparation from its integration acceptance into explicit owned tasks in this plan before dispatch. Do not place an unfinished US-007 in an early blocking wave while its prerequisites sit in a later wave; that creates a dependency deadlock.

#### File ownership and handoff rules

- The supervisor owns this PRD, the ownership map, common dependency manifests, and shared documentation integration. Workers report requested changes to those paths rather than editing them concurrently. The supervisor records verified story progress and evidence here as each slice completes.
- Give `jh-migrate.mjs` one owner at a time. In the conservative schedule its ownership passes through US-003, US-009, then US-005. Each successor preserves and reruns tests for its predecessors' schema changes.
- Keep `jh-search.mjs`, `search-linkedin-jobs.mjs`, and shared collection helpers within the sequential safety/cache track. Every dispatch prompt must list exact writable paths; all non-owned paths are read-only. Reconcile any additional shared caller found in US-001 before dispatch.
- US-003 hands `test/research-access.test.mjs` to US-004. US-008 hands `test/research-sponsorship.test.mjs` to US-009. US-009 hands `test/research-report.test.mjs` to US-010. Handoffs include the verified artifact revision and passing-test evidence; the prior worker must have stopped writing.
- US-010 owns `jh-report-gate.mjs` integration. Salary, CV, and sponsorship workers supply the agreed data contracts and fixtures instead of independently editing the combined renderer/gate.
- Give each worker its own temporary SQLite copy, test-output directory, and local test target. The canonical workspace DB, browser session, and installed skill tree are not parallel writable resources. No worker may access LinkedIn as part of investigation or offline verification.
- If a worker discovers a dependency on another worker's unfinished change or needs a non-owned file, it reports the conflict. The supervisor updates the plan and serializes the affected work; workers do not silently expand ownership or mark blocked acceptance criteria complete.

Each story is a reviewable slice. If a slice cannot fit one focused session, split it here before implementation. Keep attempt count beside the story's progress entry; after repeated failures, simplify the slice rather than repeatedly rebuilding verification infrastructure.

### Processing flow

1. Load explicit user scope and source-access state.
2. If LinkedIn is paused, mark discovery deferred and use existing saved rows; do not run the exact-URL preflight.
3. If collection is permitted operationally, acquire the shared LinkedIn owner, plan/checkpoint queries, and admit only required jobs-page navigations through the same gate.
4. Classify every result before extracting/persisting a JD. A block pauses the source; a usable posting updates its content and fetch metadata transactionally.
5. CV scoring and cached salary/sponsorship extraction operate on saved content. External enrichment is separate, source-scoped, and cannot redirect back into paused LinkedIn.
6. Render saved results and explicit coverage gaps; no report action submits an application.

### Proposed source-access contract

Use one `jh_meta` key, **new** `source_access:linkedin`, containing validated JSON:

| Field | Contract |
|---|---|
| `schemaVersion` | Version of this record's schema. |
| `state` | Exactly `paused` or `ready`; no implicit ready state. |
| `reason` | A bounded operational reason such as restriction, challenge, login intervention, unreviewed installation, or operator pause. Do not store cookies/page bodies. |
| `observedAt` | UTC timestamp of the observation/transition; not the platform's expiry promise. |
| `runId` | Run that observed the stop, or null for explicit operator action. |
| `operatorConfirmation` | On explicit resume only: timestamp and non-secret reason recording manual review. Not a claim of LinkedIn permission. |

Initialize an absent record as paused; never overwrite an existing record during migration. Validate reads before network admission. Use `BEGIN IMMEDIATE` for read/transition/write. A malformed/unreadable DB is a local safety failure with no network admission. A lease cannot waive the pause, and a resume cannot waive the lease/budget.

Proposed module operations are `readLinkedInAccess`, `pauseLinkedInAccess`, and `resumeLinkedInAccess`; proposed CLI actions are status, pause-with-reason, and resume-with-confirmation. These names are **new design**, not existing APIs. Importing either module must not navigate, initialize a live browser, or mutate the DB accidentally.

### Proposed job-fetch metadata

Add **new** `job_fetch_state` via the existing migration entrypoint:

- Composite primary/foreign key: `(source, job_id)` references `jobs(source, job_id)`.
- `content_hash`: hash of normalized stored description, nullable for legacy rows until calculated locally.
- `fetched_at`: nullable UTC timestamp of a successful actual fetch, never inferred from `updated_at`.
- `fetched_url`: actual successful document URL, nullable for legacy data.
- `last_attempt_at`: most recent attempted refresh, separately tracked.
- `last_outcome`: allowed set `success`, `failed`, `blocked`, `deferred`; nullable before a new attempt.
- `last_reason`: bounded diagnostic without credentials or full page contents.

Successful content replacement and fetch metadata commit together. A failed/blocked attempt updates only attempt/outcome diagnostics and preserves the last successful content/hash/timestamp. Missing metadata does not mean missing content.

Do not add an automatically expiring job cache in this slice. Explicit refresh IDs remain supported; any scheduled age policy must name its scope and freshness tradeoff in this plan before implementation. Search checkpoints, rather than a second query database, own same-scan deduplication and resume outcomes.

### Proposed CV-evidence contract

Use the existing DOCX extraction path and score-result storage. For each assessed criterion keep: normalized requirement, exact JD quotation, mandatory/preferred classification, `matched`/`not_evidenced`/`unknown` status, and CV text span or explicit cache key/value evidence reference. Store sensitive source references privately; do not copy full CV text into public tests or external requests.

A vocabulary/alias map recognizes terms only. It must not infer possession, years of experience, or transferable skills. Recompute the count/percentage relationship from those criterion records immediately before persistence and rendering. Preserve current score-run identity conventions while adding the evidence-version invalidation needed for correctness.

### Proposed sponsor-register cache and job observations

Manifest under `$JOBHUNTER_HOME/sponsor-register/`:

- `publicationUrl`, `csvUrl`, `fetchedAt`, `publicationUpdatedAt` when available;
- `sha256`, `byteCount`, `rowCount`, `headers`, and parser/normalizer version;
- retained immutable snapshot filename and a pointer to the validated current snapshot.

Keep the snapshot referenced by historical job evidence. Fetch failures leave the last validated snapshot readable but explicitly stale. No hardcoded dated URL, permanent assumptions about column order, or company-name fuzzy auto-approval.

Add **new** `job_sponsorship_observations` with a surrogate observation ID, `(source, job_id)` foreign key, observation timestamp, and:

| Field | Allowed meaning |
|---|---|
| `employer_status` | `confirmed_skilled_worker`, `ambiguous`, `no_confirmed_match`, `unknown`. |
| `role_status` | `explicit_yes`, `explicit_no`, `conditional`, `unknown`, `conflicting`. |
| `sponsorship_need` | `required`, `not_required`, `unknown`, from explicit country-specific user data. |
| `evidence_json` | Validated array of source URL, fetched/observed time, quotation or snapshot hash/row identity, applicability, and source kind. |
| `reason` | Explanation of matching/ambiguity and any role/employer conflict. |
| `input_hash` | Identity of JD, employer mapping, snapshot, and relevant user-cache inputs, allowing unchanged-input reuse. |

Keep raw register legal name and route in the evidence, not only a normalized match key. Unknown is not false. These are local research-state vocabularies, not a new shared cross-domain enum framework. If implementation introduces Python classes, classify their domain role and declare applicable existing Protocols before coding.

### Output and compatibility contract

Use the existing seven presentation columns: `Fit / Category | Role | Salary / provenance | Posting age | Reason / gaps | Location / source | URL`. Preserve `Search ID` and the `Full facts` labels: Scope, Filters, Pipeline, Salary, Source status, Scoring basis, Artifacts.

For UK rows, put a concise sponsorship summary in `Reason / gaps`, with full evidence in per-row details/JSON. The JSON row adds separate employer/role/need fields. Existing consumers must still accept the old fields; version the new envelope explicitly rather than changing meanings silently.

Report scope must distinguish:
- all requested live source runs completed;
- source coverage partial but saved-data analysis completed;
- missing descriptions/evidence preventing assessment.

Do not claim `best-paying company` from market estimates. Report `highest comparable posted pay among collected jobs`, with currency, compensation basis, location, sample count, and collection time. Recalculate all counts and aggregates in code from the displayed/underlying rows.

### Testing and release commands

Existing commands verified from the repository; these are to be run during implementation, not claimed as run during planning:

```bash
npm test
npm run verify:release
node skills/job-hunter/scripts/test-jh-migrate.mjs
node skills/job-hunter/scripts/test-jh-search.mjs
node skills/job-hunter/scripts/test-jh-report-gate.mjs
node skills/job-hunter/scripts/test-jh-freshness.mjs
node skills/linkedin-job-search/scripts/test-page-state.mjs
node skills/linkedin-job-search/scripts/test-cdp-lease.mjs
node skills/linkedin-job-search/scripts/test-retry-policy.mjs
node skills/linkedin-job-search/scripts/test-search-linkedin-jobs.mjs
node skills/linkedin-job-search/scripts/test-extraction-and-filter.mjs
python3 skills/job-match-scorer/scripts/test-score_jobs_inline.py
node skills/salary-calculator/scripts/test-itjobswatch-parse.mjs
node scripts/install.mjs --dry-run
```

The new `test/research-*.test.mjs` files run through the existing root `node --test test/*.test.mjs` command. They must not require the user's live LinkedIn session or private CV. Real private-data integration is the explicit rehearsal, not the default published test suite.

Use real temporary SQLite/filesystem/processes and the actual installed DOCX parser for invocable local dependencies. Bind a fake navigation endpoint to loopback for block/launch testing, with explicit destination binding so a fixture cannot accidentally redirect to LinkedIn. Rehearse exact persisted command artifacts end-to-end before live authorization: argument boundaries, assignment timing, launch-before-log ordering, file descriptors, and propagation of the producer's exit status through pipelines. Syntax checks alone are insufficient.

Existing `npm run verify:release` gates include release safety, local-profile leaks, skill closure, dependency matrix, documentation commands, and required documentation sections. New published skill files must use workspace/environment resolution rather than machine-specific absolute paths.

### Deployment and rollback gates

- No current LinkedIn account access is authorized by this plan.
- No plan criterion depends on provoking another warning or measuring an enforcement threshold.
- Before editing: record clean tracked HEAD; preserve dirty/untracked or non-git-covered state appropriately. Before DB changes: make a proper SQLite backup.
- Source changes belong in this repository's `skills/` tree. Port only individually reviewed installed differences; never bulk-sync either direction.
- Do not declare deployment complete until installed file hashes, dependency resolution, offline rehearsal, and persisted pause state are separately verified.
- Commits, pushes, PR creation, installation, and future live canaries require the user's separate request. Merge only on request.

## 7. Success Metrics

These are product measurements, not predicted results. Compute them from evidence artifacts rather than estimating them:

- **Unchanged-data LinkedIn access:** zero actual LinkedIn fetch/navigation attempts during the real offline analysis pass, proved by the network boundary and caller trace.
- **Restriction admission behavior:** no new covered navigation admitted after the first block; separately report already-sent/in-flight activity and cleanup outcome.
- **Duplicate work:** compare successful new-ID navigations with unique required new IDs and explicitly authorized refreshes. List any extra request and reason; do not claim a percentage reduction without a measured comparable baseline.
- **Scope conservation:** requested queries and discovered IDs equal the disjoint union of reported outcome buckets; deferred work remains recoverable.
- **CV grounding:** every matched criterion has runtime evidence, and every displayed score recomputes from its criterion counts.
- **Salary quality:** each selected pay observation has source/provenance; company/role comparisons disclose compatible basis and sample count.
- **Sponsorship quality:** each resolved UK outcome has role/register evidence, and unknown cases remain visible. No target requiring fabricated coverage.
- **Operational result:** after separately authorized normal use, observed warnings are recorded, but a quiet observation window is not proof of future immunity or permitted access.

## 8. Open Questions

No additional product question is needed to write this plan: the user already confirmed preserving discovery, CV matching, salary research, UK sponsorship, cache reuse, and stopping on restrictions.

The following are implementation/operational gates, not permission to guess:

1. Which installed launchers, scheduled tasks, extensions, or browser activity actually contributed to this incident? Resolve from read-only evidence in US-001; absent telemetry stays unknown.
2. Which installed-only changes must be ported before deployment? Record exact file-level decisions in US-001 before any installer write.
3. What source access is available/permitted after the restriction clears? No approved LinkedIn API/export entitlement was verified during research. Do not promise one or claim caching changes LinkedIn's terms.
4. What operational scan cadence and shared budget does the owner want after manual review? Preserve full scope through resumable batches; no undocumented safe threshold or automatic restart.
5. What is the score table's compatible representation for insufficient evidence? Verify schema constraints and record the decision in US-006 before changing persistence.
6. Which employer aliases, if any, can the owner confirm, and what sponsor-register freshness policy should apply? Until confirmed, retain ambiguity/staleness and continue showing the job for review.
7. Does a future live LinkedIn canary remain necessary and authorized? It is explicitly not part of current offline acceptance, and live compatibility must remain marked unverified until that separate step succeeds.
