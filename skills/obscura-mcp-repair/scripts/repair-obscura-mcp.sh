#!/usr/bin/env bash
set -euo pipefail

PATCH_ADAPTER=1
KILL_STALE=0
DRY_RUN=0

usage() {
  cat <<'USAGE'
Repair Pi + Obscura MCP integration.

Usage:
  repair-obscura-mcp.sh [--no-patch-adapter] [--kill-stale] [--dry-run]

What it does:
  - creates ~/.local/bin/obscura-mcp-pi-wrapper
  - merges an obscura server into ~/.pi/agent/mcp.json
  - backs up and removes ~/.pi/agent/mcp-cache.json
  - preserves existing Obscura CDP browsers by default
  - optionally stops stale obscura-mcp / obscura serve processes with --kill-stale
  - optionally patches pi-mcp-adapter so explicit connect forces a fresh spawn

After running inside an existing Pi session, send /reload.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-patch-adapter) PATCH_ADAPTER=0 ;;
    --kill-stale) KILL_STALE=1 ;;
    --no-kill) KILL_STALE=0 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

home_dir="${HOME:-$(cd ~ && pwd)}"
pi_agent_dir="${PI_CODING_AGENT_DIR:-$home_dir/.pi/agent}"
mcp_config="$pi_agent_dir/mcp.json"
mcp_cache="$pi_agent_dir/mcp-cache.json"
wrapper="$home_dir/.local/bin/obscura-mcp-pi-wrapper"
log_file="/tmp/obscura-mcp-pi-wrapper.log"
obscura_bin="${OBSCURA_PATH:-$home_dir/.local/bin/obscura}"

say() { printf '[obscura-mcp-repair] %s\n' "$*"; }
run() {
  if [[ "$DRY_RUN" == 1 ]]; then
    printf '[dry-run] %q ' "$@"; printf '\n'
  else
    "$@"
  fi
}

resolve_realpath() {
  python3 - "$1" <<'PY'
import os, sys
print(os.path.realpath(sys.argv[1]))
PY
}

find_obscura_mcp() {
  if [[ -n "${OBSCURA_MCP_BIN:-}" && -x "${OBSCURA_MCP_BIN}" ]]; then
    printf '%s\n' "${OBSCURA_MCP_BIN}"
    return 0
  fi
  if command -v obscura-mcp >/dev/null 2>&1; then
    command -v obscura-mcp
    return 0
  fi
  local candidate
  for candidate in \
    "$home_dir/.nvm/versions/node"/*/bin/obscura-mcp \
    "$home_dir/.brew/bin/obscura-mcp" \
    "/opt/homebrew/bin/obscura-mcp" \
    "/usr/local/bin/obscura-mcp"; do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

obscura_mcp_bin="$(find_obscura_mcp || true)"
if [[ -z "$obscura_mcp_bin" ]]; then
  echo "ERROR: Could not find obscura-mcp. Install it or set OBSCURA_MCP_BIN=/path/to/obscura-mcp" >&2
  exit 1
fi
obscura_mcp_bin="$(resolve_realpath "$obscura_mcp_bin")"

if [[ ! -x "$obscura_bin" ]]; then
  echo "ERROR: Obscura binary not executable at $obscura_bin. Set OBSCURA_PATH=/path/to/obscura" >&2
  exit 1
fi

say "Using obscura-mcp: $obscura_mcp_bin"
say "Using obscura binary: $obscura_bin"
say "Pi MCP config: $mcp_config"

if [[ "$KILL_STALE" == 1 ]]; then
  say "Stopping stale Obscura processes if present"
  if [[ "$DRY_RUN" == 0 ]]; then
    pkill -f 'obscura-mcp' 2>/dev/null || true
    pkill -f "$obscura_bin serve" 2>/dev/null || true
    pids="$(lsof -tiTCP:9222 -sTCP:LISTEN 2>/dev/null || true)"
    if [[ -n "$pids" ]]; then
      while IFS= read -r pid; do
        [[ -z "$pid" ]] && continue
        cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
        if [[ "$cmd" == *obscura* ]]; then
          kill "$pid" 2>/dev/null || true
        fi
      done <<< "$pids"
    fi
  else
    say "Would pkill obscura-mcp and stale obscura serve processes"
  fi
fi

say "Writing wrapper: $wrapper"
if [[ "$DRY_RUN" == 0 ]]; then
  mkdir -p "$(dirname "$wrapper")"
  cat > "$wrapper" <<EOF
#!/usr/bin/env bash
set -euo pipefail

LOG="\${OBSCURA_MCP_WRAPPER_LOG:-$log_file}"
{
  echo "===== \$(date '+%Y-%m-%d %H:%M:%S') obscura-mcp wrapper start ====="
  echo "pid=\$\$ ppid=\$PPID"
  echo "pwd=\$(pwd)"
  echo "PATH=\$PATH"
  echo "HOME=\${HOME:-}"
  echo "OBSCURA_PATH=\${OBSCURA_PATH:-}"
  echo "OBSCURA_STEALTH=\${OBSCURA_STEALTH:-}"
  echo "node=\$(command -v node || true)"
  echo "obscura-mcp=$obscura_mcp_bin"
  echo "obscura=\${OBSCURA_PATH:-$obscura_bin}"
} >> "\$LOG" 2>&1

export OBSCURA_PATH="\${OBSCURA_PATH:-$obscura_bin}"
export OBSCURA_STEALTH="\${OBSCURA_STEALTH:-true}"
export PATH="$(dirname "$obscura_mcp_bin"):$home_dir/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:\${PATH:-}"

exec "$obscura_mcp_bin" "\$@" 2>> "\$LOG"
EOF
  chmod +x "$wrapper"
fi

say "Merging Obscura server into MCP config"
if [[ "$DRY_RUN" == 0 ]]; then
  mkdir -p "$pi_agent_dir"
  ts="$(date +%Y%m%d%H%M%S)"
  if [[ -f "$mcp_config" ]]; then
    cp "$mcp_config" "$mcp_config.bak.$ts"
    say "Backed up config to $mcp_config.bak.$ts"
  fi
  python3 - "$mcp_config" "$wrapper" "$obscura_bin" <<'PY'
import json, os, sys
path, wrapper, obscura = sys.argv[1:4]
raw = {}
if os.path.exists(path):
    try:
        with open(path, 'r', encoding='utf-8') as f:
            raw = json.load(f)
    except Exception as e:
        backup = path + '.invalid'
        os.replace(path, backup)
        print(f'Invalid JSON moved to {backup}', file=sys.stderr)
        raw = {}
if not isinstance(raw, dict):
    raw = {}
servers = raw.get('mcpServers') or raw.get('mcp-servers') or {}
if not isinstance(servers, dict):
    servers = {}
servers['obscura'] = {
    'command': wrapper,
    'args': ['--transport', 'stdio'],
    'lifecycle': 'lazy',
    'idleTimeout': 1,
    'env': {
        'OBSCURA_PATH': obscura,
        'OBSCURA_STEALTH': 'true',
    },
}
raw.pop('mcp-servers', None)
raw['mcpServers'] = servers
tmp = path + f'.{os.getpid()}.tmp'
with open(tmp, 'w', encoding='utf-8') as f:
    json.dump(raw, f, indent=2)
    f.write('\n')
os.replace(tmp, path)
PY
fi

if [[ -f "$mcp_cache" ]]; then
  say "Backing up and removing stale MCP metadata cache"
  if [[ "$DRY_RUN" == 0 ]]; then
    ts="$(date +%Y%m%d%H%M%S)"
    cp "$mcp_cache" "$mcp_cache.bak.$ts"
    rm -f "$mcp_cache"
    say "Backed up cache to $mcp_cache.bak.$ts"
  fi
fi

find_adapter_root() {
  local bin real root candidate
  if command -v pi-mcp-adapter >/dev/null 2>&1; then
    bin="$(command -v pi-mcp-adapter)"
    real="$(resolve_realpath "$bin")"
    root="$(dirname "$real")"
    if [[ -f "$root/proxy-modes.ts" ]]; then
      printf '%s\n' "$root"
      return 0
    fi
  fi
  if command -v npm >/dev/null 2>&1; then
    root="$(npm root -g 2>/dev/null || true)/pi-mcp-adapter"
    if [[ -f "$root/proxy-modes.ts" ]]; then
      printf '%s\n' "$root"
      return 0
    fi
  fi
  for candidate in "$home_dir/.nvm/versions/node"/*/lib/node_modules/pi-mcp-adapter; do
    if [[ -f "$candidate/proxy-modes.ts" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

if [[ "$PATCH_ADAPTER" == 1 ]]; then
  adapter_root="$(find_adapter_root || true)"
  if [[ -n "$adapter_root" ]]; then
    proxy_file="$adapter_root/proxy-modes.ts"
    say "Patching adapter stale-client reconnect behavior: $proxy_file"
    if [[ "$DRY_RUN" == 0 ]]; then
      ts="$(date +%Y%m%d%H%M%S)"
      cp "$proxy_file" "$proxy_file.bak.$ts"
      python3 - "$proxy_file" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
text = path.read_text()
changed = False

needle = '''    if (state.ui) {
      state.ui.setStatus("mcp", `MCP: connecting to ${serverName}...`);
    }
    let connection = await state.manager.connect(serverName, definition);'''
replacement = '''    if (state.ui) {
      state.ui.setStatus("mcp", `MCP: connecting to ${serverName}...`);
    }
    // Treat explicit connect requests as reconnects. A child MCP process can exit
    // while the SDK Client object remains cached as "connected", causing later
    // calls to fail with "Not connected". Closing first forces a fresh spawn.
    await state.manager.close(serverName);
    let connection = await state.manager.connect(serverName, definition);'''
if 'Treat explicit connect requests as reconnects' not in text:
    if needle in text:
        text = text.replace(needle, replacement, 1)
        changed = True
    else:
        print('WARN: explicit-connect patch anchor not found', file=sys.stderr)

needle2 = '''  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    uiSession?.sendToolCancelled(message);

    let errorWithSchema = `Failed to call tool: ${message}`;'''
replacement2 = '''  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    uiSession?.sendToolCancelled(message);

    if (/not connected|connection closed|connection is not open/i.test(message)) {
      await state.manager.close(serverName).catch(() => {});
    }

    let errorWithSchema = `Failed to call tool: ${message}`;'''
if 'connection is not open/i.test(message)' not in text:
    if needle2 in text:
        text = text.replace(needle2, replacement2, 1)
        changed = True
    else:
        print('WARN: call-failure cleanup patch anchor not found', file=sys.stderr)

if changed:
    path.write_text(text)
    print('patched')
else:
    print('already patched or no changes')
PY
    fi
  else
    say "pi-mcp-adapter package not found; skipping adapter patch"
  fi
fi

say "Repair complete."
say "Next inside Pi: send /reload, then run mcp({ connect: \"obscura\" }) and test browse_page."
say "Wrapper log: $log_file"
