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
