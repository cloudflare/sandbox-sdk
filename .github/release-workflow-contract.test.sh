#!/bin/bash
set -euo pipefail

release=.github/workflows/release.yml
for workflow in .github/workflows/reusable-build.yml .github/workflows/reusable-quality.yml .github/workflows/reusable-e2e.yml .github/workflows/reusable-bridge-e2e.yml; do
  grep -q 'checkout_ref:' "$workflow" || { echo "$workflow must declare checkout_ref input" >&2; exit 1; }
  grep -q "default: ''" "$workflow" || { echo "$workflow checkout_ref default must be literal empty string" >&2; exit 1; }
  grep -Fq 'inputs.checkout_ref ||' "$workflow" || { echo "$workflow must checkout inputs.checkout_ref or default" >&2; exit 1; }
done
for workflow in .github/workflows/reusable-build.yml .github/workflows/reusable-quality.yml .github/workflows/reusable-e2e.yml; do
  grep -q 'artifact_key:' "$workflow" || { echo "$workflow must declare artifact_key input" >&2; exit 1; }
  grep -q "default: ''" "$workflow" || { echo "$workflow artifact_key default must be literal empty string" >&2; exit 1; }
  grep -Eq 'build-\$\{\{ inputs\.artifact_key \|\| github\.sha \}\}' "$workflow" || { echo "$workflow must use keyed build artifact" >&2; exit 1; }
done
grep -q 'actions/checkout@v6' "$release" || { echo 'release.yml must use actions/checkout@v6' >&2; exit 1; }
grep -q 'release-sha' "$release" || { echo 'release.yml must resolve release-sha before reusable jobs' >&2; exit 1; }
grep -q 'artifact_key: \${{ needs.release-identity.outputs.release-sha }}' "$release" || { echo 'release.yml must key artifacts by release SHA' >&2; exit 1; }
grep -q -- '--commit-sha "${{ needs.release-identity.outputs.release-sha }}"' "$release" || { echo 'stable engine must receive release SHA' >&2; exit 1; }
grep -q "promotion.outputs.result == 'pr-created'" "$release" || { echo 'PR-created promotion run must stop before Changesets' >&2; exit 1; }
grep -q "promotion.outputs.result == 'no-edits'" "$release" || { echo 'Changesets must require no promotion edits' >&2; exit 1; }
grep -q 'workflow_dispatch' .github/workflows/reconcile-stable-release.yml || { echo 'manual reconciliation workflow must remain manual' >&2; exit 1; }

echo 'release workflow contract guards passed'
