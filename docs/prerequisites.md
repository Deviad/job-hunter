# Prerequisites

Host tools are required for the pipeline to operate. They must be installed manually — the installer and doctor verify their presence but never install host-level software silently.

## Automatically Installed Code Dependencies

The global bootstrap copies the bundled skills and runs `npm ci` from the shipped workspace lockfile. It does not install host tools, containers, MCP servers, authenticated browser sessions, or model weights.

## Required Host Tools

| Tool | Purpose | Verify | Install (macOS) |
|------|---------|--------|------------------|
| Node.js ≥ 22 | Script runtime | `node --version` | `brew install node` |
| npm | Package manager | `npm --version` | bundled with Node |
| uv ≥ 0.4 | PEP 723 Python helpers (docx, pdf) | `uv --version` | `brew install uv` |
| python3 ≥ 3.11 | DOCX/PDF tools, inline extractions | `python3 --version` | bundled / `brew install python` |
| sqlite3 CLI | Schema inspections, ad-hoc queries | `sqlite3 --version` | bundled / `brew install sqlite` |
| docker + compose | Selenium Chromium, SearXNG | `docker compose version` | [Docker Desktop](https://docs.docker.com/desktop/) |
| git | Installation, updates | `git --version` | `xcode-select --install` |

## Container Services and Conditional Requirements

| Tool | Stage | Verify | Notes |
|------|-------|--------|-------|
| Chromium CDP (`127.0.0.1:9225`) | Search, Apply | `bash scripts/rehearse-compose.sh` | Provided by `compose.yaml` |
| SearXNG (`127.0.0.1:8888`) | Discover | `curl -sf http://127.0.0.1:8888/search?q=test` | Provided by `compose.yaml`; set `SEARXNG_SECRET` before startup |
| Authenticated LinkedIn session | LinkedIn search | Manual login in Selenium browser | Session is user-managed |
| Authenticated Indeed session | Indeed search | Manual login in Selenium browser | Session is user-managed |

## Service Data and Secrets

The installer creates `chromium-profile/` and `searxng/` under `$JOBHUNTER_HOME`; Compose bind-mounts them for browser state and SearXNG configuration. Set `SEARXNG_SECRET` to a random local value before `docker compose up -d`. The repository contains no default credential, and the installer never starts containers.

## Optional

| Tool | Stage | Purpose | Notes |
|------|-------|---------|-------|
| LM Studio (`127.0.0.1:1234`) | CAPTCHA solve, Visual debug | Qwen VLM inference | Never downloaded by installer |
| Obscura MCP | Browse, Apply | Headless browsing alternative | Pi MCP integration; see `obscura-mcp-repair` skill |
| Apple Mail MCP | Outreach | Cold email sending | Pi MCP integration |
| Brave browser | Brave session bridge | Cookie relay to Obscura | `brave-obscura-session` skill |

## Doctor

`jh-doctor.mjs` checks all required and conditional prerequisites, reporting which are present, missing, or degraded. It distinguishes required failures (exit non-zero) from optional degradations (warning only).
