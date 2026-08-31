#!/usr/bin/env bash
set -euo pipefail

# Generic Pi MCP stale-connection repair. Works for any server in mcp.json.
# See the sibling SKILL.md for when/how to use this.

PATCH_ADAPTER=1
KILL_STALE=0
DRY_RUN=0
SMOKE_TEST=1
SERVER=""

usage() {
  cat <<'USAGE'
Repair stale Pi MCP gateway connections (any server).

Usage:
  repair-pi-mcp.sh [server-name] [--kill-stale] [--no-patch-adapter] \
                   [--no-smoke-test] [--dry-run]

  server-name          optional key from ~/.pi/agent/mcp.json (e.g. apple-mail).
                       Enables command verification, stale-process kill, and a
                       launch smoke test for that server.
  --kill-stale         pkill processes matching the server's configured command.
  --no-patch-adapter   skip the pi-mcp-adapter patch (cache clear only).
  --no-smoke-test      skip the 3s launch smoke test.
  --dry-run            print actions without changing anything.

Always: backs up + removes ~/.pi/agent/mcp-cache.json and patches
pi-mcp-adapter/proxy-modes.ts so explicit connects drop stale cached clients
and connection-dead call failures reset state. Re-run after any
pi-mcp-adapter upgrade (the patch lives inside the package).

After running inside a live Pi session, send /reload.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --kill-stale) KILL_STALE=1 ;;
    --no-kill) KILL_STALE=0 ;;
    --no-patch-adapter) PATCH_ADAPTER=0 ;;
    --no-smoke-test) SMOKE_TEST=0 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "Unknown flag: $1" >&2; usage >&2; exit 2 ;;
    *) SERVER="$1" ;;
  esac
  shift
done

home_dir="${HOME:-$(cd ~ && pwd)}"
pi_agent_dir="${PI_CODING_AGENT_DIR:-$home_dir/.pi/agent}"
mcp_config="$pi_agent_dir/mcp.json"
mcp_cache="$pi_agent_dir/mcp-cache.json"

say() { printf '[pi-mcp-repair] %s\n' "$*"; }
run() {
  if [[ "$DRY_RUN" == 1 ]]; then
    printf '[dry-run]'; printf ' %q' "$@"; printf '\n'
  else
    "$@"
  fi
}

if [[ ! -f "$mcp_config" ]]; then
  echo "ERROR: MCP config not found at $mcp_config" >&2
  exit 1
fi
say "Pi MCP config: $mcp_config"

# ---------------------------------------------------------------------------
# Optional: resolve, verify, kill-stale, and smoke-test one named server
# ---------------------------------------------------------------------------
server_command=""
if [[ -n "$SERVER" ]]; then
  say "Resolving server: $SERVER"
  server_command="$(python3 - "$mcp_config" "$SERVER" <<'PY'
import json, sys
path, name = sys.argv[1], sys.argv[2]
with open(path, encoding="utf-8") as f:
    cfg = json.load(f)
servers = cfg.get("mcpServers") or cfg.get("mcp-servers") or {}
srv = servers.get(name)
if not srv:
    sys.exit(f"server '{name}' not in {path}; keys: {sorted(servers)}")
cmd = srv.get("command")
if not cmd:
    sys.exit(f"server '{name}' has no command")
print(cmd)
PY
  )" || { echo "ERROR: $server_command" >&2; exit 1; }

  if [[ ! -x "$server_command" && ! -f "$server_command" ]]; then
    say "WARNING: command not executable at $server_command (may resolve via PATH)"
  else
    say "Command: $server_command"
  fi

  if [[ "$KILL_STALE" == 1 ]]; then
    say "Killing stale processes matching: $server_command"
    run pkill -f "$server_command" || true
  fi

  if [[ "$SMOKE_TEST" == 1 ]]; then
    server_args="$(python3 - "$mcp_config" "$SERVER" <<'PY'
import json, sys
path, name = sys.argv[1], sys.argv[2]
with open(path, encoding="utf-8") as f:
    cfg = json.load(f)
servers = cfg.get("mcpServers") or cfg.get("mcp-servers") or {}
print(" ".join(servers.get(name, {}).get("args") or []))
PY
    )"
    smoke_log="/tmp/pi-mcp-repair-smoke.$$.log"
    say "Smoke-testing launch (3s, log: $smoke_log)"
    if [[ "$DRY_RUN" == 1 ]]; then
      say "[dry-run] would launch: $server_command $server_args"
    else
      # Hold stdin open so a stdio server stays alive; check it survives 3s.
      # shellcheck disable=SC2086
      ( sleep 6 | "$server_command" $server_args > "$smoke_log" 2>&1 ) &
      launcher_pid=$!
      sleep 3
      if kill -0 "$launcher_pid" 2>/dev/null && pgrep -P "$launcher_pid" >/dev/null 2>&1; then
        alive_pid="$(pgrep -P "$launcher_pid" | while read -r p; do
          [[ "$(ps -p "$p" -o comm= 2>/dev/null)" != *sleep* ]] && echo "$p"
        done | head -1)"
        if [[ -n "$alive_pid" ]]; then
          say "OK: server process alive after 3s (pid $alive_pid)"
        else
          say "WARN: launcher alive but no child process yet"
        fi
      else
        say "FAIL: server process exited within 3s — see $smoke_log"
        tail -20 "$smoke_log" >&2 || true
      fi
      # Clean up the smoke-test process tree.
      pkill -P "$launcher_pid" 2>/dev/null || true
      kill "$launcher_pid" 2>/dev/null || true
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Always: clear stale metadata cache
# ---------------------------------------------------------------------------
if [[ -f "$mcp_cache" ]]; then
  ts="$(date +%Y%m%d%H%M%S)"
  say "Backing up + removing stale MCP metadata cache"
  if [[ "$DRY_RUN" == 0 ]]; then
    cp "$mcp_cache" "$mcp_cache.bak.$ts"
    rm -f "$mcp_cache"
    say "Backed up cache to $mcp_cache.bak.$ts"
  fi
else
  say "No MCP cache to clear ($mcp_cache absent)"
fi

# ---------------------------------------------------------------------------
# Locate pi-mcp-adapter package root
# ---------------------------------------------------------------------------
resolve_realpath() { python3 -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "$1"; }

find_adapter_root() {
  local bin real root candidate
  # Pi's bundled install location first.
  candidate="$pi_agent_dir/npm/node_modules/pi-mcp-adapter"
  if [[ -f "$candidate/proxy-modes.ts" ]]; then printf '%s\n' "$candidate"; return 0; fi
  if command -v pi-mcp-adapter >/dev/null 2>&1; then
    bin="$(command -v pi-mcp-adapter)"
    real="$(resolve_realpath "$bin")"
    root="$(dirname "$real")"
    if [[ -f "$root/proxy-modes.ts" ]]; then printf '%s\n' "$root"; return 0; fi
  fi
  if command -v npm >/dev/null 2>&1; then
    root="$(npm root -g 2>/dev/null || true)/pi-mcp-adapter"
    if [[ -f "$root/proxy-modes.ts" ]]; then printf '%s\n' "$root"; return 0; fi
  fi
  for candidate in "$home_dir/.nvm/versions/node"/*/lib/node_modules/pi-mcp-adapter; do
    if [[ -f "$candidate/proxy-modes.ts" ]]; then printf '%s\n' "$candidate"; return 0; fi
  done
  return 1
}

# ---------------------------------------------------------------------------
# Patch the adapter (idempotent, version-tolerant regex anchors)
# ---------------------------------------------------------------------------
if [[ "$PATCH_ADAPTER" == 1 ]]; then
  adapter_root="$(find_adapter_root || true)"
  if [[ -z "$adapter_root" ]]; then
    say "WARN: pi-mcp-adapter not found; skipping patch"
  else
    proxy_file="$adapter_root/proxy-modes.ts"
    say "Adapter root: $adapter_root"
    say "Patching stale-client behavior: $proxy_file"
    if [[ "$DRY_RUN" == 0 ]]; then
      ts="$(date +%Y%m%d%H%M%S)"
      cp "$proxy_file" "$proxy_file.bak.$ts"
      say "Backed up proxy-modes.ts to $proxy_file.bak.$ts"
      python3 - "$proxy_file" <<'PY'
from pathlib import Path
import re, sys

path = Path(sys.argv[1])
text = path.read_text()
changed = False

# Patch A: explicit connect must drop any stale cached client first.
# Anchor: the `let connection = await state.manager.connect(...)` inside
# executeConnect, which is preceded by the "MCP: connecting to" setStatus.
MARK_A = "pi-mcp-repair: explicit connect forces a fresh spawn"
if MARK_A not in text:
    pat_a = re.compile(
        r"([ \t]*)let connection = await state\.manager\.connect\("
        r"serverName, definition(?:, signal)?\);"
    )
    def repl_a(m):
        indent = m.group(1)
        return (
            f"{indent}// {MARK_A}\n"
            f"{indent}// A child MCP process can exit while the cached client still\n"
            f"{indent}// reads \"connected\"; close first so connect() respawns it.\n"
            f"{indent}await state.manager.close(serverName).catch(() => {{}});\n"
            f"{m.group(0)}"
        )
    # Only patch the occurrence that follows the executeConnect setStatus.
    anchor = 'state.ui.setStatus("mcp", `MCP: connecting to ${serverName}...`);'
    anchor_pos = text.find(anchor)
    if anchor_pos >= 0:
        region_start = anchor_pos
        # Find the first connect() call after the anchor.
        match = None
        for match in pat_a.finditer(text, region_start):
            break
        if match:
            text = text[:match.start()] + repl_a(match) + text[match.end():]
            changed = True
        else:
            print("WARN: Patch A anchor (connect after setStatus) not found", file=sys.stderr)
    else:
        print("WARN: Patch A setStatus anchor not found", file=sys.stderr)
else:
    print("Patch A already applied")

# Patch B: on a connection-dead call failure, reset the stale connection so
# the next call auto-reconnects. Anchor: the generic catch that sets
# `const message = ...` then `uiSession?.sendToolCancelled(message);`
# immediately followed by `const schemaText =`.
MARK_B = "pi-mcp-repair: reset stale connection on call failure"
if MARK_B not in text:
    pat_b = re.compile(
        r"(const message = error instanceof Error \? error\.message : String\(error\);\n"
        r"[ \t]*uiSession\?\.sendToolCancelled\(message\);\n)"
        r"(\n[ \t]*const schemaText =)"
    )
    def repl_b(m):
        return (
            f"{m.group(1)}"
            "    if (/not connected|connection closed|connection is not open|"
            "transport closed|broken pipe/i.test(message)) {\n"
            f"      // {MARK_B}\n"
            "      await state.manager.close(serverName).catch(() => {});\n"
            "    }\n"
            f"{m.group(2)}"
        )
    new_text, n = pat_b.subn(repl_b, text, count=1)
    if n:
        text = new_text
        changed = True
    else:
        print("WARN: Patch B anchor (catch + schemaText) not found", file=sys.stderr)
else:
    print("Patch B already applied")

if changed:
    path.write_text(text)
    print("patched")
else:
    print("already patched or no changes")
PY
    fi
  fi
fi

say "Repair complete."
if [[ -n "$SERVER" ]]; then
  say "Next: send /reload, then mcp({ connect: \"$SERVER\" }) and test one real tool call."
else
  say "Next: send /reload, then reconnect the affected server and test one real tool call."
fi
