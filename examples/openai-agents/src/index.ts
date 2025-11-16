import { Sandbox, getSandbox } from '@cloudflare/sandbox';
export { Sandbox }; // export the Sandbox class for the worker

import {
  Agent,
  run,
  Shell,
  ShellAction,
  ShellResult,
  ShellOutputResult,
  shellTool,
  applyPatchTool,
  ApplyPatchOperation,
  ApplyPatchResult,
  applyDiff,
  Editor
} from '@openai/agents';

import { logger } from './logger';
import type { CommandResult, FileOperationResult } from './types';

class SandboxShell implements Shell {
  private cwd: string = '/workspace';
  public results: CommandResult[] = [];

  constructor(private readonly sandbox: Sandbox) {}

  async run(action: ShellAction): Promise<ShellResult> {
    logger.debug('SandboxShell.run called', {
      commands: action.commands,
      timeout: action.timeoutMs
    });
    const output: ShellResult['output'] = [];

    for (const command of action.commands) {
      logger.debug('Executing command', { command, cwd: this.cwd });
      let stdout = '';
      let stderr = '';
      let exitCode: number | null = 0;
      let outcome: ShellOutputResult['outcome'] = {
        type: 'exit',
        exitCode: 0
      };
      try {
        const result = await this.sandbox.exec(command, {
          timeout: action.timeoutMs,
          cwd: this.cwd
        });
        stdout = result.stdout;
        stderr = result.stderr;
        exitCode = result.exitCode;
        // exec returns a result even for failed commands, so check success field
        // Timeout would be indicated by a specific error or exit code
        outcome = { type: 'exit', exitCode };

        logger.debug('Command executed successfully', {
          command,
          exitCode,
          stdoutLength: stdout.length,
          stderrLength: stderr.length
        });

        // Log warnings for non-zero exit codes or stderr output
        if (exitCode !== 0) {
          logger.warn(`Command failed with exit code ${exitCode}`, {
            command,
            stderr
          });
        } else if (stderr) {
          logger.warn(`Command produced stderr output`, { command, stderr });
        } else {
          logger.info(`Command completed successfully`, { command });
        }
      } catch (error: any) {
        // Handle network/HTTP errors or timeout errors
        exitCode = typeof error?.exitCode === 'number' ? error.exitCode : null;
        stdout = error?.stdout ?? '';
        stderr = error?.stderr ?? '';

        // Check if it's a timeout error
        const errorMessage = error?.message ?? '';
        if (
          errorMessage.includes('timeout') ||
          errorMessage.includes('Timeout') ||
          errorMessage.includes('timed out')
        ) {
          logger.error(`Command timed out`, {
            command,
            timeout: action.timeoutMs
          });
          outcome = { type: 'timeout' };
        } else {
          logger.error(`Error executing command`, {
            command,
            error: errorMessage || error,
            exitCode
          });
          outcome = { type: 'exit', exitCode: exitCode ?? 1 };
        }
      }
      output.push({
        command,
        stdout,
        stderr,
        outcome
      });

      // Collect results for API responses
      const collectedExitCode =
        outcome.type === 'exit' ? outcome.exitCode : null;
      const timestamp = Date.now();
      this.results.push({
        command: String(command),
        stdout: String(stdout),
        stderr: String(stderr),
        exitCode: collectedExitCode,
        timestamp
      });
      logger.debug('Result collected', {
        command,
        exitCode: collectedExitCode,
        timestamp
      });

      if (outcome.type === 'timeout') {
        logger.warn('Breaking command loop due to timeout');
        break;
      }
    }

    logger.debug('SandboxShell.run completed', {
      totalCommands: action.commands.length,
      resultsCount: this.results.length
    });
    return {
      output,
      providerData: {
        working_directory: this.cwd
      }
    };
  }
}

class WorkspaceEditor implements Editor {
  public results: FileOperationResult[] = [];

  constructor(
    private readonly sandbox: Sandbox,
    private readonly root: string = '/workspace'
  ) {}

  async createFile(
    operation: Extract<ApplyPatchOperation, { type: 'create_file' }>
  ): Promise<ApplyPatchResult | void> {
    const targetPath = this.resolve(operation.path);
    logger.debug('WorkspaceEditor.createFile called', {
      path: operation.path,
      targetPath
    });

    try {
      // Create parent directory if needed
      const dirPath = this.getDirname(targetPath);
      if (dirPath !== this.root && dirPath !== '/') {
        logger.debug('Creating parent directory', { dirPath });
        await this.sandbox.mkdir(dirPath, { recursive: true });
      }

      const content = applyDiff('', operation.diff, 'create');
      logger.debug('Writing file content', {
        path: targetPath,
        contentLength: content.length
      });
      await this.sandbox.writeFile(targetPath, content, { encoding: 'utf-8' });
      const timestamp = Date.now();
      const result: FileOperationResult = {
        operation: 'create',
        path: operation.path,
        status: 'completed',
        output: `Created ${operation.path}`,
        timestamp
      };
      this.results.push(result);
      logger.info('File created successfully', {
        path: operation.path,
        timestamp
      });
      return { status: 'completed', output: `Created ${operation.path}` };
    } catch (error: any) {
      const timestamp = Date.now();
      const result: FileOperationResult = {
        operation: 'create',
        path: operation.path,
        status: 'failed',
        output: `Failed to create ${operation.path}`,
        error: error?.message || String(error),
        timestamp
      };
      this.results.push(result);
      logger.error('Failed to create file', {
        path: operation.path,
        error: error?.message || error
      });
      throw error;
    }
  }

  async updateFile(
    operation: Extract<ApplyPatchOperation, { type: 'update_file' }>
  ): Promise<ApplyPatchResult | void> {
    const targetPath = this.resolve(operation.path);
    logger.debug('WorkspaceEditor.updateFile called', {
      path: operation.path,
      targetPath
    });

    try {
      let original: string;
      try {
        logger.debug('Reading original file', { path: targetPath });
        const fileInfo = await this.sandbox.readFile(targetPath, {
          encoding: 'utf-8'
        });
        original = fileInfo.content;
        logger.debug('Original file read', {
          path: targetPath,
          originalLength: original.length
        });
      } catch (error: any) {
        // Sandbox API may throw errors for missing files
        if (
          error?.message?.includes('not found') ||
          error?.message?.includes('ENOENT') ||
          error?.status === 404
        ) {
          logger.error('Cannot update missing file', { path: operation.path });
          throw new Error(`Cannot update missing file: ${operation.path}`);
        }
        logger.error('Error reading file', {
          path: operation.path,
          error: error?.message || error
        });
        throw error;
      }

      const patched = applyDiff(original, operation.diff);
      logger.debug('Applied diff', {
        path: targetPath,
        originalLength: original.length,
        patchedLength: patched.length
      });
      await this.sandbox.writeFile(targetPath, patched, { encoding: 'utf-8' });
      const timestamp = Date.now();
      const result: FileOperationResult = {
        operation: 'update',
        path: operation.path,
        status: 'completed',
        output: `Updated ${operation.path}`,
        timestamp
      };
      this.results.push(result);
      logger.info('File updated successfully', {
        path: operation.path,
        timestamp
      });
      return { status: 'completed', output: `Updated ${operation.path}` };
    } catch (error: any) {
      const timestamp = Date.now();
      const result: FileOperationResult = {
        operation: 'update',
        path: operation.path,
        status: 'failed',
        output: `Failed to update ${operation.path}`,
        error: error?.message || String(error),
        timestamp
      };
      this.results.push(result);
      logger.error('Failed to update file', {
        path: operation.path,
        error: error?.message || error
      });
      throw error;
    }
  }

  async deleteFile(
    operation: Extract<ApplyPatchOperation, { type: 'delete_file' }>
  ): Promise<ApplyPatchResult | void> {
    const targetPath = this.resolve(operation.path);
    logger.debug('WorkspaceEditor.deleteFile called', {
      path: operation.path,
      targetPath
    });

    try {
      await this.sandbox.deleteFile(targetPath);
      const timestamp = Date.now();
      const result: FileOperationResult = {
        operation: 'delete',
        path: operation.path,
        status: 'completed',
        output: `Deleted ${operation.path}`,
        timestamp
      };
      this.results.push(result);
      logger.info('File deleted successfully', {
        path: operation.path,
        timestamp
      });
      return { status: 'completed', output: `Deleted ${operation.path}` };
    } catch (error: any) {
      const timestamp = Date.now();
      const result: FileOperationResult = {
        operation: 'delete',
        path: operation.path,
        status: 'failed',
        output: `Failed to delete ${operation.path}`,
        error: error?.message || String(error),
        timestamp
      };
      this.results.push(result);
      logger.error('Failed to delete file', {
        path: operation.path,
        error: error?.message || error
      });
      throw error;
    }
  }

  private resolve(relativePath: string): string {
    // Remove leading ./ or / if present, then join with root
    const normalized = relativePath.replace(/^\.\//, '').replace(/^\//, '');
    const resolved = normalized ? `${this.root}/${normalized}` : this.root;
    // Ensure the resolved path is within the workspace
    if (!resolved.startsWith(this.root)) {
      throw new Error(`Operation outside workspace: ${relativePath}`);
    }
    // Normalize path separators
    return resolved.replace(/\/+/g, '/');
  }

  private getDirname(filePath: string): string {
    const lastSlash = filePath.lastIndexOf('/');
    if (lastSlash === -1) {
      return '/';
    }
    return filePath.substring(0, lastSlash) || '/';
  }
}

async function handleRunRequest(request: Request, env: Env): Promise<Response> {
  logger.debug('handleRunRequest called', {
    method: request.method,
    url: request.url
  });

  try {
    // Parse request body
    logger.debug('Parsing request body');
    const body = (await request.json()) as { input?: string };
    const input = body.input;

    if (!input || typeof input !== 'string') {
      logger.warn('Invalid or missing input field', { input });
      return new Response(
        JSON.stringify({ error: 'Missing or invalid input field' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    logger.info('Processing request', { inputLength: input.length });

    // Get sandbox instance (reused for both shell and editor)
    logger.debug('Getting sandbox instance', {
      sessionId: 'workspace-session'
    });
    const sandbox = getSandbox(env.Sandbox, 'workspace-session');

    // Create shell (automatically collects results)
    logger.debug('Creating SandboxShell');
    const shell = new SandboxShell(sandbox);

    // Create workspace editor
    logger.debug('Creating WorkspaceEditor', { root: '/workspace' });
    const editor = new WorkspaceEditor(sandbox, '/workspace');

    // Create agent with both shell and patch tools, auto-approval for web API
    logger.debug('Creating Agent', {
      name: 'Sandbox Studio',
      model: 'gpt-5.1'
    });
    const agent = new Agent({
      name: 'Sandbox Studio',
      model: 'gpt-5.1',
      instructions:
        'You can execute shell commands and edit files in the workspace. Use shell commands to inspect the repository and the apply_patch tool to create, update, or delete files. Keep responses concise and include command output when helpful.',
      tools: [
        shellTool({
          shell,
          needsApproval: false // Auto-approve for web API
        }),
        applyPatchTool({
          editor,
          needsApproval: false // Auto-approve for web API
        })
      ]
    });

    // Run the agent
    logger.info('Running agent', { input });
    const result = await run(agent, input);
    logger.debug('Agent run completed', {
      hasOutput: !!result.finalOutput,
      outputLength: result.finalOutput?.length || 0
    });

    // Combine and sort all results by timestamp for logging
    const allResults = [
      ...shell.results.map((r) => ({ type: 'command' as const, ...r })),
      ...editor.results.map((r) => ({ type: 'file' as const, ...r }))
    ].sort((a, b) => a.timestamp - b.timestamp);

    logger.debug('Results collected', {
      commandResults: shell.results.length,
      fileOperations: editor.results.length,
      totalResults: allResults.length
    });

    // Format response with combined and sorted results
    const response = {
      naturalResponse: result.finalOutput || null,
      commandResults: shell.results.sort((a, b) => a.timestamp - b.timestamp),
      fileOperations: editor.results.sort((a, b) => a.timestamp - b.timestamp)
    };

    logger.info('Request completed successfully');
    return new Response(JSON.stringify(response), {
      headers: {
        'Content-Type': 'application/json'
      }
    });
  } catch (error: any) {
    logger.error('Error handling run request', {
      error: error?.message || error,
      stack: error?.stack
    });
    return new Response(
      JSON.stringify({
        error: error.message || 'Internal server error',
        naturalResponse: 'An error occurred while processing your request.',
        commandResults: [],
        fileOperations: []
      }),
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );
  }
}

export default {
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);
    logger.debug('Fetch handler called', {
      pathname: url.pathname,
      method: request.method
    });

    if (url.pathname === '/run' && request.method === 'POST') {
      return handleRunRequest(request, env);
    }

    logger.warn('Route not found', {
      pathname: url.pathname,
      method: request.method
    });
    return new Response('Not found', { status: 404 });
  }
};
