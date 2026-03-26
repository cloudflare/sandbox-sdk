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
      env?: Record<string, string | undefined>;
      cwd?: string;
      origin?: 'user' | 'internal';
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
        ...(options?.cwd !== undefined && { cwd: options.cwd }),
        ...(options?.origin !== undefined && { origin: options.origin })
      };

      const response = await this.post<ExecuteResponse>('/api/execute', data);

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
      timeoutMs?: number;
      env?: Record<string, string | undefined>;
      cwd?: string;
      origin?: 'user' | 'internal';
    }
  ): Promise<ReadableStream<Uint8Array>> {
    try {
      const data = {
        command,
        sessionId,
        ...(options?.timeoutMs !== undefined && {
          timeoutMs: options.timeoutMs
        }),
        ...(options?.env !== undefined && { env: options.env }),
        ...(options?.cwd !== undefined && { cwd: options.cwd }),
        ...(options?.origin !== undefined && { origin: options.origin })
      };

      // Use doStreamFetch which handles both WebSocket and HTTP streaming
      const stream = await this.doStreamFetch('/api/execute/stream', data);

      return stream;
    } catch (error) {
      // Call error callback if provided
      this.options.onError?.(
        error instanceof Error ? error.message : String(error),
        command
      );

      throw error;
    }
  }
}
