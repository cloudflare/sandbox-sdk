# Performance Testing Guide

Performance tests measure sandbox latency, throughput, and behavior under load.

## Running Tests

```bash
# All scenarios
npm run test:perf

# Individual scenarios (fastest to slowest)
npm run test:perf:sustained    # ~1 min  - commands on warm sandbox
npm run test:perf:cold-start   # ~30s    - fresh sandbox creation
npm run test:perf:burst        # ~2 min  - concurrent request spikes
npm run test:perf:concurrent   # ~5 min  - multiple sandbox creation
```

## Test Scenarios

| Scenario                 | What it measures                               |
| ------------------------ | ---------------------------------------------- |
| **cold-start**           | Time to create sandbox + execute first command |
| **sustained-throughput** | Command latency over 60s (5 req/s)             |
| **bursty-traffic**       | 3 bursts of 50 concurrent requests             |
| **concurrent-creation**  | 25 sandboxes created simultaneously            |

## Environment

- **Local**: Uses `wrangler dev` (Docker required)
- **CI**: Set `TEST_WORKER_URL` to deployed worker

```bash
# Run against deployed worker
TEST_WORKER_URL=https://your-worker.workers.dev npm run test:perf
```

## Metrics Collection

The `MetricsCollector` class tracks timing and success rates:

```typescript
const metrics = new MetricsCollector('scenario-name');

// Time an async operation
const result = await metrics.timeAsync('operation-name', async () => {
  return await doSomething();
});

// Record a raw value
metrics.record('custom-metric', 123.45, 'ms');

// Track success/failure
metrics.recordSuccess('operation-name', succeeded);
```

Statistics calculated per metric:

- **Count**: Number of samples
- **Min/Max/Mean**: Basic stats
- **StdDev**: Standard deviation
- **Percentiles**: p50, p75, p90, p95, p99

## Output

Results written to `perf-results/`:

- `latest.json` - Full metrics with percentiles and success rates
- `vitest-output.json` - Vitest test results

JSON schema (v1.0.0):

```typescript
{
  version: string;
  timestamp: string;
  environment: { workerUrl, mode: 'local' | 'ci' };
  scenarios: [{
    name: string;
    duration: number;
    metrics: [{ name, unit, count, min, max, mean, p50, p95, p99, stdDev }];
    successRates: { [name]: { total, success, failure, rate } };
  }];
}
```

Console shows summary:

```
SCENARIO: cold-start
Duration: 26s

  cold-start-latency (n=10):
    P50: 1.37s  P95: 1.59s  P99: 1.59s
  Success Rate: 100.0% (10/10)
```

## GitHub Actions

Workflow at `.github/workflows/performance.yml`:

- **Manual**: Run via workflow_dispatch
- **Scheduled**: Weekly baseline (Sunday midnight)
- **On release**: Pre-release validation

## Writing New Scenarios

```typescript
import { describe, test, beforeAll, afterAll } from 'vitest';
import { PerfSandboxManager } from '../helpers/perf-sandbox-manager';
import { MetricsCollector } from '../helpers/metrics-collector';

describe('My Scenario', () => {
  let manager: PerfSandboxManager;
  let metrics: MetricsCollector;

  beforeAll(async () => {
    manager = new PerfSandboxManager(workerUrl);
    metrics = new MetricsCollector('my-scenario');
  });

  afterAll(async () => {
    await manager.destroyAll();
    metrics.printReport();
  });

  test('should measure something', async () => {
    const sandbox = await manager.createSandbox();

    const latency = await metrics.timeAsync('operation', async () => {
      return sandbox.execute('echo test');
    });

    expect(latency).toBeLessThan(5000);
  });
});
```

## Local vs Production

Local Docker performance differs from Cloudflare production:

- **Cold start**: ~1.3s local, varies in production
- **Concurrent**: Limited by laptop resources locally
- **Capacity errors**: Only occur in production (account limits)

Use local tests for regression detection, production for baseline metrics.
