import { parseSSEStream } from '../sse-parser';
import type { LogEvent } from '../types';
import { BaseHttpClient } from './base-client';
import type { BaseApiResponse, HttpClientOptions, SessionRequest } from './types';

/**
 * Request interface for starting processes
 */
export interface StartProcessRequest extends SessionRequest {
  command: string;
  processId?: string;
}

/**
 * Process information
 */
export interface ProcessInfo {
  id: string;
  command: string;
  status: 'running' | 'completed' | 'killed' | 'failed';
  pid?: number;
  exitCode?: number;
  startTime: string;
  endTime?: string;
}

/**
 * Response interface for starting processes
 */
export interface StartProcessResponse extends BaseApiResponse {
  process: ProcessInfo;
}

/**
 * Response interface for listing processes
 */
export interface ListProcessesResponse extends BaseApiResponse {
  processes: ProcessInfo[];
  count: number;
}

/**
 * Response interface for getting a single process
 */
export interface GetProcessResponse extends BaseApiResponse {
  process: ProcessInfo;
}

/**
 * Response interface for process logs - matches container format
 */
export interface GetProcessLogsResponse extends BaseApiResponse {
  processId: string;
  stdout: string;
  stderr: string;
}

/**
 * Response interface for killing processes
 */
export interface KillProcessResponse extends BaseApiResponse {
  message: string;
}

/**
 * Response interface for killing all processes
 */
export interface KillAllProcessesResponse extends BaseApiResponse {
  killedCount: number;
  message: string;
}


/**
 * Client for background process management
 */
export class ProcessClient extends BaseHttpClient {
  constructor(options: HttpClientOptions = {}) {
    super(options);
  }

  /**
   * Start a background process
   */
  async startProcess(
    command: string,
    options?: { processId?: string; sessionId?: string }
  ): Promise<StartProcessResponse> {
    try {
      const data = this.withSession({
        command,
        processId: options?.processId,
      }, options?.sessionId);

      const response = await this.postJson<StartProcessResponse>(
        '/api/process/start',
        data
      );

      this.logSuccess(
        'Process started',
        `${command} (ID: ${response.process.id})`
      );

      return response;
    } catch (error) {
      this.logError('startProcess', error);
      throw error;
    }
  }

  /**
   * List all processes
   */
  async listProcesses(): Promise<ListProcessesResponse> {
    try {
      const response = await this.get<ListProcessesResponse>('/api/process/list');
      
      this.logSuccess('Processes listed', `${response.count} processes`);
      return response;
    } catch (error) {
      this.logError('listProcesses', error);
      throw error;
    }
  }

  /**
   * Get information about a specific process
   */
  async getProcess(processId: string): Promise<GetProcessResponse> {
    try {
      const response = await this.get<GetProcessResponse>(`/api/process/${processId}`);
      
      this.logSuccess('Process retrieved', `ID: ${processId}`);
      return response;
    } catch (error) {
      this.logError('getProcess', error);
      throw error;
    }
  }

  /**
   * Kill a specific process
   */
  async killProcess(processId: string): Promise<KillProcessResponse> {
    try {
      const response = await this.delete<KillProcessResponse>(
        `/api/process/${processId}`
      );

      this.logSuccess('Process killed', `ID: ${processId}`);
      return response;
    } catch (error) {
      this.logError('killProcess', error);
      throw error;
    }
  }

  /**
   * Kill all running processes
   */
  async killAllProcesses(): Promise<KillAllProcessesResponse> {
    try {
      const response = await this.delete<KillAllProcessesResponse>(
        '/api/process/kill-all'
      );

      this.logSuccess(
        'All processes killed',
        `${response.killedCount} processes terminated`
      );

      return response;
    } catch (error) {
      this.logError('killAllProcesses', error);
      throw error;
    }
  }

  /**
   * Get logs from a specific process
   */
  async getProcessLogs(processId: string): Promise<GetProcessLogsResponse> {
    try {
      const response = await this.get<GetProcessLogsResponse>(
        `/api/process/${processId}/logs`
      );

      this.logSuccess(
        'Process logs retrieved',
        `ID: ${processId}, stdout: ${response.stdout.length} chars, stderr: ${response.stderr.length} chars`
      );

      return response;
    } catch (error) {
      this.logError('getProcessLogs', error);
      throw error;
    }
  }

  /**
   * Stream logs from a specific process
   */
  async streamProcessLogs(processId: string): Promise<ReadableStream<Uint8Array>> {
    try {
      const response = await this.doFetch(`/api/process/${processId}/stream`, {
        method: 'GET',
      });

      const stream = await this.handleStreamResponse(response);
      
      this.logSuccess('Process log stream started', `ID: ${processId}`);

      return stream;
    } catch (error) {
      this.logError('streamProcessLogs', error);
      throw error;
    }
  }
}
