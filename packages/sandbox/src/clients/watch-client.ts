import type { WatchRequest } from '@repo/shared';
import { BaseHttpClient } from './base-client';

/**
 * Client for file watch operations
 * Uses inotify under the hood for native filesystem event notifications
 *
 * @internal This client is used internally by the SDK.
 * Users should use `sandbox.watch()` instead.
 */
export class WatchClient extends BaseHttpClient {
  /**
   * Start watching a directory for changes
   * Returns a stream of SSE events for file changes
   *
   * @param request - Watch request with path and options
   */
  async watch(request: WatchRequest): Promise<ReadableStream<Uint8Array>> {
    try {
      // Use doStreamFetch which handles both WebSocket and HTTP streaming
      const stream = await this.doStreamFetch('/api/watch', request);

      this.logSuccess('File watch started', request.path);
      return stream;
    } catch (error) {
      this.logError('watch', error);
      throw error;
    }
  }
}
