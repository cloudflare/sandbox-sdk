#!/bin/bash
set -euo pipefail

workflow=.github/workflows/reusable-prerelease.yml

assert_step_exports_account_id() {
  local step_name="$1"
  local step_block

  step_block=$(awk -v step="$step_name" '
    $0 == "      - name: " step { in_step = 1; print; next }
    in_step && /^      - name: / { exit }
    in_step { print }
  ' "$workflow")

  if [[ -z "$step_block" ]]; then
    echo "Missing workflow step: $step_name" >&2
    return 1
  fi

  # shellcheck disable=SC2016
  if ! grep -Fq 'CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}' <<<"$step_block"; then
    echo "Workflow step '$step_name' must export CLOUDFLARE_ACCOUNT_ID" >&2
    return 1
  fi
}

assert_step_exports_account_id "Publish Docker images to Docker Hub"
assert_step_exports_account_id "Publish Docker images to CF Registry Library"
