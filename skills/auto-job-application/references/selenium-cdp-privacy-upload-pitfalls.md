# Selenium CDP application pitfalls: privacy banners and file uploads

Use this reference during browser-based job applications when the active browser is Selenium Chromium on CDP port `9225`.

## 1. Reuse the existing 9225 browser session

When the user already has an authenticated Selenium Chromium session on `127.0.0.1:9225`, drive that target directly through CDP. Do not switch to Pi Agent `browser_navigate` tabs or another browser context; doing so may open an unauthenticated LinkedIn/session copy and trigger avoidable login/MFA.

Recommended sequence:

1. Inspect `http://127.0.0.1:9225/json/list`.
2. Pick the relevant `page` target (LinkedIn feed/job page or ATS page).
3. Attach via its `webSocketDebuggerUrl`.
4. If Chrome returns WebSocket origin `403`, reconnect with no Origin / suppressed Origin. Do not change browser sessions as the first response.

## 2. Fill before submit

Some ATS forms expose an enabled submit button even while mandatory fields are empty. Before clicking submit, verify:

- name, email, phone, address fields are populated
- required screening fields are answered truthfully
- dropdowns have non-empty values where required
- file inputs show the expected selected filename(s)
- visible privacy/cookie overlays are cleared

## 3. Privacy/cookie disclaimer iframe pattern

NTT DATA-style pages can render the privacy/cookie disclaimer in same-origin iframes such as:

- `#ifrmCookieBanner`
- `#ifrmPrivacyBanner`

The visible text contains links like `Privacy Policy` and `Cookie Policy`; those are not the accept controls. Inspect the iframe document and click the real accept button, commonly:

- `#sp-accept`
- `.evSpAcceptBtn`
- button text exactly `Accept`

After clicking, verify the banner iframe is not visible. A small trust/privacy badge may remain visible and is normal.

## 4. Selenium-container file upload path pattern

When Chromium runs inside the Selenium container, `DOM.setFileInputFiles` must use file paths visible inside the container. Host-only paths such as `/host-only/path/CV.pdf` may appear selected in the DOM but fail at submit time because the browser process cannot read them.

Failure signature after submit:

```text
chrome-error://chromewebdata/
Your file couldn’t be accessed
ERR_FILE_NOT_FOUND
```

Fix:

1. Copy or mount the CV/cover letter into a path visible to the Selenium browser container, e.g. `/tmp/CV.pdf` inside the container.
2. Set the file input using the container-visible path.
3. Re-read each file input and confirm the selected filename.
4. Submit again and verify confirmation or validation errors.

Do not treat `ERR_FILE_NOT_FOUND` as an ATS rejection; it is an upload path/access issue.