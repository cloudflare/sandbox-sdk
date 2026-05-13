import { existsSync } from 'node:fs';
import { type Logger, logCanonicalEvent } from '@repo/shared';
import type {
  CommandErrorContext,
  ProcessErrorContext,
  ProcessNotFoundContext
} from '@repo/shared/errors';
import { ErrorCode } from '@repo/shared/errors';
import { spawn } from 'bun';
import type {
  CommandResult,
  ProcessOptions,
  ProcessRecord,
  ProcessStatus,
  ServiceResult
} from '../core/types';
import { ProcessManager } from '../managers/process-manager';
import type { ProcessStore } from './process-store';
import type { SessionManager } from './session-manager';

// Re-export types for use by ProcessStore implementations
export type { ProcessRecord, ProcessStatus } from '../core/types';
export type { ProcessStore } from './process-store';

export interface ProcessFilters {
  status?: ProcessStatus;
}

export class ProcessService {
  private manager: ProcessManager;

  constructor(
    private store: ProcessStore,
    private logger: Logger,
    private sessionManager: SessionManager
  ) {
    this.manager = new ProcessManager();
  }

  /**
   * Start a background process via SessionManager
   * Semantically identical to executeCommandStream() - both use SessionManager
   * The difference is conceptual: startProcess() runs in background for long-lived processes
   */
  async startProcess(
    command: string,
    options: ProcessOptions = {}
  ): Promise<ServiceResult<ProcessRecord>> {
    return this.executeCommandStream(command, options);
  }

  async executeCommand(
    command: string,
    options: ProcessOptions = {}
  ): Promise<ServiceResult<CommandResult>> {
    if (options.sessionless) {
      return this.executeCommandOneShot(command, options);
    }

    try {
      // Always use SessionManager for execution (unified model)
      const sessionId = options.sessionId || 'default';
      const result = await this.sessionManager.executeInSession(
        sessionId,
        command,
        {
          cwd: options.cwd,
          timeoutMs: options.timeoutMs,
          env: options.env,
          origin: options.origin
        }
      );

      if (!result.success) {
        return result as ServiceResult<CommandResult>;
      }

      // Convert RawExecResult to CommandResult
      const commandResult: CommandResult = {
        success: result.data.exitCode === 0,
        exitCode: result.data.exitCode,
        stdout: result.data.stdout,
        stderr: result.data.stderr
      };

      return {
        success: true,
        data: commandResult
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';

      return {
        success: false,
        error: {
          message: `Failed to execute command '${command}': ${errorMessage}`,
          code: ErrorCode.COMMAND_EXECUTION_ERROR,
          details: {
            command,
            stderr: errorMessage
          } satisfies CommandErrorContext
        }
      };
    }
  }

  private async executeCommandOneShot(
    command: string,
    options: ProcessOptions
  ): Promise<ServiceResult<CommandResult>> {
    const validation = this.manager.validateCommand(command);
    if (!validation.valid) {
      return {
        success: false,
        error: {
          message: validation.error || 'Invalid command',
          code: validation.code || 'INVALID_COMMAND'
        }
      };
    }

    const controller = new AbortController();
    const timeout =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => controller.abort(), options.timeoutMs);

    try {
      const env = Object.fromEntries(
        Object.entries(options.env ?? {}).filter(
          (entry): entry is [string, string] => entry[1] !== undefined
        )
      );
      const subprocess = spawn({
        cmd: ['bash', '-lc', command],
        cwd:
          options.cwd ??
          (existsSync('/workspace') ? '/workspace' : process.cwd()),
        env: {
          ...process.env,
          ...env
        },
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'ignore',
        signal: controller.signal
      });

      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(subprocess.stdout).text(),
        new Response(subprocess.stderr).text(),
        subprocess.exited
      ]);

      if (controller.signal.aborted) {
        return {
          success: true,
          data: {
            success: false,
            exitCode: 124,
            stdout: '',
            stderr: `Command timed out after ${options.timeoutMs}ms`
          }
        };
      }

      return {
        success: true,
        data: {
          success: exitCode === 0,
          exitCode,
          stdout,
          stderr
        }
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';

      if (controller.signal.aborted) {
        return {
          success: true,
          data: {
            success: false,
            exitCode: 124,
            stdout: '',
            stderr: `Command timed out after ${options.timeoutMs}ms`
          }
        };
      }

      return {
        success: false,
        error: {
          message: `Failed to execute command '${command}': ${errorMessage}`,
          code: ErrorCode.COMMAND_EXECUTION_ERROR,
          details: {
            command,
            stderr: errorMessage
          } satisfies CommandErrorContext
        }
      };
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  /**
   * Execute a command with streaming output via SessionManager
   * Used by both execStream() and startProcess()
   */
  async executeCommandStream(
    command: string,
    options: ProcessOptions = {}
  ): Promise<ServiceResult<ProcessRecord>> {
    if (options.sessionless) {
      return this.executeCommandStreamOneShot(command, options);
    }

    const startTime = Date.now();
    try {
      // 1. Validate command (business logic via manager)
      const validation = this.manager.validateCommand(command);
      if (!validation.valid) {
        return {
          success: false,
          error: {
            message: validation.error || 'Invalid command',
            code: validation.code || 'INVALID_COMMAND'
          }
        };
      }

      // 2. Create process record (without subprocess)
      const processRecordData = this.manager.createProcessRecord(
        command,
        undefined,
        options
      );

      // 3. Build full process record with commandHandle instead of subprocess
      const sessionId = options.sessionId || 'default';
      const processRecord: ProcessRecord = {
        ...processRecordData,
        commandHandle: {
          sessionId,
          commandId: processRecordData.id // Use process ID as command ID
        }
      };

      // 4. Store record (data layer)
      await this.store.create(processRecord);

      // 5. Execute command via SessionManager with streaming
      // Pass process ID as commandId for tracking and killing
      // CRITICAL: Await the initial result to ensure command is tracked before returning
      const streamResult = await this.sessionManager.executeStreamInSession(
        sessionId,
        command,
        async (event) => {
          // Route events to process record listeners
          if (event.type === 'start' && event.pid !== undefined) {
            processRecord.pid = event.pid;
            await this.store.update(processRecord.id, { pid: event.pid });
            logCanonicalEvent(this.logger, {
              event: 'process.start',
              outcome: 'success',
              command: command,
              pid: event.pid,
              durationMs: Date.now() - startTime,
              processId: processRecord.id,
              sessionId,
              origin: options.origin
            });
          } else if (event.type === 'stdout' && event.data) {
            processRecord.stdout += event.data;
            processRecord.outputListeners.forEach((listener) => {
              listener('stdout', event.data!);
            });
          } else if (event.type === 'stderr' && event.data) {
            processRecord.stderr += event.data;
            processRecord.outputListeners.forEach((listener) => {
              listener('stderr', event.data!);
            });
          } else if (event.type === 'complete') {
            const exitCode = event.exitCode ?? 0;
            const status = this.manager.interpretExitCode(exitCode);
            const endTime = new Date();

            processRecord.status = status;
            processRecord.endTime = endTime;
            processRecord.exitCode = exitCode;

            logCanonicalEvent(this.logger, {
              event: 'process.exit',
              outcome: 'success',
              command: command,
              pid: processRecord.pid,
              exitCode: exitCode,
              durationMs:
                processRecord.startTime instanceof Date
                  ? endTime.getTime() - processRecord.startTime.getTime()
                  : Date.now() - startTime,
              processId: processRecord.id,
              sessionId,
              origin: options.origin
            });

            processRecord.statusListeners.forEach((listener) => {
              listener(status);
            });

            // Await store update to ensure consistency before next event
            try {
              await this.store.update(processRecord.id, {
                status,
                endTime,
                exitCode
              });
            } catch (error) {
              this.logger.error(
                'Failed to update process status',
                error instanceof Error ? error : undefined,
                {
                  processId: processRecord.id
                }
              );
            }
          } else if (event.type === 'error') {
            processRecord.status = 'error';
            processRecord.endTime = new Date();
            processRecord.statusListeners.forEach((listener) => {
              listener('error');
            });

            logCanonicalEvent(this.logger, {
              event: 'process.error',
              outcome: 'error',
              command,
              processId: processRecord.id,
              sessionId,
              durationMs: Date.now() - startTime,
              errorMessage: event.error,
              error: new Error(event.error),
              origin: options.origin
            });
          }
        },
        {
          cwd: options.cwd,
          env: options.env,
          origin: options.origin
        },
        processRecordData.id, // Pass process ID as commandId for tracking and killing
        { background: true } // Release lock after startup
      );

      if (!streamResult.success) {
        return streamResult as ServiceResult<ProcessRecord>;
      }

      // Store streaming promise so getLogs() can await it for completed processes
      // This ensures all output is captured before returning logs
      processRecord.streamingComplete =
        streamResult.data.continueStreaming.catch((error) => {
          this.logger.debug('process.streamComplete', {
            processId: processRecord.id,
            outcome: 'error',
            errorMessage: error instanceof Error ? error.message : String(error)
          });
        });

      return {
        success: true,
        data: processRecord
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';

      return {
        success: false,
        error: {
          message: `Failed to start streaming command '${command}': ${errorMessage}`,
          code: ErrorCode.STREAM_START_ERROR,
          details: {
            command,
            stderr: errorMessage
          } satisfies CommandErrorContext
        }
      };
    }
  }

  private async executeCommandStreamOneShot(
    command: string,
    options: ProcessOptions
  ): Promise<ServiceResult<ProcessRecord>> {
    const startTime = Date.now();
    const validation = this.manager.validateCommand(command);
    if (!validation.valid) {
      return {
        success: false,
        error: {
          message: validation.error || 'Invalid command',
          code: validation.code || 'INVALID_COMMAND'
        }
      };
    }

    const controller = new AbortController();
    const timeout =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => controller.abort(), options.timeoutMs);

    try {
      const processRecordData = this.manager.createProcessRecord(
        command,
        undefined,
        options
      );
      const processRecord: ProcessRecord = {
        ...processRecordData,
        sessionId: options.sessionId
      };

      const env = Object.fromEntries(
        Object.entries(options.env ?? {}).filter(
          (entry): entry is [string, string] => entry[1] !== undefined
        )
      );
      const subprocess = spawn({
        cmd: ['bash', '-lc', command],
        cwd:
          options.cwd ??
          (existsSync('/workspace') ? '/workspace' : process.cwd()),
        env: {
          ...process.env,
          ...env
        },
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'ignore',
        signal: controller.signal
      });

      processRecord.pid = subprocess.pid;
      await this.store.create(processRecord);

      logCanonicalEvent(this.logger, {
        event: 'process.start',
        outcome: 'success',
        command,
        pid: subprocess.pid,
        durationMs: Date.now() - startTime,
        processId: processRecord.id,
        sessionId: options.sessionId,
        origin: options.origin
      });

      const emitOutput = (stream: 'stdout' | 'stderr', data: string) => {
        if (stream === 'stdout') {
          processRecord.stdout += data;
        } else {
          processRecord.stderr += data;
        }
        processRecord.outputListeners.forEach((listener) => {
          listener(stream, data);
        });
      };

      const streamOutput = async (
        stream: ReadableStream<Uint8Array> | null,
        type: 'stdout' | 'stderr'
      ) => {
        if (!stream) {
          return;
        }

        const decoder = new TextDecoder();
        const reader = stream.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }
            emitOutput(type, decoder.decode(value, { stream: true }));
          }

          const remaining = decoder.decode();
          if (remaining) {
            emitOutput(type, remaining);
          }
        } finally {
          reader.releaseLock();
        }
      };

      // Note: streamingComplete is assigned after store.create, so a concurrent
      // getProcess call in the brief window between create and this assignment
      // will see streamingComplete as undefined and skip the wait. This is a
      // known race shared with the session-based path; in practice the window
      // is sub-millisecond and harmless for the current use-cases.
      processRecord.streamingComplete = Promise.all([
        streamOutput(subprocess.stdout, 'stdout'),
        streamOutput(subprocess.stderr, 'stderr'),
        subprocess.exited
      ])
        .then(async ([, , exitCode]) => {
          clearTimeout(timeout);
          const status = this.manager.interpretExitCode(exitCode);
          const endTime = new Date();
          processRecord.status = status;
          processRecord.endTime = endTime;
          processRecord.exitCode = exitCode;

          await this.store.update(processRecord.id, {
            status,
            endTime,
            exitCode
          });

          logCanonicalEvent(this.logger, {
            event: 'process.exit',
            outcome: 'success',
            command,
            pid: processRecord.pid,
            exitCode,
            durationMs:
              processRecord.startTime instanceof Date
                ? endTime.getTime() - processRecord.startTime.getTime()
                : Date.now() - startTime,
            processId: processRecord.id,
            sessionId: options.sessionId,
            origin: options.origin
          });

          processRecord.statusListeners.forEach((listener) => {
            listener(status);
          });
        })
        .catch(async (error) => {
          clearTimeout(timeout);
          const timedOut = controller.signal.aborted;
          const endTime = new Date();
          processRecord.status = 'error';
          processRecord.endTime = endTime;
          if (timedOut) {
            processRecord.exitCode = 124;
          }
          await this.store.update(processRecord.id, {
            status: 'error',
            endTime,
            ...(timedOut && { exitCode: 124 })
          });
          processRecord.statusListeners.forEach((listener) => {
            listener('error');
          });

          const errorMessage = timedOut
            ? `Command timed out after ${options.timeoutMs}ms`
            : error instanceof Error
              ? error.message
              : String(error);
          logCanonicalEvent(this.logger, {
            event: 'process.error',
            outcome: 'error',
            command,
            processId: processRecord.id,
            sessionId: options.sessionId,
            durationMs: Date.now() - startTime,
            errorMessage,
            error: error instanceof Error ? error : new Error(errorMessage),
            origin: options.origin
          });
        });

      return {
        success: true,
        data: processRecord
      };
    } catch (error) {
      clearTimeout(timeout);
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';

      return {
        success: false,
        error: {
          message: `Failed to start streaming command '${command}': ${errorMessage}`,
          code: ErrorCode.STREAM_START_ERROR,
          details: {
            command,
            stderr: errorMessage
          } satisfies CommandErrorContext
        }
      };
    }
  }

  async getProcess(id: string): Promise<ServiceResult<ProcessRecord>> {
    try {
      const processRecord = await this.store.get(id);

      if (!processRecord) {
        return {
          success: false,
          error: {
            message: `Process ${id} not found`,
            code: ErrorCode.PROCESS_NOT_FOUND,
            details: {
              processId: id
            } satisfies ProcessNotFoundContext
          }
        };
      }

      // Wait for streaming to finish to ensure all output is captured
      // We use three indicators to decide whether to wait:
      // 1. Terminal status: command has finished, wait for streaming callbacks
      // 2. PID check: if process is no longer alive, command finished, wait for streaming
      // 3. No streamingComplete: process was read from disk, output is complete
      //
      // For long-running processes (servers), PID is alive and status is 'running',
      // so we return current output without blocking.
      if (processRecord.streamingComplete) {
        const isTerminal = ['completed', 'failed', 'killed', 'error'].includes(
          processRecord.status
        );

        // Check if the subprocess is still alive (deterministic check for fast commands)
        // If PID is set and subprocess is dead, the command has finished
        let commandFinished = false;
        if (processRecord.pid !== undefined) {
          try {
            // Signal 0 doesn't actually send a signal, just checks if process exists
            process.kill(processRecord.pid, 0);
            // Subprocess is still running
          } catch {
            // Subprocess is not running (either finished or doesn't exist)
            commandFinished = true;
          }
        }

        // Wait if status is terminal OR command has finished (for fast commands)
        if (isTerminal || commandFinished) {
          await processRecord.streamingComplete;
        }
      }

      return {
        success: true,
        data: processRecord
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';

      return {
        success: false,
        error: {
          message: `Failed to get process '${id}': ${errorMessage}`,
          code: ErrorCode.PROCESS_ERROR,
          details: {
            processId: id,
            stderr: errorMessage
          } satisfies ProcessErrorContext
        }
      };
    }
  }

  async killProcess(id: string): Promise<ServiceResult<void>> {
    try {
      const process = await this.store.get(id);

      if (!process) {
        return {
          success: false,
          error: {
            message: `Process ${id} not found`,
            code: ErrorCode.PROCESS_NOT_FOUND,
            details: {
              processId: id
            } satisfies ProcessNotFoundContext
          }
        };
      }

      // All processes use SessionManager for unified execution model
      if (!process.commandHandle) {
        // Process has no commandHandle - likely already completed or malformed
        return {
          success: true
        };
      }

      const result = await this.sessionManager.killCommand(
        process.commandHandle.sessionId,
        process.commandHandle.commandId
      );

      if (result.success) {
        await this.store.update(id, {
          status: 'killed',
          endTime: new Date()
        });
      }

      return result;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';

      return {
        success: false,
        error: {
          message: `Failed to kill process '${id}': ${errorMessage}`,
          code: ErrorCode.PROCESS_ERROR,
          details: {
            processId: id,
            stderr: errorMessage
          } satisfies ProcessErrorContext
        }
      };
    }
  }

  async listProcesses(
    filters?: ProcessFilters
  ): Promise<ServiceResult<ProcessRecord[]>> {
    try {
      const processes = await this.store.list(filters);

      return {
        success: true,
        data: processes
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';

      return {
        success: false,
        error: {
          message: `Failed to list processes: ${errorMessage}`,
          code: ErrorCode.PROCESS_ERROR,
          details: {
            processId: 'list', // Meta operation
            stderr: errorMessage
          } satisfies ProcessErrorContext
        }
      };
    }
  }

  async killAllProcesses(): Promise<ServiceResult<number>> {
    try {
      const processes = await this.store.list({ status: 'running' });
      let killed = 0;

      for (const process of processes) {
        const result = await this.killProcess(process.id);
        if (result.success) {
          killed++;
        }
      }

      return {
        success: true,
        data: killed
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';

      return {
        success: false,
        error: {
          message: `Failed to kill all processes: ${errorMessage}`,
          code: ErrorCode.PROCESS_ERROR,
          details: {
            processId: 'killAll', // Meta operation
            stderr: errorMessage
          } satisfies ProcessErrorContext
        }
      };
    }
  }

  // Cleanup method for graceful shutdown
  async destroy(): Promise<void> {
    // Kill all running processes
    await this.killAllProcesses();
  }
}
