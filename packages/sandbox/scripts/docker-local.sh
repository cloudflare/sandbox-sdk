#!/usr/bin/env bash
set -euo pipefail

# Run from the repo root
cd "$(dirname "$0")/../../.."

VERSION="$npm_package_version"
IMAGE="cloudflare/sandbox-test"

docker build \
  -f packages/sandbox/Dockerfile \
  --target default \
  --platform linux/amd64 \
  --build-arg SANDBOX_VERSION="$VERSION" \
  -t "$IMAGE:$VERSION" \
  .

docker build \
  -f packages/sandbox/Dockerfile \
  --target python \
  --platform linux/amd64 \
  --build-arg SANDBOX_VERSION="$VERSION" \
  -t "$IMAGE:$VERSION-python" \
  .

docker build \
  -f packages/sandbox/Dockerfile \
  --target opencode \
  --platform linux/amd64 \
  --build-arg SANDBOX_VERSION="$VERSION" \
  -t "$IMAGE:$VERSION-opencode" \
  --secret id=wrangler_ca,src="${NODE_EXTRA_CA_CERTS:-/dev/null}" \
  .

docker build \
  -f packages/sandbox/Dockerfile \
  --target desktop \
  --platform linux/amd64 \
  --build-arg SANDBOX_VERSION="$VERSION" \
  -t "$IMAGE:$VERSION-desktop" \
  --secret id=wrangler_ca,src="${NODE_EXTRA_CA_CERTS:-/dev/null}" \
  .

STANDALONE_DIR="tests/e2e/test-worker"
sed -E "s|$IMAGE:[0-9]+\.[0-9]+\.[0-9]+|$IMAGE:$VERSION|g" \
  "$STANDALONE_DIR/Dockerfile.standalone" > "$STANDALONE_DIR/Dockerfile.standalone.tmp"
docker build \
  -f "$STANDALONE_DIR/Dockerfile.standalone.tmp" \
  --platform linux/amd64 \
  -t "$IMAGE:$VERSION-standalone" \
  "$STANDALONE_DIR"
rm "$STANDALONE_DIR/Dockerfile.standalone.tmp"

docker build \
  -f packages/sandbox/Dockerfile \
  --target musl \
  --platform linux/amd64 \
  --build-arg SANDBOX_VERSION="$VERSION" \
  -t "$IMAGE:$VERSION-musl" \
  --secret id=wrangler_ca,src="${NODE_EXTRA_CA_CERTS:-/dev/null}" \
  .
