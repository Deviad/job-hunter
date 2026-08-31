#!/usr/bin/env bash
# Bounded real-service rehearsal using isolated ports, project identity, and workspace.

set -euo pipefail

TIMEOUT_SECS="${JOBHUNTER_REHEARSAL_TIMEOUT:-120}"
POLL_INTERVAL=2
COMPOSE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT_NAME="job-hunter-rehearsal-$$"
REHEARSAL_HOME="$(mktemp -d "${TMPDIR:-/tmp}/job-hunter-rehearsal.XXXXXX")"
PASS=0
FAIL=0

set -- $(python3 - <<'PY'
import socket
ports = []
for _ in range(4):
    sock = socket.socket()
    sock.bind(('127.0.0.1', 0))
    ports.append(sock.getsockname()[1])
    sock.close()
print(*ports)
PY
)
export SELENIUM_PORT="$1"
export NOVNC_PORT="$2"
export CDP_PORT="$3"
export SEARXNG_PORT="$4"
export JOBHUNTER_HOME="$REHEARSAL_HOME"
export SEARXNG_SECRET="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
mkdir -p "$REHEARSAL_HOME/chromium-profile" "$REHEARSAL_HOME/searxng"
chmod 0777 "$REHEARSAL_HOME/chromium-profile" "$REHEARSAL_HOME/searxng"

COMPOSE=(docker compose -p "$PROJECT_NAME" -f "$COMPOSE_DIR/compose.yaml")

info() { printf '[INFO]  %s\n' "$*"; }
pass() { PASS=$((PASS + 1)); printf '[PASS]  %s\n' "$*"; }
fail() { FAIL=$((FAIL + 1)); printf '[FAIL]  %s\n' "$*"; }

cleanup() {
  info "Tearing down isolated rehearsal"
  "${COMPOSE[@]}" down --volumes --timeout 10 >/dev/null 2>&1 || true
  rm -rf "$REHEARSAL_HOME"
}
trap cleanup EXIT

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker not found on PATH" >&2
  exit 2
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "ERROR: docker compose not available" >&2
  exit 2
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR: python3 not found on PATH" >&2
  exit 2
fi

info "Validating compose.yaml"
"${COMPOSE[@]}" config --quiet
pass "compose.yaml is valid"

info "Starting isolated services"
"${COMPOSE[@]}" up -d

wait_http() {
  local label="$1"
  local url="$2"
  local elapsed=0
  info "Waiting for $label"
  while [ "$elapsed" -lt "$TIMEOUT_SECS" ]; do
    if curl -sf --max-time 3 -o /dev/null "$url" 2>/dev/null; then
      pass "$label reachable"
      return 0
    fi
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  fail "$label not reachable within ${TIMEOUT_SECS}s"
  return 1
}

wait_http "Selenium CDP" "http://127.0.0.1:${CDP_PORT}/json/version" || true
browser="$(curl -sf --max-time 3 "http://127.0.0.1:${CDP_PORT}/json/version" 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin).get('Browser',''))" 2>/dev/null || true)"
if [ -n "$browser" ]; then
  pass "Selenium CDP returned a Browser identity"
else
  fail "Selenium CDP response missing Browser identity"
fi

wait_http "noVNC" "http://127.0.0.1:${NOVNC_PORT}/" || true
wait_http "SearXNG" "http://127.0.0.1:${SEARXNG_PORT}/search?q=test" || true

binding="$("${COMPOSE[@]}" port selenium-chromium 4444 2>/dev/null || true)"
case "$binding" in
  127.0.0.1:*) pass "Selenium bound to localhost" ;;
  *) fail "Selenium may be externally accessible: $binding" ;;
esac

info "Results: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
  "${COMPOSE[@]}" ps || true
  "${COMPOSE[@]}" logs --tail 120 || true
  exit 1
fi
