# Error Handling & Runtime Admission

## HTTP Status Code Semantics

The SDK uses HTTP status codes to distinguish startup/admission failures from
already-admitted runtime work:

| Status  | Meaning                                          | SDK behavior                     |
| ------- | ------------------------------------------------ | -------------------------------- |
| **503** | Container unavailable before operation admission | Caller may retry a new operation |
| **500** | Permanent startup/configuration error            | Fail immediately                 |
| **400** | Client error (capacity limits, validation)       | Fail immediately                 |

## Runtime Admission, Not Operation Replay

Before runtime RPCs, the SDK establishes or observes the current container
runtime, probes its control-process metadata, validates the runtime
incarnation, and activates an exact control session. A semantic operation then
runs inside one admitted runtime lease. Waking operations choose to start the
runtime at that boundary; non-waking discovery and cleanup only use an already
active exact runtime and never create a replacement.

The transport is single-attempt for each activated session. If a runtime changes
or the control WebSocket is lost after admission, the SDK surfaces
`OperationInterruptedError`, `RPCTransportError`, or the domain-specific
runtime error. It does not replay ambiguous side-effecting work. Applications
that want recovery should start a new semantic operation after observing the
failure.

## Container Unavailable

`CONTAINER_UNAVAILABLE` means the SDK could not make the container available
before the requested user operation was admitted to the container control
plane. The operation did not start in the container.

Applications may handle this like a service-level 503: retry later, enqueue the
work, show retry UI, or return a 503 response to their caller. This can happen
during cold start, after sleep, during deployment or platform churn, or while
the SDK is opening the current container control connection.

Do not apply the same retry rule to execution or transport errors raised after
an operation was admitted. For example, if a command starts and the WebSocket
later closes, the SDK surfaces an execution error or `RPCTransportError`
because the operation may have already produced side effects.

## Container Boot Lifecycle

When a request triggers a cold start, the container goes through four relevant
phases. Errors are surfaced as 503 for phases that can self-heal, and 500 for
phases where retrying the same deployment makes no difference.

```text
[1] Instance allocation      ──┐
[2] Control port start       ──┤  runtime lifecycle establishment owns 1–3
[3] Control session activate ──┘  exact runtime incarnation is validated
[4] Admitted forwarding/RPC  ──   admitted TCP-port fetch or activated RPC
```

### [1] Instance allocation

**Budget:** `containerTimeouts.instanceGetTimeoutMS` (default 30 s).
**What happens:** workerd's container scheduler tries to assign a VM to the DO.
On a cold start or right after eviction there may not be one ready yet.

| Failure                 | Surfaced as | SDK behavior                     |
| ----------------------- | ----------- | -------------------------------- |
| `no container instance` | 503         | Caller may retry a new operation |
| `SURPASSED_*_LIMITS`    | 400         | Fail immediately (account limit) |

Production-only: `wrangler dev` always has an instance ready, so phase 1 never
returns 503 locally.

### [2] Control port start

**What happens:** the runtime lifecycle starts the configured container and
waits for the control port to be reachable. Image and configuration errors are
not retryable by the SDK because they will keep failing until the deployment is
fixed.

| Failure                          | Surfaced as | SDK behavior                                             |
| -------------------------------- | ----------- | -------------------------------------------------------- |
| `No such image available`        | 500         | Fail — misconfigured `wrangler.jsonc` or registry mirror |
| `Container already exists`       | 500         | Fail — name collision in DO state                        |
| `Container exited before health` | 500         | Fail — image entrypoint crashed before readiness         |
| Control port not ready           | 503         | Caller may retry a new operation                         |

### [3] Control session activation

**What happens:** the SDK probes runtime metadata, validates the runtime
incarnation, and activates the capnweb control session for that exact
incarnation. Domain RPCs are rejected before activation. A replacement runtime
must perform a new probe and activation; old sessions are interrupted rather
than reused.

| Failure                         | Surfaced as                  | SDK behavior                      |
| ------------------------------- | ---------------------------- | --------------------------------- |
| Missing/invalid metadata        | Runtime control protocol err | Fail current operation            |
| Incarnation mismatch            | Operation interrupted        | Do not replay ambiguous operation |
| WebSocket upgrade/transport err | Transport/runtime error      | Surface failure, no hidden retry  |

### [4] Admitted forwarding/RPC

**What happens:** once an operation is admitted, runtime control RPCs use the
activated session. Direct HTTP/WebSocket forwarding first waits for the target
port using the admitted runtime lease, then calls
`this.ctx.container.getTcpPort(port).fetch(request)` inside that same lease.
HTTP response bodies and WebSockets retain runtime authority until EOF,
cancellation, close, or interruption.

| Failure                       | Surfaced as                                            |
| ----------------------------- | ------------------------------------------------------ |
| Runtime replacement           | `OperationInterruptedError`; no replay                 |
| WebSocket close/transport     | `RPCTransportError` or domain-specific interruption    |
| Container-side handler error  | Passthrough response or mapped `SandboxError` subclass |
| Caller abort before admission | Caller abort reason                                    |

Direct forwarding no longer routes through inherited `Container.fetch()` or
`Container.containerFetch()` after admission. Preview, terminal, and direct
container forwarding all use exact runtime ownership and non-starting paths
where their public API requires non-waking behavior.

## Capacity Limit Errors (Production Only)

When hitting account limits, the Containers API returns 400 with these error
codes:

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

## Testing Strategy

### Local Unit Tests

Mock each startup phase separately:

1. Instance allocation errors via the container start path.
2. Control port readiness errors via lifecycle establishment.
3. Activation errors via runtime metadata/session mocks.
4. Post-admission interruption via runtime replacement or transport close.

### E2E Tests

Production-only paths require deployed Workers tests:

- Cold start under load.
- Image pull failures.
- Account capacity limits.
- Runtime replacement while streams/WebSockets are retained.

## Monitoring

Track these error patterns in production:

- High 503 rate with `container_starting`: cold start or readiness tuning.
- 500s with image/config messages: deployment misconfiguration.
- `OperationInterruptedError`: expected during runtime replacement; unexpected
  spikes indicate churn.
- `RPCTransportError`: control transport closed after admission.
