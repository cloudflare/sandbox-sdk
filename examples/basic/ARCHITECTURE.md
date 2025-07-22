# Sandbox SDK Example Architecture

This document explains the complete architecture of the Sandbox SDK example application and how all the components work together.

## 🏗️ System Overview

The example demonstrates the proper 3-layer architecture for using the Cloudflare Sandbox SDK:

```
┌─────────────────┐    HTTP     ┌─────────────────┐   Direct   ┌─────────────────┐  Internal  ┌─────────────────┐
│   React App     │ ──────────▶ │     Worker      │ ─────────▶ │  Sandbox DO     │ ─────────▶ │ Container Logic │
│   (Frontend)    │             │  (API Gateway)  │  Method    │ (Process Mgmt)  │  HTTP      │ (ChildProcess)  │
│                 │             │                 │  Calls     │                 │  Calls     │                 │
│ • UI Components │◀────────────│ • HTTP Endpoints│◀───────────│ • SDK Methods   │◀───────────│ • Real Processes│
│ • State Mgmt    │   JSON/SSE  │ • Business Logic│   Results  │ • AsyncIterable │  Results   │ • Output Streams│
│ • API Calls     │             │ • Error Handling│            │ • Lifecycle     │            │ • Port Exposure │
└─────────────────┘             └─────────────────┘            └─────────────────┘            └─────────────────┘
```

## 📋 Component Responsibilities

### 1. Frontend (React App)
**Location**: `app/index.tsx`
**Role**: User Interface & Experience

**Responsibilities**:
- Render UI components (Commands, Processes, Ports, Streaming tabs)
- Handle user input and form submissions
- Make HTTP requests to Worker API endpoints
- Manage client-side state and real-time updates via SSE
- Display results, errors, and streaming output

**Key Features**:
- Tabbed interface for different SDK features
- Real-time streaming via Server-Sent Events
- Process lifecycle visualization
- Error handling and loading states

### 2. Worker (API Gateway)
**Location**: `src/index.ts`
**Role**: Business Logic & API Layer

**Responsibilities**:
- Expose frontend-optimized HTTP API endpoints
- Handle CORS, validation, and error responses
- Call Sandbox Durable Object methods directly
- Transform SDK responses for frontend consumption
- Implement streaming via Server-Sent Events

**Key Endpoints**:
```typescript
POST /api/execute              → sandbox.exec(command, options)
POST /api/execute/stream       → sandbox.execStream(command, options)
GET  /api/process/list         → sandbox.listProcesses()
POST /api/process/start        → sandbox.startProcess(command, options)
GET  /api/process/{id}/stream  → sandbox.streamProcessLogs(processId)
DELETE /api/process/{id}       → sandbox.killProcess(processId)
POST /api/expose-port          → sandbox.exposePort(port, options)
```

**Important**: Worker does NOT implement container server endpoints - it calls SDK methods directly.

### 3. Sandbox Durable Object
**Location**: `packages/sandbox/src/sandbox.ts`
**Role**: SDK Implementation & Process Management

**Responsibilities**:
- Implement the ISandbox interface methods
- Manage process lifecycle (start, monitor, kill)
- Provide AsyncIterable streaming for logs and command output
- Handle container communication via internal HttpClient
- Maintain process state and metadata

**Key Methods**:
```typescript
async exec(command, options): Promise<ExecResult>
async *execStream(command, options): AsyncIterable<ExecEvent>
async startProcess(command, options): Promise<Process>
async *streamProcessLogs(processId): AsyncIterable<LogEvent>
async listProcesses(): Promise<Process[]>
async getProcess(id): Promise<Process | null>
async killProcess(id): Promise<void>
```

**Internal Architecture**:
- Extends `Container` from `@cloudflare/containers`
- Uses `HttpClient` configured with `stub: this` for internal communication
- Implements `containerFetch()` method to handle internal HTTP requests

### 4. Container Logic (Internal HTTP Server)
**Location**: Handled by `@cloudflare/containers` + internal HTTP client
**Role**: Process Runtime & System Interface

**Responsibilities**:
- Spawn real Node.js ChildProcess instances
- Capture stdout/stderr streams in real-time
- Manage process lifecycle and cleanup
- Handle port exposure and networking
- Provide HTTP endpoints for internal SDK communication

**Process Flow**:
1. Sandbox method calls `this.client.methodName()`
2. HttpClient (configured with `stub: this`) calls `this.containerFetch()`
3. Container logic processes the request and manages actual processes
4. Results flow back through the same chain

## 🔄 Data Flow Examples

### Command Execution Flow
```
User clicks "Execute" → Frontend POST /api/execute → Worker calls sandbox.exec() 
→ SDK calls this.client.execute() → HttpClient calls this.containerFetch() 
→ Container spawns ChildProcess → Results flow back through chain → Frontend displays output
```

### Process Log Streaming Flow
```
User clicks "Stream Logs" → Frontend opens SSE to /api/process/{id}/stream 
→ Worker calls sandbox.streamProcessLogs() → SDK yields AsyncIterable events 
→ HttpClient streams from this.containerFetch() → Container captures process output 
→ Events flow back through AsyncIterable → Worker sends SSE events → Frontend displays logs
```

### Process Management Flow
```
User starts process → Frontend POST /api/process/start → Worker calls sandbox.startProcess()
→ SDK creates process via this.client.startProcess() → Container spawns ChildProcess
→ Process metadata returned → Frontend shows in process list → Real-time status updates via polling
```

## 🧩 Key Architectural Patterns

### 1. Direct SDK Method Calls (Correct ✅)
Worker uses SDK as intended:
```typescript
// Worker code
const sandbox = getUserSandbox(env, request);
const result = await sandbox.exec(command, options);      // Direct method call
const process = await sandbox.startProcess(cmd, opts);    // Direct method call
```

### 2. AsyncIterable Streaming (Modern ✨)
Proper streaming implementation:
```typescript
// Worker streaming endpoint
for await (const logEvent of sandbox.streamProcessLogs(processId)) {
  controller.enqueue(encoder.encode(`data: ${JSON.stringify(logEvent)}\n\n`));
}
```

### 3. Internal HTTP Communication (Hidden 🔍)
SDK's internal architecture:
```typescript
// Inside Sandbox class
this.client = new HttpClient({
  stub: this,        // HttpClient calls back to same Durable Object
  port: 3000        // Default container port
});

// When SDK method is called:
async *streamProcessLogs(processId) {
  const stream = await this.client.streamProcessLogs(processId);  // Internal HTTP call
  // Process the stream and yield events
}
```

## 🚫 Common Anti-Patterns (What NOT to Do)

### ❌ Worker Implementing Container Endpoints
```typescript
// WRONG: Worker trying to implement container server
if (pathname === "/api/process/start") {
  // Worker should NOT implement this - SDK does it internally
  const childProcess = spawn(command);  // Don't do this!
}
```

### ❌ Circular HTTP Dependencies  
```typescript
// WRONG: SDK making HTTP requests back to Worker endpoints
// This creates: SDK → HttpClient → Worker → SDK (circular!)
```

### ❌ Frontend Using SDK Directly
```typescript
// WRONG: Frontend importing SDK internals
import { HttpClient } from "@cloudflare/sandbox/src/client";  // Don't do this!
```

## 🎯 Architecture Benefits

### 1. **Separation of Concerns**
- Frontend: UI/UX only
- Worker: API gateway and business logic  
- SDK: Process management and container communication
- Container: System-level process execution

### 2. **Scalability**
- Each layer can be optimized independently
- Durable Objects provide automatic scaling and state management
- Worker handles multiple users via different sandbox IDs

### 3. **Developer Experience**
- Frontend developers work with simple HTTP APIs
- Backend developers use clean SDK methods
- System complexity hidden behind well-defined interfaces

### 4. **Real-World Applicability**  
- Example shows how to build production applications
- Proper error handling, streaming, and lifecycle management
- Authentication and multi-tenancy patterns

## 🔧 Development Workflow

### Starting the Application
1. **Container**: Automatically managed by Cloudflare runtime
2. **Worker**: `npm start` (runs `wrangler dev`)  
3. **Frontend**: Served by Worker at root URL

### Making Changes
- **Frontend changes**: Edit `app/index.tsx`, reload browser
- **Worker changes**: Edit `src/index.ts`, Wrangler auto-reloads
- **SDK changes**: Edit `packages/sandbox/src/*`, rebuild and restart

### Debugging
- **Worker logs**: Visible in Wrangler console
- **Frontend errors**: Browser developer tools
- **Process debugging**: Use Commands tab to inspect processes
- **Streaming debugging**: Check Streaming tab for real-time events

## 📚 Further Reading

- **APPROACHES.md**: Detailed API design analysis and alternatives
- **REFACTOR.md**: Evolution of the example from internal APIs to proper architecture
- **packages/sandbox/README.md**: Core SDK documentation
- **Cloudflare Containers**: https://developers.cloudflare.com/containers/

## 🎉 Success Criteria

This architecture successfully demonstrates:

✅ **Proper 3-layer separation**: Frontend → Worker → SDK → Container  
✅ **Clean SDK usage**: Direct method calls, no internal API abuse  
✅ **Modern streaming**: AsyncIterable patterns with SSE delivery  
✅ **Production patterns**: Error handling, validation, CORS, authentication hooks  
✅ **Developer template**: Copy-paste architecture for real applications  

The example serves as both a testing platform for the SDK and a template for developers building their own applications with the Cloudflare Sandbox SDK.