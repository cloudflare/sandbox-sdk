# Error Handling Improvement Plan

## 🎯 **IMPLEMENTATION STATUS: CORE COMPLETE**

### ✅ **Completed (Phase 1 & 2)**
- **Container Error Mapping**: All file, command, process, port, and git operations now return structured errors with specific codes and HTTP status codes
- **Client Error Classes**: Comprehensive error class hierarchy with specific types (FileNotFoundError, CommandNotFoundError, PortAlreadyExposedError, GitAuthenticationError, etc.)
- **Error Utilities**: Clean, simple mapping functions without over-engineering
- **Build & Diagnostics**: All TypeScript errors resolved, package builds successfully

### 📈 **Key Improvements Delivered**
```diff
- ❌ Generic "Failed to read file" errors
- ❌ All failures return HTTP 500 status
- ❌ No programmatic error handling possible

+ ✅ "File not found: /app/hello.txt" (FileNotFoundError, 404)
+ ✅ "Permission denied: /app/secret.txt" (PermissionDeniedError, 403)
+ ✅ "Command not found: invalidcommand" (CommandNotFoundError, 404)
+ ✅ "Port already exposed: 3000" (PortAlreadyExposedError, 409)
+ ✅ "Git authentication failed: github.com/user/repo" (GitAuthenticationError, 401)
+ ✅ Rich error context for debugging and programmatic handling
```

### 🔄 **Next Steps Available**
- **Testing**: Comprehensive error scenario test coverage
- **Advanced Features**: Timeout handling, command validation, retry logic
- **Documentation**: Update examples and guides with new error handling patterns

---

## Current Problem Analysis

The Cloudflare Sandbox SDK currently has inconsistent and often unhelpful error handling across operations. When operations fail, users receive generic error messages that don't provide enough context for debugging or handling specific error conditions.

### Comprehensive Analysis of All Operations

After analyzing the entire SDK codebase, here's the current state of error handling across all operation types:

#### **File Operations** (🔥 Critical Priority)
**Current Issues:**
- Generic "Failed to read file" instead of "File not found: /app/hello.txt"
- Container logs detailed Node.js errors (`ENOENT: no such file or directory, errno: -2, code: "ENOENT"`) but strips context
- All file operations return 500 status instead of appropriate codes (404, 403, 409)
- Missing error codes for programmatic handling

**Current Error Flow:**
```
Container: ENOENT: no such file or directory, open '/app/hello.txt'
↓
Container Response: { "error": "Failed to read file" } (500)
↓
Client Error: Error: Failed to read file
```

**Specific Problems Found:**
- `readFile`: ENOENT becomes generic "Failed to read file" (500)
- `writeFile`: Permission/space issues become "Failed to write file" (500)
- `deleteFile`: Non-existent files become "Failed to delete file" (500)
- `moveFile`: Source/dest issues become "Failed to move file" (500)
- `renameFile`: File conflicts become "Failed to rename file" (500)
- `mkdir`: Permission issues become "Failed to create directory" (500)

#### **Command Operations** (🔥 Critical Priority)
**Current Issues:**
- All execution failures return generic "Failed to execute command" (500)
- No distinction between command not found, timeout, permission denied
- Streaming commands have same generic error handling
- Missing timeout error handling entirely

**Current Error Flow:**
```
Container: Command 'nonexistent' not found or permission denied
↓
Container Response: { "error": "Failed to execute command" } (500)
↓
Client Error: Error: Failed to execute command
```

**Specific Problems Found:**
- `execute`: All failures become "Failed to execute command" (500)
- `executeStream`: Same generic handling as non-streaming (500)
- No timeout detection or handling
- Command not found vs permission denied not distinguished

#### **Process Operations** (⚠️ Medium Priority - Partially Good)
**Current Issues:**
- Some operations have good specific messages (`"Process not found: ${processId}"`)
- But still return generic Error objects on client side
- Missing error codes for programmatic handling
- Process start failures lack context about why they failed

**Current Error Flow:**
```
Container: Process not found: abc123
↓
Container Response: { "error": "Process not found: abc123" } (404) ✅ Good message & status
↓
Client Error: Error: Process not found: abc123 ❌ Generic Error class
```

**Specific Analysis:**
- `getProcess`: ✅ Good - "Process not found: ${id}" (404)
- `killProcess`: ✅ Good - "Process not found: ${id}" (404)
- `getProcessLogs`: ✅ Good - "Process not found: ${id}" (404)
- `streamProcessLogs`: ✅ Good - "Process not found: ${id}" (404)
- `startProcess`: ❌ Bad - Generic "Failed to start process" (500)
- `listProcesses`: ❌ Bad - Generic "Failed to list processes" (500)

#### **Port Operations** (⚠️ Medium Priority - Mixed Quality)
**Current Issues:**
- Some specific messages but inconsistent error codes
- Missing context about why ports can't be exposed/unexposed
- Generic client-side Error objects

**Current Error Flow:**
```
Container: Port is not exposed / Port already exposed
↓
Container Response: { "error": "Port is not exposed" } (404) ✅ Good message & status
↓
Client Error: Error: Port is not exposed ❌ Generic Error class
```

**Specific Analysis:**
- `exposePort`: ❌ Validation good (400), but generic "Failed to expose port" (500)
- `unexposePort`: ✅ Good - "Port is not exposed" (404), validation (400)
- `getExposedPorts`: ❌ Bad - Generic "Failed to get exposed ports" (500)
- Proxy errors: ✅ Good - Specific port context in messages

#### **Git Operations** (📈 Lower Priority - Least Used)
**Current Issues:**
- Basic validation present but generic failure messages
- Missing context about what specifically failed (auth, network, invalid repo)
- All failures return 500 instead of appropriate codes

**Current Error Flow:**
```
Container: Git clone failed - authentication failed
↓
Container Response: { "error": "Failed to checkout repository" } (500)
↓
Client Error: Error: Failed to checkout repository
```

**Specific Analysis:**
- URL validation: ✅ Good - "Repository URL is required" (400)
- Format validation: ✅ Good - "Invalid repository URL format" (400)
- Clone failures: ❌ Bad - Generic "Failed to checkout repository" (500)
- Missing distinction between network, auth, and repository not found errors

### **Overall Assessment Summary**

| Operation Type | Message Quality | Status Codes | Error Codes | Client Classes | Priority |
|---------------|----------------|--------------|-------------|----------------|----------|
| **File Ops** | ❌ Generic | ❌ All 500s | ❌ None | ❌ Generic Error | 🔥 Critical |
| **Command Ops** | ❌ Generic | ❌ All 500s | ❌ None | ❌ Generic Error | 🔥 Critical |
| **Process Ops** | ✅ Specific | ✅ Mostly Good | ❌ None | ❌ Generic Error | ⚠️ Medium |
| **Port Ops** | ⚠️ Mixed | ✅ Good | ❌ None | ❌ Generic Error | ⚠️ Medium |
| **Git Ops** | ❌ Generic | ⚠️ Some Good | ❌ None | ❌ Generic Error | 📈 Low |

### **Key Patterns Identified**

1. **Lost Context Pattern**: Container logs rich error details but returns generic messages
2. **Status Code Inconsistency**: Many 500s that should be 404, 403, 409, 408
3. **No Error Code System**: Zero machine-readable error codes across the entire SDK
4. **Generic Client Errors**: All operations throw basic `Error` objects regardless of failure type
5. **Good Foundation**: HTTP status infrastructure exists, just needs proper mapping

## Proposed Solution: Structured Error Handling

### 1. Container-Level Improvements

#### Enhanced Error Response Format
```typescript
interface ContainerErrorResponse {
  error: string;           // Human-readable message
  code: string;            // Machine-readable error code
  details?: string;        // Additional context (sanitized)
  httpStatus: number;      // Appropriate HTTP status
  operation: string;       // What operation failed
  path?: string;          // Sanitized file/resource path
}
```

#### Comprehensive Error Code System by Operation

```typescript
// File Operations (🔥 Critical - Most problematic currently)
'FILE_NOT_FOUND'            // 404 - File/directory doesn't exist (ENOENT)
'FILE_PERMISSION_DENIED'    // 403 - Permission denied (EACCES)
'FILE_ALREADY_EXISTS'       // 409 - File exists when creating (EEXIST)
'DIRECTORY_NOT_EMPTY'       // 409 - Can't delete non-empty directory (ENOTEMPTY)
'INVALID_FILE_PATH'         // 400 - Malformed or dangerous path
'FILE_TOO_LARGE'           // 413 - File exceeds size limits
'DISK_SPACE_FULL'          // 507 - No space left on device (ENOSPC)
'FILE_BUSY'                // 423 - File is locked/in use (EBUSY)
'FILE_IS_DIRECTORY'        // 409 - Expected file but found directory (EISDIR)
'PATH_IS_FILE'             // 409 - Expected directory but found file (ENOTDIR)

// Command Operations (🔥 Critical - No error specificity currently)
'COMMAND_NOT_FOUND'        // 404 - Command doesn't exist in PATH
'COMMAND_PERMISSION_DENIED' // 403 - No execute permission
'COMMAND_TIMEOUT'          // 408 - Command exceeded timeout limit
'COMMAND_KILLED'           // 499 - Command was forcibly terminated
'COMMAND_FAILED'           // 500 - Command exited with non-zero code
'INVALID_COMMAND'          // 400 - Malformed or dangerous command
'WORKING_DIR_NOT_FOUND'    // 404 - Specified working directory doesn't exist

// Process Operations (⚠️ Medium - Some good messages, needs error codes)
'PROCESS_NOT_FOUND'        // 404 - Process doesn't exist
'PROCESS_ALREADY_RUNNING'  // 409 - Process already started (for background processes)
'PROCESS_START_FAILED'     // 500 - Failed to start process
'PROCESS_KILL_FAILED'      // 500 - Failed to kill process
'PROCESS_PERMISSION_DENIED' // 403 - No permission to kill process
'INVALID_PROCESS_ID'       // 400 - Malformed process ID

// Port Operations (⚠️ Medium - Mixed quality, needs consistency)
'PORT_ALREADY_EXPOSED'     // 409 - Port already exposed
'PORT_NOT_EXPOSED'         // 404 - Port not currently exposed
'INVALID_PORT_NUMBER'      // 400 - Port outside valid range (1-65535)
'PORT_RESERVED'            // 403 - Port is reserved/system port
'PORT_IN_USE'              // 409 - Port already in use by another service
'SERVICE_NOT_RESPONDING'   // 502 - Service on port not responding

// Git Operations (📈 Low - Least used, basic validation exists)
'GIT_REPOSITORY_NOT_FOUND' // 404 - Repository doesn't exist
'GIT_CLONE_FAILED'         // 500 - Failed to clone repository
'GIT_CHECKOUT_FAILED'      // 500 - Failed to checkout branch/commit
'GIT_AUTH_FAILED'          // 401 - Authentication failed
'GIT_NETWORK_ERROR'        // 502 - Network connectivity issues
'INVALID_GIT_URL'          // 400 - Malformed repository URL
'GIT_BRANCH_NOT_FOUND'     // 404 - Specified branch doesn't exist

// General System Errors (Cross-cutting)
'INVALID_REQUEST'          // 400 - Malformed request data
'RATE_LIMITED'             // 429 - Too many requests
'INTERNAL_ERROR'           // 500 - Unexpected server error
'SERVICE_UNAVAILABLE'      // 503 - Service temporarily unavailable
'CONTAINER_ERROR'          // 500 - Container-level failure
```

### 2. Client-Level Improvements

#### Comprehensive Error Class Hierarchy

```typescript
// Base error class (already exists - enhance with more context)
export class SandboxError extends Error {
  constructor(
    message: string,
    public code?: string,
    public details?: string,
    public operation?: string,
    public httpStatus?: number
  ) {
    super(message);
    this.name = 'SandboxError';
  }
}

// File Operation Error Classes (🔥 Critical Priority)
export class FileNotFoundError extends SandboxError {
  constructor(path: string, operation: string = 'access') {
    super(`File not found: ${path}`, 'FILE_NOT_FOUND', path, operation, 404);
    this.name = 'FileNotFoundError';
  }
}

export class FilePermissionError extends SandboxError {
  constructor(path: string, operation: string) {
    super(`Permission denied: Cannot ${operation} ${path}`, 'FILE_PERMISSION_DENIED', path, operation, 403);
    this.name = 'FilePermissionError';
  }
}

export class FileAlreadyExistsError extends SandboxError {
  constructor(path: string) {
    super(`File already exists: ${path}`, 'FILE_ALREADY_EXISTS', path, 'create', 409);
    this.name = 'FileAlreadyExistsError';
  }
}

export class DirectoryNotEmptyError extends SandboxError {
  constructor(path: string) {
    super(`Directory not empty: ${path}`, 'DIRECTORY_NOT_EMPTY', path, 'delete', 409);
    this.name = 'DirectoryNotEmptyError';
  }
}

export class InvalidFilePathError extends SandboxError {
  constructor(path: string, reason: string) {
    super(`Invalid file path: ${path} (${reason})`, 'INVALID_FILE_PATH', path, 'validate', 400);
    this.name = 'InvalidFilePathError';
  }
}

export class DiskSpaceFullError extends SandboxError {
  constructor(path?: string) {
    super(`Disk space full${path ? ` when writing to ${path}` : ''}`, 'DISK_SPACE_FULL', path, 'write', 507);
    this.name = 'DiskSpaceFullError';
  }
}

// Command Operation Error Classes (🔥 Critical Priority)
export class CommandNotFoundError extends SandboxError {
  constructor(command: string) {
    super(`Command not found: ${command}`, 'COMMAND_NOT_FOUND', command, 'execute', 404);
    this.name = 'CommandNotFoundError';
  }
}

export class CommandPermissionError extends SandboxError {
  constructor(command: string) {
    super(`Permission denied: Cannot execute ${command}`, 'COMMAND_PERMISSION_DENIED', command, 'execute', 403);
    this.name = 'CommandPermissionError';
  }
}

export class CommandTimeoutError extends SandboxError {
  constructor(command: string, timeout: number) {
    super(`Command timed out after ${timeout}ms: ${command}`, 'COMMAND_TIMEOUT', command, 'execute', 408);
    this.name = 'CommandTimeoutError';
  }
}

export class CommandFailedError extends SandboxError {
  constructor(command: string, exitCode: number, stderr?: string) {
    const message = `Command failed with exit code ${exitCode}: ${command}${stderr ? `\n${stderr}` : ''}`;
    super(message, 'COMMAND_FAILED', command, 'execute', 500);
    this.name = 'CommandFailedError';
  }
}

export class InvalidCommandError extends SandboxError {
  constructor(command: string, reason: string) {
    super(`Invalid command: ${command} (${reason})`, 'INVALID_COMMAND', command, 'validate', 400);
    this.name = 'InvalidCommandError';
  }
}

// Process Operation Error Classes (⚠️ Medium Priority)
export class ProcessNotFoundError extends SandboxError {
  constructor(processId: string, operation: string = 'access') {
    super(`Process not found: ${processId}`, 'PROCESS_NOT_FOUND', processId, operation, 404);
    this.name = 'ProcessNotFoundError';
  }
}

export class ProcessStartError extends SandboxError {
  constructor(command: string, reason?: string) {
    const message = `Failed to start process: ${command}${reason ? ` (${reason})` : ''}`;
    super(message, 'PROCESS_START_FAILED', command, 'start', 500);
    this.name = 'ProcessStartError';
  }
}

export class ProcessAlreadyRunningError extends SandboxError {
  constructor(processId: string) {
    super(`Process already running: ${processId}`, 'PROCESS_ALREADY_RUNNING', processId, 'start', 409);
    this.name = 'ProcessAlreadyRunningError';
  }
}

export class ProcessKillError extends SandboxError {
  constructor(processId: string, reason?: string) {
    const message = `Failed to kill process: ${processId}${reason ? ` (${reason})` : ''}`;
    super(message, 'PROCESS_KILL_FAILED', processId, 'kill', 500);
    this.name = 'ProcessKillError';
  }
}

// Port Operation Error Classes (⚠️ Medium Priority)
export class PortAlreadyExposedError extends SandboxError {
  constructor(port: number) {
    super(`Port already exposed: ${port}`, 'PORT_ALREADY_EXPOSED', port.toString(), 'expose', 409);
    this.name = 'PortAlreadyExposedError';
  }
}

export class PortNotExposedError extends SandboxError {
  constructor(port: number) {
    super(`Port not exposed: ${port}`, 'PORT_NOT_EXPOSED', port.toString(), 'unexpose', 404);
    this.name = 'PortNotExposedError';
  }
}

export class InvalidPortError extends SandboxError {
  constructor(port: number, reason: string) {
    super(`Invalid port ${port}: ${reason}`, 'INVALID_PORT_NUMBER', port.toString(), 'validate', 400);
    this.name = 'InvalidPortError';
  }
}

export class PortInUseError extends SandboxError {
  constructor(port: number) {
    super(`Port in use: ${port}`, 'PORT_IN_USE', port.toString(), 'expose', 409);
    this.name = 'PortInUseError';
  }
}

export class ServiceNotRespondingError extends SandboxError {
  constructor(port: number) {
    super(`Service on port ${port} is not responding`, 'SERVICE_NOT_RESPONDING', port.toString(), 'proxy', 502);
    this.name = 'ServiceNotRespondingError';
  }
}

// Git Operation Error Classes (📈 Lower Priority)
export class GitRepositoryNotFoundError extends SandboxError {
  constructor(url: string) {
    super(`Git repository not found: ${url}`, 'GIT_REPOSITORY_NOT_FOUND', url, 'clone', 404);
    this.name = 'GitRepositoryNotFoundError';
  }
}

export class GitAuthError extends SandboxError {
  constructor(url: string) {
    super(`Git authentication failed: ${url}`, 'GIT_AUTH_FAILED', url, 'clone', 401);
    this.name = 'GitAuthError';
  }
}

export class GitCloneError extends SandboxError {
  constructor(url: string, reason?: string) {
    const message = `Failed to clone repository: ${url}${reason ? ` (${reason})` : ''}`;
    super(message, 'GIT_CLONE_FAILED', url, 'clone', 500);
    this.name = 'GitCloneError';
  }
}

export class GitCheckoutError extends SandboxError {
  constructor(branch: string, reason?: string) {
    const message = `Failed to checkout: ${branch}${reason ? ` (${reason})` : ''}`;
    super(message, 'GIT_CHECKOUT_FAILED', branch, 'checkout', 500);
    this.name = 'GitCheckoutError';
  }
}

export class InvalidGitUrlError extends SandboxError {
  constructor(url: string) {
    super(`Invalid Git URL: ${url}`, 'INVALID_GIT_URL', url, 'validate', 400);
    this.name = 'InvalidGitUrlError';
  }
}
```

#### Enhanced Client Error Handling with Comprehensive Mapping

```typescript
protected async handleErrorResponse(response: Response): Promise<never> {
  let errorData: ContainerErrorResponse;

  try {
    errorData = await response.json();
  } catch {
    errorData = {
      error: `HTTP error! status: ${response.status}`,
      code: 'HTTP_ERROR',
      httpStatus: response.status,
      operation: 'request'
    };
  }

  // Map error codes to specific error classes
  const error = this.createSpecificError(errorData);

  // Call error callback if provided
  this.options.onError?.(errorData.error, errorData.code);

  throw error;
}

private createSpecificError(errorData: ContainerErrorResponse): Error {
  const { error, code, details, operation } = errorData;

  // File Operation Errors (🔥 Critical Priority)
  switch (code) {
    case 'FILE_NOT_FOUND':
      return new FileNotFoundError(details || 'unknown', operation || 'access');
    case 'FILE_PERMISSION_DENIED':
      return new FilePermissionError(details || 'unknown', operation || 'access');
    case 'FILE_ALREADY_EXISTS':
      return new FileAlreadyExistsError(details || 'unknown');
    case 'DIRECTORY_NOT_EMPTY':
      return new DirectoryNotEmptyError(details || 'unknown');
    case 'INVALID_FILE_PATH':
      return new InvalidFilePathError(details || 'unknown', error);
    case 'DISK_SPACE_FULL':
      return new DiskSpaceFullError(details);

    // Command Operation Errors (🔥 Critical Priority)
    case 'COMMAND_NOT_FOUND':
      return new CommandNotFoundError(details || 'unknown');
    case 'COMMAND_PERMISSION_DENIED':
      return new CommandPermissionError(details || 'unknown');
    case 'COMMAND_TIMEOUT':
      // Parse timeout from error message or use default
      const timeout = this.parseTimeoutFromMessage(error) || 30000;
      return new CommandTimeoutError(details || 'unknown', timeout);
    case 'COMMAND_FAILED':
      // Parse exit code from error message
      const exitCode = this.parseExitCodeFromMessage(error) || 1;
      return new CommandFailedError(details || 'unknown', exitCode);
    case 'INVALID_COMMAND':
      return new InvalidCommandError(details || 'unknown', error);

    // Process Operation Errors (⚠️ Medium Priority)
    case 'PROCESS_NOT_FOUND':
      return new ProcessNotFoundError(details || 'unknown', operation || 'access');
    case 'PROCESS_START_FAILED':
      return new ProcessStartError(details || 'unknown', error);
    case 'PROCESS_ALREADY_RUNNING':
      return new ProcessAlreadyRunningError(details || 'unknown');
    case 'PROCESS_KILL_FAILED':
      return new ProcessKillError(details || 'unknown', error);

    // Port Operation Errors (⚠️ Medium Priority)
    case 'PORT_ALREADY_EXPOSED':
      return new PortAlreadyExposedError(parseInt(details || '0'));
    case 'PORT_NOT_EXPOSED':
      return new PortNotExposedError(parseInt(details || '0'));
    case 'INVALID_PORT_NUMBER':
      return new InvalidPortError(parseInt(details || '0'), error);
    case 'PORT_IN_USE':
      return new PortInUseError(parseInt(details || '0'));
    case 'SERVICE_NOT_RESPONDING':
      return new ServiceNotRespondingError(parseInt(details || '0'));

    // Git Operation Errors (📈 Lower Priority)
    case 'GIT_REPOSITORY_NOT_FOUND':
      return new GitRepositoryNotFoundError(details || 'unknown');
    case 'GIT_AUTH_FAILED':
      return new GitAuthError(details || 'unknown');
    case 'GIT_CLONE_FAILED':
      return new GitCloneError(details || 'unknown', error);
    case 'GIT_CHECKOUT_FAILED':
      return new GitCheckoutError(details || 'unknown', error);
    case 'INVALID_GIT_URL':
      return new InvalidGitUrlError(details || 'unknown');

    // Fallback to base SandboxError
    default:
      return new SandboxError(error, code, details, operation, errorData.httpStatus);
  }
}

// Helper methods for parsing context from error messages
private parseTimeoutFromMessage(message: string): number | null {
  const match = message.match(/timeout.*?(\d+)\s*ms/i);
  return match ? parseInt(match[1]) : null;
}

private parseExitCodeFromMessage(message: string): number | null {
  const match = message.match(/exit code\s*(\d+)/i);
  return match ? parseInt(match[1]) : null;
}
```

### 3. Detailed Implementation Plan

#### **Phase 1: Container Error Response Enhancement** (🔥 Critical - 2-3 days) ✅ **COMPLETED**

##### **1.1 File Operations Handler (`handler/file.ts`)** - Priority 1 ✅ **COMPLETED**
**Current Issues:** All file operations return generic 500 errors
**Target:** Map Node.js filesystem errors to specific codes with proper HTTP status

```typescript
// Example transformation for readFile handler
// BEFORE:
catch (error) {
  console.error(`[Server] Error reading file: ${path}`, error);
  return new Response(JSON.stringify({
    error: "Failed to read file",  // Generic message
    message: error instanceof Error ? error.message : "Unknown error"
  }), { status: 500 });  // Wrong status code
}

// AFTER:
catch (error: any) {
  console.error(`[Server] Error reading file: ${path}`, error);

  // Map Node.js error codes to specific responses
  if (error.code === 'ENOENT') {
    return new Response(JSON.stringify({
      error: `File not found: ${path}`,
      code: 'FILE_NOT_FOUND',
      operation: 'readFile',
      path: path,
      httpStatus: 404
    }), { status: 404 });
  }

  if (error.code === 'EACCES') {
    return new Response(JSON.stringify({
      error: `Permission denied: Cannot read ${path}`,
      code: 'FILE_PERMISSION_DENIED',
      operation: 'readFile',
      path: path,
      httpStatus: 403
    }), { status: 403 });
  }

  // ... handle ENOSPC, EBUSY, etc.
}
```

**Specific Tasks:**
- [x] Map ENOENT → FILE_NOT_FOUND (404)
- [x] Map EACCES → PERMISSION_DENIED (403)
- [x] Map EEXIST → FILE_EXISTS (409)
- [x] Map ENOSPC → NO_SPACE (507)
- [x] Map EBUSY → RESOURCE_BUSY (423)
- [x] Map EISDIR → IS_DIRECTORY (400)
- [x] Map ENOTDIR → NOT_DIRECTORY (400)
- [x] Apply to: readFile, writeFile, deleteFile, moveFile, renameFile, mkdir

##### **1.2 Command Execution Handler (`handler/exec.ts`)** - Priority 1 ✅ **COMPLETED**
**Current Issues:** All command failures return generic "Failed to execute command" (500)
**Target:** Distinguish between command not found, permissions, timeouts, and failures

```typescript
// Example transformation for execute handler
// Add timeout handling and error code detection
const executeCommand = (command: string, timeout: number = 30000) => {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, stdio: ['pipe', 'pipe', 'pipe'] });

    // Add timeout handling
    const timeoutId = setTimeout(() => {
      child.kill('SIGKILL');
      reject({
        code: 'COMMAND_TIMEOUT',
        message: `Command timed out after ${timeout}ms: ${command}`,
        httpStatus: 408
      });
    }, timeout);

    child.on('error', (error: any) => {
      clearTimeout(timeoutId);

      // Map spawn errors to specific codes
      if (error.code === 'ENOENT') {
        reject({
          code: 'COMMAND_NOT_FOUND',
          message: `Command not found: ${command}`,
          httpStatus: 404
        });
      } else if (error.code === 'EACCES') {
        reject({
          code: 'COMMAND_PERMISSION_DENIED',
          message: `Permission denied: Cannot execute ${command}`,
          httpStatus: 403
        });
      }
    });

    child.on('close', (exitCode) => {
      clearTimeout(timeoutId);

      if (exitCode !== 0) {
        reject({
          code: 'COMMAND_FAILED',
          message: `Command failed with exit code ${exitCode}: ${command}`,
          exitCode,
          httpStatus: 500
        });
      } else {
        resolve({ success: true, exitCode: 0 });
      }
    });
  });
};
```

**Specific Tasks:**
- [x] Map ENOENT spawn errors → COMMAND_NOT_FOUND (404)
- [x] Map EACCES spawn errors → COMMAND_PERMISSION_DENIED (403)
- [x] Map general command failures → COMMAND_EXECUTION_ERROR (500)
- [x] Apply to both execute and executeStream handlers
- [ ] Add timeout handling with COMMAND_TIMEOUT (408) - Future enhancement
- [ ] Add command validation → INVALID_COMMAND (400) - Future enhancement

##### **1.3 Process Operations Handler (`handler/process.ts`)** - Priority 2 ✅ **COMPLETED**
**Current Status:** ✅ Already good messages for most operations, need error codes
**Target:** Add error codes while preserving good existing messages

**Specific Tasks:**
- [x] Add error codes to existing good messages (getProcess, killProcess, etc.)
- [x] Improve startProcess error handling with specific failure reasons
- [x] Apply PROCESS_NOT_FOUND with proper error structure
- [ ] Improve listProcesses error handling - Future enhancement
- [ ] Add PROCESS_ALREADY_RUNNING detection for background processes - Future enhancement

##### **1.4 Port Operations Handler (`handler/ports.ts`)** - Priority 2 ✅ **COMPLETED**
**Current Status:** ⚠️ Mixed quality, some good messages
**Target:** Standardize error codes and improve generic error messages

**Specific Tasks:**
- [x] Add error codes to existing good messages
- [x] Improve generic "Failed to expose port" with specific reasons
- [x] Add PORT_ALREADY_EXPOSED detection for duplicate exposures
- [x] Enhance proxy error handling with SERVICE_NOT_RESPONDING
- [x] Standardize all port validation errors with INVALID_PORT_NUMBER
- [ ] Add PORT_IN_USE detection when port binding fails - Future enhancement

##### **1.5 Git Operations Handler (`handler/git.ts`)** - Priority 3 ✅ **COMPLETED**
**Current Status:** Basic validation, generic failure messages
**Target:** Add specific error codes for different git failure scenarios

**Specific Tasks:**
- [x] Add error codes to existing validation (INVALID_GIT_URL)
- [x] Parse git command output to distinguish auth vs network vs repository errors
- [x] Add GIT_BRANCH_NOT_FOUND for checkout failures
- [x] Add GIT_AUTH_FAILED, GIT_REPOSITORY_NOT_FOUND, GIT_NETWORK_ERROR
- [x] Map git failures to specific error types (GIT_CLONE_FAILED, GIT_CHECKOUT_FAILED)

#### **Phase 2: Client Error Class Implementation** (⚠️ Medium - 1-2 days) ✅ **COMPLETED**

##### **2.1 Add Comprehensive Error Classes (`src/errors.ts`)** ✅ **COMPLETED**
- [x] Add all file operation error classes (FileSystemError, FileNotFoundError, etc.)
- [x] Add all command operation error classes (CommandError, CommandNotFoundError, etc.)
- [x] Add all process operation error classes (ProcessError, ProcessNotFoundError, etc.)
- [x] Add all port operation error classes (PortError, PortAlreadyExposedError, etc.)
- [x] Add all git operation error classes (GitError, GitRepositoryNotFoundError, GitAuthenticationError, etc.)
- [x] Enhance base SandboxError with operation, details, and httpStatus fields

##### **2.2 Update Base Client Error Handling (`src/clients/base-client.ts`)** ✅ **COMPLETED**
- [x] Replace current handleErrorResponse with comprehensive error mapping
- [x] Add error mapping utility integration with mapContainerError function
- [x] Update error callback to include error codes
- [ ] Add helper methods for parsing context from error messages - Future enhancement

##### **2.3 Update Type Definitions (`src/clients/types.ts`)** ✅ **COMPLETED**
- [x] ErrorResponse interface already supports code and operation fields
- [x] All new error classes exported from main index
- [ ] Add httpStatus field to ErrorResponse - Future enhancement

#### **Phase 3: Testing & Validation** (📈 Medium - 1-2 days)

##### **3.1 Unit Tests for Error Scenarios**
- [ ] File operation error tests (ENOENT, EACCES, EEXIST, etc.)
- [ ] Command operation error tests (not found, timeout, permission, etc.)
- [ ] Process operation error tests (not found, start failed, etc.)
- [ ] Port operation error tests (already exposed, invalid number, etc.)
- [ ] Git operation error tests (auth failed, repo not found, etc.)

##### **3.2 Integration Tests for Error Propagation**
- [ ] Container → Client error flow tests
- [ ] Verify proper error class instantiation
- [ ] Verify HTTP status code mapping
- [ ] Test error callback functionality

##### **3.3 End-to-End Error Testing**
- [ ] Test error scenarios in example applications
- [ ] Verify user-friendly error messages
- [ ] Test error handling in streaming operations
- [ ] Performance impact testing

#### **Phase 4: Documentation & Migration** (📈 Low - 1 day)

##### **4.1 Update Documentation**
- [ ] Add error handling examples to README
- [ ] Create error handling guide for SDK users
- [ ] Document all error codes and their meanings
- [ ] Add migration guide for error handling changes

##### **4.2 Backward Compatibility**
- [ ] Ensure existing error handling continues to work
- [ ] Add deprecation notices for generic error patterns
- [ ] Provide migration path for users who want specific error types

### 4. Benefits

#### For Developers
- **Clear debugging**: Know exactly what went wrong and why
- **Programmatic handling**: Can catch specific error types and handle appropriately
- **Better UX**: Show meaningful error messages to end users

#### For Operations
- **Structured logging**: Error codes enable better monitoring and alerting
- **Debugging**: Faster issue resolution with specific error contexts
- **Metrics**: Track error rates by type for system health monitoring

#### Example Improved Error Flow
```
Container: ENOENT: no such file or directory, open '/app/hello.txt'
↓
Container Response: {
  "error": "File not found: /app/hello.txt",
  "code": "FILE_NOT_FOUND",
  "httpStatus": 404,
  "operation": "readFile",
  "path": "/app/hello.txt"
}
↓
Client Error: FileNotFoundError: File not found: /app/hello.txt
```

## **Success Criteria & Metrics**

### **Container-Level Improvements**
- [ ] **File Operations:** All filesystem errors mapped to specific codes (FILE_NOT_FOUND, FILE_PERMISSION_DENIED, etc.)
- [ ] **Command Operations:** All execution errors mapped to specific codes (COMMAND_NOT_FOUND, COMMAND_TIMEOUT, etc.)
- [ ] **Process Operations:** Error codes added to existing good messages (PROCESS_NOT_FOUND, etc.)
- [ ] **Port Operations:** Standardized error codes for all scenarios (PORT_ALREADY_EXPOSED, etc.)
- [ ] **Git Operations:** Specific error codes for different failure types (GIT_AUTH_FAILED, etc.)
- [ ] **HTTP Status Codes:** Proper mapping (404 for not found, 403 for permissions, 409 for conflicts, etc.)
- [ ] **Error Messages:** Include helpful context without exposing sensitive system information

### **Client-Level Improvements**
- [ ] **Error Classes:** Client throws appropriate error classes instead of generic Error objects
- [ ] **Error Mapping:** All container error codes mapped to specific client error classes
- [ ] **Context Preservation:** Error details, operation context, and HTTP status preserved through client
- [ ] **Backward Compatibility:** Existing error handling continues to work unchanged

### **Testing & Quality**
- [ ] **Unit Test Coverage:** >90% coverage for all error scenarios across all operation types
- [ ] **Integration Tests:** Complete container → client error flow testing
- [ ] **Error Propagation:** Verified proper error class instantiation and context preservation
- [ ] **Performance Impact:** No measurable performance degradation from enhanced error handling

### **Documentation & Usability**
- [ ] **API Documentation:** All error codes documented with examples and use cases
- [ ] **Error Handling Guide:** Comprehensive guide for SDK users on handling specific error types
- [ ] **Migration Examples:** Clear examples of how to catch and handle specific error types
- [ ] **Example Applications:** Updated to demonstrate proper error handling patterns

### **Measurable Outcomes**

**Before Implementation:**
```
❌ Generic "Failed to read file" errors
❌ All failures return HTTP 500 status
❌ No programmatic error handling possible
❌ Users can't distinguish between different failure types
❌ Poor debugging experience with minimal context
```

**After Implementation:**
```
✅ "File not found: /app/hello.txt" (FileNotFoundError, 404)
✅ "Permission denied: Cannot read /app/secret.txt" (FilePermissionError, 403)
✅ "Command not found: invalidcommand" (CommandNotFoundError, 404)
✅ "Command timed out after 30000ms: longrunning" (CommandTimeoutError, 408)
✅ "Process not found: abc123" (ProcessNotFoundError, 404)
✅ Rich error context for debugging and programmatic handling
```

**Error Handling Quality Score:**
- **Current State:** 2/10 (Generic messages, wrong HTTP codes, no programmatic handling)
- **Target State:** 9/10 (Specific messages, correct HTTP codes, full error class hierarchy)

## **Future Enhancements & Roadmap**

### **Phase 5: Advanced Error Features** (Future)

#### **Error Recovery & Resilience**
1. **Error Recovery Suggestions**: Include suggested actions in error responses
   ```typescript
   {
     error: "File not found: /app/config.json",
     code: "FILE_NOT_FOUND",
     suggestions: [
       "Create the file with default configuration",
       "Check if the file path is correct",
       "Verify file permissions in the parent directory"
     ]
   }
   ```

2. **Automatic Retry Logic**: Built-in retry for transient errors with exponential backoff
   ```typescript
   // Auto-retry for transient errors like EBUSY, network issues
   const retryableErrors = ['DISK_SPACE_FULL', 'FILE_BUSY', 'GIT_NETWORK_ERROR'];
   if (retryableErrors.includes(error.code)) {
     await retryWithBackoff(operation, { maxRetries: 3, baseDelay: 1000, maxDelay: 5000 });
   }
   ```

3. **Circuit Breaker Pattern**: Prevent cascading failures by temporarily disabling failing operations

#### **Monitoring & Analytics**
4. **Structured Error Reporting**: Detailed error metrics for monitoring and alerting
   ```typescript
   interface ErrorTelemetry {
     errorCode: string;
     operation: string;
     frequency: number;
     impact: 'low' | 'medium' | 'high';
     resolution: string;
     firstSeen: string;
     lastSeen: string;
   }
   ```

5. **Error Rate Monitoring**: Track error rates by operation type and error code
6. **Performance Impact Tracking**: Monitor how errors affect overall system performance

#### **User Experience Enhancements**
7. **Localization Support**: Multi-language error messages for international users
8. **User-Friendly Messages**: Context-aware error messages for different user skill levels
9. **Interactive Error Resolution**: Guided troubleshooting workflows

#### **Developer Experience**
10. **Debug Mode**: Enhanced error context for development environments
    ```typescript
    // Debug mode includes stack traces, system state, related operations
    {
      error: "File not found: /app/hello.txt",
      code: "FILE_NOT_FOUND",
      debug: {
        stackTrace: "...",
        systemState: { diskSpace: "50GB free", permissions: "rwxr-xr-x" },
        relatedOperations: ["Previous writeFile to /app/", "Current working directory: /app"]
      }
    }
    ```

11. **Error Documentation Generator**: Auto-generate error handling documentation from code
12. **Error Playground**: Interactive environment for testing error scenarios

### **Integration Opportunities**

#### **Cloudflare Platform Integration**
- **Workers Analytics**: Integration with Cloudflare Workers Analytics for error tracking
- **Logs & Metrics**: Stream structured error data to Cloudflare Logs
- **Alert Manager**: Integration with Cloudflare alerting for critical error patterns

#### **Third-Party Integrations**
- **Sentry/DataDog**: Structured error reporting to external monitoring platforms
- **Slack/Discord**: Real-time error notifications for development teams
- **GitHub Issues**: Automatic issue creation for recurring error patterns

### **Long-term Vision**

**Intelligent Error Handling System:**
1. **Machine Learning Error Classification**: AI-powered error categorization and resolution suggestions
2. **Predictive Error Prevention**: Identify conditions that lead to errors before they occur
3. **Self-Healing Capabilities**: Automatic recovery from common error scenarios
4. **Context-Aware Error Messages**: Dynamic error messages based on user context and history

**Goal:** Transform the SDK from reactive error handling to proactive error prevention and intelligent recovery, making it the gold standard for developer experience in serverless computing platforms.

---

## **🔧 Maintainability & Architecture Considerations**

### **Simple, Clean Design Principles**

You're absolutely right to call out over-engineering. Here's a **clean, simple, maintainable approach** without unnecessary abstractions:

#### **1. Simple Error Mapping Utilities**

**Problem:** Scattered error handling logic across multiple files.

**Solution:** Simple utility functions, not complex configuration systems:

```typescript
// packages/sandbox/container_src/error-utils.ts
export interface ContainerErrorResponse {
  error: string;
  code: string;
  operation: string;
  httpStatus: number;
  details?: string;
  path?: string;
}

// Simple mapping functions - easy to extend manually
export function mapFileSystemError(error: any, operation: string, path: string): ContainerErrorResponse {
  // Handle common Node.js filesystem errors
  switch (error.code) {
    case 'ENOENT':
      return {
        error: `File not found: ${path}`,
        code: 'FILE_NOT_FOUND',
        operation,
        httpStatus: 404,
        details: path,
        path
      };

    case 'EACCES':
      return {
        error: `Permission denied: Cannot ${operation} ${path}`,
        code: 'FILE_PERMISSION_DENIED',
        operation,
        httpStatus: 403,
        details: path,
        path
      };

    case 'ENOSPC':
      return {
        error: `Disk space full when writing to ${path}`,
        code: 'DISK_SPACE_FULL',
        operation,
        httpStatus: 507,
        details: path,
        path
      };

    default:
      // Easy to handle custom cases that don't fit the pattern
      return {
        error: `File operation failed: ${error.message}`,
        code: 'FILE_OPERATION_FAILED',
        operation,
        httpStatus: 500,
        details: error.message
      };
  }
}

export function mapCommandError(error: any, command: string): ContainerErrorResponse {
  // Handle command execution errors
  if (error.code === 'ENOENT') {
    return {
      error: `Command not found: ${command}`,
      code: 'COMMAND_NOT_FOUND',
      operation: 'execute',
      httpStatus: 404,
      details: command
    };
  }

  // Easy to add more cases as needed
  return {
    error: `Command failed: ${error.message}`,
    code: 'COMMAND_FAILED',
    operation: 'execute',
    httpStatus: 500,
    details: error.message
  };
}
```

**Benefits:**
- ✅ **Simple functions** - easy to understand and modify
- ✅ **Easy to extend** - just add new cases or create new functions
- ✅ **No rigid configuration** - handles custom cases naturally
- ✅ **Clear and testable** - straightforward to unit test

#### **2. Minimal Base Handler (Optional)**

**Problem:** Duplicate error handling patterns across handlers.

**Solution:** Simple base class to avoid duplication, but easy to override:

```typescript
// packages/sandbox/container_src/handlers/base-handler.ts
export abstract class BaseHandler {
  protected createErrorResponse(errorData: ContainerErrorResponse): Response {
    console.error(`[Server] ${errorData.operation} error:`, errorData.error);

    return new Response(JSON.stringify(errorData), {
      status: errorData.httpStatus,
      headers: {
        'Content-Type': 'application/json',
        ...this.getCorsHeaders()
      }
    });
  }

  protected createSuccessResponse(data: any): Response {
    return new Response(JSON.stringify(data), {
      headers: {
        'Content-Type': 'application/json',
        ...this.getCorsHeaders()
      }
    });
  }

  protected abstract getCorsHeaders(): Record<string, string>;
}
```

**Usage - easy to customize when needed:**
```typescript
// packages/sandbox/container_src/handler/file.ts
export async function handleReadFileRequest(req: Request, corsHeaders: Record<string, string>): Promise<Response> {
  try {
    const body = await req.json() as ReadFileRequest;
    const { path } = body;

    // Validation logic...

    const content = await readFile(path, 'utf-8');

    return new Response(JSON.stringify({
      content,
      path,
      success: true,
      timestamp: new Date().toISOString()
    }), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });

  } catch (error: any) {
    // Simple error mapping - easy to customize for special cases
    const errorResponse = mapFileSystemError(error, 'readFile', body?.path || 'unknown');

    return new Response(JSON.stringify(errorResponse), {
      status: errorResponse.httpStatus,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
}
```

#### **3. Manual Error Classes - Clean Patterns**

**Problem:** Need consistent error classes but want flexibility.

**Solution:** Manual classes following clear patterns - easy to extend:

```typescript
// packages/sandbox/src/errors.ts
export class SandboxError extends Error {
  constructor(
    message: string,
    public code?: string,
    public details?: string,
    public operation?: string,
    public httpStatus?: number
  ) {
    super(message);
    this.name = 'SandboxError';
  }
}

// File operation errors - follow consistent pattern but easy to customize
export class FileNotFoundError extends SandboxError {
  constructor(path: string, operation: string = 'access') {
    super(`File not found: ${path}`, 'FILE_NOT_FOUND', path, operation, 404);
    this.name = 'FileNotFoundError';
  }
}

export class FilePermissionError extends SandboxError {
  constructor(path: string, operation: string) {
    super(`Permission denied: Cannot ${operation} ${path}`, 'FILE_PERMISSION_DENIED', path, operation, 403);
    this.name = 'FilePermissionError';
  }
}

// Command operation errors
export class CommandNotFoundError extends SandboxError {
  constructor(command: string) {
    super(`Command not found: ${command}`, 'COMMAND_NOT_FOUND', command, 'execute', 404);
    this.name = 'CommandNotFoundError';
  }
}

// Easy to add custom error classes for special cases
export class CustomValidationError extends SandboxError {
  constructor(message: string, field: string) {
    super(message, 'VALIDATION_ERROR', field, 'validate', 400);
    this.name = 'CustomValidationError';
  }
}
```

#### **4. Simple Client Error Mapping**

**Problem:** Client needs to map container errors to specific error classes.

**Solution:** Simple switch statement - easy to extend and customize:

```typescript
// packages/sandbox/src/clients/base-client.ts
protected async handleErrorResponse(response: Response): Promise<never> {
  let errorData: ContainerErrorResponse;

  try {
    errorData = await response.json();
  } catch {
    // Simple fallback
    throw new SandboxError(`HTTP error! status: ${response.status}`, 'HTTP_ERROR');
  }

  // Simple error mapping - easy to add new cases
  const error = this.createSpecificError(errorData);
  this.options.onError?.(errorData.error, errorData.code);
  throw error;
}

private createSpecificError(errorData: ContainerErrorResponse): Error {
  const { error, code, details, operation } = errorData;

  // Simple switch - easy to extend
  switch (code) {
    case 'FILE_NOT_FOUND':
      return new FileNotFoundError(details || 'unknown', operation || 'access');
    case 'FILE_PERMISSION_DENIED':
      return new FilePermissionError(details || 'unknown', operation || 'access');
    case 'COMMAND_NOT_FOUND':
      return new CommandNotFoundError(details || 'unknown');

    // Easy to add special handling for custom cases
    case 'CUSTOM_VALIDATION_ERROR':
      return new CustomValidationError(error, details || 'unknown');

    default:
      return new SandboxError(error, code, details, operation, errorData.httpStatus);
  }
}
```

#### **5. Straightforward Testing Patterns**

**Problem:** Need comprehensive error testing without over-engineering.

**Solution:** Simple, clear test patterns:

```typescript
// packages/sandbox/src/__tests__/error-handling.test.ts
describe('Error Handling', () => {
  describe('File System Errors', () => {
    it('should map ENOENT to FILE_NOT_FOUND', () => {
      const nodeError = { code: 'ENOENT', message: 'file not found' };
      const result = mapFileSystemError(nodeError, 'readFile', '/test.txt');

      expect(result.code).toBe('FILE_NOT_FOUND');
      expect(result.httpStatus).toBe(404);
      expect(result.error).toBe('File not found: /test.txt');
    });

    it('should handle custom cases', () => {
      const customError = { code: 'CUSTOM', message: 'custom error' };
      const result = mapFileSystemError(customError, 'readFile', '/test.txt');

      expect(result.code).toBe('FILE_OPERATION_FAILED');
      expect(result.httpStatus).toBe(500);
    });
  });

  describe('Client Error Mapping', () => {
    it('should create FileNotFoundError for FILE_NOT_FOUND code', () => {
      const errorData = {
        error: 'File not found: /test.txt',
        code: 'FILE_NOT_FOUND',
        operation: 'readFile',
        httpStatus: 404,
        details: '/test.txt'
      };

      const client = new BaseClient({ sandboxId: 'test' });
      const error = client['createSpecificError'](errorData);

      expect(error).toBeInstanceOf(FileNotFoundError);
      expect(error.message).toBe('File not found: /test.txt');
    });
  });
});
```

### **Key Maintainability Benefits**

#### **Easy to Extend**
- ✅ **Add new error types:** Just add a case to the mapping function
- ✅ **Custom cases:** Easy to handle special scenarios that don't fit patterns
- ✅ **New operations:** Create new mapping functions as needed

#### **Simple to Understand**
- ✅ **No complex abstractions** - straightforward functions and classes
- ✅ **Clear patterns** - consistent but not rigid
- ✅ **Easy debugging** - simple code paths to follow

#### **Flexible Architecture**
- ✅ **Override when needed** - base patterns but easy to customize
- ✅ **Gradual adoption** - can apply to some operations first
- ✅ **No breaking changes** - additive improvements only

### **Migration Strategy**

#### **Simple Feature Flag**
```typescript
// Just use environment variable for gradual rollout
const USE_ENHANCED_ERRORS = process.env.ENHANCED_ERRORS === 'true';

try {
  // ... operation logic
} catch (error) {
  if (USE_ENHANCED_ERRORS) {
    const errorResponse = mapFileSystemError(error, 'readFile', path);
    return new Response(JSON.stringify(errorResponse), { status: errorResponse.httpStatus });
  } else {
    // Keep existing logic
    return new Response(JSON.stringify({ error: 'Failed to read file' }), { status: 500 });
  }
}
```

This approach is **clean, simple, maintainable** without over-engineering! 🎯