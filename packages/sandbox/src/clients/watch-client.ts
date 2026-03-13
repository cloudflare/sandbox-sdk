import {
  type FileWatchSSEEvent,
  parseSSEFrames,
  type SSEPartialEvent,
  type WatchCheckpointRequest,
  type WatchCheckpointResult,
  type WatchEnsureResult,
  type WatchRequest,
  type WatchStateResult,
  type WatchStopOptions,
  type WatchStopResult
} from '@repo/shared';
import { BaseHttpClient } from './base-client';

/**
 * Client for file watch operations
 * Uses inotify under the hood for native filesystem event notifications
 *
 * @internal This client is used internally by the SDK.
 * Users should use `sandbox.watch()` instead.
 */
export class WatchClient extends BaseHttpClient {
  async ensureWatch(request: WatchRequest): Promise<WatchEnsureResult> {
    try {
      const response = await this.post<WatchEnsureResult>(
        '/api/watch/ensure',
        request
      );

      this.logSuccess('Persistent watch ensured', request.path);
      return response;
    } catch (error) {
      this.logError('ensureWatch', error);
      throw error;
    }
  }

  async getWatchState(watchId: string): Promise<WatchStateResult> {
    try {
      const response = await this.get<WatchStateResult>(
        `/api/watch/${watchId}`
      );

      this.logSuccess('Watch state retrieved', watchId);
      return response;
    } catch (error) {
      this.logError('getWatchState', error);
      throw error;
    }
  }

  async checkpointWatch(
    watchId: string,
    request: WatchCheckpointRequest
  ): Promise<WatchCheckpointResult> {
    try {
      const response = await this.post<WatchCheckpointResult>(
        `/api/watch/${watchId}/checkpoint`,
        request
      );

      this.logSuccess('Watch checkpoint recorded', watchId);
      return response;
    } catch (error) {
      this.logError('checkpointWatch', error);
      throw error;
    }
  }

  async stopWatch(
    watchId: string,
    options: WatchStopOptions = {}
  ): Promise<WatchStopResult> {
    try {
      const searchParams = new URLSearchParams();
      if (options.leaseToken) {
        searchParams.set('leaseToken', options.leaseToken);
      }
      const suffix = searchParams.size > 0 ? `?${searchParams.toString()}` : '';
      const response = await this.delete<WatchStopResult>(
        `/api/watch/${watchId}${suffix}`
      );

      this.logSuccess('Watch stopped', watchId);
      return response;
    } catch (error) {
      this.logError('stopWatch', error);
      throw error;
    }
  }

  /**
   * Start watching a directory for changes.
   * The returned promise resolves only after the watcher is established
   * on the filesystem (i.e. the `watching` SSE event has been received).
   * The returned stream still contains the `watching` event so consumers
   * using `parseSSEStream` will see the full event sequence.
   *
   * @param request - Watch request with path and options
   */
  async watch(request: WatchRequest): Promise<ReadableStream<Uint8Array>> {
    try {
      const stream = await this.doStreamFetch('/api/watch', request);
      const readyStream = await this.waitForReadiness(stream);

      this.logSuccess('File watch started', request.path);
      return readyStream;
    } catch (error) {
      this.logError('watch', error);
      throw error;
    }
  }

  /**
   * Read SSE chunks until the `watching` event appears, then return a
   * wrapper stream that replays the buffered chunks followed by the
   * remaining original stream data.
   */
  private async waitForReadiness(
    stream: ReadableStream<Uint8Array>
  ): Promise<ReadableStream<Uint8Array>> {
    const reader = stream.getReader();
    const bufferedChunks: Uint8Array[] = [];
    const decoder = new TextDecoder();
    let buffer = '';
    let currentEvent: SSEPartialEvent = { data: [] };
    let watcherReady = false;

    const processEventData = (eventData: string) => {
      let event: FileWatchSSEEvent | undefined;
      try {
        event = JSON.parse(eventData) as FileWatchSSEEvent;
      } catch {
        return;
      }

      if (event.type === 'watching') {
        watcherReady = true;
      }

      if (event.type === 'error') {
        throw new Error(event.error || 'Watch failed to establish');
      }
    };

    try {
      while (!watcherReady) {
        const { done, value } = await reader.read();
        if (done) {
          const finalParsed = parseSSEFrames(`${buffer}\n\n`, currentEvent);
          for (const frame of finalParsed.events) {
            processEventData(frame.data);
            if (watcherReady) {
              break;
            }
          }

          if (watcherReady) {
            break;
          }

          throw new Error('Watch stream ended before watcher was established');
        }

        bufferedChunks.push(value);
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSSEFrames(buffer, currentEvent);
        buffer = parsed.remaining;
        currentEvent = parsed.currentEvent;

        for (const frame of parsed.events) {
          processEventData(frame.data);
          if (watcherReady) {
            break;
          }
        }
      }
    } catch (error) {
      reader.cancel().catch(() => {});
      throw error;
    }

    // Return a stream that replays buffered chunks, then forwards the rest.
    let replayIndex = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (replayIndex < bufferedChunks.length) {
          controller.enqueue(bufferedChunks[replayIndex++]);
          return;
        }
        return reader.read().then(({ done: d, value: v }) => {
          if (d) {
            controller.close();
            return;
          }
          controller.enqueue(v);
        });
      },
      cancel() {
        return reader.cancel();
      }
    });
  }
}
