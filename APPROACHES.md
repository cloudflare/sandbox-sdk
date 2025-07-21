# Sandbox SDK Execution API Design Approaches

A comprehensive analysis of different API design approaches for the Cloudflare Sandbox SDK, with examples showing developer experience from every angle.

## Table of Contents
- [Current Problematic API](#current-problematic-api)
- [Proposed Two-Method + AsyncIterable Approach](#proposed-two-method--asynciterable-approach)
- [Alternative Approaches](#alternative-approaches)
- [Developer Experience Analysis](#developer-experience-analysis)
- [Recommendations](#recommendations)

---

## Current Problematic API

### The Current Confusing Reality

```typescript
// 🤔 Current API - confusing boolean combinations
class Sandbox {
  async exec(command: string, args: string[], options?: { 
    stream?: boolean; 
    background?: boolean 
  }): Promise<ExecuteResponse | void>  // 😱 Return type varies!
}
```

### Developer Experience Pain Points

```typescript
// ❌ Scenario 1: Simple execution (works fine)
const result = await sandbox.exec('ls', ['-la']);
console.log(result.stdout); // ✅ Works as expected

// ❌ Scenario 2: Streaming execution (confusing return type)
const streamResult = await sandbox.exec('npm', ['run', 'build'], { stream: true });
// 🤔 What is streamResult? void? ExecuteResponse? When does it resolve?
// 😱 No way to get the final exit code!

// ❌ Scenario 3: Background process (BROKEN!)
const bgResult = await sandbox.exec('node', ['server.js'], { background: true });
console.log(`Server started with exit code: ${bgResult.exitCode}`); // 😱 Always 0!
// 💥 Returns fake success after 100ms while process is still starting!

// ❌ Scenario 4: Background + streaming (RESOURCE LEAK!)
sandbox.exec('tail', ['-f', '/var/log/app.log'], { 
  stream: true, 
  background: true 
});
// 🚨 Connection stays open forever! No way to stop it!

// ❌ Scenario 5: Managing background processes
// 😭 No way to check if server.js is still running
// 😭 No way to get the real exit code
// 😭 No way to kill the process
// 😭 No way to get accumulated logs
```

### Why Current API Fails

```typescript
// 🤮 Type horror - same method, different return types!
async function deployApp() {
  // These look the same but behave completely differently:
  const build = await exec('npm', ['run', 'build']);                    // ExecuteResponse
  const stream = await exec('npm', ['run', 'dev'], { stream: true });   // void
  const server = await exec('node', ['server.js'], { background: true }); // ExecuteResponse (fake!)
  
  // 😱 TypeScript can't help because return type is Promise<ExecuteResponse | void>
}
```

**Current Implementation Behavior Matrix:**

| stream | background | Behavior |
|--------|------------|----------|
| false  | false      | ✅ Synchronous execution, returns complete result |
| false  | true       | ❌ Returns fake success after 100ms, process continues |
| true   | false      | ✅ Streams output, closes when complete |
| true   | true       | ⚠️ Streams output, keeps connection open indefinitely |

---

## Proposed Two-Method + AsyncIterable Approach

### Clean, Predictable API

```typescript
class Sandbox {
  // Primary method - always returns result
  async exec(command: string, args: string[], options?: {
    stream?: boolean;                    // Enable real-time callbacks
    onOutput?: (stream, data) => void;   // Simple callback pattern
    signal?: AbortSignal;               // Web standard cancellation
    timeout?: number;
  }): Promise<ExecResult>               // ALWAYS returns ExecResult

  // Background processes - explicit and powerful
  async startProcess(command: string, args: string[], options?: ProcessOptions): Promise<Process>
  
  // Modern streaming patterns
  async *execStream(command: string, args: string[]): AsyncIterable<ExecEvent>
  async *streamProcessLogs(processId: string): AsyncIterable<LogEvent>
  
  // Process management
  async listProcesses(): Promise<Process[]>
  async getProcess(id: string): Promise<Process | null>
  async killProcess(id: string): Promise<void>
}
```

### 🌟 Delightful Developer Experience

```typescript
// ✅ Scenario 1: Simple execution - same as before but more consistent
const result = await sandbox.exec('ls', ['-la']);
console.log(`Exit code: ${result.exitCode}, Output: ${result.stdout}`);

// ✅ Scenario 2: Streaming execution - still returns result!
const buildResult = await sandbox.exec('npm', ['run', 'build'], {
  stream: true,
  onOutput: (stream, data) => {
    console.log(`[${stream}] ${data}`);
  }
});
// 🎉 Get real-time output AND final result with exit code!
console.log(`Build ${buildResult.success ? 'succeeded' : 'failed'} (${buildResult.exitCode})`);

// ✅ Scenario 3: Background processes - explicit and powerful
const server = await sandbox.startProcess('node', ['server.js'], {
  processId: 'web-server',
  onExit: (code) => console.log(`Server exited with code ${code}`)
});

console.log(`Server started with PID: ${server.pid}, Status: ${server.status}`);

// Later... check if still running
const serverStatus = await sandbox.getProcess('web-server');
if (serverStatus?.status === 'running') {
  console.log('Server is healthy!');
}

// ✅ Scenario 4: Background process logs - clean streaming
const logWatcher = await sandbox.startProcess('tail', ['-f', '/var/log/app.log'], {
  processId: 'log-watcher'
});

// Stream logs with modern AsyncIterable
for await (const logEvent of sandbox.streamProcessLogs('log-watcher')) {
  if (logEvent.type === 'stdout') {
    console.log(`[LOG] ${logEvent.data}`);
  }
  
  // Clean exit condition
  if (logEvent.data.includes('SHUTDOWN')) {
    await sandbox.killProcess('log-watcher');
    break;
  }
}

// ✅ Scenario 5: Advanced streaming for build tools
async function streamingBuild() {
  console.log('Starting build...');
  
  for await (const event of sandbox.execStream('npm', ['run', 'build'])) {
    switch (event.type) {
      case 'start':
        console.log(`🚀 Started: ${event.command}`);
        break;
      case 'stdout':
        process.stdout.write(event.data);
        break;
      case 'stderr':
        process.stderr.write(event.data);
        break;
      case 'complete':
        console.log(`✅ Build completed with exit code: ${event.exitCode}`);
        return event.result;
    }
  }
}

// ✅ Scenario 6: Robust error handling and cancellation
const controller = new AbortController();

try {
  const result = await sandbox.exec('sleep', ['30'], {
    signal: controller.signal,
    timeout: 10000,  // 10 second timeout
    onOutput: (stream, data) => console.log(`${stream}: ${data}`)
  });
} catch (error) {
  if (error.name === 'AbortError') {
    console.log('Command was cancelled');
  } else if (error.name === 'TimeoutError') {
    console.log('Command timed out');
  }
}

// Cancel after 5 seconds
setTimeout(() => controller.abort(), 5000);
```

### 🎯 Real-World Use Cases

```typescript
// 🚀 Web development workflow
async function developmentWorkflow() {
  // Start dev server in background
  const devServer = await sandbox.startProcess('npm', ['run', 'dev'], {
    processId: 'dev-server',
    onExit: (code) => {
      if (code !== 0) {
        console.error(`Dev server crashed with code ${code}`);
      }
    }
  });

  // Wait for server to be ready
  await new Promise(resolve => {
    const checkHealth = setInterval(async () => {
      const server = await sandbox.getProcess('dev-server');
      if (server?.status === 'running') {
        clearInterval(checkHealth);
        resolve();
      }
    }, 1000);
  });

  // Run tests with streaming output
  const testResult = await sandbox.exec('npm', ['test'], {
    stream: true,
    onOutput: (stream, data) => {
      if (stream === 'stderr' && data.includes('FAIL')) {
        console.error(`❌ Test failure: ${data}`);
      }
    }
  });

  // Cleanup
  await sandbox.killProcess('dev-server');
  
  return testResult.success;
}

// 🏗️ CI/CD Pipeline
async function ciPipeline() {
  const processes = [];

  try {
    // Install dependencies
    await sandbox.exec('npm', ['install']);

    // Run linting, tests, and build in parallel background processes
    processes.push(await sandbox.startProcess('npm', ['run', 'lint'], { processId: 'lint' }));
    processes.push(await sandbox.startProcess('npm', ['run', 'test'], { processId: 'test' }));
    processes.push(await sandbox.startProcess('npm', ['run', 'build'], { processId: 'build' }));

    // Wait for all to complete
    const results = await Promise.all([
      sandbox.getProcess('lint'),
      sandbox.getProcess('test'),
      sandbox.getProcess('build')
    ]);

    return results.every(p => p?.exitCode === 0);
  } finally {
    // Cleanup any running processes
    for (const proc of processes) {
      await sandbox.killProcess(proc.id).catch(() => {});
    }
  }
}

// 🔍 Log monitoring and alerting
async function monitorLogs() {
  const monitor = await sandbox.startProcess('journalctl', ['-f'], {
    processId: 'log-monitor'
  });

  for await (const log of sandbox.streamProcessLogs('log-monitor')) {
    const logData = log.data.toLowerCase();
    
    if (logData.includes('error') || logData.includes('exception')) {
      // Alert system
      await fetch('/api/alerts', {
        method: 'POST',
        body: JSON.stringify({ message: log.data, severity: 'error' })
      });
    }
    
    // Rotate logs or restart monitoring if needed
    if (logData.includes('log rotation')) {
      await sandbox.killProcess('log-monitor');
      // Restart monitoring...
    }
  }
}
```

---

## Alternative Approaches

### Alternative A: Single Method + Explicit Modes

```typescript
class Sandbox {
  async exec(command: string, args: string[], options?: {
    mode?: 'sync' | 'stream' | 'background';
    onOutput?: (stream, data) => void;
    signal?: AbortSignal;
  }): Promise<ExecResult | Process>  // 😕 Still union types
}
```

**Example Usage:**
```typescript
// 🤔 Better than current, but still type confusion
const syncResult = await sandbox.exec('ls', ['-la']); // ExecResult | Process
const streamResult = await sandbox.exec('npm', ['build'], { mode: 'stream' }); // ExecResult | Process  
const bgProcess = await sandbox.exec('node', ['server.js'], { mode: 'background' }); // ExecResult | Process

// 😰 TypeScript still can't help distinguish return types
if ('exitCode' in syncResult) {
  // Must check at runtime if it's ExecResult vs Process
  console.log(syncResult.exitCode);
} else {
  // It's a Process
  console.log(syncResult.pid);
}
```

**Pros & Cons:**
- ✅ Single entry point
- ✅ Explicit intent with modes
- ❌ Union return types require runtime checks
- ❌ TypeScript can't provide proper autocomplete
- ❌ Still confusing for complex scenarios

### Alternative B: Method Overloading + WebStreams

```typescript
class Sandbox {
  // Overloaded signatures
  async exec(command: string, args: string[]): Promise<ExecResult>
  async exec(command: string, args: string[], options: { stream: true }): Promise<ExecResult & { logStream: ReadableStream }>
  async exec(command: string, args: string[], options: { background: true }): Promise<Process>
  
  async exec(command: string, args: string[], options?: any): Promise<any> {
    // Implementation...
  }
}
```

**Example Usage:**
```typescript
// 🎯 Type safety through overloading
const result = await sandbox.exec('ls', ['-la']); // ✅ ExecResult
const streamResult = await sandbox.exec('npm', ['build'], { stream: true }); // ✅ ExecResult & { logStream }
const process = await sandbox.exec('node', ['server.js'], { background: true }); // ✅ Process

// 🤔 WebStreams for streaming
const reader = streamResult.logStream.getReader();
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  console.log(value);
}

// 😅 More complex but more type-safe than current
```

**Pros & Cons:**
- ✅ Type safety through overloading
- ✅ Single method name
- ❌ Overloads are hidden from basic autocomplete
- ❌ WebStreams more complex than needed for simple cases
- ❌ Still mixing different concerns in one method

### Alternative C: Separate Classes Pattern

```typescript
// Different classes for different use cases
class CommandRunner {
  async exec(cmd: string, args: string[]): Promise<ExecResult>
  async *execStream(cmd: string, args: string[]): AsyncIterable<ExecEvent>
}

class ProcessManager {
  async start(cmd: string, args: string[]): Promise<Process>
  async list(): Promise<Process[]>
  async kill(id: string): Promise<void>
  async *streamLogs(id: string): AsyncIterable<LogEvent>
}

class Sandbox {
  commands = new CommandRunner()
  processes = new ProcessManager()
}
```

**Example Usage:**
```typescript
// 🎯 Very explicit, no confusion
const result = await sandbox.commands.exec('ls', ['-la']);

for await (const event of sandbox.commands.execStream('npm', ['build'])) {
  console.log(event);
}

const server = await sandbox.processes.start('node', ['server.js']);
for await (const log of sandbox.processes.streamLogs(server.id)) {
  console.log(log.data);
}

// 😕 More verbose, might be overkill for simple use cases
```

**Pros & Cons:**
- ✅ Perfect type safety
- ✅ Clear separation of concerns
- ✅ Easy to extend each area independently
- ❌ More verbose for simple cases
- ❌ Might be overkill for the 90% use case
- ❌ Extra navigation required

---

## Developer Experience Analysis

### 📊 Comparison Matrix

| Aspect | Current API | Two-Method + AsyncIterable | Single Method + Modes | Method Overloading | Separate Classes |
|--------|-------------|---------------------------|---------------------|-------------------|------------------|
| **Type Safety** | ❌ Poor | ✅ Excellent | ⚠️ Runtime checks needed | ✅ Excellent | ✅ Excellent |
| **Discoverability** | ❌ Confusing | ✅ Natural progression | ✅ Single entry point | ⚠️ Hidden overloads | 🤔 More navigation |
| **Learning Curve** | 😱 High (gotchas) | 📈 Gentle | 📈 Gentle | 📊 Medium | 📊 Medium |
| **Code Completion** | ❌ Union types | ✅ Precise | ⚠️ Generic | ✅ Context-aware | ✅ Precise |
| **Runtime Errors** | 🚨 Many surprises | ⚡ Predictable | ⚠️ Mode validation | ⚡ Predictable | ⚡ Predictable |
| **Streaming UX** | 😭 No final result | 🎉 Best of both | 🤔 Mode switching | 📚 Complex setup | 📊 Clean separation |

### 🎯 Developer Journey Analysis

#### **New Developer (First 30 minutes)**

```typescript
// 🆕 "I just want to run a command"

// Current API - Immediate confusion
const result1 = await sandbox.exec('ls', ['-la']); // ✅ Works
const result2 = await sandbox.exec('npm', ['build'], { stream: true }); // 🤔 void? When done?

// Our Proposed - Natural learning
const result1 = await sandbox.exec('ls', ['-la']); // ✅ Works  
const result2 = await sandbox.exec('npm', ['build'], { 
  stream: true,
  onOutput: (stream, data) => console.log(data) 
}); // ✅ Still get result! + streaming!

// Alternative modes - Also natural
const result1 = await sandbox.exec('ls', ['-la']); // ✅ Works
const result2 = await sandbox.exec('npm', ['build'], { mode: 'stream' }); // 🤔 Same return type?
```

#### **Intermediate Developer (After 1 hour)**

```typescript
// 🛠️ "I need background processes now"

// Current API - Hidden pitfalls everywhere  
const server = await sandbox.exec('node', ['server.js'], { background: true });
console.log(server.exitCode); // 😱 Always 0! Process might still be starting!
// 😭 No way to check if process is actually running

// Our Proposed - Explicit intent
const server = await sandbox.startProcess('node', ['server.js']);
console.log(server.status); // ✅ 'starting' | 'running' | 'completed' etc
const currentStatus = await sandbox.getProcess(server.id); // ✅ Real status

// Alternative modes - Better but still confusing
const server = await sandbox.exec('node', ['server.js'], { mode: 'background' });
if (server instanceof Process) { // 🤔 Runtime type checking required
  console.log(server.status);
}
```

#### **Advanced Developer (Building production systems)**

```typescript
// 🏗️ "I need robust process management with monitoring"

// Current API - Impossible to build reliably
sandbox.exec('tail', ['-f', '/var/log/app.log'], { 
  stream: true, 
  background: true 
}); 
// 🚨 Memory leak! Connection never closes!
// 😭 No way to stop, manage, or recover

// Our Proposed - Production ready
const logMonitor = await sandbox.startProcess('tail', ['-f', '/var/log/app.log']);

// Robust streaming with cleanup
const logStream = sandbox.streamProcessLogs(logMonitor.id);
const controller = new AbortController();

for await (const log of logStream) {
  if (controller.signal.aborted) break;
  
  await processLog(log);
  
  if (shouldRestart()) {
    await sandbox.killProcess(logMonitor.id);
    // Start new monitor...
  }
}

// Alternative approaches require similar complexity but less clear APIs
```

### 🧠 Cognitive Load Analysis

#### **Current API Mental Model** 
```typescript
// 😵‍💫 Developer must remember:
// - `stream: false` → get ExecuteResponse
// - `stream: true` → get void (but when?)
// - `background: true` → get fake ExecuteResponse
// - `stream: true, background: true` → void + memory leak
// - No process management possible
// - Return types change unpredictably
```

#### **Our Proposed Mental Model**
```typescript
// 🧠 Clear mental model:
// - `exec()` → always get ExecResult (+ optional streaming via callback)
// - `startProcess()` → get Process object for background work
// - `execStream()` → AsyncIterable for advanced streaming
// - `streamProcessLogs()` → AsyncIterable for process log streaming
// - Process management methods when needed
```

### 🎨 API Aesthetics & Joy

#### **Current API - Pain Points**
```typescript
// 😤 Frustrating surprises
const result = await exec('command', [], { stream: true });
// 🤔 What is result? When did command finish? What was exit code?

// 😱 Silent failures  
const server = await exec('node', ['server.js'], { background: true });
// 🎭 Looks successful but might have crashed immediately

// 🚨 Resource leaks
exec('tail', ['-f', 'log'], { stream: true, background: true });
// 💸 Memory leak with no way to stop
```

#### **Our Proposed API - Delightful Moments**  
```typescript
// 🎉 Streaming + final result - best of both worlds!
const buildResult = await sandbox.exec('npm', ['run', 'build'], {
  stream: true,
  onOutput: (stream, data) => showProgress(data)
});
console.log(`Build ${buildResult.success ? '✅' : '❌'}`);

// 🛠️ Background processes feel powerful and safe
const server = await sandbox.startProcess('node', ['app.js']);
// 🔍 Rich process object with real status
console.log(`Server ${server.status} with PID ${server.pid}`);

// 🌊 Modern streaming feels natural
for await (const log of sandbox.streamProcessLogs('web-server')) {
  if (log.data.includes('ERROR')) {
    await handleError(log);
  }
}

// 🎯 Everything is cancellable and predictable
const controller = new AbortController();
const result = await sandbox.exec('slow-command', [], {
  signal: controller.signal,
  timeout: 30000
});
```

---

## Recommendations

### 🎯 Why Our Two-Method + AsyncIterable Approach Wins

#### **1. 🎓 Natural Learning Curve**
Developers start with `exec()` for simple commands and naturally discover `startProcess()` when they need background processes. No confusing boolean combinations to learn.

#### **2. ✅ Perfect Type Safety**
No union types, no runtime type checking needed. TypeScript provides excellent autocomplete and catches errors at compile time.

#### **3. 🎉 Best of Both Worlds**
`exec()` gives you streaming callbacks AND final results. You never have to choose between real-time feedback and final exit codes.

#### **4. 🛠️ Production Ready**
Robust process management APIs that handle real-world scenarios without complexity for simple cases.

#### **5. 🌊 Modern Web Platform Patterns**
AsyncIterable for advanced streaming, AbortSignal for cancellation, Promise-based APIs throughout.

#### **6. 🧹 Clean Mental Model**
Two clear concepts instead of confusing option combinations:
- **Commands**: `exec()` and `execStream()` for running commands
- **Processes**: `startProcess()` and management APIs for background work

### The "Joy Factor"

```typescript
// 😍 This feels wonderful to write
const result = await sandbox.exec('npm', ['test'], {
  stream: true,
  onOutput: (stream, data) => updateUI(data)
});

if (result.success) {
  const server = await sandbox.startProcess('npm', ['start']);
  console.log(`🚀 Server started: ${server.id}`);
}

// vs

// 🤮 Current API confusion  
const result = await sandbox.exec('npm', ['test'], { stream: true }); 
// 🤔 What is result? void? When did it finish?
```

**The magic is in the consistency**: `exec()` ALWAYS returns a result, streaming just adds real-time feedback. Background processes are explicitly different operations with rich management APIs.

### 🚀 Implementation Recommendation

**Proceed with the Two-Method + AsyncIterable approach** because it:

1. **Solves all current pain points** without introducing new complexity
2. **Provides excellent developer experience** from beginner to advanced use cases
3. **Leverages modern JavaScript patterns** that developers are learning anyway
4. **Scales beautifully** from simple scripts to production systems
5. **Maintains backwards compatibility** potential through migration paths
6. **Feels joyful to use** - the ultimate test of great API design

The approach strikes the perfect balance between simplicity for common cases and power for advanced scenarios, while maintaining crystal-clear APIs that prevent the gotchas and surprises that plague the current implementation.