# CDP Session Transfer Notes

## Ports

Use separate local CDP ports and reuse any existing Obscura CDP browser before starting another one:

- Brave: `127.0.0.1:9223`
- Obscura: usually `127.0.0.1:9222`, or the existing/user-specified port such as `9225`

Do not launch Brave on the Obscura port, and do not start a second `obscura serve` while one is already reachable.

## Brave Launch Command macOS

The helper supports automatic launch:

```bash
scripts/bridge-brave-to-obscura.mjs \
  --url "https://example.com/" \
  --launch-brave
```

Manual equivalent (always use the CDP pipe proxy to avoid focus stealing):

```bash
node ../auto-job-application/scripts/brave-cdp-proxy.mjs --port 9223 --verbose
```

Then open the target site and confirm it is logged in.

If Brave is already running without CDP, Chromium may ignore new remote-debugging flags. Quit Brave fully and retry if `127.0.0.1:9223` does not become reachable.

## Data Copied

The helper copies:

- Cookies for the target URL via CDP `Network.getCookies`
- Optional localStorage via `Runtime.evaluate`
- Optional sessionStorage via `Runtime.evaluate`

It does not print secret values.

## Injection Into Obscura

The helper connects to Obscura CDP and uses:

- `Network.setCookies` for cookies
- `Runtime.evaluate` for storage
- `Page.reload` after storage injection

This gives Obscura's browser process the session state for the target origin.

## Why Not Password Automation

For logged-in flows, copying an existing browser session is often safer and less brittle than asking the user for a password or trying to automate login forms. It also avoids exposing credentials to the conversation.

## Cleanup

Remove temp files:

```bash
rm -f /tmp/brave-obscura-session-*.json
```

Close the CDP-enabled Brave instance when finished.
