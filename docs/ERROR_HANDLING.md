# Error Handling & Retry Behavior

## HTTP Status Code Semantics

The SDK uses proper HTTP status codes for container startup errors:

| Status  | Meaning                                        | SDK Behavior                   |
| ------- | ---------------------------------------------- | ------------------------------ |
| **503** | Transient (container starting, port not ready) | Retry with exponential backoff |
| **500** | Permanent (config error, missing image)        | Fail immediately               |
| **400** | Client error (capacity limits, validation)     | Fail immediately               |

## Retry Logic

- **Total budget**: 2 minutes (configurable per Sandbox via `containerTimeouts`).
- **Backoff**: 3s → 6s → 12s → 24s → 30s (capped at 30s).
- **Only retries**: 503 Service Unavailable.

### Retry surfaces

Three independent code paths run the same retry algorithm. They all read the budget
from the same source (`Sandbox.computeRetryTimeoutMs()`), so a single `setRetryTimeoutMs`
call on the active client updates all of them.

| Path                                     | Where                                                | What it retries                                    |
| ---------------------------------------- | ---------------------------------------------------- | -------------------------------------------------- |
| HTTP / route-based requests              | `BaseTransport.fetch()`                              | 503 from `containerFetch()` (port not ready, etc.) |
| Route-based WebSocket upgrade            | `WebSocketTransport.fetchUpgradeWithRetry()`         | 503 on the WS upgrade fetch during cold start      |
| RPC control-connection upgrade (capnweb) | `ContainerControlConnection.fetchUpgradeWithRetry()` | 503 on the WS upgrade fetch during cold start      |

The two upgrade-retry paths exist because `containerFetch()` cannot be used for the
WebSocket upgrade itself — calling it from the same DO during `onStart()` would re-enter
`blockConcurrencyWhile` and deadlock. Instead, both paths call `stub.fetch()` directly and
use 503 retries as the readiness signal:

- **Container booting** — `containerFetch()` (which `stub.fetch()` ultimately routes
  through for non-WS calls) handles this via `startAndWaitForPorts()` polling. The WS
  upgrade path inherits the same wait because `Sandbox.fetch()` delegates to
  `super.fetch()` for upgrade requests.
- **No instance available** — only happens in production. `workerd` returns
  `NoInstanceError` when the DO has no allocated container yet (cold start, eviction,
  capacity pressure). `containerFetch()` translates this to 503; the SDK retries
  until an instance is allocated. `wrangler dev` does not reproduce this case — see
  `tests/container-connection.test.ts` for unit coverage.

## Container Boot Lifecycle

When a request triggers a cold start, the container goes through five distinct phases.
Errors are surfaced as 503 (retried) for any phase that can self-heal, and 500 (immediate
fail) for phases where retrying makes no difference.

```text
[1] Instance allocation     ──┐
[2] Container start         ──┤  startAndWaitForPorts() owns 1–3
[3] Port readiness          ──┘  driven by containerFetch() / Sandbox.fetch()
[4] onStart hook            ──    runs inside blockConcurrencyWhile
[5] Request proxying        ──    tcpPort.fetch() forwards the original request
```

### [1] Instance allocation

**Budget:** `containerTimeouts.instanceGetTimeoutMS` (default 30 s).
**What happens:** workerd's container scheduler tries to assign a VM to the DO. On a
cold start or right after eviction there may not be one ready yet.

| Failure                 | Surfaced as | SDK behavior                           |
| ----------------------- | ----------- | -------------------------------------- |
| `no container instance` | 503         | **Retry** (cold-start race)            |
| `SURPASSED_*_LIMITS`    | 400         | Fail immediately (account-level limit) |

Production-only: `wrangler dev` always has an instance ready, so phase 1 never returns
503 locally.

### [2] Container start

**What happens:** `containerStart` boots the configured Docker image with the requested
env, entrypoint, and outbound config.

| Failure                          | Surfaced as | SDK behavior                                             |
| -------------------------------- | ----------- | -------------------------------------------------------- |
| `No such image available`        | 500         | Fail — misconfigured `wrangler.jsonc` or registry mirror |
| `Container already exists`       | 500         | Fail — name collision in DO state                        |
| `Container exited before health` | 500         | Fail — image entrypoint crashed before phase 3           |

Image / config errors are not retryable; they will keep failing until the deployment is
fixed.

### [3] Port readiness

**Budget:** `containerTimeouts.portReadyTimeoutMS` (default 90 s).
**What happens:** `waitForPort()` polls TCP on the requested port (default 3000) every
500 ms until it accepts a connection.

| Failure                            | Surfaced as | SDK behavior                                                      |
| ---------------------------------- | ----------- | ----------------------------------------------------------------- |
| `the container is not listening`   | 503         | **Retry** — app still starting up                                 |
| `failed to verify port`            | 503         | **Retry** — health check timeout                                  |
| `container port not found`         | 503         | **Retry** — workerd hasn't picked up the Docker port mapping yet  |
| `Monitor failed to find container` | 503         | **Retry** — monitor restarted between provisioning and port check |
| Total wait > `portReadyTimeoutMS`  | 503         | **Retry** until the SDK's overall budget is exhausted             |

Slow-booting images (large dependencies, JIT warm-up, restoring snapshots) most often
trip up here. Increase `portReadyTimeoutMS` rather than `instanceGetTimeoutMS` for slow
containers — they govern different phases.

### [4] onStart hook

**What happens:** Once the port is up, `@cloudflare/containers` calls
`this.state.setHealthy()` and then `await this.onStart()` inside
`blockConcurrencyWhile`. `Sandbox.onStart()` rehydrates exposed-port tokens, restores
syncs, and primes session state.

| Failure            | Surfaced as | SDK behavior                                                                    |
| ------------------ | ----------- | ------------------------------------------------------------------------------- |
| `onStart()` throws | bubble      | The DO gate stays held; later requests see the same exception until it succeeds |

Anything `onStart` does that re-enters the DO via `stub.fetch()` will deadlock against
its own `blockConcurrencyWhile`. The SDK avoids this by talking to the container over
`stub.fetch()` directly (which routes via `containerFetch()` for non-WS calls and
`super.fetch()` for the WS upgrade), never via the DO's own `fetch()` handler.

### [5] Request proxying

**What happens:** `tcpPort.fetch(containerUrl, request)` forwards the original request
to the container. For WebSocket upgrades, the response carries a `webSocket` property
that gets `accept()`ed and handed to capnweb / the route-based WS transport.

| Failure                       | Surfaced as | SDK behavior                                                                                       |
| ----------------------------- | ----------- | -------------------------------------------------------------------------------------------------- |
| `network connection lost`     | 503         | **Retry** — socket dropped mid-request                                                             |
| WebSocket close 1000 + reason | bubble      | Surfaced as `RPCTransportError(peer_closed)`; not retried (call may have already had side effects) |
| Container-side handler error  | passthrough | The container returns a typed error, the SDK maps it to a `SandboxError` subclass                  |

### Where the retries live, by phase

| Phase              | Retried by                                                                                    |
| ------------------ | --------------------------------------------------------------------------------------------- |
| 1 Instance alloc   | All three retry surfaces (HTTP, route-based WS upgrade, RPC upgrade)                          |
| 2 Container start  | None — 500 is permanent                                                                       |
| 3 Port readiness   | HTTP via `BaseTransport.fetch()`; WS upgrades via `fetchUpgradeWithRetry()`                   |
| 4 onStart          | None — the exception bubbles                                                                  |
| 5 Request proxying | HTTP only (per-request retry); WS sessions reconnect on the next call after a transport error |

## Capacity Limit Errors (Production Only)

When hitting account limits, the Containers API returns 400 with these error codes:

| Error Code                       | Meaning                           |
| -------------------------------- | --------------------------------- |
| `SURPASSED_BASE_LIMITS`          | Exceeded per-deployment limits    |
| `SURPASSED_TOTAL_LIMITS`         | Exceeded account-wide limits      |
| `LOCATION_SURPASSED_BASE_LIMITS` | Exceeded location-specific limits |

These cannot be reproduced locally - they only occur in production.

## Account Limits (Workers Paid)

| Resource          | Limit   |
| ----------------- | ------- |
| Concurrent Memory | 400 GiB |
| Concurrent vCPU   | 100     |
| Concurrent Disk   | 2 TB    |

See [Containers limits](https://developers.cloudflare.com/containers/platform-details/limits/) for current values.

## Best Practices

- Call `destroy()` when done to free resources
- Use `keepAlive: false` (default) for auto-timeout
- Monitor concurrent container usage in production

## Error Sources & Test Coverage

The SDK handles errors from two layers:

### workerd (container-client.c++)

| Error Message                      | Condition                         | SDK Response |
| ---------------------------------- | --------------------------------- | ------------ |
| `container port not found`         | Port not in Docker mappings       | 503          |
| `Monitor failed to find container` | Container not found after retries | 503          |
| `No such image available`          | Docker image missing              | 500          |
| `Container already exists`         | Name collision                    | 500          |

### @cloudflare/containers (container.ts)

| Error Message                    | Condition                | SDK Response |
| -------------------------------- | ------------------------ | ------------ |
| `the container is not listening` | App not ready on port    | 503          |
| `failed to verify port`          | Port health check failed | 503          |
| `container did not start`        | Startup timeout          | 503          |
| `network connection lost`        | Connection dropped       | 503          |
| `no container instance`          | VM still provisioning    | 503          |

### Test Coverage

| Test File                        | What It Tests                     |
| -------------------------------- | --------------------------------- |
| `sandbox-error-handling.test.ts` | Error classification (503 vs 500) |
| `base-client.test.ts`            | Retry logic based on status codes |

All error patterns are verified against the actual error messages from workerd and @cloudflare/containers source code.
