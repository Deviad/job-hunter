# Pi MCP Repair — Findings

## Root cause (confirmed twice: obscura May 2026, apple-mail 2026-08-17)

Pi's MCP adapter (`pi-mcp-adapter` package) keeps one `ServerConnection`
object per server in an in-memory map. When the stdio child process dies —
request timeout, crash, or kill — the cached object's `status` often stays
`"connected"` because nothing watches the transport EOF.

Two consequences in `server-manager.ts` / `proxy-modes.ts`:

1. `ServerManager.connect()` (v2.11.0 lines ~105-110) reuses any connection
   whose status is `"connected"` without verifying the child is alive:
   "Reuse existing connection if healthy" — the health check is status-only.
   So `mcp({ connect: ... })` and `/mcp reconnect` return the stale
   connection's cached tool list and never spawn a new process.
2. The call path's auto-reconnect only fires when
   `!connection || connection.status !== "connected"`. With the stale status
   it proceeds straight to `client.callTool(...)`, which throws the SDK's
   transport error, surfaced as `Failed to call tool: Not connected`.

`ServerManager.close(name)` (v2.11.0 line ~417) is the safe reset: no-op when
absent, deletes from the map before async cleanup (race-safe by design).

## The fix: two patches in proxy-modes.ts

Both are applied by `scripts/repair-pi-mcp.sh` with version-tolerant regex
anchors and idempotency markers (`pi-mcp-repair: ...`).

- **Patch A (connect path)**: in `executeConnect`, insert
  `await state.manager.close(serverName).catch(() => {});` immediately before
  `let connection = await state.manager.connect(serverName, definition...)`.
  Explicit connects now always force a fresh spawn. Anchor: the
  `state.ui.setStatus("mcp", \`MCP: connecting to ...\`)` line precedes it.
  Note v2.11.0 passes a `signal` arg; the older patched version did not —
  the regex accepts both.
- **Patch B (call path)**: in the generic tool-call catch block (identified
  by `uiSession?.sendToolCancelled(message);` followed by
  `const schemaText =`), close the connection when the error matches
  `/not connected|connection closed|connection is not open|transport closed|broken pipe/i`.
  The next call then hits the auto-reconnect branch and succeeds. Deliberately
  NOT matching "timed out": a slow-but-healthy server answering a long request
  must not have its connection torn down.

Verify patch presence:
`grep -c "pi-mcp-repair" ~/.pi/agent/npm/node_modules/pi-mcp-adapter/proxy-modes.ts`
expect `2`.

## Why it recurs: adapter upgrades wipe the patch

The patch edits files inside the `pi-mcp-adapter` package. Any upgrade or
reinstall of the package replaces those files and silently removes the patch.
Evidence on 2026-08-17: installed v2.11.0 had zero `pi-mcp-repair`/
`Treat explicit connect requests as reconnects` markers and no
`proxy-modes.ts.bak.*` files, although the obscura incident had been patched
previously; registry latest was 2.26.0. Therefore: **re-run
`repair-pi-mcp.sh` after every Pi / pi-mcp-adapter update** (same posture as
`pi-anthropic-toolid-patch` after `brew upgrade pi-coding-agent`).

Anchor text changes between adapter versions (v2.11.0 added `, signal`,
`UrlElicitationRequiredError` handling, and `guardMcpOutput` in the catch).
If both WARN anchors appear, read the current `proxy-modes.ts`
(`executeConnect` + the generic call catch) and update the regexes here.

## Incident log

### obscura (2026-05, original incident)
Symptoms: `Not connected`, `CDP connection closed`, connect listed tools but
no process. Fixed via wrapper + cache clear + adapter patch; documented in
`obscura-mcp-repair`.

### apple-mail (2026-08-17)
- `apple_mail_search_messages` on the Google account timed out
  (`MCP error -32001: Request timed out`), after which the connection
  closed and every call failed with `Not connected`.
- `mcp({})` showed `✓ apple-mail (24 tools)`; `ps` had no
  `apple-mail-fast-mcp` process; `mcp({ connect })` returned the cached tool
  list three times without spawning.
- Server binary itself was healthy: launched standalone it stays alive with
  stdin open (server binary at configured `command` path).
- Workaround that unblocked the user immediately: drive Mail.app directly
  with `osascript` (the MCP server is a thin wrapper over AppleScript/IMAP).
  Gotchas: Mail.app account names differ from the MCP `name` field
  (`candidate@example.invalid`, `candidate@example.invalid`); mailbox names are
  Mail.app's (`Inbox`, `Sent Mail`, `Sent Items`), not IMAP's (`INBOX`);
  AppleScript handlers that read Mail properties must run inside a
  `tell application "Mail"` block or `date received` fails to resolve.
- AppleScript `whose sender contains` on inbox-sized mailboxes was fast
  (seconds); avoid `content contains` sweeps on large mailboxes.

## Known non-fixes

- Repeated `mcp({ connect })` calls: returns stale cached tools, never spawns.
- `/mcp reconnect <server>`: same code path (`lazyConnect`), same result.
- Waiting for backoff to expire: backoff only applies after a *failed
  connect*; the stale path never fails the connect.
