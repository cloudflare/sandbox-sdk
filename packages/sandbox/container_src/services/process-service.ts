// Bun-optimized Process Management Service
import type { 
  ProcessRecord, 
  ProcessOptions, 
  ProcessStatus, 
  CommandResult, 
  Logger, 
  ServiceResult 
} from '../core/types';

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
  sessionId?: string;
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
      if (filters.sessionId) {
        processes = processes.filter(p => p.sessionId === filters.sessionId);
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

export class ProcessService {
  private cleanupInterval: Timer | null = null;

  constructor(
    private store: ProcessStore,
    private logger: Logger
  ) {
    // Start cleanup process every 30 minutes
    this.startCleanupProcess();
  }

  async startProcess(command: string, options: ProcessOptions = {}): Promise<ServiceResult<ProcessRecord>> {
    try {
      const processId = this.generateProcessId();
      
      this.logger.info('Starting process', { processId, command, options });

      // Use Bun.spawn for better performance and lifecycle management
      const args = command.split(' ');
      const executable = args.shift();
      
      if (!executable) {
        return {
          success: false,
          error: {
            message: 'Invalid command: empty command provided',
            code: 'INVALID_COMMAND',
          },
        };
      }

      const subprocess = Bun.spawn([executable, ...args], {
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'pipe',
        cwd: options.cwd || process.cwd(),
        env: { ...process.env, ...options.env },
      });
      
      const processRecord: ProcessRecord = {
        id: processId,
        pid: subprocess.pid,
        command,
        status: 'running',
        startTime: new Date(),
        sessionId: options.sessionId,
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

  async executeCommand(command: string, options: ProcessOptions = {}): Promise<ServiceResult<CommandResult>> {
    try {
      this.logger.info('Executing command', { command, options });

      // Use Bun's shell operator for simple commands with better performance
      const proc = Bun.spawn(['sh', '-c', command], {
        stdout: 'pipe',
        stderr: 'pipe',
        cwd: options.cwd || process.cwd(),
        env: { ...process.env, ...options.env },
      });

      // Wait for the process to complete and collect output
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);

      await proc.exited;
      const exitCode = proc.exitCode || 0;

      const result: CommandResult = {
        success: exitCode === 0,
        exitCode,
        stdout,
        stderr,
      };

      this.logger.info('Command executed', { 
        command, 
        exitCode, 
        success: result.success 
      });

      // If the command failed (non-zero exit code), return error ServiceResult
      if (exitCode !== 0) {
        return {
          success: false,
          error: {
            message: 'Failed to execute command',
            code: 'COMMAND_EXEC_ERROR',
            details: { command, exitCode, stderr, originalError: `Command exited with code ${exitCode}` },
          },
        };
      }

      return {
        success: true,
        data: result,
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
    // Use Bun's native stream handling for better performance
    const decoder = new TextDecoder();
    
    // Handle stdout
    if (!subprocess.stdout) return;
    const stdoutReader = subprocess.stdout.getReader();
    const readStdout = async () => {
      try {
        while (true) {
          const { done, value } = await stdoutReader.read();
          if (done) break;
          
          const data = decoder.decode(value);
          record.stdout += data;
          record.outputListeners.forEach(listener => listener('stdout', data));
        }
      } catch (error) {
        this.logger.error('Error reading stdout', error instanceof Error ? error : undefined, { processId: record.id });
      }
    };

    // Handle stderr
    if (!subprocess.stderr) return;
    const stderrReader = subprocess.stderr.getReader();
    const readStderr = async () => {
      try {
        while (true) {
          const { done, value } = await stderrReader.read();
          if (done) break;
          
          const data = decoder.decode(value);
          record.stderr += data;
          record.outputListeners.forEach(listener => listener('stderr', data));
        }
      } catch (error) {
        this.logger.error('Error reading stderr', error instanceof Error ? error : undefined, { processId: record.id });
      }
    };

    // Start reading streams asynchronously
    readStdout();
    readStderr();
  }

  private handleProcessExit(record: ProcessRecord, subprocess: { exited: Promise<number> }): void {
    subprocess.exited.then((exitCode: number) => {
      const endTime = new Date();
      const status: ProcessStatus = exitCode === 0 ? 'completed' : 'failed';
      
      // Update the record
      record.status = status;
      record.endTime = endTime;
      record.exitCode = exitCode;
      
      // Notify listeners
      record.statusListeners.forEach(listener => listener(status));
      
      // Update in store
      this.store.update(record.id, {
        status,
        endTime,
        exitCode,
      }).catch(error => {
        this.logger.error('Failed to update process status', error, { processId: record.id });
      });

      this.logger.info('Process exited', {
        processId: record.id,
        exitCode,
        status,
        duration: endTime.getTime() - record.startTime.getTime(),
      });
    }).catch(error => {
      record.status = 'error';
      record.endTime = new Date();
      record.statusListeners.forEach(listener => listener('error'));
      
      this.logger.error('Process error', error, { processId: record.id });
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