import { BaseHttpClient } from './base-client';
import type { BaseApiResponse, HttpClientOptions } from './types';

/**
 * Response interface for ping operations
 */
export interface PingResponse extends BaseApiResponse {
  message: string;
  uptime?: number;
}

/**
 * Response interface for getting available commands
 */
export interface CommandsResponse extends BaseApiResponse {
  availableCommands: string[];
  count: number;
}

/**
 * Client for health checks and utility operations
 */
export class UtilityClient extends BaseHttpClient {
  constructor(options: HttpClientOptions = {}) {
    super(options);
  }

  /**
   * Ping the sandbox to check if it's responsive
   */
  async ping(): Promise<string> {
    try {
      const response = await this.get<PingResponse>('/api/ping');
      
      this.logSuccess('Ping successful', response.message);
      return response.message;
    } catch (error) {
      this.logError('ping', error);
      throw error;
    }
  }

  /**
   * Get list of available commands in the sandbox environment
   */
  async getCommands(): Promise<string[]> {
    try {
      const response = await this.get<CommandsResponse>('/api/commands');
      
      this.logSuccess(
        'Commands retrieved',
        `${response.count} commands available`
      );

      return response.availableCommands;
    } catch (error) {
      this.logError('getCommands', error);
      throw error;
    }
  }
}