#!/bin/bash
set -euo pipefail

base_ref="${BASE_REF:-origin/main}"
changed=$(git diff --name-only "$base_ref"...HEAD -- '.github/*.ts' '.github/*.test.ts' '.github/test/*.ts' || true)
while IFS= read -r file; do
  [[ -z "$file" || ! -f "$file" ]] && continue
  lines=$(wc -l < "$file")
  if (( lines >= 1000 )); then
    echo "$file has $lines lines; split it below 1000" >&2
    exit 1
  fi
done <<< "$changed"

if grep -R "test/release-platform-fake" .github --include='*.ts' | grep -v '\.test\.ts' | grep -v '.github/test/release-platform-fake.ts'; then
  echo 'production TypeScript must not import the fake release platform' >&2
  exit 1
fi
