import type {
  PortCloseResult,
  PortExposeResult,
  PortListResult,
  PortWatchRequest
} from '@repo/shared';
import { BaseHttpClient } from './base-client';

// Re-export for convenience
export type { PortExposeResult, PortCloseResult, PortListResult };

/**
 * Request interface for exposing ports
 */
export interface ExposePortRequest {
  port: number;
  name?: string;
  /**
   * Custom token for the preview URL (optional)
   * If not provided, a random token will be generated
   * Must be exactly 16 characters, containing only lowercase letters, numbers, hyphens, and underscores
   */
  token?: string;
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
   * @param token - Optional custom token for the preview URL
   */
  async exposePort(
    port: number,
    sessionId: string,
    name?: string,
    token?: string
  ): Promise<PortExposeResult> {
    try {
      const data = { port, sessionId, name, token };

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

  /**
   * Watch a port for readiness via SSE stream
   * @param request - Port watch configuration
   * @returns SSE stream that emits PortWatchEvent objects
   */
  async watchPort(
    request: PortWatchRequest
  ): Promise<ReadableStream<Uint8Array>> {
    try {
      const stream = await this.doStreamFetch('/api/port-watch', request);
      this.logSuccess('Port watch started', `port ${request.port}`);
      return stream;
    } catch (error) {
      this.logError('watchPort', error);
      throw error;
    }
  }
}
