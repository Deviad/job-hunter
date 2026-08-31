---
name: brave-obscura-session
description: Reuses the user's own logged-in Brave browser session in Obscura by copying same-origin cookies, and optionally localStorage/sessionStorage, over local CDP. Use when a user wants Obscura browsing to inherit an already-authenticated Brave session for a website they control or are authorized to access.
allowed-tools: read bash mcp
---

# Brave → Obscura Session Bridge

This skill transfers a logged-in session from the user's **local Brave browser** to **Obscura** using local Chrome DevTools Protocol (CDP). It is for the user's own accounts/sessions only.

## Global Obscura Reuse Rule

Before starting or asking to start Obscura, always check for an existing local CDP browser and reuse it. Prefer a user-specified port first, then `OBSCURA_CDP_PORT` / `OBSCURA_PORT`, then common Obscura ports such as `9222` and `9225`. Do not spawn a second `obscura serve` instance while one is already reachable; pass the existing port to this bridge with `--obscura-port <port>`.

## Safety Rules

Before using this skill, confirm all of the following:

1. The user owns or is authorized to use the Brave session for the target site.
2. The user explicitly wants this session reused in Obscura.
3. Do **not** print cookies, bearer tokens, localStorage values, sessionStorage values, or auth headers.
4. Do **not** send exported session material to any network service.
5. Store temporary export files only with mode `0600`, preferably under `/tmp`, and delete them when done.
6. Bind CDP only to `127.0.0.1`; never expose it on a public interface.

If the user asks for secret values to be displayed, refuse and offer a redacted summary instead.

## When To Use

Use this skill when:

- Obscura needs to browse a logged-in website.
- The user is already logged in via Brave.
- Direct login automation is blocked, inconvenient, or unsafe.
- Cookie/session injection is preferable to asking the user for a password.

## Prerequisites

- Obscura MCP is working. If not, first use `/skill:obscura-mcp-repair`.
- Obscura CDP should already be listening on an existing local port, commonly `127.0.0.1:9222` or a user-specified port such as `9225`, after:

  ```js
  mcp({ connect: "obscura" })
  ```

- Brave must be reachable via local CDP on a **different port**, recommended `9223`.
- The helper script can launch Brave on `9223` with `--launch-brave` if it is not already reachable.

### Launch Brave With CDP on macOS

Preferred automated launch via the helper script:

```bash
scripts/bridge-brave-to-obscura.mjs \
  --url "https://example.com/" \
  --launch-brave
```

Manual launch equivalent (always use the CDP pipe proxy to avoid macOS focus stealing):

```bash
node ../auto-job-application/scripts/brave-cdp-proxy.mjs --port 9223 --verbose
```

This launches Brave with `--remote-debugging-pipe` and exposes the CDP API on `127.0.0.1:9223` — identical to `--remote-debugging-port` except without macOS window activation/focus stealing.

Then the user should open the target site in Brave and verify they are logged in.

Important: never use `--remote-debugging-port` or `--remote-debugging-address` directly — these cause Brave to steal macOS focus on every CDP target creation. Always use the pipe proxy. If `--launch-brave` cannot make `127.0.0.1:9223` reachable, quit Brave fully and restart the pipe proxy.

Check Brave CDP:

```bash
curl -s http://127.0.0.1:9223/json/version | python3 -m json.tool
```

## Main Workflow

1. Ask for target site URL, e.g. `https://www.linkedin.com/feed/`.
2. Ensure Obscura is connected:

   ```js
   mcp({ connect: "obscura" })
   ```

3. Run the bridge script. For cookies only:

   ```bash
   ../brave-obscura-session/scripts/bridge-brave-to-obscura.mjs \
     --url "https://example.com/" \
     --launch-brave \
     --brave-port 9223 \
     --obscura-port <existing-obscura-port> \
     --inject
   ```

4. If the site relies on SPA tokens in browser storage, ask for explicit consent to include storage, then run:

   ```bash
   ../brave-obscura-session/scripts/bridge-brave-to-obscura.mjs \
     --url "https://example.com/" \
     --launch-brave \
     --brave-port 9223 \
     --obscura-port <existing-obscura-port> \
     --include-storage \
     --inject
   ```

5. The script prints only a non-secret summary, such as counts and the path to the secret temp export. It does not print secret values.

6. Browse normally with Obscura:

   ```js
   mcp({ tool: "obscura_browse_page", args: '{"url":"https://example.com/","format":"text"}' })
   ```

   For multi-step browsing:

   ```js
   mcp({ tool: "obscura_browse_session", args: '{"action":"create","url":"https://example.com/"}' })
   ```

## Using From Other Skills

This skill is a **generic, reusable session bridge**. It works with any website, not just LinkedIn. When building new scraping or automation skills that require authenticated browser sessions:

1. **Prerequisites:** Ensure Obscura MCP is connected (`mcp({ connect: "obscura" })`) and the user is logged into the target site in Brave.
2. **Transfer Session:** Use the bridge script with the target URL:

   ```bash
   ../brave-obscura-session/scripts/bridge-brave-to-obscura.mjs \
     --url "https://target-site.com/" \
     --launch-brave \
     --inject
   ```

3. **If the site requires storage:** Add `--include-storage` for sites that rely on localStorage/sessionStorage tokens:

   ```bash
   ../brave-obscura-session/scripts/bridge-brave-to-obscura.mjs \
     --url "https://target-site.com/" \
     --launch-brave \
     --include-storage \
     --inject
   ```

4. **If you need to persist the session:** Add `--out /tmp/session-export.json` to save it for later use. Remember to delete the export file when done:

   ```bash
   rm -f /tmp/brave-obscura-session-*.json /tmp/session-export.json
   ```

5. **Verify:** Test the session in Obscura before proceeding with scraping:

   ```js
   mcp({ tool: "obscura_browse_page", args: '{"url":"https://target-site.com/","format":"text"}' })
   ```

Do not reinvent session transfer logic in new skills. Always use this bridge instead of asking users for passwords or cookies manually.

## Helper Script

Script path:

```text
../brave-obscura-session/scripts/bridge-brave-to-obscura.mjs
```

What it does:

- Checks Brave CDP at `127.0.0.1:<brave-port>`.
- If `--launch-brave` is passed and CDP is not reachable, launches the Brave CDP pipe proxy (`brave-cdp-proxy.mjs --port <brave-port>`) which starts Brave with `--remote-debugging-pipe` and exposes the CDP API on `127.0.0.1:<brave-port>` without macOS focus stealing.
- Waits for Brave CDP to become reachable.
- Finds or opens a Brave tab for the target origin.
- Extracts cookies for the target URL via CDP `Network.getCookies`.
- Optionally extracts `localStorage` and `sessionStorage` for the origin.
- Writes secret material to a `0600` JSON file under `/tmp` unless `--out` is provided.
- If `--inject` is passed, connects to Obscura CDP at `127.0.0.1:<obscura-port>` and injects cookies via CDP `Network.setCookies`, then injects storage via `Runtime.evaluate`.

## Important Limitations

- HttpOnly cookies can be copied by CDP but cannot be read or set via page JavaScript. This script uses CDP for cookies.
- `localStorage` generally persists for the origin in the target browser profile/context.
- `sessionStorage` is tab-scoped. Injecting it into Obscura may not help if Obscura MCP opens a different tab or isolated context later.
- Some sites bind sessions to device fingerprints, IP, TLS/browser properties, or anti-automation checks. A copied cookie may not be enough.
- Some Obscura operations may use isolated contexts. If CDP injection into Obscura does not carry over, use Obscura one-shot `cookies` arguments only if you can do so without exposing cookie values in chat/logs.

## Cleanup

After successful browsing, delete the temp export file shown by the script:

```bash
rm -f /tmp/brave-obscura-session-*.json
```

Close the CDP-enabled Brave instance when finished.

## Troubleshooting

### Brave CDP Not Reachable

If the script says Brave CDP is not reachable:

```bash
curl http://127.0.0.1:9223/json/version
```

If that fails, either use the helper's launch flag:

```bash
../brave-obscura-session/scripts/bridge-brave-to-obscura.mjs \
  --url "https://example.com/" \
  --launch-brave
```

Or quit Brave and relaunch via the CDP pipe proxy:

```bash
node ../auto-job-application/scripts/brave-cdp-proxy.mjs --port 9223 --verbose
```

### Obscura CDP Not Reachable

Run:

```js
mcp({ connect: "obscura" })
```

Then check the existing Obscura CDP port, for example:

```bash
curl -s http://127.0.0.1:<existing-obscura-port>/json/version | python3 -m json.tool
```

If Obscura still fails, use `/skill:obscura-mcp-repair`.

### Verify Without Printing Secrets

Use counts only:

```bash
python3 - <<'PY'
import json, glob
for p in glob.glob('/tmp/brave-obscura-session-*.json'):
    d=json.load(open(p))
    print(p, 'cookies=', len(d.get('cookies', [])), 'localStorageKeys=', len(d.get('localStorage', {})))
PY
```

Do not `cat` the export file into chat.

## LinkedIn Note

For LinkedIn UI login, `https://www.linkedin.com/login` may render a stripped shell. `https://www.linkedin.com/uas/login` renders the classic login form. But prefer this Brave session bridge over password-based automation.
