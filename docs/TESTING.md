# SDK Testing Guide

This guide explains how to test changes and contributions to the Cloudflare Sandbox SDK codebase. This is for **SDK contributors** making changes to the SDK implementation, not for SDK users writing tests for their applications.

## Quick Start for SDK Contributors

```bash
# Run all SDK tests
npm test

# Run specific SDK test suites
npm run test:unit        # SDK unit tests (Node.js environment)
npm run test:container   # SDK container service tests (Node.js with mocks)
npm run test:contracts   # SDK contract validation tests

# SDK development testing
npm run test:coverage    # Generate SDK test coverage report
npm run test:watch       # Watch mode for SDK development
```

## SDK Test Architecture

**Comprehensive mocked testing across 3 tiers for validating SDK changes:**

> **Note**: We use mocked testing because `vitest` + `@cloudflare/vitest-pool-workers` are not yet ready to work with containers and have significant compatibility issues. We cannot currently test in the actual Workers + Containers environment that production uses. The Containers team is working on resolving this, but we've implemented thorough contract validation and service logic testing to ensure comprehensive coverage in the meantime.

### 1. Unit Tests
**Environment**: Node.js  
**Location**: `src/__tests__/unit/`  
**Purpose**: Fast feedback on isolated SDK functionality

Tests individual SDK components without external dependencies:
- HTTP clients and session management
- Security validation and input sanitization  
- Error mapping from container responses to client exceptions
- Cross-client behavior consistency
- Request/response serialization

### 2. Contract Tests  
**Environment**: Node.js
**Location**: `src/__tests__/contracts/`  
**Purpose**: Validate HTTP API contracts and cross-cutting concerns

Tests API consistency and client behavior:
- HTTP API contract validation with type-safe validation
- Cross-cutting concerns (timestamps, error formats, session handling)
- Client uniformity across all SDK clients
- Response structure validation using discriminated unions

### 3. Container Tests
**Environment**: Node.js (mocked container services)
**Location**: `src/__tests__/container/`  
**Requirements**: None (no Docker needed)
**Purpose**: Test service layer business logic with intelligent mocking

Tests individual services in isolation:
- **GitService**: Repository operations, security validation
- **PortService**: Port management, HTTP proxying  
- **ProcessService**: Command execution, background processes
- **FileService**: File operations, path validation
- **SessionService**: Session management, context isolation

## Service Testing Patterns

### Container Service Testing (ServiceResult Pattern)
Container services (`container_src/`) return `ServiceResult<T>` for consistent error handling:

```typescript
describe('ProcessService', () => {
  it('should return success for valid command', async () => {
    const result = await processService.executeCommand('echo test');
    
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.stdout).toContain('test');
    }
  });

  it('should return error for invalid command', async () => {
    const result = await processService.executeCommand('nonexistent-cmd');
    
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('COMMAND_EXEC_ERROR');
    }
  });
});
```

### Client SDK Testing (Response Interface Pattern)
Client SDK (`src/clients/`) uses direct response interfaces with error throwing:

```typescript
describe('CommandClient', () => {
  it('should return typed response for valid command', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        stdout: 'test output',
        stderr: '',
        exitCode: 0
      })
    });

    const result = await client.execute('echo test');
    
    expect(result.success).toBe(true);
    expect(result.stdout).toBe('test output');
  });

  it('should throw custom error for container errors', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({
        error: 'Command not found: invalidcmd',
        code: 'COMMAND_NOT_FOUND'
      })
    });

    await expect(client.execute('invalidcmd'))
      .rejects.toThrow(CommandNotFoundError);
  });
});
```

### Container Service Dependency Injection
Container services accept dependencies via constructor for easy testing:

```typescript
const mockProcessStore: ProcessStore = {
  create: vi.fn(),
  get: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  list: vi.fn(),
};

const processService = new ProcessService(mockProcessStore, mockLogger);
```

### ReadableStream Handling
For Bun API integration, create fresh streams per mock call:

```typescript
mockBunSpawn.mockImplementation(() => ({
  exited: Promise.resolve(),
  exitCode: 0,
  stdout: new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('output'));
      controller.close();
    }
  })
}));
```

### Test Isolation
Prevent interference between tests:

```typescript
beforeEach(() => {
  vi.clearAllMocks();
  originalFetch = global.fetch;
  global.fetch = mockFetch;
});

afterEach(() => {
  global.fetch = originalFetch;
});
```

## Container Test Setup

### Requirements
- Node.js (no Docker needed)
- Vitest for test execution

### Service Test Environment
Each service test file follows this pattern:

```typescript
describe('GitService', () => {
  let gitService: GitService;

  beforeEach(async () => {
    vi.clearAllMocks();
    
    // Set up Bun.spawn mock for git commands
    global.Bun = {
      spawn: vi.fn().mockImplementation((args) => ({
        exited: Promise.resolve(),
        exitCode: 0,
        stdout: new ReadableStream({...}),
        stderr: new ReadableStream({...})
      }))
    } as any;
    
    // Dynamic import to avoid module loading issues
    const { GitService: GitServiceClass } = await import('@container/services/git-service');
    gitService = new GitServiceClass(mockSecurityService, mockLogger);
  });
});
```

## Framework & Tools

- **Primary Framework**: Vitest 3.2.4 (modern TypeScript testing)
- **Environment**: Node.js (due to vitest + Workers + Containers compatibility issues)
- **Coverage**: `@vitest/coverage-v8` (comprehensive reporting)
- **Mocking**: Vitest built-in mocking with `vi.fn()`

## Testing Commands Reference

| Command | Purpose | Environment |
|---------|---------|-------------|
| `npm test` | Run all test suites | Node.js |
| `npm run test:unit` | Fast unit tests only | Node.js |
| `npm run test:contracts` | Contract validation tests | Node.js |
| `npm run test:container` | Service layer tests (mocked) | Node.js |
| `npm run test:coverage` | Generate coverage report | Node.js |

## Coverage Requirements

- **Line Coverage**: 90%+
- **Branch Coverage**: 85%+  
- **Function Coverage**: 85%+
- **Critical Paths**: 100% (security, error handling)

## Troubleshooting

### Container Tests
1. **ReadableStream locked**: Use fresh streams per mock call
2. **Global mock interference**: Use proper beforeEach/afterEach cleanup
3. **Service dependency issues**: Use dynamic imports for services

### Service Tests  
1. **ReadableStream locked**: Use fresh streams per mock call
2. **Global mock interference**: Implement proper beforeEach/afterEach cleanup
3. **Async timing issues**: Use `await` for all async operations

### Performance Notes
- **Unit tests**: ~2-5 seconds (development workflow)
- **Contract tests**: ~2-5 seconds (API validation)
- **Container tests**: ~5-10 seconds (mocked service validation)

Run unit tests during development, full suite before commits.