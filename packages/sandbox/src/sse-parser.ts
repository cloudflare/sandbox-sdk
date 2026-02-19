import { parseSSEFrames, type SSEPartialEvent } from '@repo/shared';

/**
 * Server-Sent Events (SSE) parser for streaming responses
 * Converts ReadableStream<Uint8Array> to typed AsyncIterable<T>
 */

/**
 * Parse a ReadableStream of SSE events into typed AsyncIterable
 * @param stream - The ReadableStream from fetch response
 * @param signal - Optional AbortSignal for cancellation
 */
export async function* parseSSEStream<T>(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): AsyncIterable<T> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent: SSEPartialEvent = { data: [] };

  const emitEvent = (data: string): T | undefined => {
    if (data === '[DONE]' || data.trim() === '') {
      return undefined;
    }

    try {
      return JSON.parse(data) as T;
    } catch {
      return undefined;
    }
  };

  try {
    while (true) {
      // Check for cancellation
      if (signal?.aborted) {
        throw new Error('Operation was aborted');
      }

      const { done, value } = await reader.read();
      if (done) break;

      // Decode chunk and parse complete SSE frames
      buffer += decoder.decode(value, { stream: true });
      const parsed = parseSSEFrames(buffer, currentEvent);
      buffer = parsed.remaining;
      currentEvent = parsed.currentEvent;

      for (const frame of parsed.events) {
        const event = emitEvent(frame.data);
        if (event !== undefined) {
          yield event;
        }
      }
    }

    // Flush any complete frame that can be parsed from remaining data
    const finalParsed = parseSSEFrames(`${buffer}\n\n`, currentEvent);
    for (const frame of finalParsed.events) {
      const event = emitEvent(frame.data);
      if (event !== undefined) {
        yield event;
      }
    }
  } finally {
    // Clean up resources
    try {
      await reader.cancel();
    } catch {}
    reader.releaseLock();
  }
}

/**
 * Helper to convert a Response with SSE stream directly to AsyncIterable
 * @param response - Response object with SSE stream
 * @param signal - Optional AbortSignal for cancellation
 */
export async function* responseToAsyncIterable<T>(
  response: Response,
  signal?: AbortSignal
): AsyncIterable<T> {
  if (!response.ok) {
    throw new Error(
      `Response not ok: ${response.status} ${response.statusText}`
    );
  }

  if (!response.body) {
    throw new Error('No response body');
  }

  yield* parseSSEStream<T>(response.body, signal);
}

/**
 * Create an SSE-formatted ReadableStream from an AsyncIterable
 * (Useful for Worker endpoints that need to forward AsyncIterable as SSE)
 * @param events - AsyncIterable of events
 * @param options - Stream options
 */
export function asyncIterableToSSEStream<T>(
  events: AsyncIterable<T>,
  options?: {
    signal?: AbortSignal;
    serialize?: (event: T) => string;
  }
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const serialize = options?.serialize || JSON.stringify;

  return new ReadableStream({
    async start(controller) {
      try {
        for await (const event of events) {
          if (options?.signal?.aborted) {
            controller.error(new Error('Operation was aborted'));
            break;
          }

          const data = serialize(event);
          const sseEvent = `data: ${data}\n\n`;
          controller.enqueue(encoder.encode(sseEvent));
        }

        // Send completion marker
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      } catch (error) {
        controller.error(error);
      } finally {
        controller.close();
      }
    },

    cancel() {
      // Handle stream cancellation
    }
  });
}
