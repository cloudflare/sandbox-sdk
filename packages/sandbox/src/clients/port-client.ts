import type { PortWatchRequest } from '@repo/shared';
import { BaseHttpClient } from './base-client';

/**
 * Client for port readiness operations.
 */
export class PortClient extends BaseHttpClient {
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
