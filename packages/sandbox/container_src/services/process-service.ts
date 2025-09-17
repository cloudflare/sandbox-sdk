// Session-Aware Process Management Service
import type { 
  CommandResult, 
  Logger,
  ProcessOptions, 
  ProcessRecord, 
  ProcessStatus, 
  ServiceResult 
} from '../core/types';
import { CONFIG, type SessionManager, type Session } from '../isolation';
import { SessionAwareService } from './base/session-aware-service';

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
    const process = this.processes.get(id);
    if (process?.subprocess) {
      // Kill the subprocess if it's still running
      try {
        process.subprocess.kill();
      } catch (error) {
        console.warn(`Failed to kill subprocess ${id}:`, error);
      }
    }
    this.processes.delete(id);
  }

  async list(filters?: ProcessFilters): Promise<ProcessRecord[]> {
    let processes = Array.from(this.processes.values());
    
    if (filters) {
      if (filters.status) {
        processes = processes.filter(p => p.status === filters.status);
      }
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

  // Helper methods for testing
  clear(): void {
    // Kill all running processes first
    for (const process of Array.from(this.processes.values())) {
      if (process.subprocess) {
        try {
          process.subprocess.kill();
        } catch (error) {
          console.warn(`Failed to kill subprocess ${process.id}:`, error);
        }
      }
    }
    this.processes.clear();
  }

  size(): number {
    return this.processes.size;
  }
}

export class ProcessService extends SessionAwareService {
  private cleanupInterval: Timer | null = null;

  constructor(
    private store: ProcessStore,
    sessionManager: SessionManager,
    logger: Logger
  ) {
    super(sessionManager, logger);
    // Start cleanup process every 30 minutes
    this.startCleanupProcess();
  }

  async startProcess(command: string, sessionId?: string, options: ProcessOptions = {}): Promise<ServiceResult<ProcessRecord>> {
    try {
      const processId = this.generateProcessId();
      
      this.logger.info('Starting process', { processId, command, options });

      // Validate command - ALL process validation logic here
      if (!command.trim()) {
        return {
          success: false,
          error: {
            message: 'Invalid command: empty command provided',
            code: 'INVALID_COMMAND',
          },
        };
      }

      
      // Dual-mode session support: use specific session or default session
      let session: Session;
      if (sessionId) {
        const specificSession = this.sessionManager.getSession(sessionId);
        if (!specificSession) {
          return {
            success: false,
            error: {
              message: `Session '${sessionId}' not found`,
              code: 'SESSION_NOT_FOUND',
              details: { sessionId, command },
            },
          };
        }
        session = specificSession;
      } else {
        // Use default session (auto-creates if needed)
        session = await this.sessionManager.getOrCreateDefaultSession();
      }
      
      // Start background process using nohup approach (like main branch)
      // Execute command in background and get PID for tracking
      let pid: number;
      try {
        // Use nohup to start background process - returns immediately with PID
        const backgroundCommand = `nohup ${command} > /tmp/${processId}.out 2> /tmp/${processId}.err & echo $!`;
        const result = await session.exec(backgroundCommand, {
          cwd: options.cwd,
          env: options.env,
        });
        
        if (result.exitCode !== 0) {
          return {
            success: false,
            error: {
              message: `Failed to start background process: ${result.stderr}`,
              code: 'PROCESS_START_ERROR',
              details: { command, stderr: result.stderr },
            },
          };
        }
        
        // Parse PID from output
        pid = parseInt(result.stdout.trim());
        if (isNaN(pid)) {
          return {
            success: false,
            error: {
              message: `Failed to get process PID: ${result.stdout}`,
              code: 'PROCESS_PID_ERROR',
              details: { command, stdout: result.stdout },
            },
          };
        }
      } catch (error) {
        return {
          success: false,
          error: {
            message: `Failed to start background process: ${error instanceof Error ? error.message : 'Unknown error'}`,
            code: 'PROCESS_START_ERROR',
            details: { command, originalError: error instanceof Error ? error.message : 'Unknown error' },
          },
        };
      }
      
      // Create subprocess representation for background tracking
      const subprocess = {
        pid,
        stdout: this.createFileReadStream(`/tmp/${processId}.out`),
        stderr: this.createFileReadStream(`/tmp/${processId}.err`),
        stdin: null, // Background processes don't have stdin
        exited: this.createProcessExitPromise(pid), // Track process completion
        exitCode: null, // Will be set when process exits
        kill: (signal?: number) => {
          try {
            process.kill(pid, signal || 'SIGTERM');
          } catch (err) {
            // Process might already be dead
          }
        }
      };
      
      const processRecord: ProcessRecord = {
        id: processId,
        pid: subprocess.pid,
        command,
        status: 'running',
        startTime: new Date(),
        subprocess,
        stdout: '',
        stderr: '',
        outputListeners: new Set(),
        statusListeners: new Set(),
      };
      
      // Set up native stream handling with Bun's optimized streams
      this.handleProcessStreams(processRecord, subprocess);
      
      // Handle process exit
      this.handleProcessExit(processRecord, subprocess);
      
      await this.store.create(processRecord);
      
      this.logger.info('Process started successfully', { 
        processId, 
        pid: subprocess.pid 
      });
      
      return {
        success: true,
        data: processRecord,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to start process', error instanceof Error ? error : undefined, { command, options });
      
      return {
        success: false,
        error: {
          message: 'Failed to start process',
          code: 'PROCESS_START_ERROR',
          details: { command, originalError: errorMessage },
        },
      };
    }
  }

  async executeCommand(command: string, sessionId?: string, options: ProcessOptions = {}): Promise<ServiceResult<CommandResult>> {
    try {
      this.logger.info('Executing command', { command, options });

      // Use session-aware command execution - ALL command execution logic here
      const result = await this.executeInSession(command, sessionId, {
        cwd: options.cwd,
        env: options.env,
        timeout: CONFIG.COMMAND_TIMEOUT_MS,
        isolation: options.isolation ?? false
      });

      if (!result.success) {
        // Session execution failed
        return {
          success: false,
          error: {
            message: `Command execution session error: ${result.error.message}`,
            code: 'COMMAND_EXEC_SESSION_ERROR',
            details: { ...result.error.details, command, options }
          }
        };
      }

      this.logger.info('Command executed in session', { 
        command, 
        exitCode: result.data.exitCode, 
        success: result.data.success 
      });

      // Convert session result to CommandResult format
      const commandResult = {
        success: result.data.success,
        exitCode: result.data.exitCode,
        stdout: result.data.stdout,
        stderr: result.data.stderr,
        command: command
      };

      // Service operation was successful regardless of command exit code
      // Command failure is indicated in CommandResult.success, not ServiceResult.success
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
          message: 'Failed to execute command',
          code: 'COMMAND_EXEC_ERROR',
          details: { command, originalError: errorMessage },
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
            code: 'PROCESS_NOT_FOUND',
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
          message: 'Failed to get process',
          code: 'PROCESS_GET_ERROR',
          details: { processId: id, originalError: errorMessage },
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
            code: 'PROCESS_NOT_FOUND',
          },
        };
      }

      if (process.subprocess) {
        process.subprocess.kill();
        await this.store.update(id, { 
          status: 'killed', 
          endTime: new Date() 
        });
        
        this.logger.info('Process killed', { processId: id, pid: process.pid });
      }

      return {
        success: true,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to kill process', error instanceof Error ? error : undefined, { processId: id });
      
      return {
        success: false,
        error: {
          message: 'Failed to kill process',
          code: 'PROCESS_KILL_ERROR',
          details: { processId: id, originalError: errorMessage },
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
          message: 'Failed to list processes',
          code: 'PROCESS_LIST_ERROR',
          details: { filters, originalError: errorMessage },
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
          message: 'Failed to kill all processes',
          code: 'PROCESS_KILL_ALL_ERROR',
          details: { originalError: errorMessage },
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
            code: 'PROCESS_NOT_FOUND',
          },
        };
      }

      if (!process.subprocess?.stdout) {
        return {
          success: false,
          error: {
            message: `Process ${id} has no stdout stream`,
            code: 'NO_STDOUT_STREAM',
          },
        };
      }

      // Return Bun's native readable stream for better performance
      return {
        success: true,
        data: process.subprocess.stdout,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to stream process logs', error instanceof Error ? error : undefined, { processId: id });
      
      return {
        success: false,
        error: {
          message: 'Failed to stream process logs',
          code: 'PROCESS_STREAM_ERROR',
          details: { processId: id, originalError: errorMessage },
        },
      };
    }
  }

  private handleProcessStreams(record: ProcessRecord, subprocess: { stdout?: ReadableStream; stderr?: ReadableStream }): void {
    // Session-aware stream handling - ALL stream processing logic here
    const decoder = new TextDecoder();
    
    // Handle stdout with enhanced logging
    if (subprocess.stdout) {
      const stdoutReader = subprocess.stdout.getReader();
      const readStdout = async () => {
        try {
          while (true) {
            const { done, value } = await stdoutReader.read();
            if (done) break;
            
            const data = decoder.decode(value);
            record.stdout += data;
            
            // Enhanced output listener notifications with session context
            record.outputListeners.forEach(listener => {
              try {
                listener('stdout', data);
              } catch (listenerError) {
                this.logger.warn('Output listener error', { 
                  processId: record.id, 
                  error: listenerError instanceof Error ? listenerError.message : 'Unknown error' 
                });
              }
            });
          }
        } catch (error) {
          this.logger.error('Error reading stdout in session-aware process', error instanceof Error ? error : undefined, { 
            processId: record.id
          });
        }
      };
      readStdout();
    }

    // Handle stderr with enhanced logging
    if (subprocess.stderr) {
      const stderrReader = subprocess.stderr.getReader();
      const readStderr = async () => {
        try {
          while (true) {
            const { done, value } = await stderrReader.read();
            if (done) break;
            
            const data = decoder.decode(value);
            record.stderr += data;
            
            // Enhanced output listener notifications with session context
            record.outputListeners.forEach(listener => {
              try {
                listener('stderr', data);
              } catch (listenerError) {
                this.logger.warn('Output listener error', { 
                  processId: record.id, 
                  error: listenerError instanceof Error ? listenerError.message : 'Unknown error' 
                });
              }
            });
          }
        } catch (error) {
          this.logger.error('Error reading stderr in session-aware process', error instanceof Error ? error : undefined, { 
            processId: record.id,
          });
        }
      };
      readStderr();
    }
  }

  private handleProcessExit(record: ProcessRecord, subprocess: { exited: Promise<number> }): void {
    // Session-aware process exit handling - ALL exit logic here
    subprocess.exited.then((exitCode: number) => {
      const endTime = new Date();
      const status: ProcessStatus = exitCode === 0 ? 'completed' : 'failed';
      
      // Update the record with session context
      record.status = status;
      record.endTime = endTime;
      record.exitCode = exitCode;
      
      // Notify listeners with enhanced error handling
      record.statusListeners.forEach(listener => {
        try {
          listener(status);
        } catch (listenerError) {
          this.logger.warn('Status listener error', { 
            processId: record.id,
                error: listenerError instanceof Error ? listenerError.message : 'Unknown error' 
          });
        }
      });
      
      // Update in store with enhanced error handling
      this.store.update(record.id, {
        status,
        endTime,
        exitCode,
      }).catch(error => {
        this.logger.error('Failed to update process status in session-aware service', error, { 
          processId: record.id,
        });
      });

      this.logger.info('Session-aware process exited', {
        processId: record.id,
        exitCode,
        status,
        duration: endTime.getTime() - record.startTime.getTime(),
      });
    }).catch(error => {
      // Enhanced error handling for session-aware processes
      record.status = 'error';
      record.endTime = new Date();
      
      record.statusListeners.forEach(listener => {
        try {
          listener('error');
        } catch (listenerError) {
          this.logger.warn('Status listener error during process error', { 
            processId: record.id,
                error: listenerError instanceof Error ? listenerError.message : 'Unknown error' 
          });
        }
      });
      
      this.logger.error('Session-aware process error', error, { 
        processId: record.id,
      });
    });
  }

  private generateProcessId(): string {
    return `proc_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  }

  private startCleanupProcess(): void {
    this.cleanupInterval = setInterval(async () => {
      try {
        const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
        const cleaned = await this.store.cleanup(thirtyMinutesAgo);
        if (cleaned > 0) {
          this.logger.info('Cleaned up old processes', { count: cleaned });
        }
      } catch (error) {
        this.logger.error('Failed to cleanup processes', error instanceof Error ? error : undefined);
      }
    }, 30 * 60 * 1000); // 30 minutes
  }

  /**
   * Create a readable stream from a file for process output
   */
  private createFileReadStream(filePath: string): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(controller) {
        // For now, return empty stream - real implementation would watch file
        controller.close();
      }
    });
  }
  
  /**
   * Create a promise that resolves when process exits
   */
  private createProcessExitPromise(pid: number): Promise<number> {
    return new Promise((resolve) => {
      // Poll for process existence to detect when it exits
      const checkInterval = setInterval(() => {
        try {
          // Sending signal 0 checks if process exists without killing it
          process.kill(pid, 0);
        } catch (error) {
          // Process doesn't exist anymore
          clearInterval(checkInterval);
          resolve(0); // Default exit code - could be enhanced to get real exit code
        }
      }, 1000); // Check every second
    });
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