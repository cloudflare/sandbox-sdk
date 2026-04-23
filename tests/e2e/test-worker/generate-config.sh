#!/bin/bash
set -e

# Generate wrangler.jsonc from template
# Usage: ./generate-config.sh <worker-name> [container-name] [image-mode]
#
# Arguments:
#   worker-name    - Name of the worker (required)
#   container-name - Name prefix for containers (defaults to worker-name)
#   image-mode     - Image source mode (defaults to local):
#                    "local"         - Use local Dockerfiles (for local dev)
#                    "registry:<tag>" - Use Cloudflare registry images (for CI)
#                                      Requires CLOUDFLARE_ACCOUNT_ID env var

WORKER_NAME="${1:-sandbox-e2e-test-worker-local}"
CONTAINER_NAME="${2:-$WORKER_NAME}"
IMAGE_MODE="${3:-local}"

if [ -z "$WORKER_NAME" ]; then
  echo "Error: WORKER_NAME is required"
  echo "Usage: ./generate-config.sh <worker-name> [container-name] [image-mode]"
  exit 1
fi

echo "Generating wrangler.jsonc..."
echo "  Worker name: $WORKER_NAME"
echo "  Container name: $CONTAINER_NAME"
echo "  Image mode: $IMAGE_MODE"

# Determine image references based on mode
if [[ "$IMAGE_MODE" == "local" ]]; then
  IMAGE_SANDBOX="./Dockerfile"
  IMAGE_PYTHON="./Dockerfile.python"
  IMAGE_OPENCODE="./Dockerfile.opencode"
  IMAGE_STANDALONE="./Dockerfile.standalone"
  IMAGE_MUSL="./Dockerfile.musl"
  IMAGE_DESKTOP="./Dockerfile.desktop"
elif [[ "$IMAGE_MODE" == registry:* ]]; then
  TAG="${IMAGE_MODE#registry:}"
  if [ -z "$CLOUDFLARE_ACCOUNT_ID" ]; then
    echo "Error: CLOUDFLARE_ACCOUNT_ID env var required for registry mode"
    exit 1
  fi
  IMAGE_SANDBOX="registry.cloudflare.com/$CLOUDFLARE_ACCOUNT_ID/sandbox:$TAG"
  IMAGE_PYTHON="registry.cloudflare.com/$CLOUDFLARE_ACCOUNT_ID/sandbox-python:$TAG"
  IMAGE_OPENCODE="registry.cloudflare.com/$CLOUDFLARE_ACCOUNT_ID/sandbox-opencode:$TAG"
  IMAGE_STANDALONE="registry.cloudflare.com/$CLOUDFLARE_ACCOUNT_ID/sandbox-standalone:$TAG"
  IMAGE_MUSL="registry.cloudflare.com/$CLOUDFLARE_ACCOUNT_ID/sandbox-musl:$TAG"
  IMAGE_DESKTOP="registry.cloudflare.com/$CLOUDFLARE_ACCOUNT_ID/sandbox-desktop:$TAG"
else
  echo "Error: Unknown image mode: $IMAGE_MODE"
  echo "Use 'local' or 'registry:<tag>'"
  exit 1
fi

echo "  Images:"
echo "    Sandbox: $IMAGE_SANDBOX"
echo "    Python: $IMAGE_PYTHON"
echo "    Opencode: $IMAGE_OPENCODE"
echo "    Standalone: $IMAGE_STANDALONE"
echo "    Musl: $IMAGE_MUSL"
echo "    Desktop: $IMAGE_DESKTOP"

# Read template and replace placeholders
# Using | as delimiter since image URLs contain /
sed -e "s|{{WORKER_NAME}}|$WORKER_NAME|g" \
    -e "s|{{CONTAINER_NAME}}|$CONTAINER_NAME|g" \
    -e "s|{{IMAGE_SANDBOX}}|$IMAGE_SANDBOX|g" \
    -e "s|{{IMAGE_PYTHON}}|$IMAGE_PYTHON|g" \
    -e "s|{{IMAGE_OPENCODE}}|$IMAGE_OPENCODE|g" \
    -e "s|{{IMAGE_STANDALONE}}|$IMAGE_STANDALONE|g" \
    -e "s|{{IMAGE_MUSL}}|$IMAGE_MUSL|g" \
    -e "s|{{IMAGE_DESKTOP}}|$IMAGE_DESKTOP|g" \
  wrangler.template.jsonc > wrangler.jsonc

echo "✅ Generated wrangler.jsonc"
