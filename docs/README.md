# Cloudflare Sandbox SDK - Contributor Documentation

Complete documentation for **contributing to the Cloudflare Sandbox SDK codebase**. These docs are for developers working on the SDK implementation, not for SDK users.

## 📖 Documentation Index

### [🏗️ Architecture Guide](./ARCHITECTURE.md)
**For understanding how we built the SDK internally**
- Internal architecture and component relationships
- Implementation details of Client SDK, Durable Object, and Container runtime
- Service layer patterns and internal request flow
- Security implementation and preview URL system internals

### [🧪 Testing Guide](./TESTING.md)  
**For testing changes to the SDK codebase**
- 4-tier testing strategy for SDK development
- Service testing patterns with `ServiceResult<T>`
- Container test setup and troubleshooting SDK changes
- Framework usage and coverage requirements for contributions

### [👨‍💻 Developer Guide](./DEVELOPER_GUIDE.md)
**For making changes to the SDK implementation**
- SDK development workflow and internal project structure
- Code patterns and conventions used in the SDK codebase
- Adding new features to the SDK (clients, services, handlers)
- Security guidelines and performance best practices for SDK development

## 🚀 Quick Start for SDK Contributors

```bash
# Setup development environment
npm install && npm run build

# SDK development workflow
npm run test:unit:watch      # Fast feedback while changing SDK code
npm run test:coverage        # Check test coverage of SDK changes
npm run typecheck           # Verify TypeScript in SDK codebase

# Testing SDK changes
npm test                    # Run all SDK tests
npm run test:container      # Test SDK service layer
```

## 🏛️ SDK Internal Architecture

We built this SDK using isolated code execution on Cloudflare's edge with a 3-layer architecture:

```
Client SDK → Durable Object → Container Runtime
```

- **Client SDK**: Our implementation of type-safe domain clients (command, file, process, port, git)
- **Durable Object**: Our persistent sandbox instances with request routing
- **Container Runtime**: Our Bun-based service layer with HTTP API

## 🧪 SDK Testing Strategy

**Comprehensive testing** across 3 tiers for validating SDK changes:

1. **Unit Tests**: Fast isolated component testing for SDK changes
2. **Container Tests**: Service layer testing with proper mocking for SDK
3. **Contract Tests**: HTTP API and streaming format validation

## 📋 Key SDK Implementation Concepts

### Two-Layer Pattern Architecture

#### Container Layer Pattern (`container_src/`)
Our container services use the `ServiceResult<T>` pattern:
```typescript
ServiceResult<T> = {
  success: true;
  data: T;
} | {
  success: false;
  error: { message: string; code: string; details?: any };
}
```

#### Client SDK Layer Pattern (`src/clients/`)
Our client SDK uses direct response interfaces with error throwing:
```typescript
// Direct typed responses
interface ExecuteResponse {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

// Throws custom errors on failure
throw new CommandNotFoundError("Command not found");
```

### Domain Clients (SDK Implementation)
How we implemented focused APIs for specific capabilities:
```typescript
await sandbox.command.execute('npm install');
await sandbox.file.write('/app/config.json', content);
await sandbox.process.start('npm run dev');
await sandbox.port.expose(3000, 'web-server');
await sandbox.git.clone('https://github.com/user/repo.git');
```

### Container Services (Internal Implementation)
Our business logic services with dependency injection:
- **ProcessService**: Command execution and background processes
- **FileService**: File system operations with security validation
- **PortService**: Service exposure and HTTP proxying
- **GitService**: Repository operations
- **SessionService**: Session and environment management

## 🛡️ SDK Security Implementation

How we implemented multi-layer security with validation at every boundary:
- Input validation using Zod schemas
- Path traversal prevention
- Command sanitization and allowlisting
- Port validation and reserved port protection
- Git URL validation and allowlisting

## 📦 SDK Development Workflow

1. **SDK Feature Development**: Add client method → container endpoint → service logic
2. **SDK Testing**: Write unit tests → service tests → integration tests  
3. **SDK Quality**: TypeScript checking → linting → coverage validation
4. **SDK Documentation**: Update relevant docs and examples

## 🔧 Common SDK Development Tasks

### Adding New Client Method to the SDK
1. Define in client interface and implement
2. Add container handler endpoint
3. Implement service method with `ServiceResult<T>`
4. Write comprehensive tests

### Adding New Service to the SDK
1. Define service interface and implementation
2. Create handler with request validation
3. Register in container router
4. Add corresponding client methods
5. Write service and integration tests

## 📞 Need Help Contributing?

- Check existing SDK code examples in the test suites
- Review the SDK service implementations for patterns
- See the examples directory for SDK usage patterns
- Consult the specific documentation sections above

Each documentation file is designed to be comprehensive yet focused on its specific area. Together they provide complete coverage for contributing to the Sandbox SDK codebase.