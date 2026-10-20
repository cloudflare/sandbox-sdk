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

# A failed wrangler call is logged and polled again. Calls 1 and 3 are the
# first `containers list` and the first `containers info`.
mkdir -p "$tmp/bin"
cat >"$tmp/bin/wrangler" <<'SH'
#!/usr/bin/env bash
count=$(($(cat "$WRANGLER_CALLS" 2>/dev/null || echo 0) + 1))
echo "$count" >"$WRANGLER_CALLS"
if [[ $count == 1 || $count == 3 ]]; then
  echo 'Unknown internal error' >&2
  exit 1
fi
case "$1 $2" in
  'containers list')
    cat <<'JSON'
[
  {"id":"default","name":"worker"},
  {"id":"python","name":"worker-python"},
  {"id":"opencode","name":"worker-opencode"},
  {"id":"standalone","name":"worker-standalone"},
  {"id":"musl","name":"worker-musl"}
]
JSON
    ;;
  'containers info')
    case "$3" in
      default) image=sandbox ;;
      *) image="sandbox-$3" ;;
    esac
    printf '{"version":1,"configuration":{"image":"registry.cloudflare.com/account/%s:ci-expected"},"health":{"errors":[],"instances":{}}}\n' "$image"
    ;;
  'containers instances') printf '[]\n' ;;
  *) exit 1 ;;
esac
SH
chmod +x "$tmp/bin/wrangler"

if ! flaky_output=$(PATH="$tmp/bin:/usr/bin:/bin" \
  WRANGLER_CALLS="$tmp/wrangler-calls" \
  CLOUDFLARE_ACCOUNT_ID=account \
  CLOUDFLARE_API_TOKEN=token \
  ROLLOUT_TIMEOUT_SECONDS=5 \
  ROLLOUT_POLL_SECONDS=0 \
  "$script" worker ci-expected 2>&1); then
  printf 'FAIL flaky-wrangler exited non-zero\n%s\n' "$flaky_output" >&2
  exit 1
fi
for wanted in \
  '::warning::wrangler containers list --json failed; polling again: Unknown internal error' \
  '::warning::wrangler containers info default failed; polling again: Unknown internal error' \
  'All container applications are ready'; do
  if [[ $flaky_output != *"$wanted"* ]]; then
    printf 'FAIL flaky-wrangler missing %q\n%s\n' "$wanted" "$flaky_output" >&2
    exit 1
  fi
done
echo 'PASS flaky-wrangler'

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
