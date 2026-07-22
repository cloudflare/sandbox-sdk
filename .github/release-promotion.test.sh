#!/bin/bash
set -euo pipefail
workflow=.github/workflows/release.yml
grep -q 'runPromotionInWorktree' .github/promote-references.ts || { echo 'promotion must use its isolated worktree implementation' >&2; exit 1; }
grep -q 'promotion_result=pr-created' "$workflow" || { echo 'promotion step must expose PR-created result' >&2; exit 1; }
awk '/name: Prepare next release/{f=1} f&&/uses: changesets\/action@/{print; exit} f{print}' "$workflow" | grep -q "steps.promotion.outputs.result == 'no-edits'" || { echo 'Changesets must require no promotion edits' >&2; exit 1; }
awk '/name: Promote public references/{f=1} f&&/^[[:space:]]+- name: Stop after promotion PR/{exit} f{print}' "$workflow" | grep -Eq 'git add -A|git add \.|git checkout main|package-lock.json' && { echo 'promotion run block must not broad-stage, restore main, or edit lockfiles' >&2; exit 1; } || true

echo 'release promotion guards passed'
