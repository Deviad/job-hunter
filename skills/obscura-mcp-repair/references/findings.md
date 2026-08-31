# Obscura MCP Repair Findings

## Symptoms Observed

- `mcp({})` showed Obscura with 4 tools, but tool calls failed with `Failed to call tool: Not connected`.
- `mcp({ connect: "obscura" })` listed tools but did not spawn or keep an `obscura-mcp` process.
- Previous errors included:
  - `Execution Error: CDP connection closed`
  - `Execution Error: CDP connection is not open`
  - `Obscura CDP client is not connected`
  - `Cannot read properties of null (reading 'send')`
- Booking.com was blocked by robot/JS checks. Trip.com JSON extraction worked for hotel-price scraping.
- LinkedIn `/login` rendered a shell with zero inputs/buttons/forms; `/uas/login` rendered the classic login form.

## Confirmed Working Direct MCP Test

A standalone MCP SDK test using `StdioClientTransport` worked with:

- command: `$HOME/.local/bin/obscura-mcp-pi-wrapper` (created by repair script)
- args: `--transport stdio`
- env:
  - `OBSCURA_PATH=$HOME/.local/bin/obscura`
  - `OBSCURA_STEALTH=true`

It listed:

- `browse_page`
- `browse_interact`
- `browse_session`
- `browse_scrape`

And `browse_page` against `https://example.com` returned `Example Domain`.

## Effective Fix

1. Create wrapper: `~/.local/bin/obscura-mcp-pi-wrapper`
2. Point Pi MCP config at wrapper: `~/.pi/agent/mcp.json`
3. Clear stale metadata cache: `~/.pi/agent/mcp-cache.json`
4. Reload Pi so the MCP adapter drops stale in-memory state.
5. Patch `pi-mcp-adapter/proxy-modes.ts` so explicit connect closes any existing cached client first.

## Why the Wrapper Helps

Pi launches MCP servers under its extension runtime, where PATH/env can differ from an interactive shell. The wrapper makes startup deterministic and writes logs without polluting MCP stdout.

Important: MCP stdio protocol uses stdout, so wrapper diagnostics must go to stderr or a file only.

## Wrapper Log

Default log path:

```text
/tmp/obscura-mcp-pi-wrapper.log
```

Working startup includes:

```text
Starting Obscura service...
Using Obscura binary: $HOME/.local/bin/obscura
CDP server: ws://127.0.0.1:9222/devtools/browser
Connected to Obscura CDP at ws://127.0.0.1:9222/devtools/browser
Obscura MCP Server running on stdio
```

## Good Verification Sequence

```js
mcp({})
mcp({ connect: "obscura" })
mcp({ tool: "obscura_browse_page", args: '{"url":"https://example.com","format":"text"}' })
```

Expected final output contains:

```text
Example Domain
```

## LinkedIn Selectors

Use:

```text
https://www.linkedin.com/uas/login
```

Expected selectors:

```text
#username
#password
button.btn__primary--large
```

Avoid collecting credentials unless the user explicitly chooses that route. Prefer cookie injection for logged-in flows.
