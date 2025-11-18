# OpenAI Agents Adapter

The Cloudflare Sandbox SDK provides adapters that integrate with the [OpenAI Agents SDK](https://github.com/openai/agents) to enable AI agents to execute shell commands and perform file operations inside sandboxed environments.

## Overview

The OpenAI Agents adapter consists of two main components:

- **`Shell`**: Implements the OpenAI Agents `Shell` interface, allowing agents to execute shell commands in the sandbox
- **`Editor`**: Implements the OpenAI Agents `Editor` interface, enabling agents to create, update, and delete files using patch operations

Both adapters automatically collect results from operations, making it easy to track what commands were executed and what files were modified during an agent session.

## Installation

The adapters are part of the `@cloudflare/sandbox` package:

```typescript
import { getSandbox } from '@cloudflare/sandbox';
import { Shell, Editor } from '@cloudflare/sandbox/openai';
import { Agent, applyPatchTool, run, shellTool } from '@openai/agents';
```

## Basic Usage

### Setting Up an Agent

```typescript
import { getSandbox } from '@cloudflare/sandbox';
import { Shell, Editor } from '@cloudflare/sandbox/openai';
import { Agent, applyPatchTool, run, shellTool } from '@openai/agents';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Get a sandbox instance
    const sandbox = getSandbox(env.Sandbox, 'workspace-session');

    // Create shell adapter (executes commands in /workspace by default)
    const shell = new Shell(sandbox);

    // Create editor adapter (operates on /workspace by default)
    const editor = new Editor(sandbox, '/workspace');

    // Create an agent with both tools
    const agent = new Agent({
      name: 'Sandbox Assistant',
      model: 'gpt-4',
      instructions:
        'You can execute shell commands and edit files in the workspace.',
      tools: [
        shellTool({ shell, needsApproval: false }),
        applyPatchTool({ editor, needsApproval: false })
      ]
    });

    // Run the agent with user input
    const { input } = await request.json();
    const result = await run(agent, input);

    // Access collected results
    const commandResults = shell.results;
    const fileOperations = editor.results;

    return new Response(
      JSON.stringify({
        naturalResponse: result.finalOutput,
        commandResults,
        fileOperations
      }),
      {
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }
};
```

## Shell Adapter

The `Shell` class adapts Cloudflare Sandbox `exec` calls to the OpenAI Agents `Shell` contract.

### Features

- Executes commands sequentially in the sandbox
- Preserves working directory (`/workspace` by default)
- Handles timeouts and errors gracefully
- Collects results with timestamps for each command
- Separates stdout and stderr output

### Command Results

Each executed command is automatically collected in `shell.results`:

```typescript
interface CommandResult {
  command: string; // The command that was executed
  stdout: string; // Standard output
  stderr: string; // Standard error
  exitCode: number | null; // Exit code (null for timeouts)
  timestamp: number; // Unix timestamp in milliseconds
}
```

### Example: Inspecting Workspace

```typescript
const shell = new Shell(sandbox);

// Agent can execute commands like:
// - ls -la
// - cat package.json
// - git status
// - npm install

// After agent execution, access results:
shell.results.forEach((result) => {
  console.log(`Command: ${result.command}`);
  console.log(`Exit code: ${result.exitCode}`);
  console.log(`Output: ${result.stdout}`);
});
```

### Error Handling

The Shell adapter handles various error scenarios:

- **Command failures**: Non-zero exit codes are captured in `exitCode`
- **Timeouts**: Commands that exceed the timeout return `exitCode: null` and `outcome.type: 'timeout'`
- **Network errors**: HTTP/network errors are caught and logged

## Editor Adapter

The `Editor` class implements file operations using the OpenAI Agents patch-based editing system.

### Features

- Creates files with initial content using diffs
- Updates existing files by applying diffs
- Deletes files
- Automatically creates parent directories when needed
- Validates paths to prevent operations outside the workspace
- Collects results with timestamps for each operation

### File Operation Results

Each file operation is automatically collected in `editor.results`:

```typescript
interface FileOperationResult {
  operation: 'create' | 'update' | 'delete';
  path: string; // Relative path from workspace root
  status: 'completed' | 'failed';
  output: string; // Human-readable status message
  error?: string; // Error message if status is 'failed'
  timestamp: number; // Unix timestamp in milliseconds
}
```

### Path Resolution

The Editor enforces security by:

- Resolving relative paths within the workspace root (`/workspace` by default)
- Preventing path traversal attacks (e.g., `../../../etc/passwd`)
- Normalizing path separators and removing redundant segments
- Throwing errors for operations outside the workspace

### Example: Creating and Editing Files

```typescript
const editor = new Editor(sandbox, '/workspace');

// Agent can use apply_patch tool to:
// - Create new files with content
// - Update existing files with diffs
// - Delete files

// After agent execution, access results:
editor.results.forEach((result) => {
  console.log(`${result.operation}: ${result.path}`);
  console.log(`Status: ${result.status}`);
  if (result.error) {
    console.log(`Error: ${result.error}`);
  }
});
```

### Custom Workspace Root

You can specify a custom workspace root:

```typescript
// Use a different root directory
const editor = new Editor(sandbox, '/custom/workspace');
```

## Complete Example

Here's a complete example showing how to integrate the adapters in a Cloudflare Worker:

```typescript
import { getSandbox } from '@cloudflare/sandbox';
import { Shell, Editor } from '@cloudflare/sandbox/openai';
import { Agent, applyPatchTool, run, shellTool } from '@openai/agents';

async function handleRunRequest(request: Request, env: Env): Promise<Response> {
  try {
    const { input } = await request.json();

    if (!input || typeof input !== 'string') {
      return new Response(
        JSON.stringify({ error: 'Missing or invalid input field' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Get sandbox instance (reused for both shell and editor)
    const sandbox = getSandbox(env.Sandbox, 'workspace-session');

    // Create adapters
    const shell = new Shell(sandbox);
    const editor = new Editor(sandbox, '/workspace');

    // Create agent with tools
    const agent = new Agent({
      name: 'Sandbox Studio',
      model: 'gpt-4',
      instructions: `
        You can execute shell commands and edit files in the workspace.
        Use shell commands to inspect the repository and the apply_patch tool
        to create, update, or delete files. Keep responses concise and include
        command output when helpful.
      `,
      tools: [
        shellTool({ shell, needsApproval: false }),
        applyPatchTool({ editor, needsApproval: false })
      ]
    });

    // Run the agent
    const result = await run(agent, input);

    // Format response with sorted results
    const response = {
      naturalResponse: result.finalOutput || null,
      commandResults: shell.results.sort((a, b) => a.timestamp - b.timestamp),
      fileOperations: editor.results.sort((a, b) => a.timestamp - b.timestamp)
    };

    return new Response(JSON.stringify(response), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : 'Internal server error',
        naturalResponse: 'An error occurred while processing your request.',
        commandResults: [],
        fileOperations: []
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/run' && request.method === 'POST') {
      return handleRunRequest(request, env);
    }

    return new Response('Not found', { status: 404 });
  }
};
```

## Result Tracking

Both adapters automatically track all operations with timestamps. This makes it easy to:

- **Audit operations**: See exactly what commands were run and files were modified
- **Debug issues**: Identify which operation failed and when
- **Build UIs**: Display a timeline of agent actions
- **Logging**: Export operation history for analysis

### Combining Results

You can combine and sort results from both adapters:

```typescript
const allResults = [
  ...shell.results.map((r) => ({ type: 'command' as const, ...r })),
  ...editor.results.map((r) => ({ type: 'file' as const, ...r }))
].sort((a, b) => a.timestamp - b.timestamp);

// allResults is now a chronological list of all operations
```

## Best Practices

1. **Reuse sandbox instances**: Create one sandbox instance and share it between Shell and Editor
2. **Set appropriate timeouts**: Configure command timeouts based on expected operation duration
3. **Handle errors gracefully**: Check `status` fields in results and handle `failed` operations
4. **Validate paths**: The Editor already validates paths, but be aware of workspace boundaries
5. **Monitor resource usage**: Large command outputs or file operations may impact performance

## Limitations

- **Working directory**: Shell operations always execute in `/workspace` (or the configured root)
- **Path restrictions**: File operations are restricted to the workspace root
- **Sequential execution**: Commands execute sequentially, not in parallel
- **Timeout handling**: Timeouts stop further command execution in a batch

## See Also

- [OpenAI Agents SDK Documentation](https://github.com/openai/openai-agents-js/)
- [Session Execution Architecture](./SESSION_EXECUTION.md) - Understanding how commands execute in sandboxes
- [Example Implementation](../examples/openai-agents/src/index.ts) - Full working example
