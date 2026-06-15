#!/bin/bash
set -euo pipefail
shopt -s nullglob

ts_tests=(.github/*.test.ts)
shell_tests=(.github/*.test.sh)

if [[ ${#ts_tests[@]} -gt 0 ]]; then
  node --import tsx --test "${ts_tests[@]}"
fi

for test_script in "${shell_tests[@]}"; do
  bash "$test_script"
done
