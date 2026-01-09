---
name: testing
description: Use when writing or running tests for this project. Covers unit vs E2E test decisions, test file locations, mock patterns, and project-specific testing conventions. (project)
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
npm run test:e2e                                                    # All E2E tests
npm run test:e2e -- -- tests/e2e/process-lifecycle-workflow.test.ts # Single file
npm run test:e2e -- -- tests/e2e/git-clone-workflow.test.ts -t 'test name'  # Single test
```

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

1. `npm run check` - catch type errors first
2. `npm test` - verify unit tests pass
3. `npm run test:e2e` - if touching core functionality

**Build trust**: The monorepo build system handles dependencies automatically. E2E tests always run against latest built code - no manual rebuild needed.
