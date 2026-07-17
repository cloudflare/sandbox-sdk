#!/usr/bin/env bash
set -euo pipefail

package_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
image="sandbox-execution-test:local"
negative_test_name="lifetime timeout cleans redirected descendants after leader exit"
negative_log=""
negative_container=""

cleanup_negative_control() {
  if [[ -n "$negative_container" ]]; then
    docker rm -f "$negative_container" >/dev/null 2>&1 || true
  fi
  if [[ -n "$negative_log" ]]; then
    rm -f "$negative_log"
  fi
}
trap cleanup_negative_control EXIT

docker build -t "$image" -f "$package_dir/Dockerfile.test" "$package_dir"

negative_log="$(mktemp -t sandbox-execution-negative-control.XXXXXX)"

echo "=== sandbox-execution negative control: bypass Tini so Bun runs as PID1 ==="
negative_container="$(
  docker create \
    --entrypoint /usr/local/bin/bun \
    --volume "$package_dir:/workspace" \
    --workdir /workspace \
    "$image" \
    test tests/managed-process-supervisor.test.ts \
    --test-name-pattern "$negative_test_name" \
    --timeout=2500
)"

set +e
docker start -a "$negative_container" >"$negative_log" 2>&1
negative_status=$?
set -e

cat "$negative_log"
docker rm -f "$negative_container" >/dev/null 2>&1 || true
negative_container=""

if [[ $negative_status -eq 0 ]]; then
  echo "ERROR: negative control unexpectedly passed without the Tini process reaper" >&2
  exit 1
fi

if ! grep -F "ManagedProcessSupervisor > $negative_test_name" "$negative_log" >/dev/null; then
  echo "ERROR: negative control did not run the intended redirected-stdio descendant test" >&2
  exit 1
fi

if ! grep -E "this test timed out after|test timed out after" "$negative_log" >/dev/null; then
  echo "ERROR: negative control did not fail with the expected process-group non-settlement timeout" >&2
  exit 1
fi

echo "=== sandbox-execution negative control: observed expected process-group non-settlement timeout ==="
echo "=== sandbox-execution positive suite: run complete tests through explicit Tini entrypoint ==="

docker run --rm \
  --entrypoint /usr/bin/tini \
  --volume "$package_dir:/workspace" \
  --workdir /workspace \
  "$image" \
  -- \
  bun test tests "$@"

echo "=== sandbox-execution positive suite: passed through explicit Tini entrypoint ==="
