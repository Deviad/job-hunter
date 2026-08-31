# Publish Job Hunter

## Overview

Publish the active Job Hunter pipeline as a clean public GitHub repository. The release must contain the complete supported Pi skill dependency closure, reproducible code dependencies, a one-command global installer, Docker Compose definitions for browser/search services, and release-safety checks that prevent personal job-hunting data from entering the repository.

The current `/Users/spotted/projects/job-hunter` worktree is an archive of the salary-calculator project, has no Git remote, and tracks personal/runtime artifacts. It is a planning location only and must not be used as the publication source. The active source is currently distributed under `~/.pi/agent/skills/`; implementation will assemble a new repository from reviewed active files without preserving the archive history.

## Goals

- Publish a clean MIT-licensed GitHub repository containing the complete supported Job Hunter workflow.
- Install all bundled Pi skills and code dependencies through one idempotent bootstrap command.
- Include reproducible manifests and lockfiles rather than checked-in dependency directories.
- Include Docker Compose configuration for Selenium Chromium and SearXNG while verifying, rather than silently installing, host-level and heavyweight prerequisites.
- Prevent CVs, databases, credentials, browser state, logs, screenshots, application records, and host-specific paths from entering a release.
- Make a fresh installation diagnosable through the existing Job Hunter doctor workflow.

## User Stories

### US-001: Create a privacy-safe publication source

**Description:** As a maintainer, I want Job Hunter exported into a clean repository so that publishing cannot expose private job-search data or archive-only history.

**Acceptance Criteria:**

- [ ] A new repository contains `README.md`, `LICENSE`, `.gitignore`, and `tasks/prd-publish-job-hunter.md`; `test -f` checks for all four files pass.
- [ ] The MIT license text is present in `LICENSE`; `node scripts/check-release-safety.mjs` reports the license check as passing.
- [ ] `node scripts/check-release-safety.mjs` exits zero after scanning tracked paths and text for databases, CVs, personal-info caches, credentials, cookies, browser profiles, logs, screenshots, generated application artifacts, `node_modules`, and `/Users/spotted` host paths.
- [ ] `node --test test/release-safety.test.mjs` proves the safety gate rejects representative forbidden fixtures and accepts the repository release tree.
- [ ] `git log --oneline --all` in the publication repository contains only the clean publication history and no imported archive commits.

### US-002: Bundle the complete supported Pi skill closure

**Description:** As a Pi user, I want every skill required by the supported pipeline included so that installation does not depend on undocumented files from the maintainer's machine.

**Acceptance Criteria:**

- [ ] `skills/` contains reviewed copies of these 14 observed active skills: `job-hunter`, `linkedin-job-search`, `indeed-job-search`, `job-match-scorer`, `salary-calculator`, `auto-job-application`, `captcha-resolution`, `qwen-screenshot-debug`, `selenium-container-visual-click-recovery`, `obscura-mcp-repair`, `pi-mcp-repair`, `brave-obscura-session`, `docx`, and `pdf`; `node scripts/verify-skill-closure.mjs` lists all 14 and exits zero.
- [ ] Every bundled skill contains a valid `SKILL.md`; `node scripts/verify-skill-closure.mjs` reports no missing or malformed skill entry point.
- [ ] Every explicit local skill reference from a bundled `SKILL.md` resolves to another bundled skill or an allowlisted Pi platform integration; `node --test test/skill-closure.test.mjs` passes.
- [ ] Bundled scripts resolve sibling skills through the selected installation root rather than `/Users/spotted`, `.hermes`, or the archived project; `node scripts/check-release-safety.mjs` reports no forbidden path references.
- [ ] A generated `docs/dependency-matrix.md` identifies each skill as core, required support, or platform integration and names its code, executable, service, and MCP prerequisites; `node scripts/verify-dependency-matrix.mjs` exits zero against the shipped files.

### US-003: Provide reproducible code dependencies

**Description:** As an installer, I want pinned dependency metadata so that Job Hunter can be installed without copying the maintainer's `node_modules` or global Python environment.

**Acceptance Criteria:**

- [ ] The repository contains a root `package.json` and `package-lock.json` covering all Node packages imported by bundled scripts, including the observed `better-sqlite3` and `ws` dependencies; `npm ci` succeeds in a clean checkout.
- [ ] No `node_modules` path is tracked; `git ls-files 'node_modules/**'` prints no paths.
- [ ] Python document helpers remain self-contained through PEP 723 scripts invoked with `uv run`; `node scripts/verify-runtime-dependencies.mjs` reports no undeclared Python package imports.
- [ ] Required executables and minimum supported versions are declared in `docs/dependency-matrix.md`; `node scripts/verify-runtime-dependencies.mjs` produces a deterministic pass/fail/optional report.
- [ ] `npm test` runs the focused closure, installer, safety, and existing skill tests from a clean dependency installation and exits zero.

### US-004: Install globally with one idempotent bootstrap command

**Description:** As a new user, I want one command to install Job Hunter into Pi's global skill root and initialize its workspace so that setup is repeatable and understandable.

**Acceptance Criteria:**

- [ ] The command documented in `README.md` invokes `scripts/install.mjs` and installs all bundled skills under `${PI_AGENT_HOME:-$HOME/.pi/agent}/skills/`.
- [ ] The installer creates `${JOBHUNTER_HOME:-$HOME/.job-hunter}` with non-sensitive templates and locked code dependencies, then runs the installed `jh-doctor.mjs`; `node --test test/install.test.mjs` proves this behavior using temporary `HOME`, `PI_AGENT_HOME`, and `JOBHUNTER_HOME` directories.
- [ ] Re-running the installer against the same temporary home exits zero without duplicating content or overwriting an existing `CV.docx`, `personal-info-cache.json`, or `jobhunter.sqlite`; the idempotency and preservation cases in `test/install.test.mjs` pass.
- [ ] The installer supports `--dry-run` and `--uninstall`; focused tests prove dry-run makes no filesystem changes and uninstall removes only files recorded in the installation manifest.
- [ ] Installation failure reports the exact missing prerequisite and leaves no partial skill directory; the rollback case in `test/install.test.mjs` passes.

### US-005: Ship and verify external service configuration

**Description:** As a user, I want supported service definitions and health checks so that browser search and discovery dependencies are reproducible without hiding heavyweight setup.

**Acceptance Criteria:**

- [ ] `compose.yaml` defines the supported Selenium Chromium/CDP and SearXNG services without embedded credentials or personal bind mounts; `docker compose config --quiet` exits zero.
- [ ] `docs/prerequisites.md` distinguishes automatically installed code dependencies from required host tools, containers, authenticated browser sessions, MCP integrations, and optional LM Studio/Qwen visual recovery.
- [ ] `jh-doctor.mjs` checks the documented Selenium CDP endpoint, SearXNG endpoint, workspace mount, SQLite CLI, Node runtime, Docker availability, and optional visual-recovery dependencies; `node --test test/doctor-publication.test.mjs` covers healthy, missing-required, and missing-optional states.
- [ ] A bounded real-dependency rehearsal starts the shipped Compose services, verifies their health endpoints and Chromium CDP connectivity, and tears them down; `scripts/rehearse-compose.sh` exits zero in release CI or a documented release-gate environment.
- [ ] The setup does not download a local visual model, create third-party accounts, bypass CAPTCHA/access controls, or inject authentication state; `docs/prerequisites.md` states these boundaries explicitly and `node scripts/check-release-safety.mjs` rejects bundled credential/cookie fixtures.

### US-006: Document secure onboarding and operation

**Description:** As a new user, I want concise setup and security documentation so that I can operate Job Hunter without exposing personal information or misunderstanding external-service requirements.

**Acceptance Criteria:**

- [ ] `README.md` contains verified sections for prerequisites, installation, initialization, doctor output, search, score, salary, apply, update, uninstall, and troubleshooting; `node scripts/check-doc-commands.mjs` confirms every documented local command resolves to a shipped file or package script.
- [ ] `docs/security-and-privacy.md` documents local data locations, sensitive-file exclusions, credential handling, authenticated-browser boundaries, CAPTCHA/access-control policy, backup expectations, and disclosure implications of job applications; `node scripts/check-required-doc-sections.mjs` exits zero.
- [ ] `docs/dependency-matrix.md` labels external services and MCP integrations as required, conditional, or optional for each workflow stage; `node scripts/verify-dependency-matrix.mjs` exits zero.
- [ ] `examples/` contains synthetic configuration and workspace fixtures only; `node scripts/check-release-safety.mjs examples/` exits zero.

### US-007: Gate and publish a reproducible GitHub release

**Description:** As a maintainer, I want automated release gates so that every published version is installable, complete, and privacy-safe.

**Acceptance Criteria:**

- [ ] `.github/workflows/ci.yml` runs `npm ci`, `npm test`, the release-safety gate, skill-closure verification, installer smoke tests, and `docker compose config --quiet`; a pull request check shows every required job passing.
- [ ] `.github/workflows/release.yml` builds a source archive, emits SHA-256 checksums, reruns the safety gate on the archive contents, and attaches only passing artifacts to a GitHub release; a draft release run provides the archive and checksum artifacts.
- [ ] Before product source is added to the new GitHub repository, this PRD is copied into a GitHub issue and becomes the plan of record; the implementation branch is named `issue-<issue-number>` and the pull request links that issue.
- [ ] The first release tag installs successfully into a temporary home through the exact README command and `jh-doctor.mjs` reaches the documented ready or explicitly degraded state; the release rehearsal log is attached to the pull request.

## Functional Requirements

- **FR-1:** The system must be published from a new clean Git repository rather than the current archive or its history.
- **FR-2:** The repository must use the MIT license.
- **FR-3:** The repository must bundle the 14 observed skills named in US-002 and mechanically verify skill-reference closure.
- **FR-4:** The repository must provide pinned, reproducible Node dependencies and self-contained Python document helpers.
- **FR-5:** The repository must not track dependency directories, personal data, runtime databases, credentials, browser state, logs, screenshots, or generated application artifacts.
- **FR-6:** The repository must provide one idempotent installer targeting Pi's global skill root and the canonical Job Hunter workspace.
- **FR-7:** The installer must preserve pre-existing user data and roll back partial installation failures.
- **FR-8:** The repository must include a dependency matrix covering skills, packages, executables, services, MCP integrations, and workflow-stage optionality.
- **FR-9:** The repository must include Docker Compose definitions for Selenium Chromium/CDP and SearXNG.
- **FR-10:** Host-level and heavyweight prerequisites must be verified with actionable diagnostics rather than installed silently.
- **FR-11:** The local Qwen/LM Studio visual-recovery path must remain optional and must not trigger model downloads during installation.
- **FR-12:** The installed doctor must distinguish required failures from optional/degraded capabilities.
- **FR-13:** All shipped examples and test data must be synthetic.
- **FR-14:** CI and release workflows must fail closed on missing dependencies, unresolved skill references, unsafe files, unsafe text, failed tests, or invalid Compose configuration.
- **FR-15:** Release artifacts must be checksummed and must pass the same safety scan as the source tree.
- **FR-16:** Documentation must state that authenticated sessions belong to the user and that the project does not bypass CAPTCHA, MFA, access controls, or site restrictions.
- **FR-17:** The GitHub issue containing this PRD must be created before implementation source is added, and implementation must occur on `issue-<issue-number>`.

## Non-Goals

- Migrating or publishing the current archive history.
- Publishing any existing CV, database, personal-info cache, application log, outreach material, screenshot, browser profile, or credential.
- Publishing an npm package in the first release.
- Automatically installing Docker, Node, `uv`, LM Studio, local model weights, Pi, or MCP servers.
- Creating third-party accounts or automating login/MFA enrollment.
- Bypassing CAPTCHA, anti-bot systems, access controls, or job-board restrictions.
- Hosting a shared Job Hunter service or centralizing user data.
- Guaranteeing Windows support in the first release.
- Refactoring the job-search, scoring, salary, or application behavior beyond portability and packaging changes required by this PRD.

## Design / Technical Considerations

- Use a monorepo with `skills/<skill-name>/` as the source of truth, plus root-level installer, verification, documentation, Compose, and CI files.
- Treat the current global skill directories as review inputs, not files to copy blindly. Exclude `.DS_Store`, caches, generated artifacts, local evidence, personal data, and stale profile-specific paths.
- Use a generated installation manifest containing file paths and content hashes so upgrades and uninstall are precise and user files are never removed accidentally.
- Prefer one root Node lockfile unless a bundled skill has a justified isolated runtime. Preserve PEP 723 `uv run` helpers for DOCX/PDF portability.
- Classify integrations such as Obscura MCP, Apple Mail MCP, authenticated Chromium, and LM Studio by the workflow stages that need them. A missing optional integration must degrade only its dependent feature.
- The publication safety scan must inspect both filenames and text content, and it must run again against the built release archive.
- The first supported release target is the currently observed Pi global skill layout and Docker-based Chromium workflow. Linux host support may be added only after a real installation rehearsal proves it.
- This file is the local issue of record until the clean GitHub repository exists. The first externally visible repository setup step must create a GitHub issue containing this plan before implementation continues.

## Success Metrics

- A clean checkout completes `npm ci` and `npm test` without access to the maintainer's home directory.
- The skill-closure verifier reports every referenced required skill as bundled or explicitly allowlisted.
- The installer succeeds twice against the same temporary home while preserving seeded user-owned files.
- The release-safety scanner reports no forbidden file or text findings in both the source tree and release archive.
- The bounded Compose rehearsal verifies Selenium/CDP and SearXNG against the shipped configuration.
- A fresh installation reaches the documented doctor state and can identify unavailable optional integrations without treating them as core installation failure.

## Open Questions

- What GitHub owner and repository name should be used when publication begins?
- Should Linux become a formally supported host after the first macOS/Docker release rehearsal?
- Should optional integrations such as Apple Mail MCP receive separate setup guides in the first release or follow in later documentation issues?
