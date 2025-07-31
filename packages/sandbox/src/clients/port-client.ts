import { BaseHttpClient } from './base-client';
import type { BaseApiResponse, HttpClientOptions } from './types';

/**
 * Request interface for exposing ports
 */
export interface ExposePortRequest {
  port: number;
  name?: string;
}

/**
 * Response interface for exposing ports
 */
export interface ExposePortResponse extends BaseApiResponse {
  port: number;
  exposedAt: string;
  name?: string;
}

/**
 * Request interface for unexposing ports
 */
export interface UnexposePortRequest {
  port: number;
}

/**
 * Response interface for unexposing ports
 */
export interface UnexposePortResponse extends BaseApiResponse {
  port: number;
}

/**
 * Information about an exposed port
 */
export interface ExposedPortInfo {
  port: number;
  name?: string;
  exposedAt: string;
}

/**
 * Response interface for getting exposed ports
 */
export interface GetExposedPortsResponse extends BaseApiResponse {
  ports: ExposedPortInfo[];
  count: number;
}

/**
 * Client for port management and preview URL operations
 */
export class PortClient extends BaseHttpClient {
  constructor(options: HttpClientOptions = {}) {
    super(options);
  }

  /**
   * Expose a port and get a preview URL
   */
  async exposePort(
    port: number,
    name?: string,
    sessionId?: string
  ): Promise<ExposePortResponse> {
    try {
      const data = this.withSession({ port, name }, sessionId);

      const response = await this.postJson<ExposePortResponse>(
        '/api/expose-port',
        data
      );

      this.logSuccess(
        'Port exposed',
        `${port} exposed at ${response.exposedAt}${name ? ` (${name})` : ''}`
      );

      return response;
    } catch (error) {
      this.logError('exposePort', error);
      throw error;
    }
  }

  /**
   * Unexpose a port and remove its preview URL
   */
  async unexposePort(port: number, sessionId?: string): Promise<UnexposePortResponse> {
    try {
      const response = await this.delete<UnexposePortResponse>(
        `/api/exposed-ports/${port}`
      );

      this.logSuccess('Port unexposed', `${port}`);
      return response;
    } catch (error) {
      this.logError('unexposePort', error);
      throw error;
    }
  }

  /**
   * Get all currently exposed ports
   */
  async getExposedPorts(sessionId?: string): Promise<GetExposedPortsResponse> {
    try {
      const response = await this.get<GetExposedPortsResponse>('/api/exposed-ports');

      this.logSuccess(
        'Exposed ports retrieved',
        `${response.count} ports exposed`
      );

      return response;
    } catch (error) {
      this.logError('getExposedPorts', error);
      throw error;
    }
  }
}