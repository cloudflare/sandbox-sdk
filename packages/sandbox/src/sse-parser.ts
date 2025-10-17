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

  try {
    while (true) {
      // Check for cancellation
      if (signal?.aborted) {
        throw new Error('Operation was aborted');
      }

      const { done, value } = await reader.read();
      if (done) break;

      // Decode chunk and add to buffer
      buffer += decoder.decode(value, { stream: true });

      // Process complete SSE events in buffer
      const lines = buffer.split('\n');

      // Keep the last incomplete line in buffer
      buffer = lines.pop() || '';

      for (const line of lines) {
        // Skip empty lines
        if (line.trim() === '') continue;

        // Process SSE data lines
        if (line.startsWith('data: ')) {
          const data = line.substring(6);

          // Skip [DONE] markers or empty data
          if (data === '[DONE]' || data.trim() === '') continue;

          try {
            const event = JSON.parse(data) as T;
            yield event;
          } catch {
            // Skip invalid JSON events and continue processing
          }
        }
        // Handle other SSE fields if needed (event:, id:, retry:)
        // For now, we only care about data: lines
      }
    }

    // Process any remaining data in buffer
    if (buffer.trim() && buffer.startsWith('data: ')) {
      const data = buffer.substring(6);
      if (data !== '[DONE]' && data.trim()) {
        try {
          const event = JSON.parse(data) as T;
          yield event;
        } catch {
          // Skip invalid JSON in final event
        }
      }
    }
  } finally {
    // Clean up resources
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
    throw new Error(`Response not ok: ${response.status} ${response.statusText}`);
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