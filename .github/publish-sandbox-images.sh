#!/bin/bash
set -euo pipefail

usage() {
  cat <<'USAGE' >&2
Usage: .github/publish-sandbox-images.sh --source-tag TAG --version VERSION [--alias TAG] [--docker-hub] [--cf-library]

Copies sandbox image variants from the internal Cloudflare account registry to
public release registries. Immutable version tags are always published; --alias
also publishes moving tags such as `next`.

Required env: CLOUDFLARE_ACCOUNT_ID
USAGE
}

SOURCE_TAG=""
VERSION=""
ALIAS=""
PUBLISH_DOCKER_HUB=false
PUBLISH_CF_LIBRARY=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source-tag)
      SOURCE_TAG="${2:-}"
      shift 2
      ;;
    --version)
      VERSION="${2:-}"
      shift 2
      ;;
    --alias)
      ALIAS="${2:-}"
      shift 2
      ;;
    --docker-hub)
      PUBLISH_DOCKER_HUB=true
      shift
      ;;
    --cf-library)
      PUBLISH_CF_LIBRARY=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "::error::Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$SOURCE_TAG" ]]; then
  echo "::error::--source-tag is required" >&2
  usage
  exit 1
fi

if [[ -z "$VERSION" ]]; then
  echo "::error::--version is required" >&2
  usage
  exit 1
fi

if [[ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
  echo "::error::CLOUDFLARE_ACCOUNT_ID is required" >&2
  exit 1
fi

if [[ "$PUBLISH_DOCKER_HUB" == "false" && "$PUBLISH_CF_LIBRARY" == "false" ]]; then
  echo "::error::At least one publish target is required: --docker-hub or --cf-library" >&2
  usage
  exit 1
fi

source .github/load-docker-images.sh
source .github/crane-copy-retry.sh

SOURCE_REGISTRY="registry.cloudflare.com/${CLOUDFLARE_ACCOUNT_ID}"
failed=0

copy_image() {
  local image="$1"
  local target_prefix="$2"
  local suffix="${image#sandbox}"

  crane_copy_retry \
    "${SOURCE_REGISTRY}/${image}:${SOURCE_TAG}" \
    "${target_prefix}:${VERSION}${suffix}" || failed=1

  if [[ -n "$ALIAS" ]]; then
    crane_copy_retry \
      "${SOURCE_REGISTRY}/${image}:${SOURCE_TAG}" \
      "${target_prefix}:${ALIAS}${suffix}" || failed=1
  fi
}

publish_target() {
  local target_prefix="$1"

  for image in "${DOCKER_IMAGES[@]}"; do
    [[ "$image" == "sandbox-standalone" ]] && continue
    copy_image "$image" "$target_prefix"
  done
}

if [[ "$PUBLISH_DOCKER_HUB" == "true" ]]; then
  publish_target "docker.io/cloudflare/sandbox"
fi

if [[ "$PUBLISH_CF_LIBRARY" == "true" ]]; then
  publish_target "registry.cloudflare.com/library/sandbox"
fi

exit "$failed"
