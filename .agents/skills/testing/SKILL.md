---
name: testing
description: "Use when writing, running, or debugging tests. Creates unit and E2E tests, selects the correct test suite, places test files in project-standard locations, and applies mock patterns (mock container, createNoOpLogger). (project)"
---

# Testing in Sandbox SDK

This skill covers project-specific testing conventions. For TDD methodology, use the `superpowers:test-driven-development` skill.

## Two Test Suites

### Unit Tests

**When to use**: Testing isolated logic, client behavior, service methods, utilities.

**Location**:

- SDK: `packages/sandbox/tests/`
- Container: `packages/sandbox-container/tests/`

**Runtime**:

- SDK tests run in Workers runtime via `@cloudflare/vitest-pool-workers`
- Container tests run in Bun runtime

**Commands**:

```bash
npm test                              # All unit tests
npm test -w @cloudflare/sandbox       # SDK tests only
npm test -w @repo/sandbox-container   # Container tests only
```

**Mock patterns**:

- SDK tests use a mock container (no Docker needed)
- Container tests mock external dependencies (filesystem, processes)
- Use `createNoOpLogger()` from `@repo/shared` for logger mocks

**Known issue**: SDK unit tests may hang on exit due to vitest-pool-workers workerd shutdown. Tests still pass/fail correctly - the hang is cosmetic.

### E2E Tests

**When to use**: Testing full request flow, container integration, real Docker behavior.

**Location**: `tests/e2e/`

**Runtime**: Real Cloudflare Workers + Docker containers

**Commands**:

```bash
npm run test:e2e                                                           # All E2E tests (vitest + browser)
npm run test:e2e:vitest -- -- tests/e2e/process-lifecycle-workflow.test.ts # Single vitest file
npm run test:e2e:vitest -- -- tests/e2e/git-clone-workflow.test.ts -t 'test name'  # Single vitest test
npm run test:e2e:browser                                                   # Browser tests only (Playwright)
```

**Note**: Use `test:e2e:vitest` when filtering tests. The `test:e2e` wrapper doesn't support argument passthrough.

**Key patterns**:

- All tests share ONE container for performance
- Use unique sessions for test isolation
- Tests run in parallel via thread pool
- Config: `vitest.e2e.config.ts` (root level)

**Writing E2E tests**:

```typescript
import { createTestSession } from './helpers';

describe('Feature X', () => {
  let session: TestSession;

  beforeEach(async () => {
    session = await createTestSession(); // Gets unique session
  });

  it('should do something', async () => {
    const result = await session.sandbox.exec('echo hello');
    expect(result.stdout).toBe('hello\n');
  });
});
```

## When to Use Which

| Scenario                                | Test Type |
| --------------------------------------- | --------- |
| Client method logic                     | Unit      |
| Service business logic                  | Unit      |
| Request/response handling               | Unit      |
| Full command execution flow             | E2E       |
| File operations with real filesystem    | E2E       |
| Process lifecycle (start, stop, signal) | E2E       |
| Port exposure and preview URLs          | E2E       |
| Git operations                          | E2E       |

## Test-Specific Conventions

**File naming**: `*.test.ts` for both unit and E2E tests

**Test structure**:

```typescript
describe('ComponentName', () => {
  describe('methodName', () => {
    it('should do X when Y', async () => {
      // Arrange
      // Act
      // Assert
    });
  });
});
```

**Assertions**: Use vitest's `expect()` with clear, specific assertions

## Running Tests During Development

After making any meaningful code change:

1. `npm run check` — catch type errors first. If this fails, fix type errors before proceeding.
2. `npm test` — verify unit tests pass. If a test hangs (known vitest-pool-workers issue), the results are still valid; check pass/fail output above the hang.
3. `npm run test:e2e` — if touching core functionality. If E2E tests fail with connection errors, verify Docker is running and the container image is built (`npm run docker:rebuild` from repo root).

The monorepo build system handles dependencies automatically. E2E tests always run against latest built code.
