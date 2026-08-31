---
name: qwen-screenshot-debug
description: Browser automation visual debugging with screenshot + local Qwen VLM. Use when a page state is uncertain, an expected upload/submit/navigation does not appear, CDP/DOM checks time out, automation seems stuck waiting for a browser change, or a local screenshot-helper approval/denial needs clarification. See references/local-qwen-helper-approval.md.
allowed-tools: read bash write
---
# Qwen Screenshot Debug

Use this skill whenever browser automation is blocked by uncertainty about what the user-visible page actually shows.

## Trigger rule

Before declaring an application step failed, retrying blindly, or waiting again, **capture a screenshot and ask the local Qwen VLM to inspect it** when any of these happen:

- an upload, submit, save, continue, or navigation was expected but DOM/CDP checks do not confirm it
- `Runtime.evaluate`, accessibility snapshots, or DOM polling time out after an action
- a spinner/progress state appears to hang
- a hidden input/file upload was manipulated and the visible UI state is unclear
- a page is technically reachable but automation cannot identify the next visible control
- the user says the visible browser shows success but automation did not detect it

The screenshot is the source of truth for visible UI state. Do not infer failure from missing DOM text alone.

**This is the DEFAULT stuck-flow protocol**, not a last resort: any time a click, form fill, or submit cannot progress — in LinkedIn Easy Apply, any ATS, or any browser flow — run visual recovery BEFORE retrying the same DOM action, before switching strategies blindly, and before marking anything failed/blocked.

## One-command entry point: `scripts/visual-recover.mjs`

Prefer this over hand-rolling the capture→ask→click→verify steps. It pairs the capture method with the correct coordinate system automatically and verifies after clicking.

```bash
# Inspect what the stuck page actually shows (CDP viewport, first page tab)
node ../qwen-screenshot-debug/scripts/visual-recover.mjs

# Pick the tab and ask a specific question
node ../qwen-screenshot-debug/scripts/visual-recover.mjs \
  --url-substr linkedin.com/jobs --prompt "Did the Easy Apply modal advance past the resume step? Any validation errors?"

# Inspect + click the next control Qwen identifies + verify the state changed (exit 3 if unchanged)
node ../qwen-screenshot-debug/scripts/visual-recover.mjs --url-substr linkedin.com --click

# Container display capture + xdotool click — for JS alerts/native modals CDP screenshots can't see
node ../qwen-screenshot-debug/scripts/visual-recover.mjs --capture ffmpeg --click
```

Coordinate-system contract (the historical #1 failure when mixed): `--capture cdp` → viewport px → CDP `Input.dispatchMouseEvent`; `--capture ffmpeg` → X-display px → `xdotool` in the container. Never feed ffmpeg coordinates to CDP or vice versa.

Escalation ladder when stuck:
1. `visual-recover.mjs` (inspect) — what does the page actually show?
2. If Qwen sees a clickable control but DOM selectors can't reach it → `--click` (CDP first).
3. If CDP screenshots look fine but the click has no effect, or a native alert/modal is suspected → `--capture ffmpeg --click` (full `selenium-container-visual-click-recovery` skill for pitfalls).
4. CAPTCHA visible → `captcha-resolution` skill.
5. Only after these: pause and escalate to the user with the screenshot path and Qwen's description.

Env overrides: `QWEN_VLM_ENDPOINT`, `QWEN_VLM_MODEL`, `BROWSER_CDP_PORT`, `SELENIUM_CONTAINER`.

## Local Qwen VLM endpoint

Use the existing local LM Studio vision endpoint documented by `captcha-resolution`:

- Endpoint: `http://localhost:1234/v1/chat/completions`
- Model: `qwen3.6-35b-a3b-holo3-qwopus-instruct-qx64-hi-mlx`
- Do **not** use DeepSeek on port `8002` for images; it is text-only and silently ignores screenshots.

## Workflow

1. Capture a screenshot of the relevant browser viewport or element.
2. Save it under `/tmp`, e.g. `/tmp/qwen-debug-<timestamp>.png`.
3. Send the screenshot to Qwen with a concrete visual-inspection prompt.
4. Prefer the bundled helper `scripts/qwen-vlm-inspect.mjs` instead of shell pipelines such as `curl ... | python3 -c ...`; Pi Agent/Tirith can flag network-output-to-interpreter pipelines as high-risk even when the endpoint is local.
5. Use Qwen's answer to decide the next action.
   - For coordinate requests, treat Qwen's answer as a hypothesis, not proof. When DOM/CDP is reachable, verify the coordinate with `document.elementFromPoint()` and/or the element's `getBoundingClientRect()` converted to the screenshot/xdotool coordinate system before clicking. Qwen can misidentify a nearby text/form area as a button when layout changes or DevTools has just been closed.
6. Record the finding in the application notes / skill known issues if it solves a reusable form issue.

If a tool approval result says a command was denied but the user did not intentionally deny it, do not abandon the workflow. Explain the exact action, ask for/accept explicit approval, then retry or use the safer bundled helper.

## CDP screenshot capture example

```js
const shot = await c.send('Page.captureScreenshot', {
  format: 'png',
  captureBeyondViewport: false
});
fs.writeFileSync('/tmp/qwen-debug.png', Buffer.from(shot.data, 'base64'));
```

If CDP on the target tab is wedged, use an alternate visual path instead of stopping:

- Selenium/WebDriver screenshot endpoint if the browser is a Selenium container
- OS screenshot (`screencapture`) if the visible browser window is on the desktop
- VNC/noVNC screenshot if the Selenium browser is visible there

For Selenium Chromium containers, use the `selenium-container-visual-click-recovery` skill: capture Xvfb with `ffmpeg`, ask Qwen for visible state/coordinates, and use `xdotool` inside the container to click blocked alerts or modal buttons.

## Qwen call example

Use the bundled helper to avoid approval friction from `curl | python`-style pipelines:

```bash
node ../qwen-screenshot-debug/scripts/qwen-vlm-inspect.mjs \
  /tmp/qwen-debug.png \
  "Inspect this browser screenshot. Answer only with: visible status, any error text, whether the expected action appears complete, and the next visible button/control to click."
```

The helper calls `http://localhost:1234/v1/chat/completions` directly from Node, parses JSON internally, and prints only the model answer.

## Prompt templates

### Upload state

> Inspect this browser screenshot. Did the resume/CV upload succeed? Quote any visible filename, success text, error text, or upload/remove button. If successful, what is the next visible control to continue?

### Stuck wait / timeout

> Inspect this browser screenshot. The automation waited for a state change but DOM checks timed out. What state is visibly shown? Is there a spinner, modal, validation error, file picker, success message, or next-step button?

### Form validation

> Inspect this application form screenshot. Identify visible validation errors, required fields still blank, and the next action the automation should take.

Workday-specific checkbox lesson: if a Workday step reports `Field and Value required` for a required acknowledgement/terms checkbox, do not trust prior programmatic checkbox handling. Capture a screenshot, ask Qwen whether the checkbox is visibly checked/unchecked, then click the actual visible input coordinates and verify `checked=true` / `aria-checked=true` before pressing Next.

### Verify filled field values

> For each field below, state the EXACT VALUE SHOWN and whether there's a red 'Value is required' error: 1) [field name], 2) [field name], ... Also: is the submit/next button enabled? Are any fields still empty?

Use this after filling a form with autocomplete/dropdown fields to confirm the correct option was selected — not just "something was typed." The keyboard+Enter fallback often selects the wrong dropdown entry; the VLM screenshot is the only reliable verification.

## Important lesson from NTT DATA application

The NTT DATA resume upload looked failed from DOM/CDP polling because `Runtime.evaluate` timed out after file selection. The visible page actually showed the upload had succeeded. The correct response was to take a screenshot and ask Qwen, not to assume the upload failed or retry with different file formats.

In the Selenium Chromium container, the alert was dismissed with `xdotool` after Qwen identified the `OK` button coordinates. See `selenium-container-visual-click-recovery` for the reusable workflow.

Base directory for this skill: this directory
