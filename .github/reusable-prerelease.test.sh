#!/bin/bash
set -euo pipefail

assert_step_exports_account_id() {
  local workflow="$1"
  local step_name="$2"
  local indent="$3"
  local step_block

  step_block=$(awk -v step="$step_name" -v indent="$indent" '
    $0 == indent "- name: " step { in_step = 1; print; next }
    in_step && index($0, indent "- name: ") == 1 { exit }
    in_step { print }
  ' "$workflow")

  if [[ -z "$step_block" ]]; then
    echo "Missing workflow step '$step_name' in $workflow" >&2
    return 1
  fi

  # shellcheck disable=SC2016
  if ! grep -Fq 'CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}' <<<"$step_block"; then
    echo "Workflow step '$step_name' in $workflow must export CLOUDFLARE_ACCOUNT_ID" >&2
    return 1
  fi
}

assert_step_exports_account_id ".github/workflows/reusable-prerelease.yml" "Publish prerelease" "      "
assert_step_exports_account_id ".github/workflows/release.yml" "Publish stable release" "      "
assert_step_exports_account_id ".github/workflows/backfill-release-artifacts.yml" "Backfill stable release artifacts" "      "

assert_workflow_contains() {
  local workflow="$1"
  local needle="$2"
  if ! grep -Fq "$needle" "$workflow"; then
    echo "Workflow $workflow must contain: $needle" >&2
    return 1
  fi
}

assert_workflow_contains ".github/workflows/release.yml" "npx tsx .github/release-orchestrator.ts stable"
assert_workflow_contains ".github/workflows/release.yml" "bash .github/detect-stable-release-needed.sh"
assert_workflow_contains ".github/workflows/release.yml" "steps.stable-release.outputs.publish == 'true'"
assert_workflow_contains ".github/workflows/release.yml" 'GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}'
assert_workflow_contains ".github/workflows/release.yml" "for file in .changeset/*.md; do"
assert_workflow_contains ".github/workflows/release.yml" '[[ "$file" == ".changeset/README.md" ]]'
assert_workflow_contains ".github/workflows/backfill-release-artifacts.yml" "npx tsx .github/release-orchestrator.ts stable"
assert_workflow_contains ".github/workflows/backfill-release-artifacts.yml" "fetch-depth: 0"
assert_workflow_contains ".github/workflows/backfill-release-artifacts.yml" "persist-credentials: true"
assert_workflow_contains ".github/workflows/backfill-release-artifacts.yml" "release_commit_sha"
assert_workflow_contains ".github/workflows/backfill-release-artifacts.yml" 'git rev-list -n 1 "$git_tag"'
assert_workflow_contains ".github/workflows/backfill-release-artifacts.yml" 'Release tag $git_tag is missing; provide release_commit_sha'
if grep -Fq -- '--commit-sha "${{ github.sha }}"' .github/workflows/backfill-release-artifacts.yml; then
  echo "Backfill must resolve the release commit instead of passing github.sha" >&2
  exit 1
fi
assert_workflow_contains ".github/workflows/reusable-prerelease.yml" "npx tsx .github/release-orchestrator.ts prerelease"

detect_pending_changesets() {
  local changeset_dir="$1"
  local files=()
  local file

  shopt -s nullglob
  for file in "$changeset_dir"/*.md; do
    if [[ "${file##*/}" == "README.md" ]]; then
      continue
    fi
    files+=("$file")
  done

  if [[ ${#files[@]} -gt 0 ]]; then
    echo "present=true"
  else
    echo "present=false"
  fi
}

changeset_test_dir=$(mktemp -d)
trap 'rm -rf "$changeset_test_dir"' EXIT
mkdir -p "$changeset_test_dir/.changeset"
printf '# Changesets\n' > "$changeset_test_dir/.changeset/README.md"
if [[ "$(detect_pending_changesets "$changeset_test_dir/.changeset")" != "present=false" ]]; then
  echo "README-only changeset state must not count as pending" >&2
  exit 1
fi
printf -- '---\n"@cloudflare/sandbox": patch\n---\n\nTest changeset\n' > "$changeset_test_dir/.changeset/real.md"
if [[ "$(detect_pending_changesets "$changeset_test_dir/.changeset")" != "present=true" ]]; then
  echo "Real changeset markdown must count as pending" >&2
  exit 1
fi

if grep -Fq "steps.changesets.outputs.published == 'true'" .github/workflows/release.yml; then
  echo "Stable release artifacts must not be gated by changesets.outputs.published" >&2
  exit 1
fi
