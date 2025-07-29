# Testing Guide

This document describes the testing infrastructure for the Cloudflare Sandbox SDK.

## Quick Start

```bash
# Run all tests
npm test

# Run specific test suites
npm run test:unit        # Fast unit tests (node environment)
npm run test:integration # Client-container integration (Workers runtime)
npm run test:container   # Real container testing (requires Docker)
npm run test:e2e         # End-to-end workflows

# Development
npm run test:coverage    # Generate coverage report
npm run test:unit:watch  # Watch mode for unit tests
```

## Test Architecture

The SDK uses a 4-tier testing strategy with **476 comprehensive tests**:

### 1. Unit Tests (273 tests)
**Environment**: Node.js for fast execution  
**Location**: `src/__tests__/unit/`

Tests isolated functionality without external dependencies:
- **Domain Clients**: CommandClient, FileClient, ProcessClient, PortClient, GitClient, UtilityClient
- **BaseHttpClient**: Core HTTP functionality and session management
- **Error System**: Error classes and container-to-client error mapping
- **Security & Utilities**: Input validation, SSE parsing, request routing

### 2. Integration Tests (28 tests)
**Environment**: Cloudflare Workers runtime  
**Location**: `src/__tests__/integration/`

Tests client-container communication and Durable Object integration:
- Client architecture validation against container endpoints
- Session management across domain clients
- Error propagation from container to client layers
- Workers runtime compatibility

### 3. Container Tests (104 tests)
**Environment**: Cloudflare Workers with real containers  
**Location**: `src/__tests__/container/`  
**Requirements**: Docker

Tests actual HTTP endpoints in running containers:
- Container handler validation with structured error responses
- Real container-client communication via `getTcpPort()`
- Complete error mapping validation
- Resource management and cleanup

### 4. End-to-End Tests (18 tests)
**Environment**: Full sandbox workflows  
**Location**: `src/__tests__/e2e/`

Tests complete development scenarios:
- Node.js and Python application deployment
- Git repository workflows with dependency installation
- Real-time streaming operations
- Error recovery and system resilience

## Container Testing Setup

### Requirements
- Docker installed and running
- `@cloudflare/vitest-pool-workers` with Build ID fix

### Configuration
Container tests use dynamic build IDs generated per test run:

```typescript
// vitest.container.config.ts
export default defineWorkersConfig({
  test: {
    globalSetup: ['./global-setup.ts'], // Builds containers
    poolOptions: {
      workers: ({ inject }) => ({
        wrangler: {
          configPath: './wrangler.jsonc',
          containerBuildId: inject('containerBuildId'),
        }
      })
    }
  }
});
```

### Build ID Solution
We solved the "Build ID should be set if containers are defined and enabled" error by:
1. **Global Setup**: `global-setup.ts` builds containers with unique IDs
2. **Dynamic IDs**: Generated per test run to avoid conflicts
3. **Docker Integration**: Direct `docker build` commands for reliability

## Key Testing Patterns

### Domain Client Testing
```typescript
describe('CommandClient', () => {
  let client: CommandClient;
  let mockFetch: Mock;

  beforeEach(() => {
    mockFetch = vi.fn();
    client = new CommandClient({ 
      baseUrl: 'http://test.com',
      fetch: mockFetch
    });
  });

  it('should handle command errors', async () => {
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

### Container Communication Testing
```typescript
it('should communicate with real container', async () => {
  const result = await runInDurableObject(stub, async (instance) => {
    await waitForContainerReady(instance);
    
    const port = instance.ctx.container.getTcpPort(3000);
    const response = await port.fetch('http://container/api/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'echo test' })
    });
    
    return await response.json();
  });

  expect(result.success).toBe(true);
  expect(result.stdout.trim()).toBe('test');
});
```

### Error Mapping Testing
```typescript
it('should map container errors to client errors', () => {
  const containerError = {
    error: 'File not found: /missing.txt',
    code: 'FILE_NOT_FOUND',
    operation: 'readFile',
    httpStatus: 404
  };

  const clientError = mapContainerError(containerError);
  
  expect(clientError).toBeInstanceOf(FileNotFoundError);
  expect(clientError.code).toBe('FILE_NOT_FOUND');
});
```

## Framework & Tools

- **Primary Framework**: Vitest 3.2.4 (modern, fast TypeScript testing)
- **Cloudflare Integration**: `@cloudflare/vitest-pool-workers` (Workers runtime support)
- **Coverage**: `@vitest/coverage-v8` (comprehensive coverage reporting)
- **Mocking**: Built-in `fetchMock` from `cloudflare:test`

## CI Integration

### GitHub Actions
Tests run in appropriate environments:
- **Pull Requests**: Unit tests only (fast feedback)
- **Main/Develop**: Full test suite (comprehensive validation)
- **Releases**: Complete validation with coverage reporting

### Environment-Aware Logging
Tests use environment detection to prevent stderr noise in CI:
```typescript
const isTestEnvironment = process.env.NODE_ENV === 'test' || 
                         process.env.VITEST === 'true';
if (!isTestEnvironment) {
  console.log(message); // Only log in non-test environments
}
```

## Coverage Requirements

- **Line Coverage**: 90%+
- **Branch Coverage**: 85%+
- **Function Coverage**: 85%+
- **Critical Areas**: 100% (security validation, error handling)

## Troubleshooting

### Container Tests Failing
1. **Check Docker**: Ensure Docker is running (`docker ps`)
2. **Build Issues**: Check if containers build manually (`npm run docker:local`)
3. **Port Conflicts**: Ensure no services running on port 3000

### Integration Test Issues
1. **Workers Runtime**: Check `@cloudflare/vitest-pool-workers` version
2. **Storage Warnings**: Expected with isolated storage, tests still pass
3. **Build ID Errors**: Ensure dynamic build ID setup is working

### Unit Test Mocking
1. **Mock Isolation**: Use `vi.resetAllMocks()` in `beforeEach`
2. **Fetch Mocking**: Activate `fetchMock` and disable network connections
3. **Type Issues**: Use proper mock typing with `vi.MockedFunction`

## Performance Notes

- **Unit Tests**: ~2-5 seconds (fast feedback loop)
- **Integration Tests**: ~10-15 seconds (Workers runtime startup)
- **Container Tests**: ~30-60 seconds (container building and startup)
- **E2E Tests**: ~45-90 seconds (complete workflows)

Run unit tests during development, full suite before commits.