#!/bin/bash
set -euo pipefail

workflow=.github/workflows/release.yml
[[ -f "$workflow" ]] || { echo "run from repo root" >&2; exit 1; }

if ! grep -Eq '^  release-identity:' "$workflow"; then
  echo 'release.yml must declare a release-identity job' >&2
  exit 1
fi
if ! grep -q 'release-identity.ts' "$workflow"; then
  echo 'identity job must run release-identity.ts' >&2
  exit 1
fi
if ! grep -q 'release-sha:' "$workflow"; then
  echo 'identity job must output release-sha' >&2
  exit 1
fi
if ! grep -q 'release-mode:' "$workflow"; then
  echo 'identity job must output release-mode' >&2
  exit 1
fi
if ! grep -q 'ref: ${{ needs.release-identity.outputs.release-sha }}' "$workflow"; then
  echo 'a job must checkout the resolved release-sha' >&2
  exit 1
fi
if ! grep -q 'checkout_ref: ${{ needs.release-identity.outputs.release-sha }}' "$workflow"; then
  echo 'reusable jobs must use the resolved release-sha via checkout_ref' >&2
  exit 1
fi
if ! grep -q 'artifact_key: ${{ needs.release-identity.outputs.release-sha }}' "$workflow"; then
  echo 'reusable jobs must key build artifacts by release-sha' >&2
  exit 1
fi
if ! grep -q 'commit-sha "${{ needs.release-identity.outputs.release-sha }}"' "$workflow"; then
  echo 'publish steps must use needs.release-identity.outputs.release-sha as commit sha' >&2
  exit 1
fi
if grep -q -- '--commit-sha "${{ github.sha }}"' "$workflow"; then
  echo 'publish steps must not use github.sha as the release commit' >&2
  exit 1
fi

echo 'release identity workflow guards passed'
