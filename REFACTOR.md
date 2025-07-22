# Example App Refactor: Frontend-Optimized Architecture

## 🎯 Objective

Refactor the `examples/basic/` application to demonstrate the proper architectural pattern for using the Sandbox SDK: **Frontend → Worker → Sandbox SDK → Container**, with frontend-optimized APIs that showcase real-world usage patterns.

## 🚨 Current Problems

### What's Wrong Today
- ❌ **Frontend directly imports internal SDK code**: `import { HttpClient } from "../../../packages/sandbox/src/client"`
- ❌ **Bypasses intended architecture**: Frontend hits container endpoints directly via custom `SandboxApiClient`
- ❌ **Not showcasing SDK value**: Doesn't demonstrate the beautiful new APIs designed in APPROACHES.md and PLAN.md
- ❌ **Poor developer experience**: Not showing how developers should actually use the SDK

### Why This Happened
- Original example was built before the new SDK APIs were implemented
- Frontend needed to test functionality but took shortcuts to internal APIs
- Missing the Worker layer that should orchestrate SDK operations

## 🏗️ Target Architecture

### Proper 3-Layer Pattern
```
┌─────────────────┐    HTTP     ┌─────────────────┐    SDK      ┌─────────────────┐
│   React App     │ ─────────── │     Worker      │ ─────────── │  Sandbox SDK    │
│   (Frontend)    │   fetch()   │  (Orchestrator) │  getSandbox │ (Business Logic)│
│                 │             │                 │             │                 │
│ - UI/UX         │◄────────────│ - Auth/Control  │◄────────────│ - exec()        │
│ - User Input    │    JSON     │ - Business APIs │   Results   │ - startProcess()│
│ - Display       │             │ - Error Handling│             │ - streamLogs()  │
└─────────────────┘             └─────────────────┘             └─────────────────┘
```

### Key Principles
1. **Frontend-Optimized APIs**: Design Worker endpoints for UI needs, not 1:1 SDK mapping
2. **Business Logic in Worker**: Auth, validation, orchestration, error handling
3. **SDK Showcase**: Demonstrate new APIs like `sandbox.exec()`, `startProcess()`, streaming
4. **Real-World Patterns**: Show how to build production applications

## 📋 Implementation Plan

### Phase 1: API Design & Analysis ⏸️ PENDING
- [ ] **Analyze current frontend requirements**
  - [ ] Audit React components to understand data needs
  - [ ] Map current `SandboxApiClient` calls to UI features
  - [ ] Identify opportunities for API consolidation
  - [ ] Document streaming and real-time requirements

- [ ] **Design frontend-optimized APIs**
  - [ ] Command execution endpoint with streaming
  - [ ] Process management endpoints (create, list, status, kill)
  - [ ] Port management with server templates
  - [ ] File operations (read, write, templates)
  - [ ] Real-time streaming endpoints (SSE/WebSocket)

- [ ] **Document API specifications**
  - [ ] Request/response formats
  - [ ] Error handling patterns
  - [ ] Streaming protocol design
  - [ ] Authentication/authorization strategy

### Phase 2: Worker Implementation ⏸️ PENDING
- [ ] **Implement core Worker endpoints**
  - [ ] `POST /api/commands/execute` - Execute commands with streaming
  - [ ] `GET /api/processes` - List active processes with status
  - [ ] `POST /api/processes` - Start background processes
  - [ ] `DELETE /api/processes/:id` - Kill processes
  - [ ] `GET /api/processes/:id/logs` - Get process logs

- [ ] **Implement advanced endpoints**
  - [ ] `POST /api/dev-server/start` - Start dev server with template
  - [ ] `POST /api/ports/expose` - Expose ports with preview URLs
  - [ ] `GET /api/ports` - List exposed ports
  - [ ] `GET /api/files/*` - File operations
  - [ ] `POST /api/files/*` - Write files with templates

- [ ] **Implement streaming endpoints**
  - [ ] `GET /api/stream/command-output` - SSE for command execution
  - [ ] `GET /api/stream/process-logs` - SSE for process logs
  - [ ] `GET /api/stream/system-events` - SSE for system notifications

- [ ] **Add middleware and utilities**
  - [ ] Error handling and formatting
  - [ ] Request validation
  - [ ] Rate limiting
  - [ ] Logging and monitoring
  - [ ] CORS and security headers

### Phase 3: Frontend Refactor ⏸️ PENDING
- [ ] **Remove internal SDK dependencies**
  - [ ] Delete custom `SandboxApiClient` class
  - [ ] Remove direct imports of internal SDK code
  - [ ] Clean up type definitions

- [ ] **Implement new API client**
  - [ ] Simple fetch-based API calls
  - [ ] SSE handling for real-time updates
  - [ ] Error handling and retry logic
  - [ ] TypeScript types for API responses

- [ ] **Update React components**
  - [ ] Commands tab: Use new command execution API
  - [ ] Processes tab: Use new process management APIs
  - [ ] Ports tab: Use new port/server template APIs
  - [ ] Streaming tab: Use new streaming endpoints
  - [ ] Add loading states and error boundaries

- [ ] **Optimize user experience**
  - [ ] Real-time updates via SSE
  - [ ] Better error messages
  - [ ] Loading and progress indicators
  - [ ] Responsive design improvements

### Phase 4: Testing & Documentation ⏸️ PENDING
- [ ] **Integration testing**
  - [ ] Test all API endpoints
  - [ ] Verify streaming functionality
  - [ ] Test error scenarios
  - [ ] Performance testing with multiple operations

- [ ] **User experience testing**
  - [ ] Test all UI workflows
  - [ ] Verify real-time updates
  - [ ] Test responsive design
  - [ ] Accessibility testing

- [ ] **Documentation updates**
  - [ ] Update README with new architecture
  - [ ] Add API documentation
  - [ ] Create developer guide
  - [ ] Document best practices

## 🔌 API Design Specifications

### Command Execution
```typescript
POST /api/commands/execute
{
  command: "npm",
  args: ["test"],
  options: {
    sessionId?: string,
    env?: Record<string, string>,
    cwd?: string,
    stream?: boolean
  }
}

Response: {
  success: boolean,
  exitCode: number,
  stdout: string,
  stderr: string,
  duration: number,
  streamUrl?: string  // SSE endpoint for streaming
}
```

### Process Management
```typescript
POST /api/processes
{
  command: "node",
  args: ["server.js"],
  options: {
    processId?: string,
    sessionId?: string,
    autoCleanup?: boolean
  }
}

GET /api/processes
Response: {
  processes: Array<{
    id: string,
    command: string,
    status: 'starting' | 'running' | 'completed' | 'failed',
    startTime: string,
    exitCode?: number,
    pid?: number
  }>
}
```

### Development Server Template
```typescript
POST /api/dev-server/start
{
  template: "bun" | "node" | "python",
  port: number,
  options?: {
    processId?: string,
    autoExpose?: boolean
  }
}

Response: {
  process: Process,
  preview?: {
    url: string,
    port: number
  },
  logs: {
    streamUrl: string  // SSE endpoint for real-time logs
  }
}
```

### Streaming Endpoints
```typescript
GET /api/stream/command-output?commandId={id}
GET /api/stream/process-logs?processId={id}
GET /api/stream/system-events

SSE Events:
- data: { type: 'stdout', data: string, timestamp: string }
- data: { type: 'stderr', data: string, timestamp: string }
- data: { type: 'complete', exitCode: number, timestamp: string }
- data: { type: 'error', message: string, timestamp: string }
```

## 🎨 SDK Integration Patterns

### Example: Command Execution Endpoint
```typescript
// Worker endpoint showcases new SDK APIs
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.url.endsWith('/api/commands/execute')) {
      const { command, args, options } = await request.json();
      const sandbox = getSandbox(env.Sandbox, getUserId(request));
      
      // Showcase new streaming API with callbacks AND final result
      const result = await sandbox.exec(command, args, {
        stream: options.stream,
        onOutput: options.stream ? (stream, data) => {
          // Stream to frontend via SSE
          streamToClient(stream, data);
        } : undefined,
        sessionId: options.sessionId,
        env: options.env,
        timeout: 30000
      });
      
      return Response.json(result);
    }
  }
}
```

### Example: Process Management
```typescript
// Show background process management
async function startDevServer(request) {
  const sandbox = getSandbox(env.Sandbox, getUserId(request));
  
  // Multiple SDK operations orchestrated in one endpoint
  await sandbox.writeFile('/server.js', getServerTemplate('bun'));
  
  const server = await sandbox.startProcess('bun', ['run', 'server.js'], {
    processId: 'dev-server',
    sessionId: getSessionId(request)
  });
  
  const preview = await sandbox.exposePort(3000, { name: 'dev-server' });
  
  // Set up log streaming for frontend
  const logStream = sandbox.streamProcessLogs(server.id);
  setupSSEStream(logStream, getUserId(request));
  
  return { server, preview, streamUrl: `/api/stream/process-logs?processId=${server.id}` };
}
```

## 🧪 Testing Strategy

### Integration Tests
- [ ] All Worker endpoints respond correctly
- [ ] SDK operations work as expected
- [ ] Streaming endpoints function properly
- [ ] Error handling works correctly

### Frontend Tests
- [ ] All React components render correctly
- [ ] API calls are made properly
- [ ] Real-time updates work
- [ ] Error states display correctly

### End-to-End Tests
- [ ] Complete user workflows work
- [ ] Process lifecycle management
- [ ] Port exposure and preview URLs
- [ ] File operations and templates

## 📝 Progress Notes

### Current Status: Planning Phase
- ✅ Identified architectural problems
- ✅ Designed target architecture
- ✅ Created comprehensive implementation plan
- ⏸️ Ready to begin Phase 1: API Design & Analysis

### Key Decisions Made
1. **Frontend-optimized APIs**: Not 1:1 mapping with SDK methods
2. **Worker as orchestration layer**: Handles business logic and SDK operations
3. **Real-time streaming**: Use SSE for command output and process logs
4. **Template-driven approach**: Provide server templates for common use cases

### Next Steps
1. Begin Phase 1: Analyze current frontend requirements
2. Design specific API endpoints with request/response formats
3. Document streaming protocols and error handling patterns
4. Create API specification document

---

## 🎯 Success Criteria

When this refactor is complete, the example app should:

- ✅ **Demonstrate proper architecture**: Frontend → Worker → SDK → Container
- ✅ **Showcase new SDK APIs**: All the beautiful APIs from APPROACHES.md in action
- ✅ **Provide excellent developer experience**: Clear patterns for building real applications
- ✅ **Be production-ready**: Proper error handling, streaming, authentication patterns
- ✅ **Serve as a template**: Other developers can copy this pattern for their own apps

The example will transform from a direct SDK testing tool into a **showcase of how to build real applications** with the Cloudflare Sandbox SDK.