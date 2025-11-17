import type { Logger } from '@repo/shared';
import type {
  CommandErrorContext,
  ProcessErrorContext,
  ProcessNotFoundContext
} from '@repo/shared/errors';
import { ErrorCode } from '@repo/shared/errors';
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
    try {
      // Always use SessionManager for execution (unified model)
      const sessionId = options.sessionId || 'default';
      const result = await this.sessionManager.executeInSession(
        sessionId,
        command,
        options.cwd,
        options.timeoutMs
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
      this.logger.error(
        'Failed to execute command',
        error instanceof Error ? error : undefined,
        { command, options }
      );

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

  /**
   * Execute a command with streaming output via SessionManager
   * Used by both execStream() and startProcess()
   */
  async executeCommandStream(
    command: string,
    options: ProcessOptions = {}
  ): Promise<ServiceResult<ProcessRecord>> {
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
        (event) => {
          // Route events to process record listeners
          if (event.type === 'stdout' && event.data) {
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

            processRecord.statusListeners.forEach((listener) => {
              listener(status);
            });

            this.store
              .update(processRecord.id, {
                status,
                endTime,
                exitCode
              })
              .catch((error) => {
                this.logger.error('Failed to update process status', error, {
                  processId: processRecord.id
                });
              });
          } else if (event.type === 'error') {
            processRecord.status = 'error';
            processRecord.endTime = new Date();
            processRecord.statusListeners.forEach((listener) => {
              listener('error');
            });

            this.logger.error(
              'Streaming command error',
              new Error(event.error),
              { processId: processRecord.id }
            );
          }
        },
        options.cwd,
        processRecordData.id // Pass process ID as commandId for tracking and killing
      );

      if (!streamResult.success) {
        return streamResult as ServiceResult<ProcessRecord>;
      }

      // Command is now tracked and first event processed - safe to return process record
      // Continue streaming in background without blocking
      streamResult.data.continueStreaming.catch((error) => {
        this.logger.error('Failed to execute streaming command', error, {
          processId: processRecord.id,
          command
        });
      });

      return {
        success: true,
        data: processRecord
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(
        'Failed to start streaming command',
        error instanceof Error ? error : undefined,
        { command, options }
      );

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

      return {
        success: true,
        data: process
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(
        'Failed to get process',
        error instanceof Error ? error : undefined,
        { processId: id }
      );

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
      this.logger.error(
        'Failed to kill process',
        error instanceof Error ? error : undefined,
        { processId: id }
      );

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
      this.logger.error(
        'Failed to list processes',
        error instanceof Error ? error : undefined,
        { filters }
      );

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
      this.logger.error(
        'Failed to kill all processes',
        error instanceof Error ? error : undefined
      );

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

  async streamProcessLogs(id: string): Promise<ServiceResult<ReadableStream>> {
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

      // All processes use SessionManager - create stream from listeners and buffered output
      let outputListener:
        | ((stream: 'stdout' | 'stderr', data: string) => void)
        | null = null;
      let statusListener: ((status: string) => void) | null = null;

      const cleanup = () => {
        if (outputListener) {
          process.outputListeners.delete(outputListener);
          outputListener = null;
        }
        if (statusListener) {
          process.statusListeners.delete(statusListener);
          statusListener = null;
        }
      };

      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();

          // Send already-buffered output
          if (process.stdout) {
            controller.enqueue(encoder.encode(process.stdout));
          }
          if (process.stderr) {
            controller.enqueue(encoder.encode(process.stderr));
          }

          // Set up listener for future output
          outputListener = (stream: 'stdout' | 'stderr', data: string) => {
            controller.enqueue(encoder.encode(data));
          };

          statusListener = (status: string) => {
            if (['completed', 'failed', 'killed', 'error'].includes(status)) {
              cleanup();
              controller.close();
            }
          };

          process.outputListeners.add(outputListener);
          process.statusListeners.add(statusListener);

          // If already completed, close immediately
          if (
            ['completed', 'failed', 'killed', 'error'].includes(process.status)
          ) {
            cleanup();
            controller.close();
          }
        },
        cancel() {
          cleanup();
        }
      });

      return {
        success: true,
        data: stream
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(
        'Failed to stream process logs',
        error instanceof Error ? error : undefined,
        { processId: id }
      );

      return {
        success: false,
        error: {
          message: `Failed to stream logs for process '${id}': ${errorMessage}`,
          code: ErrorCode.PROCESS_ERROR,
          details: {
            processId: id,
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
