---
name: selenium-container-visual-click-recovery
description: Recovers an authorized Selenium Chromium flow with a screenshot, local Qwen coordinate analysis, and xdotool click when DOM/CDP automation cannot operate a visibly available control.
allowed-tools: read bash
---

# Selenium Container Visual Click Recovery

Use this only when the intended control is visible in the authorized Selenium container but DOM/CDP interaction cannot progress.

## Preconditions

- The target tab belongs to the user's authorized workflow.
- The visible page is not a login, MFA, identity-verification, CAPTCHA, anti-bot, or access-denied boundary.
- The expected control and desired action are known.
- A DOM/CDP attempt already failed or the control is demonstrably inaccessible.

## Workflow

1. Verify the Selenium container, noVNC backend, and browser tab.
2. Capture the visible browser from the container coordinate system.
3. Ask the approved local Qwen helper for the control's center coordinates and visible-state explanation.
4. Reject coordinates outside the captured browser bounds.
5. Click once with `xdotool` in the same coordinate system.
6. Capture again and verify a visible state change.
7. If nothing changed, stop and report the evidence rather than repeating clicks.

## Safety

- Never click a submit, consent, disclosure, payment, or destructive control without the user's authorization for that action.
- Never use visual clicks to bypass CAPTCHA, MFA, login, verification, or access controls.
- Do not send screenshots containing personal data to an unapproved external service.
- Keep one visual-recovery operation active on the shared browser at a time.

## Dependencies

- Selenium Chromium container
- `ffmpeg`
- `xdotool`
- `qwen-screenshot-debug`
- local LM Studio/Qwen endpoint when visual interpretation is required

## References

- [noVNC and container management](references/novnc-and-container-management.md)
- [SmartRecruiters visual recovery](references/smartrecruiters-click-and-novnc-recovery.md)
- [Submit coordinate recovery](references/smartrecruiters-submit-coordinate-recovery.md)
