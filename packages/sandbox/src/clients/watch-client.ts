import type { WatchRequest, WatchStopResult } from '@repo/shared';
import { BaseHttpClient } from './base-client';

/**
 * Response for listing active watches
 */
export interface WatchListResponse {
  success: boolean;
  watches: Array<{
    id: string;
    path: string;
    startedAt: string;
  }>;
  count: number;
  timestamp: string;
}

/**
 * Client for file watch operations
 * Uses inotify under the hood for native filesystem event notifications
 *
 * @internal This client is used internally by the SDK.
 * Users should use `sandbox.files.watch()` instead.
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

  /**
   * Stop a specific watch by ID
   *
   * @param watchId - The watch ID returned in the 'watching' event
   */
  async stopWatch(watchId: string): Promise<WatchStopResult> {
    try {
      const response = await this.post<WatchStopResult>('/api/watch/stop', {
        watchId
      });

      this.logSuccess('Watch stopped', watchId);
      return response;
    } catch (error) {
      this.logError('stopWatch', error);
      throw error;
    }
  }

  /**
   * List all active watches
   */
  async listWatches(): Promise<WatchListResponse> {
    try {
      const response = await this.get<WatchListResponse>('/api/watch/list');

      this.logSuccess('Watches listed', `${response.count} active`);
      return response;
    } catch (error) {
      this.logError('listWatches', error);
      throw error;
    }
  }
}
