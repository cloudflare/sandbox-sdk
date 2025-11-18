/**
 * OpenAI Agents adapters for executing shell commands and file operations
 * inside a Cloudflare Sandbox.
 */
import {
  type ApplyPatchOperation,
  type ApplyPatchResult,
  applyDiff,
  type Editor as OpenAIEeditor,
  type Shell as OpenAIShell,
  type ShellAction,
  type ShellOutputResult,
  type ShellResult
} from '@openai/agents';

// Command result for API responses
export interface CommandResult {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timestamp: number;
}

// File operation result for API responses
export interface FileOperationResult {
  operation: 'create' | 'update' | 'delete';
  path: string;
  status: 'completed' | 'failed';
  output: string;
  error?: string;
  timestamp: number;
}

import { createLogger, type Logger } from '@repo/shared';
import type { Sandbox } from '../sandbox';

const logger: Logger = createLogger({
  component: 'sandbox-do',
  operation: 'openai-agent'
});

// Helper functions for error handling
function isErrorWithProperties(error: unknown): error is {
  message?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  status?: number;
  stack?: string;
} {
  return typeof error === 'object' && error !== null;
}

function getErrorMessage(error: unknown): string {
  if (isErrorWithProperties(error) && typeof error.message === 'string') {
    return error.message;
  }
  return String(error);
}

/**
 * Convert unknown values to Error instances when possible so downstream
 * loggers can include stack traces without losing type safety.
 */
function toError(error: unknown): Error | undefined {
  return error instanceof Error ? error : undefined;
}

/**
 * Shell implementation that adapts Cloudflare Sandbox exec calls to the
 * OpenAI Agents `Shell` contract, including structured result collection.
 */
export class Shell implements OpenAIShell {
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
      } catch (error: unknown) {
        // Handle network/HTTP errors or timeout errors
        const errorObj = isErrorWithProperties(error) ? error : {};
        exitCode =
          typeof errorObj.exitCode === 'number' ? errorObj.exitCode : null;
        stdout = typeof errorObj.stdout === 'string' ? errorObj.stdout : '';
        stderr = typeof errorObj.stderr === 'string' ? errorObj.stderr : '';

        // Check if it's a timeout error
        const errorMessage = getErrorMessage(error);
        if (
          errorMessage.includes('timeout') ||
          errorMessage.includes('Timeout') ||
          errorMessage.includes('timed out')
        ) {
          logger.error(`Command timed out`, undefined, {
            command,
            timeout: action.timeoutMs
          });
          outcome = { type: 'timeout' };
        } else {
          logger.error(`Error executing command`, toError(error), {
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

/**
 * Editor implementation that projects applyPatch operations from Agents
 * into calls against the sandbox filesystem APIs.
 */
export class Editor implements OpenAIEeditor {
  public results: FileOperationResult[] = [];

  constructor(
    private readonly sandbox: Sandbox,
    private readonly root: string = '/workspace'
  ) {}

  /**
   * Create a new file inside the sandbox by applying the provided diff.
   */
  async createFile(
    operation: Extract<ApplyPatchOperation, { type: 'create_file' }>
  ): Promise<ApplyPatchResult | undefined> {
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
    } catch (error: unknown) {
      const timestamp = Date.now();
      const errorMessage = getErrorMessage(error);
      const result: FileOperationResult = {
        operation: 'create',
        path: operation.path,
        status: 'failed',
        output: `Failed to create ${operation.path}`,
        error: errorMessage,
        timestamp
      };
      this.results.push(result);
      logger.error('Failed to create file', toError(error), {
        path: operation.path,
        error: errorMessage
      });
      throw error;
    }
  }

  /**
   * Update an existing file by reading its content, applying a diff, and
   * writing the patched output back to the sandbox.
   */
  async updateFile(
    operation: Extract<ApplyPatchOperation, { type: 'update_file' }>
  ): Promise<ApplyPatchResult | undefined> {
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
      } catch (error: unknown) {
        // Sandbox API may throw errors for missing files
        const errorObj = isErrorWithProperties(error) ? error : {};
        const errorMessage = getErrorMessage(error);
        if (
          errorMessage.includes('not found') ||
          errorMessage.includes('ENOENT') ||
          errorObj.status === 404
        ) {
          logger.error('Cannot update missing file', undefined, {
            path: operation.path
          });
          throw new Error(`Cannot update missing file: ${operation.path}`);
        }
        logger.error('Error reading file', toError(error), {
          path: operation.path,
          error: errorMessage
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
    } catch (error: unknown) {
      const timestamp = Date.now();
      const errorMessage = getErrorMessage(error);
      const result: FileOperationResult = {
        operation: 'update',
        path: operation.path,
        status: 'failed',
        output: `Failed to update ${operation.path}`,
        error: errorMessage,
        timestamp
      };
      this.results.push(result);
      logger.error('Failed to update file', toError(error), {
        path: operation.path,
        error: errorMessage
      });
      throw error;
    }
  }

  /**
   * Delete a file that was previously created through applyPatch calls.
   */
  async deleteFile(
    operation: Extract<ApplyPatchOperation, { type: 'delete_file' }>
  ): Promise<ApplyPatchResult | undefined> {
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
    } catch (error: unknown) {
      const timestamp = Date.now();
      const errorMessage = getErrorMessage(error);
      const result: FileOperationResult = {
        operation: 'delete',
        path: operation.path,
        status: 'failed',
        output: `Failed to delete ${operation.path}`,
        error: errorMessage,
        timestamp
      };
      this.results.push(result);
      logger.error('Failed to delete file', toError(error), {
        path: operation.path,
        error: errorMessage
      });
      throw error;
    }
  }

  private resolve(relativePath: string): string {
    // Remove leading ./ or / if present, then join with root
    const normalized = relativePath.replace(/^\.\//, '').replace(/^\//, '');
    const resolved = normalized ? `${this.root}/${normalized}` : this.root;

    // Normalize path separators first
    const pathWithNormalizedSeparators = resolved.replace(/\/+/g, '/');

    // Normalize .. segments by processing path segments
    const segments = pathWithNormalizedSeparators
      .split('/')
      .filter((s) => s && s !== '.');
    const stack: string[] = [];

    for (const segment of segments) {
      if (segment === '..') {
        if (stack.length === 0) {
          throw new Error(`Operation outside workspace: ${relativePath}`);
        }
        stack.pop();
      } else {
        stack.push(segment);
      }
    }

    const normalizedPath = `/${stack.join('/')}`;

    // Ensure the resolved path is within the workspace
    if (!normalizedPath.startsWith(this.root)) {
      throw new Error(`Operation outside workspace: ${relativePath}`);
    }

    return normalizedPath;
  }

  private getDirname(filePath: string): string {
    const lastSlash = filePath.lastIndexOf('/');
    if (lastSlash === -1) {
      return '/';
    }
    return filePath.substring(0, lastSlash) || '/';
  }
}
