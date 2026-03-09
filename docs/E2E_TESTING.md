# E2E Testing Guide

E2E tests validate full workflows against real Cloudflare Workers and Docker containers.

## Architecture

All E2E tests share a **single sandbox container** for performance. Test isolation is achieved through **sessions** - each test file gets a unique session that provides isolated shell state (env vars, working directory) within the shared container.

```
┌─────────────────────────────────────────────────────┐
│                  Shared Sandbox                     │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐    │
│  │  Session A  │ │  Session B  │ │  Session C  │    │
│  │  (test 1)   │ │  (test 2)   │ │  (test 3)   │    │
│  └─────────────┘ └─────────────┘ └─────────────┘    │
│                                                     │
│              Shared filesystem & processes          │
└─────────────────────────────────────────────────────┘
```

**Key files:**

- `tests/e2e/global-setup.ts` - Creates sandbox before tests, warms containers
- `tests/e2e/helpers/global-sandbox.ts` - Provides `getSharedSandbox()` API
- `vitest.e2e.config.ts` - Configures parallel execution with global setup

## Writing Tests

### Basic Template

```typescript
import { describe, test, expect, beforeAll } from 'vitest';
import {
  getSharedSandbox,
  createUniqueSession
} from './helpers/global-sandbox';

describe('My Feature', () => {
  let workerUrl: string;
  let headers: Record<string, string>;

  beforeAll(async () => {
    const sandbox = await getSharedSandbox();
    workerUrl = sandbox.workerUrl;
    headers = sandbox.createHeaders(createUniqueSession());
  }, 120000);

  test('should do something', async () => {
    const response = await fetch(`${workerUrl}/api/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ command: 'echo hello' })
    });
    expect(response.status).toBe(200);
  }, 60000);
});
```

### Using Python Image

For tests requiring Python (code interpreter, etc.):

```typescript
beforeAll(async () => {
  const sandbox = await getSharedSandbox();
  workerUrl = sandbox.workerUrl;
  // Use createPythonHeaders instead of createHeaders
  headers = sandbox.createPythonHeaders(createUniqueSession());
}, 120000);
```

### File Isolation

Since the filesystem is shared, use unique paths to avoid conflicts:

```typescript
const sandbox = await getSharedSandbox();
const testDir = sandbox.uniquePath('my-feature'); // /workspace/test-abc123/my-feature

await fetch(`${workerUrl}/api/file/write`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    path: `${testDir}/config.json`,
    content: '{"key": "value"}'
  })
});
```

### Port Usage

Ports must be exposed in the Dockerfile. Currently exposed:

- `8080` - General testing
- `9090`, `9091`, `9092` - Process readiness tests
- `9998` - Process lifecycle tests
- `9999` - WebSocket tests

To use a new port:

1. Add it to both `tests/e2e/test-worker/Dockerfile` and `Dockerfile.python`
2. Document which test uses it

### Process Cleanup

Always clean up background processes:

```typescript
test('should start server', async () => {
  const startRes = await fetch(`${workerUrl}/api/process/start`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ command: 'bun run server.js' })
  });
  const { id: processId } = await startRes.json();

  // ... test logic ...

  // Cleanup
  await fetch(`${workerUrl}/api/process/${processId}`, {
    method: 'DELETE',
    headers
  });
}, 60000);
```

## Test Organization

| File                                    | Purpose                      |
| --------------------------------------- | ---------------------------- |
| `comprehensive-workflow.test.ts`        | Happy path integration tests |
| `process-lifecycle-workflow.test.ts`    | Error handling for processes |
| `process-readiness-workflow.test.ts`    | waitForLog/waitForPort tests |
| `code-interpreter-workflow.test.ts`     | Python/JS code execution     |
| `file-operations-workflow.test.ts`      | File read/write/list         |
| `streaming-operations-workflow.test.ts` | Streaming command output     |
| `websocket-workflow.test.ts`            | WebSocket connections        |
| `bucket-mounting.test.ts`               | R2 bucket mounting (CI only) |

## Running Tests

```bash
# All E2E tests (runs vitest E2E tests, then browser E2E tests sequentially)
npm run test:e2e

# Single vitest E2E file
npm run test:e2e:vitest -- -- tests/e2e/process-lifecycle-workflow.test.ts

# Single vitest E2E test by name
npm run test:e2e:vitest -- -- tests/e2e/git-clone-workflow.test.ts -t 'should clone repo'

# Browser E2E tests only (Playwright)
npm run test:e2e:browser
```

**Note on argument passthrough**: Use `test:e2e:vitest` (not `test:e2e`) when passing arguments to filter tests. The `test:e2e` script runs both vitest and browser tests sequentially but doesn't support argument passthrough due to turborepo limitations.

## Debugging

- Tests auto-retry once on failure (`retry: 1` in config)
- Global setup logs sandbox ID on startup - check for initialization errors
- If tests fail on first run only, the container might not be warmed (check global-setup.ts initializes the right image type)
- Port conflicts: check no other test uses the same port

## What NOT to Do

- **Don't create new sandboxes unless strictly necessary** - use `getSharedSandbox()`
- **Don't skip cleanup** - leaked processes affect other tests
- **Don't use hardcoded ports** without adding to Dockerfile
- **Don't rely on filesystem state** from other tests - use unique paths
