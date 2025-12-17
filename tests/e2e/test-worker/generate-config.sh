#!/bin/bash
set -e

# Generate wrangler.jsonc from template
# Usage: ./generate-config.sh <worker-name> [container-name] [transport]
#
# If container-name is not provided, it defaults to worker-name
# If transport is not provided, it defaults to "http"

WORKER_NAME="${1:-sandbox-e2e-test-worker-local}"
CONTAINER_NAME="${2:-$WORKER_NAME}"
TRANSPORT="${3:-http}"

if [ -z "$WORKER_NAME" ]; then
  echo "Error: WORKER_NAME is required"
  echo "Usage: ./generate-config.sh <worker-name> [container-name] [transport]"
  exit 1
fi

echo "Generating wrangler.jsonc..."
echo "  Worker name: $WORKER_NAME"
echo "  Container name: $CONTAINER_NAME"
echo "  Transport: $TRANSPORT"

# Read template and replace placeholders
sed "s/{{WORKER_NAME}}/$WORKER_NAME/g; s/{{CONTAINER_NAME}}/$CONTAINER_NAME/g; s/{{TRANSPORT}}/$TRANSPORT/g" \
  wrangler.template.jsonc > wrangler.jsonc

echo "✅ Generated wrangler.jsonc"
