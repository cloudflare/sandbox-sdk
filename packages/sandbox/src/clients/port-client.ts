import type {
  ExposePortRequest,
  PortCloseResult,
  PortExposeResult,
  PortListResult,
  PortWatchRequest
} from '@repo/shared';
import { BaseHttpClient } from './base-client';

// Re-export for convenience
export type {
  ExposePortRequest,
  PortExposeResult,
  PortCloseResult,
  PortListResult
};

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
    const data = { port, sessionId, name };

    const response = await this.post<PortExposeResult>(
      '/api/expose-port',
      data
    );

    return response;
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
    const url = `/api/exposed-ports/${port}?session=${encodeURIComponent(
      sessionId
    )}`;
    const response = await this.delete<PortCloseResult>(url);

    return response;
  }

  /**
   * Get all currently exposed ports
   * @param sessionId - The session ID for this operation
   */
  async getExposedPorts(sessionId: string): Promise<PortListResult> {
    const url = `/api/exposed-ports?session=${encodeURIComponent(sessionId)}`;
    const response = await this.get<PortListResult>(url);

    return response;
  }

  /**
   * Watch a port for readiness via SSE stream
   * @param request - Port watch configuration
   * @returns SSE stream that emits PortWatchEvent objects
   */
  async watchPort(
    request: PortWatchRequest
  ): Promise<ReadableStream<Uint8Array>> {
    const stream = await this.doStreamFetch('/api/port-watch', request);
    return stream;
  }
}
