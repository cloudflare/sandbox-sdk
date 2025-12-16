# Error Handling & Retry Behavior

## HTTP Status Code Semantics

The SDK uses proper HTTP status codes for container startup errors:

| Status  | Meaning                                        | SDK Behavior                   |
| ------- | ---------------------------------------------- | ------------------------------ |
| **503** | Transient (container starting, port not ready) | Retry with exponential backoff |
| **500** | Permanent (config error, missing image)        | Fail immediately               |
| **400** | Client error (capacity limits, validation)     | Fail immediately               |

## Retry Logic

- **Total budget**: 2 minutes
- **Backoff**: 3s → 6s → 12s → 24s → 30s (capped)
- **Only retries**: 503 Service Unavailable

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
