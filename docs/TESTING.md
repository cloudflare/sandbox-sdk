# SDK Testing Guide

This guide explains how to test changes and contributions to the Cloudflare Sandbox SDK codebase. This is for **SDK contributors** making changes to the SDK implementation, not for SDK users writing tests for their applications.

## Quick Start for SDK Contributors

```bash
# Run all SDK tests
npm test

# Run specific SDK test suites
npm run test:unit        # SDK unit tests (Node.js environment)
npm run test:integration # SDK client-container integration (Workers runtime) 
npm run test:container   # SDK container service tests (requires Docker)
npm run test:e2e         # SDK end-to-end workflows

# SDK development testing
npm run test:coverage    # Generate SDK test coverage report
npm run test:watch       # Watch mode for SDK development
```

## SDK Test Architecture

**103 service tests + integration/e2e tests across 4 tiers for validating SDK changes:**

### 1. Unit Tests
**Environment**: Node.js  
**Location**: `src/__tests__/unit/`  
**Purpose**: Fast feedback on isolated SDK functionality

Tests individual SDK components without external dependencies:
- HTTP clients and session management
- Security validation and input sanitization  
- SSE parsing and request routing utilities
- Error classes and type guards

### 2. Integration Tests  
**Environment**: Cloudflare Workers runtime  
**Location**: `src/__tests__/integration/`  
**Purpose**: Validate Durable Object integration

Tests client-container communication:
- Sandbox class integration with HttpClient
- Error propagation from container to client
- Session management across operations
- Workers runtime compatibility

### 3. Container Tests
**Environment**: Cloudflare Workers with real containers  
**Location**: `src/__tests__/container/`  
**Requirements**: Docker running  
**Purpose**: Test service layer with proper mocking

Tests individual services in isolation:
- **GitService** (21 tests): Repository operations, security validation
- **PortService** (27 tests): Port management, HTTP proxying  
- **ProcessService** (8 tests): Command execution, background processes
- **FileService** (28 tests): File operations, path validation
- **SessionService** (19 tests): Session management, context isolation

### 4. End-to-End Tests
**Environment**: Full sandbox workflows  
**Location**: `src/__tests__/e2e/`  
**Purpose**: Complete development scenarios

Tests real-world usage patterns:
- Application deployment and port exposure
- Git workflows with dependency installation
- Streaming operations and error recovery

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
- Docker installed and running
- `@cloudflare/vitest-pool-workers` for Workers runtime

### Configuration
Container tests use Vitest with Workers pool:

```typescript
// vitest.container.config.ts
export default defineWorkersConfig({
  test: {
    pool: 'workers',
    poolOptions: {
      workers: {
        wrangler: {
          configPath: './wrangler.jsonc'
        }
      }
    }
  }
});
```

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
- **Cloudflare Integration**: `@cloudflare/vitest-pool-workers` (Workers runtime)
- **Coverage**: `@vitest/coverage-v8` (comprehensive reporting)
- **Mocking**: Vitest built-in mocking with `vi.fn()`

## Testing Commands Reference

| Command | Purpose | Environment |
|---------|---------|-------------|
| `npm test` | Run all test suites | Mixed |
| `npm run test:unit` | Fast unit tests only | Node.js |
| `npm run test:integration` | Client-container integration | Workers |
| `npm run test:container` | Service layer tests | Workers + Docker |
| `npm run test:e2e` | End-to-end workflows | Full stack |
| `npm run test:coverage` | Generate coverage report | All |
| `npm run cleanup:containers` | Clean up Docker containers | System |

## Coverage Requirements

- **Line Coverage**: 90%+
- **Branch Coverage**: 85%+  
- **Function Coverage**: 85%+
- **Critical Paths**: 100% (security, error handling)

## Troubleshooting

### Container Tests
1. **Docker not running**: Start Docker Desktop
2. **Port conflicts**: Stop services using port 3000
3. **Build failures**: Run `npm run docker:local` manually

### Service Tests  
1. **ReadableStream locked**: Use fresh streams per mock call
2. **Global mock interference**: Implement proper beforeEach/afterEach cleanup
3. **Async timing issues**: Use `await` for all async operations

### Performance Notes
- **Unit tests**: ~2-5 seconds (development workflow)
- **Container tests**: ~30-60 seconds (full service validation)
- **E2E tests**: ~45-90 seconds (complete workflows)

Run unit tests during development, full suite before commits.