#!/bin/bash
set -e

# Cleanup Test Deployment Script
# Deletes a test worker and its associated container with proper ordering and retry logic
#
# Usage: ./cleanup-test-deployment.sh <worker-name>
# Example: ./cleanup-test-deployment.sh sandbox-e2e-test-worker-pr-123
#
# Environment variables required:
# - CLOUDFLARE_API_TOKEN
# - CLOUDFLARE_ACCOUNT_ID

WORKER_NAME=$1

if [ -z "$WORKER_NAME" ]; then
  echo "❌ Error: Worker name is required"
  echo "Usage: $0 <worker-name>"
  exit 1
fi

echo "=== Starting cleanup for $WORKER_NAME ==="

# Step 1: Get container ID BEFORE deleting worker (critical order!)
echo "Looking up container ID..."

# Get container list (wrangler outputs JSON by default, no --json flag needed)
RAW_OUTPUT=$(npx wrangler containers list 2>&1)

# Check if output looks like JSON (starts with '[')
if echo "$RAW_OUTPUT" | grep -q '^\['; then
  echo "✓ Got JSON output from wrangler containers list"

  # Parse JSON to find container
  CONTAINER_ID=$(echo "$RAW_OUTPUT" | jq -r ".[] | select(.name==\"$WORKER_NAME\") | .id" 2>/dev/null || echo "")

  if [ -n "$CONTAINER_ID" ]; then
    echo "✓ Found container: $CONTAINER_ID"
  else
    echo "⚠️  No container found for worker $WORKER_NAME"
    echo "Available containers:"
    echo "$RAW_OUTPUT" | jq -r '.[].name' 2>/dev/null || echo "(unable to parse container names)"
  fi
else
  echo "⚠️  Non-JSON output from wrangler containers list:"
  echo "$RAW_OUTPUT"
  CONTAINER_ID=""
fi

# Step 2: Delete worker
echo "Deleting worker..."
if npx wrangler delete --name "$WORKER_NAME" 2>/dev/null; then
  echo "✓ Worker deleted successfully"
else
  echo "⚠️  Worker deletion failed or already deleted"
fi

# Step 3: Delete container with retry logic (if we found one)
if [ -n "$CONTAINER_ID" ]; then
  echo "Deleting container with retry logic..."
  for i in 1 2 3; do
    if npx wrangler containers delete "$CONTAINER_ID" 2>/dev/null; then
      echo "✓ Container deleted successfully"
      break
    else
      if [ $i -lt 3 ]; then
        echo "⚠️  Container deletion attempt $i/3 failed, retrying in 5s..."
        sleep 5
      else
        echo "❌ Container deletion failed after 3 attempts"
        exit 1
      fi
    fi
  done
fi

echo "=== Cleanup complete ==="
