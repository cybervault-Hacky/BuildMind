#!/usr/bin/env bash
# ==========================================================================
# BuildMind — real browser E2E launcher.
#
# Starts everything the browser test needs, in order, and waits for each:
#
#   1. a local stand-in for the AI provider (the real OpenAI adapter talks to
#      it, so the adapter, the orchestrator and the validation gates are all
#      genuinely exercised)
#   2. the BuildMind API on :3100, against the real PostgreSQL
#   3. the dev proxy on :8180 (static frontend + /api on one origin — the
#      production layout)
#
# Each background service is launched in its own process group (`setsid`) so
# cleanup reliably terminates `npx`/`tsx`/Node descendants and verifies that
# every port is free before exiting.
#
# Usage:
#   scripts/e2e.sh                      # the full browser suite
#   scripts/e2e.sh tests/ui.e2e.cjs     # a specific suite
#
# Environment:
#   DATABASE_URL     the PostgreSQL connection string (required)
#   API_PORT         the API port           (default 3100)
#   PROXY_PORT       the proxy port         (default 8180)
#   E2E_BASE         the browser base URL   (default http://127.0.0.1:$PROXY_PORT)
#   CHROMIUM_PATH    the Chromium binary    (default /tmp/chromium/chromium)
#   PUPPETEER_CORE   the puppeteer-core module directory
# ==========================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND="$(cd "$HERE/../backend" && pwd)"

API_PORT="${API_PORT:-3100}"
PROXY_PORT="${PROXY_PORT:-8180}"
E2E_BASE="${E2E_BASE:-http://127.0.0.1:${PROXY_PORT}}"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL must point at a PostgreSQL server." >&2
  exit 1
fi

if [ $# -gt 0 ]; then
  SUITES=("$@")
else
  SUITES=(
    "$BACKEND/tests/e2e/browserE2E.cjs"
    "$BACKEND/tests/e2e/phase12FrontendE2E.cjs"
  )
fi

export SESSION_SECRET="${SESSION_SECRET:-buildmind-e2e-session-secret-0123456789abcdef}"
export ENCRYPTION_KEY="${ENCRYPTION_KEY:-YnVpbGRtaW5kLWUyZS1lbmNyeXB0aW9uLWtleS0zMjE=}"
export APP_ORIGIN="${APP_ORIGIN:-$E2E_BASE}"
export NODE_ENV="${NODE_ENV:-development}"
export PORT="$API_PORT"
DEFAULT_WS="$BACKEND/.workspaces-e2e"
export WORKSPACE_ROOT="${WORKSPACE_ROOT:-$DEFAULT_WS}"

FAKE_URL_FILE="$(mktemp)"
export FAKE_URL_FILE

port_open() {
  local port="$1"
  if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
    exec 3<&- 3>&-
    return 0
  fi
  return 1
}

pgids=()

start_group() {
  setsid "$@" &
  pgids+=("$!")
}

cleanup() {
  local code=$?
  trap - EXIT INT TERM

  for pgid in "${pgids[@]:-}"; do
    kill -TERM -- "-$pgid" 2>/dev/null || kill -TERM "$pgid" 2>/dev/null || true
  done

  for _ in $(seq 1 25); do
    local alive=0
    for pgid in "${pgids[@]:-}"; do
      if kill -0 -- "-$pgid" 2>/dev/null || kill -0 "$pgid" 2>/dev/null; then
        alive=1
        break
      fi
    done
    [ "$alive" -eq 0 ] && break
    sleep 0.1
  done

  for pgid in "${pgids[@]:-}"; do
    kill -KILL -- "-$pgid" 2>/dev/null || kill -KILL "$pgid" 2>/dev/null || true
  done

  wait 2>/dev/null || true
  rm -f "$FAKE_URL_FILE"
  if [ "$WORKSPACE_ROOT" = "$DEFAULT_WS" ]; then
    rm -rf "$DEFAULT_WS"
  fi

  for port in "$API_PORT" "$PROXY_PORT"; do
    for _ in $(seq 1 20); do
      port_open "$port" || break
      sleep 0.1
    done
    if port_open "$port"; then
      echo "warning: port $port remained open after cleanup" >&2
    fi
  done

  exit "$code"
}
trap cleanup EXIT INT TERM

wait_for_port() {
  local port="$1" tries=100
  while [ "$tries" -gt 0 ]; do
    if port_open "$port"; then
      return 0
    fi
    tries=$((tries - 1))
    sleep 0.2
  done
  echo "timed out waiting for port $port" >&2
  return 1
}

# A previous run that was interrupted leaves listeners behind, and the next
# run would then talk to a stale server. Fail loudly instead.
require_free_port() {
  local port="$1"
  if port_open "$port"; then
    echo "port $port is already in use — stop the stale process first" >&2
    exit 1
  fi
}

require_free_port "$API_PORT"
require_free_port "$PROXY_PORT"

echo "1/3 fake AI provider"
start_group bash -c "cd \"$BACKEND\" && exec npx tsx tests/helpers/fakeOpenAIServer.ts"
for _ in $(seq 1 100); do
  [ -s "$FAKE_URL_FILE" ] && break
  sleep 0.2
done
if [ ! -s "$FAKE_URL_FILE" ]; then
  echo "the fake provider did not start" >&2
  exit 1
fi
FAKE_URL="$(cat "$FAKE_URL_FILE")"
echo "    $FAKE_URL"

echo "2/3 BuildMind API on :$API_PORT"
export OPENAI_BASE_URL="$FAKE_URL"
start_group bash -c "cd \"$BACKEND\" && exec npx tsx src/server.ts"
wait_for_port "$API_PORT"

echo "3/3 static + API proxy on :$PROXY_PORT"
start_group bash -c "cd \"$BACKEND\" && API_TARGET=\"http://127.0.0.1:${API_PORT}\" PROXY_PORT=\"$PROXY_PORT\" exec npx tsx tests/helpers/e2eProxy.ts"
wait_for_port "$PROXY_PORT"

for SUITE in "${SUITES[@]}"; do
  echo "running $SUITE against $E2E_BASE"
  E2E_BASE="$E2E_BASE" node "$SUITE"
done
