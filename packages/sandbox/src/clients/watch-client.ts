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
    let accumulated = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          throw new Error('Watch stream ended before watcher was established');
        }
        bufferedChunks.push(value);
        accumulated += decoder.decode(value, { stream: true });

        if (accumulated.includes('"type":"watching"')) {
          break;
        }

        if (accumulated.includes('"type":"error"')) {
          const match = accumulated.match(/"error"\s*:\s*"([^"]+)"/);
          const msg = match?.[1] || 'Watch failed to establish';
          reader.cancel().catch(() => {});
          throw new Error(msg);
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
