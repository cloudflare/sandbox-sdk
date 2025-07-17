# Cloudflare Sandbox SDK Improvements

This document outlines the key features missing from the Cloudflare Sandbox SDK when compared to more mature sandbox solutions like Daytona. These improvements focus on practical enhancements that align with Cloudflare's Workers-based architecture.

## High-Priority Missing Features

### 1. Advanced Process Management

The current SDK has basic `exec()` functionality but lacks sophisticated process management capabilities:

- **Session-based command execution** with proper state persistence between commands
- **Streaming logs** for long-running processes with real-time output
- **Background task support** with process management (start, stop, list running processes)
- **Command history** tracking within a session
- **Working directory persistence** across commands in the same session

### 2. Enhanced File System Operations

Current file operations are limited to basic CRUD. Missing features include:

- **File search**: Find files by pattern/content across directories
  ```typescript
  // Example API
  await sandbox.findFiles("/workspace", "*.js", { content: "TODO" });
  ```
- **Search and replace**: Bulk text replacement in files
  ```typescript
  await sandbox.replaceInFiles(["file1.js", "file2.js"], "oldText", "newText");
  ```
- **File permissions**: Get/set file permissions
- **Bulk operations**: Upload/download multiple files efficiently
- **File metadata**: Get detailed file info (size, modified time, permissions)

### 3. Full Git Workflow Support

Currently only `gitCheckout` is available. A complete git integration would include:

- **Repository status**: `git status` equivalent
- **Staging and committing**: `git add`, `git commit`
- **Branch operations**: Create, switch, list, delete branches
- **Remote operations**: Push/pull capabilities with authentication
- **Diff viewing**: See changes between commits or working tree
- **Git configuration**: Set user name, email, etc.

Example API:
```typescript
await sandbox.git.status("/repo");
await sandbox.git.add("/repo", ["file1.js", "file2.js"]);
await sandbox.git.commit("/repo", "feat: add new feature");
await sandbox.git.push("/repo", { username: "user", token: "token" });
```

### 4. Direct Code Execution

Instead of using `exec()` to run interpreters, provide direct code execution:

```typescript
// Current approach
await sandbox.exec("python", ["-c", "print('Hello')"]); 

// Proposed approach
await sandbox.codeRun("print('Hello')", "python");
```

Features needed:
- Language auto-detection based on file extension or shebang
- Proper stdin/stdout/stderr handling
- Execution timeout controls
- Environment variable injection
- Return exit codes and execution time

### 5. Preview URLs & Port Management

Automatic preview URL generation for running services:

```typescript
// Start a web server
await sandbox.exec("python", ["-m", "http.server", "8000"]);

// Get preview URL
const preview = await sandbox.getPreviewUrl(8000);
// Returns: { url: "https://8000-sandbox-abc123.preview.workers.dev", token: "auth_token" }
```

Features:
- Automatic preview URL generation for any exposed port
- Built-in auth tokens for preview access
- Port availability checking
- Service health checks
- Multiple port support

### 6. Better Session Management

Enhance session capabilities:

```typescript
// Create a named session
const session = await sandbox.createSession("build-session");

// Execute commands in session context
await session.exec("cd /workspace");
await session.exec("npm install"); // Runs in /workspace
await session.exec("npm run build"); // Still in /workspace

// Get session info
const info = await session.getInfo();
// { workingDir: "/workspace", env: {...}, history: [...], uptime: 120 }
```

### 7. Web Terminal Access

Built-in terminal access without SSH:

```typescript
// Get terminal WebSocket endpoint
const terminal = await sandbox.getTerminalUrl();
// Returns: { url: "wss://terminal-sandbox-abc123.workers.dev", token: "auth_token" }
```

Features:
- WebSocket-based terminal access
- Terminal session management
- Resize support
- Copy/paste functionality

### 8. Language Server Protocol (LSP) Support

For AI coding assistants and IDE-like features:

```typescript
// Create LSP server
const lsp = await sandbox.createLSPServer("typescript", "/workspace");

// Get completions
const completions = await lsp.getCompletions("/workspace/file.ts", { line: 10, column: 15 });

// Get diagnostics
const diagnostics = await lsp.getDiagnostics("/workspace/file.ts");
```

## Implementation Priorities

1. **Phase 1**: Advanced process management and streaming (foundation for other features)
2. **Phase 2**: Enhanced file operations and git support (common developer workflows)
3. **Phase 3**: Direct code execution and preview URLs (better DX)
4. **Phase 4**: LSP support and web terminal (advanced features)

## Architecture Considerations

All improvements should:
- Work within the Workers/Durable Objects architecture
- Maintain the stateless nature of Workers
- Use the existing container command server pattern
- Be backwards compatible with current SDK
- Follow Cloudflare's security model

## Next Steps

1. Prioritize features based on user feedback
2. Design APIs that feel natural for Workers developers
3. Implement features incrementally with proper testing
4. Update documentation and examples for each feature
5. Gather feedback from early adopters before stabilizing APIs