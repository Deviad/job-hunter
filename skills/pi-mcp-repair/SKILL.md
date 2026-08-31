---
name: pi-mcp-repair
description: Repairs stale Pi MCP gateway connections for ANY MCP server (apple-mail, obscura, searxng, context-mode, ...) when mcp({}) or metadata shows tools/connected but tool calls fail with "Not connected", "connection closed", "Request timed out" followed by "Connection closed", or mcp({connect}) lists tools without spawning a server process. Also the canonical place to re-apply the pi-mcp-adapter stale-client patch after any pi-mcp-adapter upgrade. Use BEFORE declaring an MCP server unusable or falling back to workarounds.
allowed-tools: read bash edit write mcp
---

# Pi MCP Repair (generic, any server)

Generic repair for the Pi MCP gateway's stale-connection failure mode. The
obscura-specific wrapper/browser repair stays in `obscura-mcp-repair`; this
skill covers the shared root cause and works for every server in
`~/.pi/agent/mcp.json`.

## Failure signature (must match before repairing)

- `mcp({})` or a `connect` call shows the server as connected with N tools,
  but tool calls fail with `Failed to call tool: Not connected`,
  `connection closed`, or `connection is not open`.
- A `Request timed out` on a slow tool call, after which every further call
  fails and `connect` stops working.
- `mcp({ connect: "<server>" })` returns the tool list but `ps` shows no
  child process for that server's command.

Root cause: the MCP child process exits (timeout, crash, or killed) but the
adapter's cached client still reads `status === "connected"`.
`ServerManager.connect()` reuses a connection whose status is `"connected"`
without checking whether the child is alive, so it never respawns. Details
and incident history: `references/findings.md`.

## One-command repair

```bash
../pi-mcp-repair/scripts/repair-pi-mcp.sh [server-name] [--kill-stale] [--dry-run] [--no-patch-adapter] [--no-smoke-test]
```

Resolve `../pi-mcp-repair/scripts/repair-pi-mcp.sh` against this skill's
directory. The script is idempotent. With a `server-name` (key from
`~/.pi/agent/mcp.json`, e.g. `apple-mail`) it additionally:

1. resolves and verifies the configured command is executable,
2. with `--kill-stale`, pkills processes matching that command path,
3. runs a 3-second launch smoke test (process must survive with stdin held
   open) and reports its log.

Always, it:

4. backs up and removes `~/.pi/agent/mcp-cache.json` (forces fresh metadata
   discovery),
5. patches `pi-mcp-adapter/proxy-modes.ts` (idempotent, version-tolerant
   regex anchors) so explicit connects close any stale cached client first,
   and call failures matching connection-dead errors reset the stale state.

## Post-repair workflow

1. The patch only takes effect after the extension reloads. Tell the user to
   send `/reload` (or restart Pi).
2. Verify: `mcp({})` should show the server not connected, then
   `mcp({ connect: "<server>" })` must spawn the process — confirm with
   `ps aux | grep <command>`.
3. Test one real tool call against the server.

## UPGRADE WIPE — re-run after every pi-mcp-adapter update

The patch lives inside the `pi-mcp-adapter` package, so ANY update/reinstall
of that package removes it. This is why the failure recurs across servers.
Re-run `scripts/repair-pi-mcp.sh` after upgrading Pi or pi-mcp-adapter
(verify with `grep -c "pi-mcp-repair" <adapter>/proxy-modes.ts` — expect 2).

## While MCP is broken: use the direct backend

MCP servers are thin wrappers. If the user needs results immediately, drive
the underlying system directly instead of waiting for the repair:
apple-mail → Mail.app via `osascript` (accounts by Mail.app display name,
mailboxes often differ from IMAP names, e.g. Hotmail uses `Inbox` not
`INBOX`, Gmail has `Sent Mail`); obscura → the `obscura` binary; etc.

## If repair still fails

Inspect in order: `~/.pi/agent/mcp.json` command path → smoke-test log in
`/tmp/pi-mcp-repair-smoke.*.log` → adapter root resolution (script prints
it) → whether `/reload` happened after patching → `references/findings.md`.
