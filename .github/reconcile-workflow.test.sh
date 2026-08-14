#!/bin/bash
set -euo pipefail
manual=.github/workflows/reconcile-stable-release.yml
for expected in 'group: release-refs/heads/main' 'cancel-in-progress: false' 'Resolve manual release identity' 'checkout_ref: ${{ needs.release-identity.outputs.release-sha }}' 'artifact_key: ${{ needs.release-identity.outputs.release-sha }}' 'hashFiles(' 'deploy: ${{ steps.hash.outputs.deploy }}' 'source-tag "ci-${{ needs.hashes.outputs.docker }}"' 'path: ${{ runner.temp }}/release-root/packages' 'release-orchestrator.ts stable' '--mode "${{ needs.release-identity.outputs.release-mode }}"' 'pull-requests: write' 'Promote public references' "if: needs.release-identity.outputs.release-mode == 'current'" 'GH_TOKEN: ${{ steps.app-token.outputs.token }}' 'git rev-parse origin/main' 'promote-references.ts'; do
  grep -Fq -- "$expected" "$manual" || { echo "manual workflow missing: $expected" >&2; exit 1; }
done
if grep -Eq 'source[_-]tag:|inputs\.source[_-]tag|source-tag.*inputs' "$manual"; then
  echo 'manual workflow must not accept free-form source tag' >&2
  exit 1
fi
awk '/name: Promote public references/{f=1} f&&/^[[:space:]]+- name:/{if (++steps > 1) exit} f{print}' "$manual" | grep -Fq 'if: always()' && {
  echo 'promotion must run only after successful reconciliation' >&2
  exit 1
} || true
