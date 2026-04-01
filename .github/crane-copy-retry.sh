#!/bin/bash
# Copy a container image tag with retries on transient failures.
#
# Sourced (not executed) by workflow steps — avoid changing shell options.
#
# Usage: source .github/crane-copy-retry.sh
#        crane_copy_retry "registry/image:src" "registry/image:dst"

crane_copy_retry() {
  local src="$1" dst="$2"
  if crane copy "$src" "$dst"; then return 0; fi
  for delay in 10 30; do
    echo "::warning::crane copy failed for $dst — retrying in ${delay}s"
    sleep "$delay"
    if crane copy "$src" "$dst"; then return 0; fi
  done
  echo "::error::Failed to copy $dst after 3 attempts"
  return 1
}
