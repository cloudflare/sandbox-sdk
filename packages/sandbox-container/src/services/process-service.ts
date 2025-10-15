import type {
  CommandErrorContext,
  ProcessErrorContext,
  ProcessNotFoundContext,
} from '@repo/shared/errors';
import { ErrorCode } from '@repo/shared/errors';
import type {
  CommandResult,
  Logger,
  ProcessOptions,
  ProcessRecord,
  ProcessStatus,
  ServiceResult
} from '../core/types';
import { ProcessManager } from '../managers/process-manager';
import type { SessionManager } from './session-manager';

export interface ProcessStore {
  create(process: ProcessRecord): Promise<void>;
  get(id: string): Promise<ProcessRecord | null>;
  update(id: string, data: Partial<ProcessRecord>): Promise<void>;
  delete(id: string): Promise<void>;
  list(filters?: ProcessFilters): Promise<ProcessRecord[]>;
  cleanup(olderThan: Date): Promise<number>;
}

export interface ProcessFilters {
  status?: ProcessStatus;
}

// In-memory implementation optimized for Bun
export class InMemoryProcessStore implements ProcessStore {
  private processes = new Map<string, ProcessRecord>();

  async create(process: ProcessRecord): Promise<void> {
    this.processes.set(process.id, process);
  }

  async get(id: string): Promise<ProcessRecord | null> {
    return this.processes.get(id) || null;
  }

  async update(id: string, data: Partial<ProcessRecord>): Promise<void> {
    const existing = this.processes.get(id);
    if (!existing) {
      throw new Error(`Process ${id} not found`);
    }
    
    const updated = { ...existing, ...data };
    this.processes.set(id, updated);
  }

  async delete(id: string): Promise<void> {
    // Note: ProcessService is responsible for killing processes via SessionManager
    // This method only removes the record from storage
    this.processes.delete(id);
  }

  async list(filters?: ProcessFilters): Promise<ProcessRecord[]> {
    let processes = Array.from(this.processes.values());

    // Processes are sandbox-scoped, not session-scoped
    // Filter by status only (like filtering 'ps' output by state)
    if (filters?.status) {
      processes = processes.filter(p => p.status === filters.status);
    }

    return processes;
  }

  async cleanup(olderThan: Date): Promise<number> {
    let cleaned = 0;
    for (const [id, process] of Array.from(this.processes.entries())) {
      if (process.startTime < olderThan && 
          ['completed', 'failed', 'killed', 'error'].includes(process.status)) {
        await this.delete(id);
        cleaned++;
      }
    }
    return cleaned;
  }
}

export class ProcessService {
  private cleanupInterval: Timer | null = null;
  private manager: ProcessManager;

  constructor(
    private store: ProcessStore,
    private logger: Logger,
    private sessionManager: SessionManager
  ) {
    this.manager = new ProcessManager();

    // Start cleanup process every 30 minutes
    this.startCleanupProcess();
  }

  /**
   * Start a background process via SessionManager
   * Semantically identical to executeCommandStream() - both use SessionManager
   * The difference is conceptual: startProcess() runs in background for long-lived processes
   */
  async startProcess(command: string, options: ProcessOptions = {}): Promise<ServiceResult<ProcessRecord>> {
    this.logger.info('Starting background process via SessionManager', { command, options });
    return this.executeCommandStream(command, options);
  }

  async executeCommand(command: string, options: ProcessOptions = {}): Promise<ServiceResult<CommandResult>> {
    try {
      this.logger.info('Executing command', { command, options });

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
        stderr: result.data.stderr,
      };

      this.logger.info('Command executed successfully', {
        command,
        exitCode: commandResult.exitCode,
        success: commandResult.success
      });

      return {
        success: true,
        data: commandResult,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to execute command', error instanceof Error ? error : undefined, { command, options });

      return {
        success: false,
        error: {
          message: `Failed to execute command '${command}': ${errorMessage}`,
          code: ErrorCode.COMMAND_EXECUTION_ERROR,
          details: {
            command,
            stderr: errorMessage,
          } satisfies CommandErrorContext,
        },
      };
    }
  }

  /**
   * Execute a command with streaming output via SessionManager
   * Used by both execStream() and startProcess()
   */
  async executeCommandStream(command: string, options: ProcessOptions = {}): Promise<ServiceResult<ProcessRecord>> {
    try {
      // 1. Validate command (business logic via manager)
      const validation = this.manager.validateCommand(command);
      if (!validation.valid) {
        return {
          success: false,
          error: {
            message: validation.error || 'Invalid command',
            code: validation.code || 'INVALID_COMMAND',
          },
        };
      }

      this.logger.info('Starting streaming command execution', { command, options });

      // 2. Create process record (without subprocess)
      const processRecordData = this.manager.createProcessRecord(command, undefined, options);

      // 3. Build full process record with commandHandle instead of subprocess
      const sessionId = options.sessionId || 'default';
      const processRecord: ProcessRecord = {
        ...processRecordData,
        commandHandle: {
          sessionId,
          commandId: processRecordData.id,  // Use process ID as command ID
        },
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
            processRecord.outputListeners.forEach(listener => {
              listener('stdout', event.data!);
            });
          } else if (event.type === 'stderr' && event.data) {
            processRecord.stderr += event.data;
            processRecord.outputListeners.forEach(listener => {
              listener('stderr', event.data!);
            });
          } else if (event.type === 'complete') {
            const exitCode = event.exitCode ?? 0;
            const status = this.manager.interpretExitCode(exitCode);
            const endTime = new Date();

            processRecord.status = status;
            processRecord.endTime = endTime;
            processRecord.exitCode = exitCode;

            processRecord.statusListeners.forEach(listener => {
              listener(status);
            });

            this.store.update(processRecord.id, {
              status,
              endTime,
              exitCode,
            }).catch(error => {
              this.logger.error('Failed to update process status', error, { processId: processRecord.id });
            });

            this.logger.info('Streaming command completed', {
              processId: processRecord.id,
              exitCode,
              status,
              duration: endTime.getTime() - processRecord.startTime.getTime(),
            });
          } else if (event.type === 'error') {
            processRecord.status = 'error';
            processRecord.endTime = new Date();
            processRecord.statusListeners.forEach(listener => {
              listener('error');
            });

            this.logger.error('Streaming command error', new Error(event.error), { processId: processRecord.id });
          }
        },
        options.cwd,
        processRecordData.id  // Pass process ID as commandId for tracking and killing
      );

      if (!streamResult.success) {
        return streamResult as ServiceResult<ProcessRecord>;
      }

      // Command is now tracked and first event processed - safe to return process record
      // Continue streaming in background without blocking
      streamResult.data.continueStreaming.catch(error => {
        this.logger.error('Failed to execute streaming command', error, {
          processId: processRecord.id,
          command
        });
      });

      this.logger.info('Streaming command started successfully', {
        processId: processRecord.id,
      });

      return {
        success: true,
        data: processRecord,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to start streaming command', error instanceof Error ? error : undefined, { command, options });

      return {
        success: false,
        error: {
          message: `Failed to start streaming command '${command}': ${errorMessage}`,
          code: ErrorCode.STREAM_START_ERROR,
          details: {
            command,
            stderr: errorMessage,
          } satisfies CommandErrorContext,
        },
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
              processId: id,
            } satisfies ProcessNotFoundContext,
          },
        };
      }

      return {
        success: true,
        data: process,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to get process', error instanceof Error ? error : undefined, { processId: id });

      return {
        success: false,
        error: {
          message: `Failed to get process '${id}': ${errorMessage}`,
          code: ErrorCode.PROCESS_ERROR,
          details: {
            processId: id,
            stderr: errorMessage,
          } satisfies ProcessErrorContext,
        },
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
              processId: id,
            } satisfies ProcessNotFoundContext,
          },
        };
      }

      // All processes use SessionManager for unified execution model
      if (!process.commandHandle) {
        // Process has no commandHandle - likely already completed or malformed
        return {
          success: true,
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

        this.logger.info('Process killed', { processId: id });
      }

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to kill process', error instanceof Error ? error : undefined, { processId: id });

      return {
        success: false,
        error: {
          message: `Failed to kill process '${id}': ${errorMessage}`,
          code: ErrorCode.PROCESS_ERROR,
          details: {
            processId: id,
            stderr: errorMessage,
          } satisfies ProcessErrorContext,
        },
      };
    }
  }

  async listProcesses(filters?: ProcessFilters): Promise<ServiceResult<ProcessRecord[]>> {
    try {
      const processes = await this.store.list(filters);
      
      return {
        success: true,
        data: processes,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to list processes', error instanceof Error ? error : undefined, { filters });

      return {
        success: false,
        error: {
          message: `Failed to list processes: ${errorMessage}`,
          code: ErrorCode.PROCESS_ERROR,
          details: {
            processId: 'list',  // Meta operation
            stderr: errorMessage,
          } satisfies ProcessErrorContext,
        },
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

      this.logger.info('Killed all processes', { count: killed });

      return {
        success: true,
        data: killed,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to kill all processes', error instanceof Error ? error : undefined);

      return {
        success: false,
        error: {
          message: `Failed to kill all processes: ${errorMessage}`,
          code: ErrorCode.PROCESS_ERROR,
          details: {
            processId: 'killAll',  // Meta operation
            stderr: errorMessage,
          } satisfies ProcessErrorContext,
        },
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
              processId: id,
            } satisfies ProcessNotFoundContext,
          },
        };
      }

      // All processes use SessionManager - create stream from listeners and buffered output
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
          const outputListener = (stream: 'stdout' | 'stderr', data: string) => {
            controller.enqueue(encoder.encode(data));
          };

          const statusListener = (status: string) => {
            if (['completed', 'failed', 'killed', 'error'].includes(status)) {
              controller.close();
            }
          };

          process.outputListeners.add(outputListener);
          process.statusListeners.add(statusListener);

          // If already completed, close immediately
          if (['completed', 'failed', 'killed', 'error'].includes(process.status)) {
            controller.close();
          }
        },
      });

      return {
        success: true,
        data: stream,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to stream process logs', error instanceof Error ? error : undefined, { processId: id });

      return {
        success: false,
        error: {
          message: `Failed to stream logs for process '${id}': ${errorMessage}`,
          code: ErrorCode.PROCESS_ERROR,
          details: {
            processId: id,
            stderr: errorMessage,
          } satisfies ProcessErrorContext,
        },
      };
    }
  }


  private startCleanupProcess(): void {
    this.cleanupInterval = setInterval(async () => {
      try {
        // Use manager to calculate cleanup cutoff date
        const thirtyMinutesAgo = this.manager.createCleanupCutoffDate(30);
        const cleaned = await this.store.cleanup(thirtyMinutesAgo);
        if (cleaned > 0) {
          this.logger.info('Cleaned up old processes', { count: cleaned });
        }
      } catch (error) {
        this.logger.error('Failed to cleanup processes', error instanceof Error ? error : undefined);
      }
    }, 30 * 60 * 1000); // 30 minutes
  }

  // Cleanup method for graceful shutdown
  async destroy(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    // Kill all running processes
    const result = await this.killAllProcesses();
    if (result.success) {
      this.logger.info('All processes killed during service shutdown');
    }
  }
}