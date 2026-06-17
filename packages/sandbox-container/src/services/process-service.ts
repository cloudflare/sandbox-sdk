import { type Logger, logCanonicalEvent } from '@repo/shared';
import type {
  CommandErrorContext,
  ProcessErrorContext,
  ProcessNotFoundContext
} from '@repo/shared/errors';
import { ErrorCode } from '@repo/shared/errors';
import { DISABLE_SESSION_TOKEN } from '@repo/shared/internal';
import type {
  CommandResult,
  ProcessCommandHandle,
  ProcessOptions,
  ProcessRecord,
  ProcessStatus,
  ServiceResult
} from '../core/types';
import { ProcessManager } from '../managers/process-manager';
import type { ExecutionService } from './execution-service';
import type { ProcessStore } from './process-store';

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
    private executionService: ExecutionService
  ) {
    this.manager = new ProcessManager();
  }

  async startProcess(
    command: string,
    options: ProcessOptions = {}
  ): Promise<ServiceResult<ProcessRecord>> {
    return this.startProcessRecord(command, options);
  }

  async executeCommand(
    command: string,
    options: ProcessOptions = {}
  ): Promise<ServiceResult<CommandResult>> {
    try {
      // Always use ExecutionService for command execution
      const result = await this.executionService.execute(command, {
        sessionId: options.sessionId,
        cwd: options.cwd,
        timeoutMs: options.timeoutMs,
        env: options.env,
        origin: options.origin
      });

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

  private async startProcessRecord(
    command: string,
    options: ProcessOptions = {}
  ): Promise<ServiceResult<ProcessRecord>> {
    const startTime = Date.now();
    let processRecord: ProcessRecord | undefined;
    let storedProcessRecord = false;

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
      const commandHandle: ProcessCommandHandle = {
        sessionId: options.sessionId ?? DISABLE_SESSION_TOKEN,
        commandId: processRecordData.id
      };

      processRecord = {
        ...processRecordData,
        commandHandle
      };
      const storedRecord = processRecord;
      let executionSessionId = commandHandle.sessionId;

      // 4. Store record (data layer)
      await this.store.create(storedRecord);
      storedProcessRecord = true;

      // 5. Start process lifecycle streaming and bind it to the process record.
      // Pass process ID as commandId for tracking and killing.
      const streamResult = await this.executionService.startProcessStream(
        command,
        {
          sessionId: options.sessionId,
          cwd: options.cwd,
          timeoutMs: options.timeoutMs,
          env: options.env,
          origin: options.origin,
          commandId: processRecordData.id,
          onEvent: async (event) => {
            // Route events to process record listeners.
            if (event.type === 'start' && event.pid !== undefined) {
              storedRecord.pid = event.pid;
              await this.store.update(storedRecord.id, { pid: event.pid });
              logCanonicalEvent(this.logger, {
                event: 'process.start',
                outcome: 'success',
                command,
                pid: event.pid,
                durationMs: Date.now() - startTime,
                processId: storedRecord.id,
                sessionId: executionSessionId,
                origin: options.origin
              });
            } else if (event.type === 'stdout' && event.data) {
              storedRecord.stdout += event.data;
              storedRecord.outputListeners.forEach((listener) => {
                listener('stdout', event.data!);
              });
            } else if (event.type === 'stderr' && event.data) {
              storedRecord.stderr += event.data;
              storedRecord.outputListeners.forEach((listener) => {
                listener('stderr', event.data!);
              });
            } else if (event.type === 'complete') {
              const exitCode = event.exitCode ?? 0;
              const status = this.manager.interpretExitCode(exitCode);
              const endTime = new Date();

              storedRecord.status = status;
              storedRecord.endTime = endTime;
              storedRecord.exitCode = exitCode;

              logCanonicalEvent(this.logger, {
                event: 'process.exit',
                outcome: 'success',
                command,
                pid: storedRecord.pid,
                exitCode,
                durationMs:
                  storedRecord.startTime instanceof Date
                    ? endTime.getTime() - storedRecord.startTime.getTime()
                    : Date.now() - startTime,
                processId: storedRecord.id,
                sessionId: executionSessionId,
                origin: options.origin
              });

              storedRecord.statusListeners.forEach((listener) => {
                listener(status);
              });

              // Await store update to ensure consistency before next event.
              try {
                await this.store.update(storedRecord.id, {
                  status,
                  endTime,
                  exitCode
                });
              } catch (error) {
                this.logger.error(
                  'Failed to update process status',
                  error instanceof Error ? error : undefined,
                  {
                    processId: storedRecord.id
                  }
                );
              }
            } else if (event.type === 'error') {
              storedRecord.status = 'error';
              storedRecord.endTime = new Date();
              storedRecord.statusListeners.forEach((listener) => {
                listener('error');
              });

              logCanonicalEvent(this.logger, {
                event: 'process.error',
                outcome: 'error',
                command,
                processId: storedRecord.id,
                sessionId: executionSessionId,
                durationMs: Date.now() - startTime,
                errorMessage: event.error,
                error: new Error(event.error),
                origin: options.origin
              });
            }
          }
        }
      );

      if (!streamResult.success) {
        await this.markStartupFailed(processRecord, streamResult.error.message);
        return streamResult as ServiceResult<ProcessRecord>;
      }

      executionSessionId = streamResult.data.commandHandle.sessionId;
      processRecord.commandHandle = streamResult.data.commandHandle;
      await this.store.update(processRecord.id, {
        commandHandle: streamResult.data.commandHandle
      });

      // Store streaming promise so getLogs() can await it for completed processes
      // This ensures all output is captured before returning logs
      const activeProcessRecord = processRecord;
      activeProcessRecord.streamingComplete =
        streamResult.data.continueStreaming.catch((error) => {
          this.logger.debug('process.streamComplete', {
            processId: activeProcessRecord.id,
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

      if (storedProcessRecord && processRecord) {
        await this.markStartupFailed(processRecord, errorMessage);
      }

      return {
        success: false,
        error: {
          message: `Failed to start process stream '${command}': ${errorMessage}`,
          code: ErrorCode.STREAM_START_ERROR,
          details: {
            command,
            stderr: errorMessage
          } satisfies CommandErrorContext
        }
      };
    }
  }

  private async markStartupFailed(
    processRecord: ProcessRecord,
    errorMessage?: string
  ): Promise<void> {
    const stderr =
      errorMessage === undefined
        ? processRecord.stderr
        : processRecord.stderr
          ? `${processRecord.stderr}\n${errorMessage}`
          : errorMessage;

    processRecord.status = 'error';
    processRecord.endTime = new Date();
    processRecord.stderr = stderr;
    processRecord.statusListeners.forEach((listener) => {
      listener('error');
    });

    try {
      await this.store.update(processRecord.id, {
        status: 'error',
        endTime: processRecord.endTime,
        stderr
      });
    } catch (error) {
      this.logger.error(
        'Failed to mark process startup failure',
        error instanceof Error ? error : undefined,
        {
          processId: processRecord.id
        }
      );
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

      // All processes use ExecutionService for the unified execution model
      if (!process.commandHandle) {
        // Process has no commandHandle - likely already completed or malformed
        return {
          success: true
        };
      }

      const result = await this.executionService.kill(process.commandHandle);

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
