# Job-hunter development

The plan of record is `tasks/prd-linkedin-research-safety.md`. Follow its acceptance criteria and current supervisor log before changing behavior.

## Research-safety boundaries

Implementation and verification use local fixtures and saved evidence. Do not access LinkedIn, including diagnostic requests, redirects, browser/CDP navigation or production searches. The canonical job workspace and installed skills are read-only. Applications, installation, live canaries, commits and pushes require separate user authorization.

Workers may modify only their explicitly assigned paths. Reviewers, testers and auditors keep repository files read-only and write only their assigned private report plus external temporary scratch. In AgentFS, use the provided working directory, not a reconstructed host repository path.

## Current state

S01 wrapper/preflight admission is accepted at direct revision 2. Verification run `run_d06014b4-a328-452c-8906-1b1279698376` is terminal/PASS; current source hashes, reports, tests and the retained worker-boundary finding are recorded in section 9 and `agent-output/linkedin-research-safety/S01-direct-verification/ACCEPTANCE.md`. Preserve this slice rather than rebuilding it. The S07a scorer rewrite (`inline-v3` scoring plus its direct-invocation test suite) and the S04 strict lease/retry primitives (opt-in strict source owner and strict source retry policy) landed 2026-09-11 as bounded direct slices; S08a then wired those primitives into `search-linkedin-jobs.mjs` behind the opt-in `--strict-owner` flag (default stays on the legacy fail-open path; flipping it awaits the collector end-to-end fixture). All three are awaiting independent review; their recalibrated proofs, the intended `checksum-manifest.txt` drift on both repository scorer paths, and the remaining US-006 gaps (persistence/caller integration, root CV-evidence test, private real-data recomputation) are recorded in section 9. Full US-003 and the remaining caller, salary, sponsorship and reporting slices are still incomplete; remaining US-004 work is the disposable-SQLite variants, wrapper/child ownership transfer, the collector end-to-end fixture and the default-flip decision. S09 (2026-09-11, direct, awaiting independent review) consolidated the restriction seam: one `RESTRICTION_STATES` set and `researchNavigationDecision` live in `linkedin-page-state.mjs` and every caller imports them; the strict collector and the backfill persist the pause at the observation site; the backfill gained the startup access gate; stored destinations are validated immediately before navigation. See section 9 of the PRD.

The framework-verification worker and run `run_68bcd1ec-a00d-4aa3-b970-8a0d46f6394e` are retired. The job-hunter build `run_29a6f045-1941-4c37-96ac-9bcfbfa1c763` was also cancelled after its failed attempt limit. The user explicitly authorized direct supervisor implementation of S01, retaining independent review and verification. All implementation, review, test and audit roles must use the product resumption instructions in section 9 of the PRD and the reverification brief; do not restart framework verification. Combined-revision acceptance of the delegation repair (export/settlement repair plus the mutable-catalog correction) ran 2026-09-11 as fresh operations runs under that path — `run_ac97518b-e42f-4346-9c63-df72300b8d4a` aborted on command shape, then `run_1e0af10e-313e-4164-88ec-6841ffd24f8e` completed the chain and closed blocked with a packaging-scoped audit FAIL and no acceptance (see `agent-output/worker-export-recovery-verification-3/ACCEPTANCE.md`); neither resumed `run_68bcd1ec`.

US-001 and US-002 are accepted in `tasks/prd-linkedin-research-safety.md`; preserve them unless current evidence identifies a concrete defect. The user authorized reverification and completion of the remaining PRD on 2026-09-10. Every reverification, implementation, review, test and audit role must read `agent-output/linkedin-research-safety/reverification/BRIEF.md` and section 9 of the PRD for current scope, ownership, evidence and progress. The US-003 state/migration/operator foundation is accepted and its existing tests were freshly rerun; preserve it while adding caller integration, and do not mistake that bounded foundation for full US-003. The older `US-003/BRIEF.md` and `EVIDENCE-BRIEF.md` describe historical foundation work, not authorization to repeat it or acceptance of later stories.

For US-002 provenance review, read `agent-output/linkedin-research-safety/US-002/PROVENANCE-BRIEF.md` and the final `provenance-audit.json` beside it. The separate evidence-only closure is terminal/PASS; the earlier blocked build and failed source/audit candidates remain historical. Acceptance covers delivered snapshots and local behavior, not live/installed compatibility. The implementation handoff below is retained for that story only.

## US-002 implementation and acceptance

When planning, implementing, reviewing, testing or auditing US-002, read `agent-output/linkedin-research-safety/US-002/BRIEF.md` first. It defines ownership, local-only fixtures and the current checkpoint lifecycle. Older US-001 acceptance briefs are historical for that work.

## US-001 drift research

For the static drift-analysis graph, read `agent-output/linkedin-research-safety/US-001-drift/BRIEF.md`. Its input manifest defines the assigned source pairs. Research workers keep every repository path read-only and author only their assigned private reports. Synthesis uses the collected-report manifest named in that brief; it is not a substitute for the parent build's acceptance review.

## Acquisition checkpoint

US-001 is complete. Its strict checkpoint now runs explicitly with `npm run verify:research-baseline` from `scripts/check-research-baseline.mjs`, outside the normal regression suite. It requires private evidence and the original runtime sources. Historical briefs/reports retain their original command paths; do not use their old root-test command after this move or weaken assertions to accommodate intentional later source changes.

## US-001 verification handoff

For review or testing of the existing baseline, read `agent-output/linkedin-research-safety/US-001/REVIEW-BRIEF.md` first. For the final evidence audit, read `agent-output/linkedin-research-safety/US-001/AUDIT-BRIEF.md` first. The current verification plan is `agent-output/linkedin-research-safety/us001-verification-plan.json`; its dispatch-only normalization is recorded in the issue. Fresh command evidence is `agent-output/linkedin-research-safety/US-001-verification/verification.json`.

Judge the original US-001 acceptance criteria as well as the verification slice. Distinguish freshly verified facts from historical acquisition claims. Do not replay obsolete task amendments or treat a green command as full semantic acceptance. Report concrete defects instead of editing baseline artifacts during review.

Author the extension-required evidence-bearing JSON report at its assigned path and verify that it parses before ending. A launcher-generated execution projection is not a semantic report.
