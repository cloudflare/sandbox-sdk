# SDK Architecture Guide

This guide explains how we built the Cloudflare Sandbox SDK's internal architecture. This is for **SDK contributors** who need to understand the implementation details, not for SDK users.

## Our SDK's Core Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Client SDK    │───▶│  Durable Object │───▶│   Container     │
│    (our impl)   │    │   (Sandbox)     │    │   (our impl)    │  
│ • Domain Clients│    │ • Client Layer  │    │ • Service Layer │
│ • HTTP Layer    │    │ • Request Proxy │    │ • HTTP Server   │
│ • Error Mapping │    │ • Security      │    │ • Native APIs   │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

## SDK Implementation Components

### 1. Client SDK Implementation (`src/clients/`)
**Purpose**: Our type-safe interface implementation for sandbox operations  
**Runtime**: Cloudflare Workers / Node.js

Our domain-specific client implementations provide focused APIs:
- **CommandClient**: Our command execution implementation with streaming
- **FileClient**: Our file system operations implementation
- **ProcessClient**: Our background process management implementation
- **PortClient**: Our service exposure and proxy management implementation
- **GitClient**: Our repository operations implementation
- **UtilityClient**: Our environment and session management implementation

### 2. Durable Object Implementation (`src/sandbox.ts`)
**Purpose**: Our persistent sandbox instances with state management  
**Runtime**: Cloudflare Workers

Our `Sandbox` class implementation:
- Extends Cloudflare Container for isolated execution
- Manages container lifecycle and security
- Handles internal request routing and authentication
- Provides preview URL generation for exposed services

### 3. Container Runtime Implementation (`container_src/`)
**Purpose**: Our isolated execution environment implementation
**Runtime**: Bun in Docker container

Our layered architecture implementation:
- **Service Layer**: Business logic with `ServiceResult<T>` pattern
- **Handler Layer**: HTTP endpoint implementations  
- **Middleware**: CORS, logging, validation, security
- **Router**: Request routing with middleware pipeline

## Our Client Architecture Implementation

### Domain Client Pattern Implementation
How we implemented each domain client to focus on a specific capability:

```typescript
// CommandClient - Command execution
await sandbox.command.execute('npm install');
await sandbox.command.stream('npm run dev');

// FileClient - File operations  
await sandbox.file.write('/app/package.json', content);
const files = await sandbox.file.list('/app');

// ProcessClient - Background processes
const process = await sandbox.process.start('npm run dev');
await sandbox.process.kill(process.id);

// PortClient - Service exposure
await sandbox.port.expose(3000, 'web-server');
const url = await sandbox.port.getPreviewUrl(3000);
```

### Base HTTP Client Implementation
All our domain clients extend `BaseHttpClient`:

```typescript
abstract class BaseHttpClient {
  protected async request<T>(endpoint: string, options?: RequestOptions): Promise<T> {
    // Session management
    // Error handling with custom error types via mapContainerError()
    // Direct typed response interfaces (not ServiceResult)
  }
}
```

**Key Features:**
- Session-based request management
- Automatic error mapping from container responses to custom error classes
- Direct typed response interfaces (e.g., `ExecuteResponse`, `WriteFileResponse`)
- Throws specific error types instead of returning error objects

## Container Architecture

### Container Service Layer Pattern
Our container business logic implemented as injectable services with ServiceResult pattern:

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

### Service Implementations

#### ProcessService
**Purpose**: Command execution and background process management  
**Native APIs**: `Bun.spawn()` for process creation

```typescript
class ProcessService {
  async executeCommand(command: string): Promise<ServiceResult<CommandResult>>
  async startProcess(command: string): Promise<ServiceResult<ProcessRecord>>
  async streamProcessLogs(id: string): Promise<ServiceResult<ReadableStream>>
}
```

#### FileService  
**Purpose**: File system operations with security validation  
**Native APIs**: `Bun.file()`, `Bun.write()`

```typescript
class FileService {
  async readFile(path: string): Promise<ServiceResult<FileContent>>
  async writeFile(path: string, content: string): Promise<ServiceResult<void>>
  async listDirectory(path: string): Promise<ServiceResult<FileInfo[]>>
}
```

#### PortService
**Purpose**: Service exposure and HTTP proxying  
**Features**: Automatic cleanup, status tracking

```typescript
class PortService {
  async exposePort(port: number): Promise<ServiceResult<PortInfo>>
  async proxyRequest(port: number, request: Request): Promise<Response>
  async cleanupInactivePorts(): Promise<ServiceResult<number>>
}
```

#### GitService
**Purpose**: Repository operations with security validation  
**Native APIs**: `Bun.spawn()` for git commands

```typescript
class GitService {
  async cloneRepository(url: string): Promise<ServiceResult<CloneResult>>
  async checkoutBranch(path: string, branch: string): Promise<ServiceResult<void>>
  async listBranches(path: string): Promise<ServiceResult<string[]>>
}
```

### Handler Layer
HTTP endpoints that coordinate service calls:

```typescript
abstract class BaseHandler {
  protected handleRequest(request: Request): Promise<Response> {
    // Request validation
    // Service method invocation  
    // Error handling and response formatting
  }
}
```

**Handler Implementations:**
- **ExecuteHandler**: `/api/execute` - Command execution
- **ProcessHandler**: `/api/process/*` - Process management
- **FileHandler**: `/api/files/*` - File operations
- **PortHandler**: `/api/ports/*` - Port management
- **GitHandler**: `/api/git/*` - Git operations
- **SessionHandler**: `/api/session/*` - Session management

### Container Runtime
Bun-based HTTP server with structured routing:

```typescript
// container_src/index.ts
const server = Bun.serve({
  port: 3000,
  fetch: async (request) => {
    const router = new Router();
    
    // Apply middleware pipeline
    router.use(corsMiddleware);
    router.use(loggingMiddleware);  
    router.use(validationMiddleware);
    
    // Register handlers
    router.post('/api/execute', executeHandler);
    router.all('/api/process/*', processHandler);
    router.all('/api/files/*', fileHandler);
    // ...
    
    return router.handle(request);
  }
});
```

## Security Architecture

### Multi-Layer Security
1. **Input Validation**: Request schema validation using Zod
2. **Path Security**: Sandbox path traversal prevention
3. **Port Validation**: Reserved port protection  
4. **Git URL Validation**: Repository URL allowlisting
5. **Command Sanitization**: Shell injection prevention

### Security Service
Centralized security validation:

```typescript
class SecurityService {
  validatePath(path: string): ValidationResult
  validatePort(port: number): ValidationResult  
  validateGitUrl(url: string): ValidationResult
  sanitizeCommand(command: string): string
}
```

## Request Flow

### Typical Operation Flow
1. **Client Request**: Domain client makes typed request
2. **HTTP Transport**: BaseHttpClient handles session and transport
3. **Durable Object**: Sandbox routes to container endpoint
4. **Container Handler**: Validates request and calls service
5. **Service Logic**: Executes operation using native APIs
6. **Response**: ServiceResult mapped to HTTP response
7. **Client Response**: Error mapping and type-safe result

### Streaming Operations
For real-time operations (command execution, log streaming):

```typescript
// Client-side streaming
for await (const chunk of sandbox.command.stream('npm run dev')) {
  console.log(chunk.data);
}

// Container-side streaming  
return new Response(processOutputStream, {
  headers: { 'Content-Type': 'text/event-stream' }
});
```

## Preview URL System

### URL Structure
```
https://{sandboxId}.{workerDomain}/proxy/{port}/{path}
```

### Routing Logic
1. **Subdomain Extraction**: Parse sandbox ID from hostname
2. **Port Routing**: Extract target port from URL path
3. **Path Forwarding**: Proxy remaining path to container service
4. **Response Streaming**: Return service response with original headers

### Container Integration
```typescript
// Expose service on port 3000
await sandbox.port.expose(3000, 'web-app');

// Get preview URL
const url = await sandbox.port.getPreviewUrl(3000);
// Returns: https://sandbox-123.example.workers.dev/proxy/3000/
```

## Development Patterns

### Error Handling
Consistent error handling across all layers:

```typescript
// Service layer
return {
  success: false,
  error: {
    message: 'File not found',
    code: 'FILE_NOT_FOUND',
    details: { path: '/missing.txt' }
  }
};

// Client layer  
throw new FileNotFoundError('File not found: /missing.txt');
```

### Dependency Injection
Services use constructor injection for testability:

```typescript
class ProcessService {
  constructor(
    private store: ProcessStore,
    private logger: Logger
  ) {}
}
```

### Resource Management
Automatic cleanup with lifecycle management:

```typescript
class PortService {
  constructor() {
    // Start cleanup process every hour
    this.startCleanupProcess();
  }
  
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }
}
```

This architecture provides a robust, secure, and maintainable foundation for isolated code execution on Cloudflare's edge network.