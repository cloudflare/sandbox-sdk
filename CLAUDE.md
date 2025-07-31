# CLAUDE.md

This file provides guidance to Claude Code and other AI agents when working with the Cloudflare Sandbox SDK codebase.

## Project Overview

The Cloudflare Sandbox SDK is a TypeScript SDK providing isolated code execution environments on Cloudflare's edge network using Durable Objects and Containers. The SDK implements a 3-layer architecture with distinct patterns for each layer.

## Development Commands

### Essential Commands
```bash
# Setup and build
npm install && npm run build

# Testing (run frequently during development)
npm run test:unit           # Fast unit tests (Node.js)
npm run test:container      # Container service tests (Docker required)
npm test                    # Full test suite

# Quality checks
npm run typecheck          # TypeScript validation
npm run check             # Biome linting

# No Docker needed - all tests are mocked
```

### Package-Specific Commands
```bash
npm run build -w @cloudflare/sandbox      # Build only sandbox package
npm run docker:local -w @cloudflare/sandbox # Build local Docker image
```

## Architecture - Updated 2024

### 3-Layer Architecture
```
Client SDK → Durable Object → Container Runtime
(src/)      (sandbox.ts)     (container_src/)
```

### Layer 1: Client SDK (`src/clients/`)
**Pattern**: Direct response interfaces with error throwing
**Key Files**:
- `clients/base-client.ts` - Base HTTP client with error mapping
- `clients/command-client.ts` - Command execution
- `clients/file-client.ts` - File operations
- `clients/process-client.ts` - Process management  
- `clients/port-client.ts` - Port exposure
- `clients/git-client.ts` - Git operations
- `utils/error-mapping.ts` - Container error → client error mapping

**Response Pattern**:
```typescript
// Direct response interfaces (NOT ServiceResult)
interface ExecuteResponse {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

// Throws custom errors on failure
throw new CommandNotFoundError("Command not found");
```

### Layer 2: Durable Object (`src/sandbox.ts`)
**Purpose**: Persistent sandbox instances with state management
**Key Features**:
- Extends Cloudflare Container for isolated execution
- Routes requests between client and container
- Manages preview URL generation
- Handles security and authentication

### Layer 3: Container Runtime (`container_src/`)
**Pattern**: ServiceResult<T> for all business logic
**Architecture**:
- **Services** (`services/`) - Business logic with ServiceResult pattern
- **Handlers** (`handlers/`) - HTTP endpoint implementations
- **Middleware** (`middleware/`) - CORS, logging, validation
- **Core** (`core/`) - Router, types, container setup

**ServiceResult Pattern**:
```typescript
interface ServiceResult<T> {
  success: true;
  data: T;
} | {
  success: false;
  error: {
    message: string;
    code: string;
    details?: Record<string, any>;
  };
}
```

**Key Services**:
- `ProcessService` - Command execution and background processes
- `FileService` - File system operations with security validation
- `PortService` - Service exposure and HTTP proxying
- `GitService` - Repository operations
- `SessionService` - Session and environment management

## Testing Architecture - Current

### 3-Tier Testing Strategy (103 service tests + integration/e2e)

1. **Unit Tests** (`src/__tests__/unit/`)
   - Client SDK testing with mocked HTTP
   - Security validation and utilities
   - Fast feedback during development

2. **Container Tests** (`src/__tests__/container/`)
   - Service layer testing with ServiceResult validation (Node.js with mocks)
   - Handler testing with proper mocking (no Docker needed)
   - **Current focus**: 103 service tests (mocked services)

3. **Container Integration Tests** (`src/__tests__/container-integration/`)
   - End-to-end workflow validation across multiple services
   - Complete request flows: validation → middleware → handler → response
   - Cross-service integration testing (Git + File + Process workflows)

### Testing Patterns by Layer

#### Client SDK Testing
```typescript
describe('CommandClient', () => {
  let client: CommandClient;
  let mockFetch: Mock;

  beforeEach(() => {
    mockFetch = vi.fn();
    client = new CommandClient({ baseUrl: 'http://test.com', fetch: mockFetch });
  });

  it('should return typed response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, stdout: 'output' })
    });

    const result = await client.execute('echo test');
    expect(result.stdout).toBe('output');
  });
});
```

#### Container Service Testing
```typescript
describe('ProcessService', () => {
  let service: ProcessService;

  beforeEach(async () => {
    // Smart mocking for Bun APIs
    global.Bun = {
      spawn: vi.fn().mockImplementation(() => ({
        exited: Promise.resolve(),
        exitCode: 0,
        stdout: new ReadableStream({...})
      }))
    } as any;

    const { ProcessService: ServiceClass } = await import('@container/services/process-service');
    service = new ServiceClass(mockStore, mockLogger);
  });

  it('should return ServiceResult for valid operation', async () => {
    const result = await service.executeCommand('echo test');
    
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.stdout).toContain('test');
    }
  });
});
```

## Key Implementation Patterns

### Error Handling by Layer

#### Client SDK Layer
- Uses custom error classes (`CommandNotFoundError`, `FileNotFoundError`, etc.)
- Errors thrown via `mapContainerError()` function
- Direct Promise rejection, not ServiceResult

#### Container Layer
- All services return `ServiceResult<T>`
- Structured error objects with codes and details
- Never throws, always returns result object

### Security Model
- **Input Validation**: SecurityService validates all inputs in container layer
- **Path Security**: Prevents traversal attacks with path validation
- **Command Security**: Allowlists and sanitization for command execution
- **Port Security**: Reserved port protection and validation

### Streaming Operations
- **Client Side**: AsyncIterable interface for streaming
- **Container Side**: ReadableStream with proper lifecycle management
- **SSE Support**: Server-Sent Events for real-time operations

## Documentation Resources

### For Contributors
- `docs/ARCHITECTURE.md` - Detailed architecture guide
- `docs/DEVELOPER_GUIDE.md` - Step-by-step development workflows  
- `docs/TESTING.md` - Comprehensive testing strategy
- `CONTRIBUTING.md` - Contribution process and standards

### For AI Agents Working on This Codebase

#### Critical Pattern Recognition
1. **Always check which layer you're working in**:
   - `src/clients/` → Use direct response interfaces, throw errors
   - `container_src/services/` → Use ServiceResult<T> pattern

2. **Testing approach depends on layer**:
   - Client tests → Mock HTTP, test response interfaces
   - Container tests → Mock dependencies, test ServiceResult

3. **Error handling differs by layer**:
   - Client → Throws custom error classes
   - Container → Returns ServiceResult with error object

#### Common Development Tasks

**Adding Client Method**:
1. Define in `src/clients/types.ts` interface
2. Implement in respective client class
3. Return direct response interface (not ServiceResult)
4. Write unit tests with HTTP mocking

**Adding Container Service Method**:
1. Add to service class in `container_src/services/`
2. Always return `Promise<ServiceResult<T>>`
3. Handle errors with ServiceResult error pattern
4. Write service tests with dependency mocking

**Adding Container Handler**:
1. Extend BaseHandler in `container_src/handlers/`
2. Call service methods and use `respondWithServiceResult()`
3. Register route in `container_src/core/container.ts`

### MCP Documentation Integration

When working with external APIs or frameworks:

#### Cloudflare APIs
```typescript
// Use MCP for current Cloudflare documentation
const docs = await mcp__cloudflare__search_cloudflare_documentation({
  query: "Durable Objects testing patterns"
});
```

#### Library Documentation  
```typescript
// For up-to-date library docs
const libraryId = await mcp__context7__resolve_library_id({ 
  libraryName: "vitest" 
});
const docs = await mcp__context7__get_library_docs({
  context7CompatibleLibraryID: libraryId,
  topic: "mocking patterns",
  tokens: 5000
});
```

This ensures you're always working with current APIs and patterns rather than outdated information.

## Debugging Common Issues

### Container Test Issues (Mocked Services)
- **ReadableStream locked errors**: Create fresh streams per mock call
- **Global mock interference**: Use proper beforeEach/afterEach cleanup
- **Service dependency issues**: Use dynamic imports for services
- **No Docker needed**: Container tests are pure Node.js mocks

### Client Test Issues  
- **HTTP mocking**: Use vi.fn() for fetch mocking, not ServiceResult patterns
- **Error testing**: Test for thrown errors, not ServiceResult.error

### Architecture Confusion
- **Wrong pattern usage**: Check layer (src/ vs container_src/) before implementing
- **Mixed error handling**: Don't mix ServiceResult and thrown errors in same layer

Remember: This SDK has two distinct architectural patterns - use the right one for the layer you're working in!