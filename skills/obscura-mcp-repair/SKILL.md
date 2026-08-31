---
name: obscura-mcp-repair
description: Repairs Pi MCP configuration for Obscura browser automation when calls fail with "Not connected", "CDP connection closed", "CDP connection is not open", or metadata shows Obscura tools but runtime calls fail. Use before Obscura browsing, scraping, hotel searches, or LinkedIn/login flows when Obscura MCP is broken.
allowed-tools: read bash edit write mcp
---

# Obscura MCP Repair

## Global Obscura Reuse Rule

Before repairing, check for an existing local Obscura CDP browser and preserve it if reachable. Do not kill or start a second `obscura serve` instance just to repair MCP metadata. Use `--kill-stale` only when the existing Obscura/Obscura-MCP processes are confirmed stale or broken.

Use this skill when the Pi MCP gateway can list Obscura tools but calls such as `obscura_browse_page` fail, especially with:

- `Failed to call tool: Not connected`
- `Execution Error: CDP connection closed`
- `Execution Error: CDP connection is not open`
- `Obscura CDP client is not connected`
- `mcp({})` shows cached/connected Obscura metadata, but no `obscura-mcp` process is running

## Key Findings

- **Generic variant**: the stale-connection root cause affects ALL Pi MCP servers, not just obscura. For non-obscura servers (apple-mail, searxng, ...) or a pure stale-connection repair, use the `pi-mcp-repair` skill (`~pi-mcp-repair skill`) and its `repair-pi-mcp.sh [server]`. This obscura script additionally manages the obscura wrapper + browser processes.
- **Adapter upgrades wipe the patch** in `pi-mcp-adapter/proxy-modes.ts`. Re-run the repair after every Pi / pi-mcp-adapter update (verify: `grep -c "pi-mcp-repair" <adapter>/proxy-modes.ts` should be 2).
- Pi’s global MCP config is normally `~/.pi/agent/mcp.json`, not `~/.pi/mcp.json`.
- Obscura works reliably when launched through a wrapper that:
  - uses absolute paths,
  - sets `OBSCURA_PATH`,
  - sets `OBSCURA_STEALTH=true`,
  - logs startup/CDP errors to `/tmp/obscura-mcp-pi-wrapper.log`.
- Clearing `~/.pi/agent/mcp-cache.json` forces fresh MCP metadata discovery.
- The running Pi session may keep stale MCP client state; after repair, ask the user to run `/reload` if the tool state was already initialized.
- If `mcp({ connect: "obscura" })` only returns cached tools and does not spawn a process, patching `pi-mcp-adapter` to close before explicit reconnect fixes stale-client reuse.

## One-command Repair

Run the bundled script:

```bash
../obscura-mcp-repair/scripts/repair-obscura-mcp.sh
```

The script is idempotent. It will:

1. find `obscura-mcp` and the Obscura browser binary,
2. create/update `~/.local/bin/obscura-mcp-pi-wrapper`,
3. merge the `obscura` server into `~/.pi/agent/mcp.json`, preserving other MCP servers,
4. back up and remove `~/.pi/agent/mcp-cache.json`,
5. preserve existing Obscura CDP browser processes by default,
6. patch `pi-mcp-adapter` so explicit `mcp({ connect: "obscura" })` forces a fresh child process.

If stale processes must be stopped, run `repair-obscura-mcp.sh --kill-stale` after confirming no healthy Obscura CDP browser should be reused.

## Post-repair Workflow

After running the script:

1. If already inside Pi, tell the user to send:

   ```text
   /reload
   ```

2. Then verify status:

   ```js
   mcp({})
   ```

   Expected before connecting:

   ```text
   MCP: 0/1 servers, 0 tools
   ○ obscura (not connected)
   ```

3. Connect:

   ```js
   mcp({ connect: "obscura" })
   ```

4. Check the wrapper log and process list if needed:

   ```bash
   tail -80 /tmp/obscura-mcp-pi-wrapper.log
   ps -Ao pid,ppid,etime,command | rg -i 'obscura-mcp|/.local/bin/obscura serve'
   lsof -iTCP:9222 -sTCP:LISTEN -n -P
   ```

5. Test the actual tool path:

   ```js
   mcp({ tool: "obscura_browse_page", args: '{"url":"https://example.com","format":"text"}' })
   ```

   Expected result contains `Example Domain`.

## Config Shape

The repaired `~/.pi/agent/mcp.json` should contain an `obscura` server like this:

```json
{
  "mcpServers": {
    "obscura": {
      "command": "$HOME/.local/bin/obscura-mcp-pi-wrapper",
      "args": ["--transport", "stdio"],
      "lifecycle": "lazy",
      "idleTimeout": 1,
      "env": {
        "OBSCURA_PATH": "$HOME/.local/bin/obscura",
        "OBSCURA_STEALTH": "true"
      }
    }
  }
}
```

Use `$HOME`-relative equivalents on other machines.

## LinkedIn Finding

For LinkedIn login flows, `https://www.linkedin.com/login` may render a stripped/challenged shell with no inputs. Use:

```text
https://www.linkedin.com/uas/login
```

Expected selectors:

- email: `#username`
- password: `#password`
- submit: `button.btn__primary--large`

Do not ask users to paste passwords unless they explicitly choose that flow. Prefer cookie/session injection for authenticated automation.

## If Repair Still Fails

Inspect in this order:

1. `~/.pi/agent/mcp.json`
2. `/tmp/obscura-mcp-pi-wrapper.log`
3. `ps` for `obscura-mcp` and `obscura serve`
4. `lsof -iTCP:9222 -sTCP:LISTEN -n -P`
5. direct wrapper test using the MCP SDK if available
6. whether the Pi session needs `/reload`

See `references/findings.md` for the detailed incident notes.
