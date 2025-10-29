import type {
  PortCloseResult,
  PortExposeResult,
  PortListResult
} from '@repo/shared';
import { BaseHttpClient } from './base-client';
import type { HttpClientOptions } from './types';

// Re-export for convenience
export type { PortExposeResult, PortCloseResult, PortListResult };

/**
 * Request interface for exposing ports
 */
export interface ExposePortRequest {
  port: number;
  name?: string;
}

/**
 * Request interface for unexposing ports
 */
export interface UnexposePortRequest {
  port: number;
}

/**
 * Client for port management and preview URL operations
 */
export class PortClient extends BaseHttpClient {
  /**
   * Expose a port and get a preview URL
   * @param port - Port number to expose
   * @param sessionId - The session ID for this operation
   * @param name - Optional name for the port
   */
  async exposePort(
    port: number,
    sessionId: string,
    name?: string
  ): Promise<PortExposeResult> {
    try {
      const data = { port, sessionId, name };

      const response = await this.post<PortExposeResult>(
        '/api/expose-port',
        data
      );

      this.logSuccess(
        'Port exposed',
        `${port} exposed at ${response.url}${name ? ` (${name})` : ''}`
      );

      return response;
    } catch (error) {
      this.logError('exposePort', error);
      throw error;
    }
  }

  /**
   * Unexpose a port and remove its preview URL
   * @param port - Port number to unexpose
   * @param sessionId - The session ID for this operation
   */
  async unexposePort(
    port: number,
    sessionId: string
  ): Promise<PortCloseResult> {
    try {
      const url = `/api/exposed-ports/${port}?session=${encodeURIComponent(
        sessionId
      )}`;
      const response = await this.delete<PortCloseResult>(url);

      this.logSuccess('Port unexposed', `${port}`);
      return response;
    } catch (error) {
      this.logError('unexposePort', error);
      throw error;
    }
  }

  /**
   * Get all currently exposed ports
   * @param sessionId - The session ID for this operation
   */
  async getExposedPorts(sessionId: string): Promise<PortListResult> {
    try {
      const url = `/api/exposed-ports?session=${encodeURIComponent(sessionId)}`;
      const response = await this.get<PortListResult>(url);

      this.logSuccess(
        'Exposed ports retrieved',
        `${response.ports.length} ports exposed`
      );

      return response;
    } catch (error) {
      this.logError('getExposedPorts', error);
      throw error;
    }
  }
}
