#!/usr/bin/env bash
set -euo pipefail

package_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
image="sandbox-execution-test:local"

docker build -t "$image" -f "$package_dir/Dockerfile.test" "$package_dir"
docker run --rm \
  --init \
  --volume "$package_dir:/workspace" \
  --workdir /workspace \
  "$image" \
  bun test tests "$@"
