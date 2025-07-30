import { asyncIterableToSSEStream, parseSSEStream, responseToAsyncIterable } from '../../sse-parser';

describe('SSE Parser', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  describe('parseSSEStream', () => {
    function createMockSSEStream(events: string[]): ReadableStream<Uint8Array> {
      return new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          for (const event of events) {
            controller.enqueue(encoder.encode(event));
          }
          controller.close();
        }
      });
    }

    it('should parse valid SSE events', async () => {
      const stream = createMockSSEStream([
        'data: {"type":"start","command":"echo test"}\n\n',
        'data: {"type":"stdout","data":"test\\n"}\n\n',
        'data: {"type":"complete","exitCode":0}\n\n'
      ]);

      const events: any[] = [];
      for await (const event of parseSSEStream(stream)) {
        events.push(event);
      }

      expect(events).toHaveLength(3);
      expect(events[0]).toEqual({ type: 'start', command: 'echo test' });
      expect(events[1]).toEqual({ type: 'stdout', data: 'test\n' });
      expect(events[2]).toEqual({ type: 'complete', exitCode: 0 });
    });

    it('should handle empty data lines', async () => {
      const stream = createMockSSEStream([
        'data: \n\n',
        'data: {"type":"stdout","data":"valid"}\n\n'
      ]);

      const events: any[] = [];
      for await (const event of parseSSEStream(stream)) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ type: 'stdout', data: 'valid' });
    });

    it('should skip [DONE] markers', async () => {
      const stream = createMockSSEStream([
        'data: {"type":"start"}\n\n',
        'data: [DONE]\n\n',
        'data: {"type":"complete"}\n\n'
      ]);

      const events: any[] = [];
      for await (const event of parseSSEStream(stream)) {
        events.push(event);
      }

      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({ type: 'start' });
      expect(events[1]).toEqual({ type: 'complete' });
    });

    it('should handle malformed JSON gracefully', async () => {
      const stream = createMockSSEStream([
        'data: invalid json\n\n',
        'data: {"type":"stdout","data":"valid"}\n\n',
        'data: {incomplete\n\n'
      ]);

      const events: any[] = [];
      for await (const event of parseSSEStream(stream)) {
        events.push(event);
      }

      // Should skip malformed events and continue processing
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ type: 'stdout', data: 'valid' });
      
      // Should log parsing errors
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Failed to parse SSE event:',
        'invalid json',
        expect.any(Error)
      );
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Failed to parse SSE event:',
        '{incomplete',
        expect.any(Error)
      );
    });

    it('should handle empty lines and comments', async () => {
      const stream = createMockSSEStream([
        '\n',
        '   \n',
        ': this is a comment\n',
        'data: {"type":"test"}\n\n',
        '\n'
      ]);

      const events: any[] = [];
      for await (const event of parseSSEStream(stream)) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ type: 'test' });
    });

    it('should handle chunked data properly', async () => {
      // Simulate chunked delivery where data arrives in parts
      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          // Send partial data
          controller.enqueue(encoder.encode('data: {"typ'));
          controller.enqueue(encoder.encode('e":"start"}\n\n'));
          controller.enqueue(encoder.encode('data: {"type":"end"}\n\n'));
          controller.close();
        }
      });

      const events: any[] = [];
      for await (const event of parseSSEStream(stream)) {
        events.push(event);
      }

      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({ type: 'start' });
      expect(events[1]).toEqual({ type: 'end' });
    });

    it('should handle remaining buffer data after stream ends', async () => {
      const stream = createMockSSEStream([
        'data: {"type":"complete"}'  // No trailing newlines
      ]);

      const events: any[] = [];
      for await (const event of parseSSEStream(stream)) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ type: 'complete' });
    });

    it('should handle malformed final buffer data', async () => {
      const stream = createMockSSEStream([
        'data: invalid final data'  // No trailing newlines, invalid JSON
      ]);

      const events: any[] = [];
      for await (const event of parseSSEStream(stream)) {
        events.push(event);
      }

      expect(events).toHaveLength(0);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Failed to parse final SSE event:',
        'invalid final data',
        expect.any(Error)
      );
    });

    it('should support cancellation via AbortSignal', async () => {
      const controller = new AbortController();
      
      // Create a stream that would normally provide multiple events
      const stream = new ReadableStream({
        start(streamController) {
          const encoder = new TextEncoder();
          streamController.enqueue(encoder.encode('data: {"type":"start"}\n\n'));
          streamController.enqueue(encoder.encode('data: {"type":"continue"}\n\n'));
          streamController.close();
        }
      });

      // Abort the signal immediately
      controller.abort();

      await expect(async () => {
        for await (const event of parseSSEStream(stream, controller.signal)) {
          // Should not process any events due to immediate abort
        }
      }).rejects.toThrow('Operation was aborted');
    });

    it('should handle non-data SSE lines', async () => {
      const stream = createMockSSEStream([
        'event: message\n',
        'id: 123\n',
        'retry: 3000\n',
        'data: {"type":"test"}\n\n',
        'event: close\n',
        'data: {"type":"end"}\n\n'
      ]);

      const events: any[] = [];
      for await (const event of parseSSEStream(stream)) {
        events.push(event);
      }

      // Should only process data: lines
      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({ type: 'test' });
      expect(events[1]).toEqual({ type: 'end' });
    });
  });

  describe('responseToAsyncIterable', () => {
    it('should convert Response with SSE stream to AsyncIterable', async () => {
      const mockBody = createMockSSEStream([
        'data: {"type":"start"}\n\n',
        'data: {"type":"end"}\n\n'
      ]);

      const mockResponse = {
        ok: true,
        body: mockBody
      } as Response;

      const events: any[] = [];
      for await (const event of responseToAsyncIterable(mockResponse)) {
        events.push(event);
      }

      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({ type: 'start' });
      expect(events[1]).toEqual({ type: 'end' });
    });

    it('should throw error for non-ok response', async () => {
      const mockResponse = {
        ok: false,
        status: 500,
        statusText: 'Internal Server Error'
      } as Response;

      await expect(async () => {
        for await (const event of responseToAsyncIterable(mockResponse)) {
          // Should not reach here
        }
      }).rejects.toThrow('Response not ok: 500 Internal Server Error');
    });

    it('should throw error for response without body', async () => {
      const mockResponse = {
        ok: true,
        body: null
      } as Response;

      await expect(async () => {
        for await (const event of responseToAsyncIterable(mockResponse)) {
          // Should not reach here
        }
      }).rejects.toThrow('No response body');
    });

    it('should pass through AbortSignal to parseSSEStream', async () => {
      const controller = new AbortController();
      const mockBody = new ReadableStream({
        start(streamController) {
          const encoder = new TextEncoder();
          streamController.enqueue(encoder.encode('data: {"type":"start"}\n\n'));
          streamController.enqueue(encoder.encode('data: {"type":"end"}\n\n'));
          streamController.close();
        }
      });

      const mockResponse = {
        ok: true,
        body: mockBody
      } as Response;

      // Abort immediately to test signal propagation
      controller.abort();

      await expect(async () => {
        for await (const event of responseToAsyncIterable(mockResponse, controller.signal)) {
          // Should be aborted immediately
        }
      }).rejects.toThrow('Operation was aborted');
    });
  });

  describe('asyncIterableToSSEStream', () => {
    it('should convert AsyncIterable to SSE-formatted ReadableStream', async () => {
      async function* mockEvents() {
        yield { type: 'start', command: 'test' };
        yield { type: 'stdout', data: 'output' };
        yield { type: 'complete', exitCode: 0 };
      }

      const stream = asyncIterableToSSEStream(mockEvents());
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      
      const chunks: string[] = [];
      let done = false;
      
      while (!done) {
        const { value, done: readerDone } = await reader.read();
        done = readerDone;
        if (value) {
          chunks.push(decoder.decode(value));
        }
      }

      const fullOutput = chunks.join('');
      expect(fullOutput).toBe(
        'data: {"type":"start","command":"test"}\n\n' +
        'data: {"type":"stdout","data":"output"}\n\n' +
        'data: {"type":"complete","exitCode":0}\n\n' +
        'data: [DONE]\n\n'
      );
    });

    it('should use custom serializer when provided', async () => {
      async function* mockEvents() {
        yield { name: 'test', value: 123 };
      }

      const stream = asyncIterableToSSEStream(
        mockEvents(),
        {
          serialize: (event) => `custom:${event.name}=${event.value}`
        }
      );

      const reader = stream.getReader();
      const decoder = new TextDecoder();
      const { value } = await reader.read();
      
      expect(decoder.decode(value!)).toBe('data: custom:test=123\n\n');
    });

    it('should handle AbortSignal cancellation', async () => {
      const controller = new AbortController();
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      async function* mockEvents() {
        yield { type: 'start' };
        // Simulate long-running operation
        await new Promise(resolve => setTimeout(resolve, 100));
        yield { type: 'end' };
      }

      const stream = asyncIterableToSSEStream(
        mockEvents(),
        { signal: controller.signal }
      );

      const reader = stream.getReader();
      
      // Start reading
      const readPromise = reader.read();
      
      // Abort after short delay
      setTimeout(() => controller.abort(), 50);

      try {
        await readPromise;
        // Continue reading to trigger abort handling
        await reader.read();
      } catch (error) {
        expect((error as Error).message).toBe('Operation was aborted');
      }

      consoleLogSpy.mockRestore();
    });

    it('should handle stream cancellation', async () => {
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      async function* mockEvents() {
        yield { type: 'start' };
        yield { type: 'end' };
      }

      const stream = asyncIterableToSSEStream(mockEvents());
      const reader = stream.getReader();

      // Read first chunk
      await reader.read();

      // Cancel the stream
      await reader.cancel();

      expect(consoleLogSpy).toHaveBeenCalledWith('SSE stream cancelled');
      consoleLogSpy.mockRestore();
    });

    it('should handle errors in async iterable', async () => {
      async function* mockEvents() {
        yield { type: 'start' };
        throw new Error('Async iterable error');
      }

      const stream = asyncIterableToSSEStream(mockEvents());
      const reader = stream.getReader();

      // Read first chunk successfully
      const { value: firstValue } = await reader.read();
      expect(firstValue).toBeDefined();

      // Second read should encounter the error
      await expect(reader.read()).rejects.toThrow('Async iterable error');
    });

    it('should close stream after completion marker', async () => {
      async function* mockEvents() {
        yield { type: 'single' };
      }

      const stream = asyncIterableToSSEStream(mockEvents());
      const reader = stream.getReader();

      // Read the data event
      const { value: dataValue, done: dataDone } = await reader.read();
      expect(dataDone).toBe(false);
      expect(dataValue).toBeDefined();

      // Read the [DONE] marker
      const { value: doneValue, done: doneDone } = await reader.read();
      expect(doneDone).toBe(false);
      expect(doneValue).toBeDefined();
      
      const decoder = new TextDecoder();
      expect(decoder.decode(doneValue!)).toBe('data: [DONE]\n\n');

      // Stream should be closed now
      const { done: finalDone } = await reader.read();
      expect(finalDone).toBe(true);
    });
  });

  function createMockSSEStream(events: string[]): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        for (const event of events) {
          controller.enqueue(encoder.encode(event));
        }
        controller.close();
      }
    });
  }
});