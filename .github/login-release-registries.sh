#!/bin/bash
set -euo pipefail

source .github/cf-registry-login.sh
cf_registry_credentials 30 '["pull", "push", "library_push"]'

echo "$CF_REGISTRY_PASSWORD" | docker login registry.cloudflare.com \
  -u "$CF_REGISTRY_USERNAME" --password-stdin

echo "$CF_REGISTRY_PASSWORD" | crane auth login registry.cloudflare.com \
  --password-stdin -u "$CF_REGISTRY_USERNAME"

echo "$DOCKER_HUB_ACCESS_TOKEN" | crane auth login index.docker.io \
  --password-stdin -u "$DOCKER_HUB_USERNAME"
