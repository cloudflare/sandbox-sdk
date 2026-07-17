#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
script="$script_dir/wait-for-container-rollout.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
expected='registry.cloudflare.com/account/sandbox:ci-expected'

assert_output() {
  local name=$1 expected_output=$2
  shift 2
  actual=$(CLOUDFLARE_ACCOUNT_ID=account "$script" --evaluate "$@")
  if [[ $actual != "$expected_output" ]]; then
    printf 'FAIL %s\nexpected: %q\nactual:   %q\n' "$name" "$expected_output" "$actual" >&2
    exit 1
  fi
  echo "PASS $name"
}

cat >"$tmp/ready.json" <<'JSON'
{"version":2,"configuration":{"image":"registry.cloudflare.com/account/sandbox:ci-expected"},"health":{"errors":[],"instances":{"starting":0,"scheduling":0,"failed":0}}}
JSON
cat >"$tmp/current-instances.json" <<'JSON'
[{"id":"new","version":2,"state":"healthy"}]
JSON
assert_output ready '' "$tmp/ready.json" "$tmp/current-instances.json" "$expected"

cat >"$tmp/rolling.json" <<'JSON'
{"version":2,"active_rollout_id":"rollout-1","configuration":{"image":"registry.cloudflare.com/account/sandbox:ci-old"},"health":{"errors":[{"message":"pulling"}],"instances":{"starting":1,"scheduling":0,"failed":0}}}
JSON
cat >"$tmp/mixed-instances.json" <<'JSON'
[{"id":"old","version":1,"state":"active"},{"id":"new","version":2,"state":"healthy"}]
JSON
assert_output rolling $'image=registry.cloudflare.com/account/sandbox:ci-old\nactive_rollout_id=rollout-1\nhealth_errors=1\nhealth_starting=1\nold_instance=old:version=1' "$tmp/rolling.json" "$tmp/mixed-instances.json" "$expected"

cat >"$tmp/no-instances.json" <<'JSON'
[]
JSON
assert_output no-instances '' "$tmp/ready.json" "$tmp/no-instances.json" "$expected"

cat >"$tmp/inactive-do.json" <<'JSON'
[{"id":"durable-object","version":null,"state":"inactive"}]
JSON
assert_output inactive-do '' "$tmp/ready.json" "$tmp/inactive-do.json" "$expected"
