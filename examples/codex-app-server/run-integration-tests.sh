#!/usr/bin/env bash
# Starts wrangler dev, runs the integration test, and tears down.
# Usage: ./run-integration-tests.sh
set -euo pipefail

PORT=8787
LOG=$(mktemp)
cleanup() { kill "$WRANGLER_PID" 2>/dev/null; rm -f "$LOG"; }
trap cleanup EXIT

# macOS arm64 workaround for sandbox-sdk#522
export MINIFLARE_CONTAINER_EGRESS_IMAGE="cloudflare/proxy-everything:3cb1195@sha256:78c7910f4575a511d928d7824b1cbcaec6b7c4bf4dbb3fafaeeae3104030e73c"

echo "Starting wrangler dev..."
npx wrangler dev --port "$PORT" > "$LOG" 2>&1 &
WRANGLER_PID=$!

# Wait for the server to be ready (up to 30s)
for i in $(seq 1 30); do
  if grep -q "Ready on" "$LOG" 2>/dev/null; then
    echo "Server ready on port $PORT"
    break
  fi
  if ! kill -0 "$WRANGLER_PID" 2>/dev/null; then
    echo "wrangler exited unexpectedly:"
    cat "$LOG"
    exit 1
  fi
  sleep 1
done

if ! grep -q "Ready on" "$LOG" 2>/dev/null; then
  echo "Timed out waiting for wrangler dev"
  cat "$LOG"
  exit 1
fi

echo "Running test..."
node test.mjs
