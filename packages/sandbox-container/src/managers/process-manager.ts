/**
 * ProcessManager - Pure Business Logic
 *
 * Contains all process-related business logic with NO I/O operations.
 * This class is 100% unit testable without mocking Bun APIs.
 *
 * Responsibilities:
 * - Command validation
 * - Command parsing
 * - Process record creation
 * - Exit code interpretation
 * - ID generation
 */

import type { ProcessOptions, ProcessRecord, ProcessStatus } from '../core/types';

export interface CommandValidation {
  valid: boolean;
  error?: string;
  code?: string;
}

export interface ParsedCommand {
  executable: string;
  args: string[];
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
   * Pure logic - no I/O
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
   * Parses a command string into executable and arguments
   * Pure logic - no I/O
   */
  parseCommand(command: string): ParsedCommand {
    const args = command.split(' ').filter(arg => arg.length > 0);
    const executable = args.shift() || '';

    return {
      executable,
      args,
    };
  }

  /**
   * Creates a process record data structure
   * Pure logic - no I/O
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
   * Pure logic - uses Date.now() and Math.random() but no I/O
   */
  generateProcessId(): string {
    return `proc_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  }

  /**
   * Interprets an exit code to determine process status
   * Pure logic - no I/O
   */
  interpretExitCode(exitCode: number): ProcessStatus {
    return exitCode === 0 ? 'completed' : 'failed';
  }

  /**
   * Determines if a process should be cleaned up based on age and status
   * Pure logic - no I/O
   */
  shouldCleanupProcess(
    process: { status: ProcessStatus; startTime: Date },
    olderThan: Date
  ): boolean {
    const isTerminated = ['completed', 'failed', 'killed', 'error'].includes(process.status);
    const isOld = process.startTime < olderThan;

    return isTerminated && isOld;
  }

  /**
   * Validates process options
   * Pure logic - no I/O
   */
  validateProcessOptions(options: ProcessOptions): { valid: boolean; error?: string } {
    // Add validation logic for options if needed
    // For now, all options are valid
    return { valid: true };
  }

  /**
   * Creates a cleanup cutoff date
   * Pure logic - date calculation
   */
  createCleanupCutoffDate(minutesAgo: number): Date {
    return new Date(Date.now() - minutesAgo * 60 * 1000);
  }
}
