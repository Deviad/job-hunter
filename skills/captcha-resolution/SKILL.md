---
name: captcha-resolution
description: Resolves supported CAPTCHA and reCAPTCHA challenges during an authorized application flow through the existing Chromium CDP session. Use only when an application is visibly blocked by a supported challenge.
allowed-tools: read bash
---

# CAPTCHA Resolution

CAPTCHA handling is a recovery path for the user's authorized browser flow. It is not a bypass for login, account verification, rate limits, access controls, or job-board search restrictions.

## Boundaries

- Work only in the existing Chromium CDP session on `127.0.0.1:9225`.
- Confirm the challenge belongs to the authorized application tab.
- Do not export cookies, tokens, or challenge payloads.
- Do not send screenshots containing personal information to an unapproved external service.
- Stop for MFA, identity verification, unsupported challenges, repeated failures, or account-level security checks.
- Search/listing verification walls are hard stops; this skill is for supported application-flow challenges.

## Workflow

### 1. Inspect

Capture the visible page state and identify:

- challenge provider;
- checkbox, image-grid, or invisible challenge;
- iframe target and dimensions;
- whether the challenge is active, solved, expired, or replaced;
- whether the surrounding page is still the intended application.

### 2. Use DOM/CDP Evidence

Inspect challenge frames through CDP. Use stable frame and element geometry; do not guess coordinates from a stale screenshot. Recompute geometry after every challenge refresh.

### 3. Solve Supported Challenges

For image grids, use the bundled scripts and the approved local visual model path. Keep the prompt limited to the challenge image and requested object class.

The pixel fallback runs through its PEP 723 dependency environment:

```bash
uv run scripts/captcha-analyzer.py <image> <grid-size> <challenge-type>
```

Use the local Qwen helper when visual interpretation is required. If the model or challenge state is uncertain, pause instead of clicking speculative tiles.

### 4. Verify

A checkbox click or tile selection is not completion. Verify the challenge reports solved and the parent application can progress. If the token expires or the page replaces the challenge, restart from inspection.

### 5. Escalate

After a bounded failed attempt, capture the current state and ask the user to complete the challenge in Chromium. Never loop indefinitely or increase request volume against the site.

## Container Recovery

When the challenge is visible only in the Selenium container and CDP cannot operate it, use `selenium-container-visual-click-recovery`. Keep coordinate systems tied to the same capture source.

## Reference

- [SmartRecruiters/DataDome boundary](references/smartrecruiters-datadome.md)
