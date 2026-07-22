#!/bin/bash
set -euo pipefail

build=.github/workflows/reusable-build.yml
release=.github/workflows/release.yml

# JS build artifact retention must be at least 7 days.
retention=$(awk '/name: build-\$\{\{ github.sha \}\}/{f=1} f&&/retention-days:/{print $2; exit}' "$build")
if [[ -z "$retention" ]]; then
  # Fallback: any retention-days in the build upload step.
  retention=$(grep -A6 'upload-artifact' "$build" | awk '/retention-days:/{print $2; exit}')
fi
if [[ "${retention:-0}" -lt 7 ]]; then
  echo "build artifact retention must be >= 7 days, found: ${retention:-none}" >&2
  exit 1
fi

# Release workflow must emit a deterministic recovery instruction when the
# build artifact is unavailable.
if ! awk '
  /uses: actions\/download-artifact@v8/ { in_download=1; next }
  in_download && /^[[:space:]]+- / { exit }
  in_download && /continue-on-error: true/ { found=1 }
  END { exit found ? 0 : 1 }
' "$release"; then
  echo 'release.yml build download must tolerate failure to emit a recovery message' >&2
  exit 1
fi
if ! grep -q 'Re-run the entire Release workflow' "$release"; then
  echo 'release.yml must print a deterministic re-run-all recovery instruction' >&2
  exit 1
fi
recovery_annotation=$(grep 'echo "::error title=Build artifact unavailable::' "$release" || true)
if [[ -z "$recovery_annotation" ]]; then
  echo 'release.yml must emit the missing-artifact annotation' >&2
  exit 1
fi
if [[ "$recovery_annotation" == *'>&2'* ]]; then
  echo 'release.yml missing-artifact annotation must be emitted on stdout' >&2
  exit 1
fi

echo 'build retention + recovery guards passed'
