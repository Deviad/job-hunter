# Job-hunter development

The plan of record is `tasks/prd-linkedin-research-safety.md`. Follow its acceptance criteria and current supervisor log before changing behavior.

## Research-safety boundaries

Implementation and verification use local fixtures and saved evidence. Do not access LinkedIn, including diagnostic requests, redirects, browser/CDP navigation or production searches. The canonical job workspace and installed skills are read-only. Applications, installation, live canaries, commits and pushes require separate user authorization.

Workers may modify only their explicitly assigned paths. Reviewers, testers and auditors keep repository files read-only and write only their assigned private report plus external temporary scratch. In AgentFS, use the provided working directory, not a reconstructed host repository path.

## Current state

Merged to `main` on 2026-09-11: the LinkedIn research-safety slices (commit `d0f3c54`: US-002 backfill stop, the US-003 access-state foundation and operator CLI, S01 wrapper/preflight admission, S04 strict lease/retry primitives, S07a scorer rewrite, S08a collector adoption behind `--strict-owner`, and S09 restriction-seam consolidation with the pause persisted at the observation site, a startup access gate in the backfill and stored-URL validation before navigation) and the profile generalisation (commit `38d95bd`, handoff in `tasks/profile-generalisation-handoff.md`; `9ea8bca` stops Python bytecode landing in the skill tree). Section 9 of the PRD records the research-safety evidence. Still open from the PRD: the strict default flip, wrapper/child ownership transfer, removal of the masking helpers, the collector end-to-end fixture, full US-003 caller coverage, US-005 caching, US-007 salary, US-008/US-009 sponsorship, US-010 reporting and US-011 rehearsal.

## Profile rules

User-specific values (roles, languages, skills, target countries, fit threshold, classifier taxonomy) come only from the profile loader: `skills/job-hunter/scripts/jh-profile.mjs` (JavaScript) and `skills/job-match-scorer/scripts/jh_profile.py` (Python, which delegates to the JavaScript loader). Layers: curated `personal-info-cache.json`, CV-derived `profile-derived.json` (rebuilt automatically when the CV hash, extractor version or reference data changes), `search-config.json`, and the generic tables under `skills/job-hunter/data/`. Never add a built-in personal default to a script, test, fixture or doc; an explicit flag may override the profile, and a missing profile fails loudly with a `ProfileError`. The AI-architect vocabulary lives only in `examples/profiles/ai-architect/` as an example. Tests build synthetic profiles in a temporary `JOBHUNTER_HOME`. Python entry points set `sys.dont_write_bytecode`; the release gate rejects `__pycache__` and `profile-derived.json` anywhere in the repository.

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
