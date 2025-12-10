#!/bin/bash
set -e

# Cleanup Test Deployment Script
# Deletes a test worker and its associated containers with proper ordering and retry logic
#
# Usage: ./cleanup-test-deployment.sh <worker-name>
# Example: ./cleanup-test-deployment.sh sandbox-e2e-test-worker-pr-123
#
# This script handles multiple container variants:
# - <worker-name>: Base image container (no Python, default)
# - <worker-name>-python: Python image container
# - <worker-name>-opencode: OpenCode image container
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

# Step 1: Get container IDs BEFORE deleting worker (critical order!)
echo "Looking up container IDs..."

# Get container list (wrangler outputs JSON by default, no --json flag needed)
RAW_OUTPUT=$(npx wrangler containers list 2>&1)

CONTAINER_ID=""
CONTAINER_PYTHON_ID=""
CONTAINER_OPENCODE_ID=""

# Check if output looks like JSON (starts with '[')
if echo "$RAW_OUTPUT" | grep -q '^\['; then
  echo "✓ Got JSON output from wrangler containers list"

  # Parse JSON to find all containers
  CONTAINER_ID=$(echo "$RAW_OUTPUT" | jq -r ".[] | select(.name==\"$WORKER_NAME\") | .id" 2>/dev/null || echo "")
  CONTAINER_PYTHON_ID=$(echo "$RAW_OUTPUT" | jq -r ".[] | select(.name==\"$WORKER_NAME-python\") | .id" 2>/dev/null || echo "")
  CONTAINER_OPENCODE_ID=$(echo "$RAW_OUTPUT" | jq -r ".[] | select(.name==\"$WORKER_NAME-opencode\") | .id" 2>/dev/null || echo "")

  if [ -n "$CONTAINER_ID" ]; then
    echo "✓ Found base container: $CONTAINER_ID"
  else
    echo "⚠️  No base container found for $WORKER_NAME"
  fi

  if [ -n "$CONTAINER_PYTHON_ID" ]; then
    echo "✓ Found python container: $CONTAINER_PYTHON_ID"
  else
    echo "⚠️  No python container found for $WORKER_NAME-python"
  fi

  if [ -n "$CONTAINER_OPENCODE_ID" ]; then
    echo "✓ Found opencode container: $CONTAINER_OPENCODE_ID"
  else
    echo "⚠️  No opencode container found for $WORKER_NAME-opencode"
  fi

  if [ -z "$CONTAINER_ID" ] && [ -z "$CONTAINER_PYTHON_ID" ] && [ -z "$CONTAINER_OPENCODE_ID" ]; then
    echo "Available containers:"
    echo "$RAW_OUTPUT" | jq -r '.[].name' 2>/dev/null || echo "(unable to parse container names)"
  fi
else
  echo "⚠️  Non-JSON output from wrangler containers list:"
  echo "$RAW_OUTPUT"
fi

# Step 2: Delete worker
echo "Deleting worker..."
if npx wrangler delete --name "$WORKER_NAME" 2>/dev/null; then
  echo "✓ Worker deleted successfully"
else
  echo "⚠️  Worker deletion failed or already deleted"
fi

# Function to delete a container with retry logic
delete_container() {
  local container_id=$1
  local container_name=$2

  if [ -z "$container_id" ]; then
    return 0
  fi

  echo "Deleting $container_name container with retry logic..."
  for i in 1 2 3; do
    if npx wrangler containers delete "$container_id" 2>/dev/null; then
      echo "✓ $container_name container deleted successfully"
      return 0
    else
      if [ $i -lt 3 ]; then
        echo "⚠️  $container_name container deletion attempt $i/3 failed, retrying in 5s..."
        sleep 5
      else
        echo "❌ $container_name container deletion failed after 3 attempts"
        return 1
      fi
    fi
  done
}

# Step 3: Delete containers
CLEANUP_FAILED=false

delete_container "$CONTAINER_ID" "base" || CLEANUP_FAILED=true
delete_container "$CONTAINER_PYTHON_ID" "python" || CLEANUP_FAILED=true
delete_container "$CONTAINER_OPENCODE_ID" "opencode" || CLEANUP_FAILED=true

if [ "$CLEANUP_FAILED" = true ]; then
  echo "=== Cleanup completed with errors ==="
  exit 1
fi

echo "=== Cleanup complete ==="
