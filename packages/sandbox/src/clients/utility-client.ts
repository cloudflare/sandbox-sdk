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
 * Response interface for getting container version
 */
export interface VersionResponse extends BaseApiResponse {
  version: string;
}

/**
 * Request interface for creating sessions
 */
export interface CreateSessionRequest {
  id: string;
  env?: Record<string, string | undefined>;
  cwd?: string;
  commandTimeoutMs?: number;
}

/**
 * Response interface for creating sessions.
 *
 * `containerPlacementId` carries the container's `CLOUDFLARE_PLACEMENT_ID` at session
 * creation time so the DO can capture it without a separate request. It is
 * `null` when the environment variable is not set, such as in local dev.
 */
export interface CreateSessionResponse extends BaseApiResponse {
  id: string;
  message: string;
  containerPlacementId?: string | null;
}

/**
 * Request interface for deleting sessions
 */
export interface DeleteSessionRequest {
  sessionId: string;
}

/**
 * Response interface for deleting sessions
 */
export interface DeleteSessionResponse extends BaseApiResponse {
  sessionId: string;
}

/**
 * Client for health checks and utility operations
 */
export class UtilityClient extends BaseHttpClient {
  /**
   * Ping the sandbox to check if it's responsive
   */
  async ping(): Promise<string> {
    const response = await this.get<PingResponse>('/api/ping');

    return response.message;
  }

  /**
   * Get list of available commands in the sandbox environment
   */
  async getCommands(): Promise<string[]> {
    const response = await this.get<CommandsResponse>('/api/commands');

    return response.availableCommands;
  }

  /**
   * Create a new execution session
   * @param options - Session configuration (id, env, cwd)
   */
  async createSession(
    options: CreateSessionRequest
  ): Promise<CreateSessionResponse> {
    const response = await this.post<CreateSessionResponse>(
      '/api/session/create',
      options
    );

    return response;
  }

  /**
   * Delete an execution session
   * @param sessionId - Session ID to delete
   */
  async deleteSession(sessionId: string): Promise<DeleteSessionResponse> {
    const response = await this.post<DeleteSessionResponse>(
      '/api/session/delete',
      { sessionId }
    );

    return response;
  }

  /**
   * Get the container version
   * Returns the version embedded in the Docker image during build
   */
  async getVersion(): Promise<string> {
    try {
      const response = await this.get<VersionResponse>('/api/version');

      return response.version;
    } catch (error) {
      // If version endpoint doesn't exist (old container), return 'unknown'
      // This allows for backward compatibility
      this.logger.debug(
        'Failed to get container version (may be old container)',
        { error }
      );
      return 'unknown';
    }
  }
}
