#!/usr/bin/env bash
set -euo pipefail

delete_instance() {
  local app_id=$1 instance_id=$2 response status
  response=$(mktemp)
  status=$(curl --silent --show-error --output "$response" --write-out '%{http_code}' \
    --request DELETE \
    --header "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/containers/applications/$app_id/instances/$instance_id" || true)
  case "$status" in
    2??|404|409) ;;
    *)
      echo "::error::Failed to delete instance $instance_id (HTTP $status): $(cat "$response")" >&2
      rm -f "$response"
      return 1
      ;;
  esac
  rm -f "$response"
}

expected_image() {
  local worker=$1 image_tag=$2 app_name=$3 image=sandbox
  case "$app_name" in
    "$worker") ;;
    "$worker-browser") ;;
    "$worker-python") image=sandbox-python ;;
    "$worker-opencode") image=sandbox-opencode ;;
    "$worker-standalone") image=sandbox-standalone ;;
    "$worker-musl") image=sandbox-musl ;;
    *) return 1 ;;
  esac
  printf 'registry.cloudflare.com/%s/%s:%s' \
    "$CLOUDFLARE_ACCOUNT_ID" "$image" "$image_tag"
}

readiness_reasons() {
  local app_json=$1 instances_json=$2 expected=$3
  local expected_version
  expected_version=$(jq -r '.version | tostring' <<<"$app_json")

  jq -nr --arg expected "$expected" --arg version "$expected_version" \
    --argjson app "$app_json" --argjson instances "$instances_json" '
    [
      if $app.configuration.image != $expected then
        "image=" + ($app.configuration.image // "missing")
      else empty end,
      if (($app.active_rollout_id // "") | length) > 0 then
        "active_rollout_id=" + $app.active_rollout_id
      else empty end,
      if (($app.health.errors // []) | length) > 0 then
        "health_errors=" + (($app.health.errors | length) | tostring)
      else empty end,
      ($app.health.instances // {} | to_entries[] |
        select(.key == "starting" or .key == "scheduling" or .key == "failed") |
        select(.value > 0) | "health_" + .key + "=" + (.value | tostring)),
      ($instances[]? |
        select(.version != null) |
        select((.version | tostring) != $version) |
        "old_instance=" + .id + ":version=" + (.version | tostring))
    ] | .[]
  '
}

if [[ ${1:-} == --evaluate ]]; then
  readiness_reasons "$(<"$2")" "$(<"$3")" "$4"
  exit 0
fi

if [[ ${1:-} == --expected-image ]]; then
  expected_image "$2" "$3" "$4"
  exit 0
fi

worker=${1:?worker name required}
image_tag=${2:?image tag required}
timeout_seconds=${ROLLOUT_TIMEOUT_SECONDS:-600}
drain_grace_seconds=${ROLLOUT_DRAIN_GRACE_SECONDS:-180}
poll_seconds=${ROLLOUT_POLL_SECONDS:-10}
deadline=$((SECONDS + timeout_seconds))
drain_deadline=$((SECONDS + drain_grace_seconds))
app_names=("$worker" "$worker-browser" "$worker-python" "$worker-opencode" "$worker-standalone" "$worker-musl")

echo "Waiting for container applications to serve image tag $image_tag"
while ((SECONDS < deadline)); do
  apps=$(wrangler containers list --json)
  all_ready=true

  for app_name in "${app_names[@]}"; do
    app=$(jq -c --arg name "$app_name" '.[] | select(.name == $name)' <<<"$apps")
    if [[ -z $app ]]; then
      echo "$app_name: application not found"
      all_ready=false
      continue
    fi

    app_id=$(jq -r '.id' <<<"$app")
    app=$(wrangler containers info "$app_id")
    expected=$(expected_image "$worker" "$image_tag" "$app_name")
    instances=$(wrangler containers instances "$app_id" --json)
    reasons=$(readiness_reasons "$app" "$instances" "$expected")

    if [[ -z $reasons ]]; then
      echo "$app_name: ready at version $(jq -r '.version' <<<"$app")"
      continue
    fi

    all_ready=false
    echo "$app_name: waiting ($(tr '\n' ' ' <<<"$reasons"))"

    if ((SECONDS >= drain_deadline)); then
      expected_version=$(jq -r '.version | tostring' <<<"$app")
      while IFS= read -r instance_id; do
        [[ -z $instance_id ]] && continue
        echo "$app_name: deleting old-version instance $instance_id"
        delete_instance "$app_id" "$instance_id"
      done < <(jq -r --arg version "$expected_version" \
        '.[] | select(.version != null) | select((.version | tostring) != $version) | .id' <<<"$instances")
    fi
  done

  if [[ $all_ready == true ]]; then
    echo 'All container applications are ready'
    exit 0
  fi
  sleep "$poll_seconds"
done

echo '::error::Container rollout did not become ready before timeout'
exit 1
