#!/bin/bash
# Requests short-lived credentials for registry.cloudflare.com. The call is
# retried up to five times on transient failures (408, any 5xx, or a missing
# HTTP code from a network-level error) with escalating backoff. Other 4xx
# responses are treated as permanent and reported immediately, since the
# endpoint only ever returns them for misconfiguration (bad token, wrong
# account ID) that a retry cannot resolve.
#
# GitHub Actions annotations (::warning::, ::error::) are emitted directly
# rather than delegated to curl's --retry flags so that retries and final
# failures surface cleanly in the job log.
#
# On success, exports CF_REGISTRY_USERNAME and CF_REGISTRY_PASSWORD for the
# caller to consume (e.g. piping the password into `crane auth login` or
# `docker login`). The response body is only printed on final failure, and
# the Cloudflare API's failure envelope does not contain credentials.
#
# Sourced (not executed) by workflow steps — avoid changing shell options.
#
# Usage: source .github/cf-registry-login.sh
#        cf_registry_credentials <expiration_minutes> <permissions_json_array>
#
# Example: cf_registry_credentials 15 '["pull", "push"]'
#
# Required env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID

cf_registry_credentials() {
  local expiration_minutes="$1"
  local permissions_json="$2"
  local url="https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/containers/registries/registry.cloudflare.com/credentials"
  local body response_file http attempt max_attempts=5
  body=$(jq -nc --argjson exp "$expiration_minutes" --argjson perms "$permissions_json" \
    '{expiration_minutes: $exp, permissions: $perms}')
  response_file=$(mktemp)

  for attempt in $(seq 1 $max_attempts); do
    http=$(curl -s -o "$response_file" -w '%{http_code}' --max-time 45 -X POST "$url" \
      -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
      -H "Content-Type: application/json" \
      -d "$body")
    if [[ "$http" == "201" ]]; then
      CF_REGISTRY_USERNAME=$(jq -r '.result.username // ""' "$response_file")
      CF_REGISTRY_PASSWORD=$(jq -r '.result.password // ""' "$response_file")
      rm -f "$response_file"
      if [[ -z "$CF_REGISTRY_USERNAME" || -z "$CF_REGISTRY_PASSWORD" ]]; then
        echo "::error::CF registry returned 201 with empty username or password"
        return 1
      fi
      export CF_REGISTRY_USERNAME CF_REGISTRY_PASSWORD
      return 0
    fi
    # Permanent client errors (bad token, wrong account ID, malformed request)
    # — skip the remaining attempts and report directly.
    if [[ "$http" =~ ^4[0-9][0-9]$ && "$http" != "408" ]]; then
      echo "::error::CF registry credentials request rejected with HTTP ${http} — check CLOUDFLARE_API_TOKEN scope and CLOUDFLARE_ACCOUNT_ID"
      cat "$response_file" >&2
      rm -f "$response_file"
      return 1
    fi
    if [[ "$attempt" -lt "$max_attempts" ]]; then
      echo "::warning::CF registry credentials attempt ${attempt} failed (HTTP ${http}); retrying..."
      sleep $((attempt * 5))
    fi
  done

  echo "::error::CF registry credentials endpoint unavailable after ${max_attempts} attempts (last HTTP ${http})"
  cat "$response_file" >&2
  rm -f "$response_file"
  return 1
}
