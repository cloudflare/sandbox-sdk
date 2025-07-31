# SDK Contributor Guide

This guide provides everything you need to **contribute to the Cloudflare Sandbox SDK codebase**. This is for developers working on the SDK implementation, not for SDK users.

## Getting Started

### Prerequisites
- Node.js 18+ with npm
- Docker Desktop (for container testing)
- Git

### Setup for SDK Development
```bash
# Clone and install dependencies for SDK development
git clone <repository>
cd sandbox-sdk
npm install

# Build the SDK for development
npm run build

# Run SDK tests to verify setup
npm run test:unit
```

## SDK Project Structure

```
sandbox-sdk/
├── packages/sandbox/           # Main SDK package
│   ├── src/                   # Client SDK source (our implementation)
│   │   ├── clients/           # Our domain clients (command, file, etc.)
│   │   ├── types.ts          # Our public API types
│   │   ├── sandbox.ts        # Our Durable Object implementation
│   │   └── __tests__/        # Our test suites
│   └── container_src/         # Our container runtime source
│       ├── services/          # Our business logic services
│       ├── handlers/          # Our HTTP endpoint handlers
│       ├── middleware/        # Our request processing middleware
│       └── core/             # Our router, types, utilities
├── examples/                  # SDK usage examples
└── docs/                     # SDK contributor documentation
```

## SDK Development Workflow

### 1. Making Changes to the SDK

#### Client SDK Changes (`src/`)
```bash
# Run unit tests during SDK development
npm run test:unit:watch

# Test specific SDK client
npm run test:unit -- --run src/__tests__/unit/clients/command-client.test.ts
```

#### Container Changes (`container_src/`)
```bash
# Test SDK container services  
npm run test:container

# Test specific SDK service
npm run test:container -- --run src/__tests__/container/services/process-service.test.ts
```

### 2. SDK Testing Strategy
```bash
# SDK Development: Fast feedback
npm run test:unit

# SDK Pre-commit: Full validation  
npm test

# SDK Coverage analysis
npm run test:coverage
```

### 3. SDK Build & Quality Checks
```bash
# SDK TypeScript checking
npm run typecheck

# SDK Linting
npm run check

# SDK Build for distribution
npm run build
```

## Adding New Features to the SDK

### 1. Adding a Client Method to the SDK

**Example**: Add file copying to our FileClient implementation

```typescript
// 1. Add to client interface (src/clients/types.ts)
export interface IFileClient {
  copy(sourcePath: string, targetPath: string): Promise<void>;
}

// 2. Implement in client (src/clients/file-client.ts) 
async copy(sourcePath: string, targetPath: string): Promise<void> {
  await this.request('/api/files/copy', {
    method: 'POST',
    body: JSON.stringify({ sourcePath, targetPath })
  });
}

// 3. Add container endpoint (container_src/handlers/file-handler.ts)
private async handleCopy(request: Request): Promise<Response> {
  const { sourcePath, targetPath } = await request.json();
  const result = await this.fileService.copyFile(sourcePath, targetPath);
  return this.respondWithServiceResult(result);
}

// 4. Implement service method (container_src/services/file-service.ts)
async copyFile(source: string, target: string): Promise<ServiceResult<void>> {
  try {
    // Validate paths
    const sourceValidation = this.security.validatePath(source);
    if (!sourceValidation.isValid) {
      return this.createErrorResult('INVALID_SOURCE_PATH', sourceValidation.errors);
    }

    // Use Bun APIs for file operations
    const sourceFile = Bun.file(source);
    if (!(await sourceFile.exists())) {
      return this.createErrorResult('SOURCE_NOT_FOUND', [`File not found: ${source}`]);
    }

    await Bun.write(target, sourceFile);
    this.logger.info('File copied successfully', { source, target });

    return { success: true };
  } catch (error) {
    return this.handleServiceError(error, 'FILE_COPY_ERROR', { source, target });
  }
}

// 5. Write tests (src/__tests__/unit/clients/file-client.test.ts)
it('should copy file successfully', async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ success: true })
  });

  await client.copy('/source.txt', '/target.txt');

  expect(mockFetch).toHaveBeenCalledWith(
    'http://test.com/api/files/copy',
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        sourcePath: '/source.txt',
        targetPath: '/target.txt'
      })
    })
  );
});
```

### 2. Adding a New Service

**Example**: Add NetworkService for network operations

```typescript
// 1. Define interfaces (container_src/services/network-service.ts)
export interface NetworkService {
  ping(host: string): Promise<ServiceResult<PingResult>>;
  httpCheck(url: string): Promise<ServiceResult<HttpCheckResult>>;
}

// 2. Implement service
export class NetworkService implements NetworkService {
  constructor(
    private security: SecurityService,
    private logger: Logger
  ) {}

  async ping(host: string): Promise<ServiceResult<PingResult>> {
    try {
      // Validate host
      const hostValidation = this.security.validateHost(host);
      if (!hostValidation.isValid) {
        return {
          success: false,
          error: {
            message: 'Invalid host',
            code: 'INVALID_HOST',
            details: { host, errors: hostValidation.errors }
          }
        };
      }

      // Execute ping using Bun.spawn
      const proc = Bun.spawn(['ping', '-c', '4', host], {
        stdout: 'pipe',
        stderr: 'pipe'
      });

      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text()
      ]);

      await proc.exited;
      const exitCode = proc.exitCode || 0;

      const result: PingResult = {
        host,
        success: exitCode === 0,
        output: stdout,
        error: stderr
      };

      this.logger.info('Ping completed', { host, success: result.success });

      return {
        success: true,
        data: result
      };
    } catch (error) {
      return this.handleServiceError(error, 'PING_ERROR', { host });
    }
  }
}

// 3. Add handler (container_src/handlers/network-handler.ts)
export class NetworkHandler extends BaseHandler {
  constructor(private networkService: NetworkService) {
    super();
  }

  async handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pathSegments = url.pathname.split('/').filter(Boolean);

    if (pathSegments[2] === 'ping' && request.method === 'POST') {
      return this.handlePing(request);
    }

    return this.createNotFoundResponse();
  }

  private async handlePing(request: Request): Promise<Response> {
    const { host } = await request.json();
    const result = await this.networkService.ping(host);
    return this.respondWithServiceResult(result);
  }
}

// 4. Register in container (container_src/core/container.ts)
const networkService = new NetworkService(securityService, logger);
const networkHandler = new NetworkHandler(networkService);
router.all('/api/network/*', networkHandler.handleRequest.bind(networkHandler));

// 5. Add client (src/clients/network-client.ts)
export class NetworkClient extends BaseHttpClient implements INetworkClient {
  async ping(host: string): Promise<PingResult> {
    return this.request<PingResult>('/api/network/ping', {
      method: 'POST',
      body: JSON.stringify({ host })
    });
  }
}

// 6. Write comprehensive tests
// Unit tests: src/__tests__/unit/clients/network-client.test.ts
// Service tests: src/__tests__/container/services/network-service.test.ts
// Integration tests: src/__tests__/integration/network-integration.test.ts
```

## Code Patterns & Conventions

### 1. Container Service Layer Patterns

#### ServiceResult Pattern (Container Layer Only)
Container services (`container_src/`) always return `ServiceResult<T>` for consistent error handling:

```typescript
// Success case
return {
  success: true,
  data: result
};

// Error case  
return {
  success: false,
  error: {
    message: 'Operation failed',
    code: 'ERROR_CODE',
    details: { context: 'information' }
  }
};
```

#### Error Handling Template
```typescript
async serviceMethod(param: string): Promise<ServiceResult<ResultType>> {
  try {
    // Input validation
    const validation = this.security.validateInput(param);
    if (!validation.isValid) {
      return this.createValidationError('INVALID_INPUT', validation.errors);
    }

    // Business logic
    const result = await this.performOperation(param);
    
    // Logging
    this.logger.info('Operation completed', { param, result });

    return {
      success: true,
      data: result
    };
  } catch (error) {
    return this.handleServiceError(error, 'OPERATION_ERROR', { param });
  }
}
```

### 2. Client SDK Layer Patterns

#### Domain Client Structure (Client Layer)
Client SDK (`src/clients/`) uses direct response interfaces:
```typescript
export class DomainClient extends BaseHttpClient implements IDomainClient {
  async operation(param: string): Promise<OperationResponse> {
    return this.request<OperationResponse>('/api/domain/operation', {
      method: 'POST', 
      body: JSON.stringify({ param })
    });
  }
}

// Direct response interface (not ServiceResult)
interface OperationResponse {
  success: boolean;
  data: string;
  timestamp: string;
}
```

#### Error Mapping (Client Layer)
Our client SDK maps container errors to specific client error types:

```typescript
// Define custom errors (src/errors.ts)
export class CustomOperationError extends SandboxError {
  constructor(message: string, public readonly details?: any) {
    super(message, 'CUSTOM_OPERATION_ERROR');
  }
}

// Register mapping (src/clients/base-client.ts)
const errorMappings = {
  'CUSTOM_OPERATION_ERROR': CustomOperationError,
  // ...
};
```

### 3. Testing Patterns

#### Service Testing
```typescript
describe('ServiceName', () => {
  let service: ServiceName;
  let mockDependency: MockedDependency;

  beforeEach(async () => {
    vi.clearAllMocks();
    
    // Set up mocks
    mockDependency = {
      method: vi.fn()
    };

    // Dynamic import to avoid module issues
    const { ServiceName: ServiceClass } = await import('@container/services/service-name');
    service = new ServiceClass(mockDependency, mockLogger);
  });

  it('should handle success case', async () => {
    mockDependency.method.mockResolvedValue(expectedValue);

    const result = await service.serviceMethod('param');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(expectedResult);
    }
  });

  it('should handle error case', async () => {
    mockDependency.method.mockRejectedValue(new Error('Mock error'));

    const result = await service.serviceMethod('param');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('ERROR_CODE');
    }
  });
});
```

#### Client Testing
```typescript
describe('ClientName', () => {
  let client: ClientName;
  let mockFetch: Mock;

  beforeEach(() => {
    mockFetch = vi.fn();
    client = new ClientName({
      baseUrl: 'http://test.com',
      fetch: mockFetch
    });
  });

  it('should make correct API call', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: 'data' })
    });

    const result = await client.method('param');

    expect(mockFetch).toHaveBeenCalledWith(
      'http://test.com/api/endpoint',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json'
        }),
        body: JSON.stringify({ param })
      })
    );
    expect(result).toEqual({ result: 'data' });
  });
});
```

## Security Guidelines

### 1. Input Validation
Always validate inputs using the SecurityService:

```typescript
// Path validation
const pathValidation = this.security.validatePath(userPath);
if (!pathValidation.isValid) {
  return this.createValidationError('INVALID_PATH', pathValidation.errors);
}

// Port validation  
const portValidation = this.security.validatePort(userPort);
if (!portValidation.isValid) {
  return this.createValidationError('INVALID_PORT', portValidation.errors);
}
```

### 2. Command Sanitization
```typescript
// Never execute user input directly
const sanitizedCommand = this.security.sanitizeCommand(userCommand);

// Use allowlists for known-good commands
const allowedCommands = ['npm', 'node', 'python3', 'git'];
if (!allowedCommands.includes(commandName)) {
  return this.createValidationError('COMMAND_NOT_ALLOWED');
}
```

### 3. Path Security
```typescript
// Always use absolute paths within sandbox
const absolutePath = path.resolve(sandboxRoot, userPath);

// Prevent path traversal
if (!absolutePath.startsWith(sandboxRoot)) {
  return this.createValidationError('PATH_TRAVERSAL_ATTEMPT');
}
```

## Performance Guidelines

### 1. Stream Processing
Use streaming for large operations:

```typescript
// Service method for streaming
async streamLogs(processId: string): Promise<ServiceResult<ReadableStream>> {
  const process = await this.store.get(processId);
  if (!process?.subprocess?.stdout) {
    return this.createErrorResult('NO_STDOUT');
  }

  return {
    success: true,
    data: process.subprocess.stdout // Return Bun's native stream
  };
}

// Client method for streaming
async *streamLogs(processId: string): AsyncIterable<LogChunk> {
  const response = await this.request(`/api/process/${processId}/logs`, {
    method: 'GET',
    headers: { 'Accept': 'text/event-stream' }
  });

  if (!response.body) return;
  
  const parser = new SSEParser(response.body);
  for await (const event of parser) {
    yield JSON.parse(event.data) as LogChunk;
  }
}
```

### 2. Resource Management
Implement proper cleanup:

```typescript
class ServiceWithResources {
  private cleanupInterval: Timer | null = null;

  constructor() {
    this.startCleanupProcess();
  }

  private startCleanupProcess(): void {
    this.cleanupInterval = setInterval(async () => {
      await this.cleanup();
    }, 30 * 60 * 1000); // 30 minutes
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}
```

## Debugging & Troubleshooting

### 1. Debug Environment Setup
```bash
# Enable debug logging
export DEBUG=sandbox:*

# Run tests with verbose output  
npm run test:container -- --reporter=verbose

# Run specific test with debug
npm run test:container -- --run path/to/test.ts --reporter=verbose
```

### 2. Common Issues

#### Container Communication
```typescript
// Check if container is ready
await waitForContainerReady(instance);

// Verify port is available
const port = instance.ctx.container.getTcpPort(3000);
if (!port) {
  throw new Error('Container port not available');
}
```

#### Stream Issues
```typescript
// Always create fresh streams for testing
mockSpawn.mockImplementation(() => ({
  stdout: new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('output'));
      controller.close();
    }
  })
}));
```

### 3. Logging Patterns
```typescript
// Service logging
this.logger.info('Operation started', { param, context });
this.logger.error('Operation failed', error, { param, context });

// Client logging (development only)
if (process.env.NODE_ENV !== 'production') {
  console.log('Client request:', { method, url, body });
}
```

## Best Practices

### 1. Type Safety
- Use TypeScript strictly (`strict: true`)
- Define interfaces for all service contracts
- Use generic types for reusable patterns (`ServiceResult<T>`)

### 2. Error Handling
- Always return structured errors with codes
- Include context information in error details
- Map container errors to appropriate client errors

### 3. Testing
- Write tests for all new functionality
- Use the appropriate test tier (unit/integration/container/e2e)
- Mock external dependencies and native APIs

### 4. Documentation
- Update API documentation for new endpoints
- Include usage examples in docstrings
- Update this guide when adding new patterns

This guide should provide everything needed to work effectively with the Sandbox SDK codebase. For specific implementation details, refer to the existing code examples and test suites.