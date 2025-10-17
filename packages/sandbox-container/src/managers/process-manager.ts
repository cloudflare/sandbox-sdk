import type { ProcessOptions, ProcessStatus } from '../core/types';

export interface CommandValidation {
  valid: boolean;
  error?: string;
  code?: string;
}

export interface ProcessRecordData {
  id: string;
  command: string;
  status: ProcessStatus;
  startTime: Date;
  pid?: number;
  sessionId?: string;
  stdout: string;
  stderr: string;
  outputListeners: Set<(stream: 'stdout' | 'stderr', data: string) => void>;
  statusListeners: Set<(status: ProcessStatus) => void>;
}

export class ProcessManager {
  /**
   * Validates a command string
   */
  validateCommand(command: string): CommandValidation {
    if (!command || command.trim() === '') {
      return {
        valid: false,
        error: 'Invalid command: empty command provided',
        code: 'INVALID_COMMAND',
      };
    }

    return { valid: true };
  }

  /**
   * Creates a process record data structure
   */
  createProcessRecord(
    command: string,
    pid: number | undefined,
    options: ProcessOptions
  ): ProcessRecordData {
    return {
      id: options.processId || this.generateProcessId(),
      command,
      pid,
      status: 'running',
      startTime: new Date(),
      sessionId: options.sessionId,
      stdout: '',
      stderr: '',
      outputListeners: new Set(),
      statusListeners: new Set(),
    };
  }

  /**
   * Generates a unique process ID
   */
  generateProcessId(): string {
    return `proc_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  }

  /**
   * Interprets an exit code to determine process status
   */
  interpretExitCode(exitCode: number): ProcessStatus {
    return exitCode === 0 ? 'completed' : 'failed';
  }
}
