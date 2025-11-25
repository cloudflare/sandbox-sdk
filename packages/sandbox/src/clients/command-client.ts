import type { ExecuteRequest } from '@repo/shared';
import { BaseHttpClient } from './base-client';
import type { BaseApiResponse } from './types';

/**
 * Request interface for command execution
 */
export type { ExecuteRequest };

/**
 * Response interface for command execution
 */
export interface ExecuteResponse extends BaseApiResponse {
  stdout: string;
  stderr: string;
  exitCode: number;
  command: string;
}

/**
 * Client for command execution operations
 */
export class CommandClient extends BaseHttpClient {
  /**
   * Execute a command and return the complete result
   * @param command - The command to execute
   * @param sessionId - The session ID for this command execution
   * @param timeoutMs - Optional timeout in milliseconds (unlimited by default)
   * @param env - Optional environment variables for this command
   * @param cwd - Optional working directory for this command
   */
  async execute(
    command: string,
    sessionId: string,
    options?: {
      timeoutMs?: number;
      env?: Record<string, string>;
      cwd?: string;
    }
  ): Promise<ExecuteResponse> {
    try {
      const data: ExecuteRequest = {
        command,
        sessionId,
        ...(options?.timeoutMs !== undefined && {
          timeoutMs: options.timeoutMs
        }),
        ...(options?.env !== undefined && { env: options.env }),
        ...(options?.cwd !== undefined && { cwd: options.cwd })
      };

      const response = await this.post<ExecuteResponse>('/api/execute', data);

      this.logSuccess(
        'Command executed',
        `${command}, Success: ${response.success}`
      );

      // Call the callback if provided
      this.options.onCommandComplete?.(
        response.success,
        response.exitCode,
        response.stdout,
        response.stderr,
        response.command
      );

      return response;
    } catch (error) {
      this.logError('execute', error);

      // Call error callback if provided
      this.options.onError?.(
        error instanceof Error ? error.message : String(error),
        command
      );

      throw error;
    }
  }

  /**
   * Execute a command and return a stream of events
   * @param command - The command to execute
   * @param sessionId - The session ID for this command execution
   * @param options - Optional per-command execution settings
   */
  async executeStream(
    command: string,
    sessionId: string,
    options?: {
      env?: Record<string, string>;
      cwd?: string;
    }
  ): Promise<ReadableStream<Uint8Array>> {
    try {
      const data = {
        command,
        sessionId,
        ...(options?.env !== undefined && { env: options.env }),
        ...(options?.cwd !== undefined && { cwd: options.cwd })
      };

      const response = await this.doFetch('/api/execute/stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(data)
      });

      const stream = await this.handleStreamResponse(response);

      this.logSuccess('Command stream started', command);

      return stream;
    } catch (error) {
      this.logError('executeStream', error);

      // Call error callback if provided
      this.options.onError?.(
        error instanceof Error ? error.message : String(error),
        command
      );

      throw error;
    }
  }
}
