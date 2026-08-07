#!/bin/bash
set -euo pipefail

workflow=.github/workflows/reusable-e2e.yml

assert_contains() {
  local expected=$1
  if ! grep -Fq -- "$expected" "$workflow"; then
    echo "Expected $workflow to contain: $expected" >&2
    exit 1
  fi
}

assert_not_contains() {
  local unexpected=$1
  if grep -Fq -- "$unexpected" "$workflow"; then
    echo "Expected $workflow not to contain: $unexpected" >&2
    exit 1
  fi
}

assert_contains 'echo "skip=true" >> "$GITHUB_OUTPUT"'
assert_contains 'echo "skip=false" >> "$GITHUB_OUTPUT"'
assert_contains '--secrets-file "$SECRETS_FILE"'
assert_not_contains 'wrangler secret bulk'

checkout_step=$(awk '
  /^      - name: Check out deployment revision$/ { in_step = 1 }
  in_step && /^      - / && !/Check out deployment revision$/ { exit }
  in_step { print }
' "$workflow")

if [[ -z "$checkout_step" ]]; then
  echo "Expected $workflow to define the deployment checkout step" >&2
  exit 1
fi

if grep -Fq 'if:' <<<"$checkout_step"; then
  echo "Deployment checkout must run when an existing deployment is reused" >&2
  exit 1
fi
