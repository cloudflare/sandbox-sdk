#!/bin/bash
set -euo pipefail

script=$(pwd)/.github/detect-stable-release-needed.sh
repo=$(mktemp -d)
trap 'rm -rf "$repo"' EXIT

cd "$repo"
git init >/dev/null
git config user.email test@example.com
git config user.name 'Test User'

git commit --allow-empty -m 'Release commit' >/dev/null
release_sha=$(git rev-parse HEAD)
git tag '@cloudflare/sandbox@1.0.0'

git commit --allow-empty -m 'Non-version change' >/dev/null
later_sha=$(git rev-parse HEAD)

matches_output=$(bash "$script" 1.0.0 "$release_sha")
if ! grep -Fxq 'publish=true' <<<"$matches_output"; then
  echo 'Existing tag at current commit must publish to converge missing artifacts' >&2
  exit 1
fi
if ! grep -Fxq 'reason=tag_matches_commit' <<<"$matches_output"; then
  echo 'Expected tag_matches_commit reason' >&2
  exit 1
fi

skip_output=$(bash "$script" 1.0.0 "$later_sha")
if ! grep -Fxq 'publish=false' <<<"$skip_output"; then
  echo 'Existing tag at another commit must skip publish' >&2
  exit 1
fi
if ! grep -Fxq 'reason=tag_points_elsewhere' <<<"$skip_output"; then
  echo 'Expected tag_points_elsewhere reason' >&2
  exit 1
fi
if ! grep -Fxq "tag_sha=$release_sha" <<<"$skip_output"; then
  echo 'Expected output to include the existing tag SHA' >&2
  exit 1
fi

missing_output=$(bash "$script" 1.0.1 "$later_sha")
if ! grep -Fxq 'publish=true' <<<"$missing_output"; then
  echo 'Missing tag must publish a new release' >&2
  exit 1
fi
if ! grep -Fxq 'reason=tag_missing' <<<"$missing_output"; then
  echo 'Expected tag_missing reason' >&2
  exit 1
fi
