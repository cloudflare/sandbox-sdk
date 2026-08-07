---
name: sandbox-bridge
description: Trigger only when exercising a real running stable Sandbox bridge deployment over HTTP via SANDBOX_WORKER_URL and SANDBOX_API_KEY.
---

# Sandbox Bridge

The supported self-deployed bridge is the stable release on `main`.

- Template: https://github.com/cloudflare/sandbox-sdk/tree/main/bridge/worker
- Docs: https://developers.cloudflare.com/sandbox/bridge/

Keep the bridge Worker package and `cloudflare/sandbox` container image on
matching stable versions. Do not use a bridge deployed from `next` or paired
with `@cloudflare/sandbox@next`.

## Credentials

```bash
: "${SANDBOX_WORKER_URL:?missing bridge URL}"
: "${SANDBOX_API_KEY:?missing bridge token}"
```

Pass `Authorization: Bearer $SANDBOX_API_KEY` on authenticated requests. Never
put the token in a query string.

Inspect the deployed bridge before assuming its exact version or routes:

```bash
curl -sf -H "Authorization: Bearer $SANDBOX_API_KEY" \
  "$SANDBOX_WORKER_URL/v1/openapi.json" | jq '.paths | keys'
```

The stable bridge uses command-oriented routes such as
`POST /v1/sandbox/{id}/exec`, session routes and `Session-Id`, and
`GET /v1/sandbox/{id}/pty`. Treat the live OpenAPI document as authoritative.

Always destroy test sandboxes when finished:

```bash
curl -sf -X DELETE "$SANDBOX_WORKER_URL/v1/sandbox/$SID" \
  -H "Authorization: Bearer $SANDBOX_API_KEY"
```

Use `wrangler dev` rather than the bridge when testing unreleased `next` SDK or
container behavior.
