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

assert_step_exports_account_id ".github/workflows/reusable-prerelease.yml" "Publish Docker images to Docker Hub" "      "
assert_step_exports_account_id ".github/workflows/reusable-prerelease.yml" "Publish Docker images to CF Registry Library" "      "
assert_step_exports_account_id ".github/workflows/release.yml" "Publish Docker images to Docker Hub" "      "
assert_step_exports_account_id ".github/workflows/release.yml" "Publish Docker images to CF Registry Library" "      "
assert_step_exports_account_id ".github/workflows/backfill-release-artifacts.yml" "Publish Docker images to Docker Hub" "      "
assert_step_exports_account_id ".github/workflows/backfill-release-artifacts.yml" "Publish Docker images to CF Registry Library" "      "
