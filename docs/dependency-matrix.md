# Dependency Matrix

This matrix covers every bundled skill and classifies code dependencies, executables, services, MCP integrations, and workflow-stage optionality. **Required** means the named workflow cannot run without it. **Conditional** means only specific stages need it. **Optional** means its absence degrades a recovery or convenience path.

## Skills and Packages

| Skill | Class | Node packages | Python dependencies | Direct skill dependencies |
|---|---|---|---|---|
| `job-hunter` | Core | `better-sqlite3`, `ws` | Standard-library ZIP/XML profile extraction | LinkedIn, Indeed, scorer, salary, auto-apply |
| `linkedin-job-search` | Core | `ws`, workspace `better-sqlite3`, sibling `job-hunter` skill (persisted LinkedIn access state) | None | CAPTCHA and browser repair paths |
| `indeed-job-search` | Core | `ws`, workspace `better-sqlite3` | None | LinkedIn SQLite saver, CAPTCHA and browser repair paths |
| `job-match-scorer` | Core | workspace `better-sqlite3`, Node profile loader | Standard-library scorer | `job-hunter` profile loader and DOCX reader, salary handoff |
| `salary-calculator` | Core | `better-sqlite3` | None | Browser session bridge for posted-salary evidence |
| `auto-job-application` | Core | `better-sqlite3`, `ws` | Standard-library helpers | CAPTCHA, Qwen recovery, Selenium visual recovery, DOCX/PDF |
| `captcha-resolution` | Required support | `ws` | `Pillow` through its helper environment | Qwen recovery when visual interpretation is needed |
| `qwen-screenshot-debug` | Required support | `ws` | Standard library | LM Studio/Qwen service |
| `selenium-container-visual-click-recovery` | Required support | None | Standard library | Qwen screenshot debugging |
| `obscura-mcp-repair` | Required support | None | None | Pi MCP repair |
| `pi-mcp-repair` | Required support | None | None | Pi MCP gateway |
| `brave-obscura-session` | Required support | `ws` | Standard library | Obscura MCP |
| `docx` | Required support | None | PEP 723: `python-docx`, shared document helper | `uv` |
| `pdf` | Required support | None | PEP 723: `pypdf`, `reportlab`, shared document helper | `uv` |

The root `package.json` and `package-lock.json` pin the shared Node packages. DOCX and PDF helpers declare isolated Python dependencies in their PEP 723 scripts, run with `uv run`, and share the bundled `skills/_document_common/document_common.py` helper.

## Executables

| Executable | Requirement | Used by |
|---|---|---|
| Node.js 22 or newer and npm | Required | All JavaScript skills and bootstrap |
| `sqlite3` | Required | Workspace diagnostics and database operations |
| `python3` | Required for profile workflows | CV profile extraction, scoring and ATS/document helpers |
| `uv` | Conditional | DOCX and PDF helpers |
| Docker with Compose | Conditional | Selenium Chromium and SearXNG services |
| `ffmpeg` and `xdotool` | Conditional, inside recovery environment | Selenium visual click recovery |
| Git | Required for source installation and updates | Bootstrap workflow |

## Services

| Service | Default endpoint | Requirement | Workflow |
|---|---|---|---|
| Selenium Chromium/CDP | `127.0.0.1:9225` | Conditional | LinkedIn/Indeed search and applications |
| SearXNG | `127.0.0.1:8888` | Conditional | External job discovery |
| LM Studio with Qwen VLM | `127.0.0.1:1234` | Optional | Screenshot interpretation and visual recovery |

`compose.yaml` provides Selenium Chromium and SearXNG. The installer verifies heavyweight prerequisites but does not install Docker, start services, or download model weights.

## MCP Integrations

| Integration | Requirement | Used by |
|---|---|---|
| Obscura MCP | Conditional | Alternate authorized browser flows and repair |
| Pi MCP gateway | Conditional | MCP repair skills |
| Apple Mail MCP | Optional | Authorized email-code retrieval during applications |
| Context-mode MCP | Optional | Large-output analysis by the controlling Pi agent |

## Workspace Dependencies

`$JOBHUNTER_HOME` defaults to `~/.job-hunter` and contains user-owned runtime state:

- `jobhunter.sqlite`
- `CV.docx`
- `personal-info-cache.json`
- `profile-derived.json` (regenerated CV evidence)
- `profile-confirmation.json` (confirmation tied to the effective profile hash)
- `search-config.json` (user-selected countries and search settings)
- `node_modules/better-sqlite3`
- `node_modules/ws`
- generated logs, backups, and run artifacts

These files are installed or created locally and are excluded from the publication repository.

## Workflow-Stage Optionality

| Stage | Active skills | Required service or integration |
|---|---|---|
| Initialize and doctor | `job-hunter` | Local Node, npm, SQLite |
| Search | `job-hunter`, LinkedIn, Indeed | Authenticated Selenium Chromium/CDP |
| Discover | `job-hunter` | SearXNG |
| Score | `job-match-scorer`, DOCX | Local CV and workspace profile |
| Salary | `salary-calculator` | Database; browser access only for posted evidence |
| Apply | `auto-job-application`, CAPTCHA support | Authenticated Selenium Chromium/CDP |
| Visual recovery | Qwen and Selenium recovery skills | Optional LM Studio/Qwen, `ffmpeg`, `xdotool` |
| MCP repair | Obscura and Pi MCP repair skills | Corresponding MCP server |
