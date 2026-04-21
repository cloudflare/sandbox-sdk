import type {
  ProcessCleanupResult,
  ProcessInfoResult,
  ProcessKillResult,
  ProcessListResult,
  ProcessLogsResult,
  ProcessStartResult,
  StartProcessRequest
} from '@repo/shared';
import { BaseHttpClient } from './base-client';
import type { HttpClientOptions } from './types';

// Re-export for convenience
export type {
  StartProcessRequest,
  ProcessStartResult,
  ProcessListResult,
  ProcessInfoResult,
  ProcessKillResult,
  ProcessLogsResult,
  ProcessCleanupResult
};

/**
 * Client for background process management
 */
export class ProcessClient extends BaseHttpClient {
  /**
   * Start a background process
   * @param command - Command to execute as a background process
   * @param sessionId - The session ID for this operation
   * @param options - Optional settings (processId)
   */
  async startProcess(
    command: string,
    sessionId: string,
    options?: {
      processId?: string;
      timeoutMs?: number;
      env?: Record<string, string | undefined>;
      cwd?: string;
      encoding?: string;
      autoCleanup?: boolean;
      origin?: 'user' | 'internal';
    }
  ): Promise<ProcessStartResult> {
    const data: StartProcessRequest = {
      command,
      sessionId,
      ...(options?.origin !== undefined && { origin: options.origin }),
      ...(options?.processId !== undefined && {
        processId: options.processId
      }),
      ...(options?.timeoutMs !== undefined && {
        timeoutMs: options.timeoutMs
      }),
      ...(options?.env !== undefined && { env: options.env }),
      ...(options?.cwd !== undefined && { cwd: options.cwd }),
      ...(options?.encoding !== undefined && { encoding: options.encoding }),
      ...(options?.autoCleanup !== undefined && {
        autoCleanup: options.autoCleanup
      })
    };

    const response = await this.post<ProcessStartResult>(
      '/api/process/start',
      data
    );

    return response;
  }

  /**
   * List all processes (sandbox-scoped, not session-scoped)
   */
  async listProcesses(): Promise<ProcessListResult> {
    const url = `/api/process/list`;
    const response = await this.get<ProcessListResult>(url);

    return response;
  }

  /**
   * Get information about a specific process (sandbox-scoped, not session-scoped)
   * @param processId - ID of the process to retrieve
   */
  async getProcess(processId: string): Promise<ProcessInfoResult> {
    const url = `/api/process/${processId}`;
    const response = await this.get<ProcessInfoResult>(url);

    return response;
  }

  /**
   * Kill a specific process (sandbox-scoped, not session-scoped)
   * @param processId - ID of the process to kill
   */
  async killProcess(processId: string): Promise<ProcessKillResult> {
    const url = `/api/process/${processId}`;
    const response = await this.delete<ProcessKillResult>(url);

    return response;
  }

  /**
   * Kill all running processes (sandbox-scoped, not session-scoped)
   */
  async killAllProcesses(): Promise<ProcessCleanupResult> {
    const url = `/api/process/kill-all`;
    const response = await this.delete<ProcessCleanupResult>(url);

    return response;
  }

  /**
   * Get logs from a specific process (sandbox-scoped, not session-scoped)
   * @param processId - ID of the process to get logs from
   */
  async getProcessLogs(processId: string): Promise<ProcessLogsResult> {
    const url = `/api/process/${processId}/logs`;
    const response = await this.get<ProcessLogsResult>(url);

    return response;
  }

  /**
   * Stream logs from a specific process (sandbox-scoped, not session-scoped)
   * @param processId - ID of the process to stream logs from
   */
  async streamProcessLogs(
    processId: string
  ): Promise<ReadableStream<Uint8Array>> {
    const url = `/api/process/${processId}/stream`;
    // Use doStreamFetch with GET method (process log streaming is GET)
    const stream = await this.doStreamFetch(url, undefined, 'GET');

    return stream;
  }
}
