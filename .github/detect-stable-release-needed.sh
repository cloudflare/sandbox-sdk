#!/bin/bash
set -euo pipefail

version="${1:?version is required}"
commit_sha="${2:?commit sha is required}"
git_tag="@cloudflare/sandbox@$version"

if git rev-parse --verify --quiet "refs/tags/$git_tag" >/dev/null; then
  tag_sha=$(git rev-list -n 1 "$git_tag")
  echo "tag_sha=$tag_sha"

  if [[ "$tag_sha" == "$commit_sha" ]]; then
    echo "publish=true"
    echo "reason=tag_matches_commit"
    exit 0
  fi

  echo "Stable release $git_tag already points to $tag_sha, not $commit_sha; skipping publish." >&2
  echo "publish=false"
  echo "reason=tag_points_elsewhere"
  exit 0
fi

echo "publish=true"
echo "reason=tag_missing"
