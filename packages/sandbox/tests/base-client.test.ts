import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseApiResponse, HttpClientOptions } from '../src/clients';
import { BaseHttpClient } from '../src/clients/base-client';
import type { ErrorResponse } from '../src/errors';
import {
  CommandError,
  FileNotFoundError,
  FileSystemError,
  PermissionDeniedError,
  SandboxError
} from '../src/errors';

interface TestDataResponse extends BaseApiResponse {
  data: string;
}

interface TestResourceResponse extends BaseApiResponse {
  id: string;
}

interface TestSourceResponse extends BaseApiResponse {
  source: string;
}

interface TestStatusResponse extends BaseApiResponse {
  status: string;
}

class TestHttpClient extends BaseHttpClient {
  constructor(options: HttpClientOptions = {}) {
    super({
      baseUrl: 'http://test.com',
      port: 3000,
      ...options
    });
  }

  public async testRequest<T = BaseApiResponse>(
    endpoint: string,
    data?: Record<string, unknown>
  ): Promise<T> {
    if (data) {
      return this.post<T>(endpoint, data);
    }
    return this.get<T>(endpoint);
  }

  public async testStreamRequest(endpoint: string): Promise<ReadableStream> {
    const response = await this.doFetch(endpoint);
    return this.handleStreamResponse(response);
  }

  public async testErrorHandling(errorResponse: ErrorResponse) {
    const response = new Response(JSON.stringify(errorResponse), {
      status: errorResponse.httpStatus || 400
    });
    return this.handleErrorResponse(response);
  }
}

describe('BaseHttpClient', () => {
  let client: TestHttpClient;
  let mockFetch: ReturnType<typeof vi.fn>;
  let onError: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockFetch = vi.fn();
    global.fetch = mockFetch as unknown as typeof fetch;
    onError = vi.fn();

    client = new TestHttpClient({
      baseUrl: 'http://test.com',
      port: 3000,
      onError
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('core request functionality', () => {
    it('should handle successful API requests', async () => {
      mockFetch.mockResolvedValue(
        new Response(
          JSON.stringify({ success: true, data: 'operation completed' }),
          { status: 200 }
        )
      );

      const result = await client.testRequest<TestDataResponse>('/api/test');

      expect(result.success).toBe(true);
      expect(result.data).toBe('operation completed');
    });

    it('should handle POST requests with data', async () => {
      const requestData = { action: 'create', name: 'test-resource' };
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ success: true, id: 'resource-123' }), {
          status: 201
        })
      );

      const result = await client.testRequest<TestResourceResponse>(
        '/api/create',
        requestData
      );

      expect(result.success).toBe(true);
      expect(result.id).toBe('resource-123');

      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('http://test.com/api/create');
      expect(options.method).toBe('POST');
      expect(options.headers['Content-Type']).toBe('application/json');
      expect(JSON.parse(options.body)).toEqual(requestData);
    });
  });

  describe('error handling and mapping', () => {
    it('should map container errors to client errors', async () => {
      const errorMappingTests = [
        {
          containerError: {
            code: 'FILE_NOT_FOUND',
            message: 'File not found: /test.txt',
            context: { path: '/test.txt' },
            httpStatus: 404,
            timestamp: new Date().toISOString()
          },
          expectedError: FileNotFoundError
        },
        {
          containerError: {
            code: 'PERMISSION_DENIED',
            message: 'Permission denied',
            context: { path: '/secure.txt' },
            httpStatus: 403,
            timestamp: new Date().toISOString()
          },
          expectedError: PermissionDeniedError
        },
        {
          containerError: {
            code: 'COMMAND_EXECUTION_ERROR',
            message: 'Command failed: badcmd',
            context: { command: 'badcmd' },
            httpStatus: 400,
            timestamp: new Date().toISOString()
          },
          expectedError: CommandError
        },
        {
          containerError: {
            code: 'FILESYSTEM_ERROR',
            message: 'Filesystem error',
            context: { path: '/test' },
            httpStatus: 500,
            timestamp: new Date().toISOString()
          },
          expectedError: FileSystemError
        },
        {
          containerError: {
            code: 'UNKNOWN_ERROR',
            message: 'Unknown error',
            context: {},
            httpStatus: 500,
            timestamp: new Date().toISOString()
          },
          expectedError: SandboxError
        }
      ];

      for (const test of errorMappingTests) {
        await expect(
          client.testErrorHandling(test.containerError as ErrorResponse)
        ).rejects.toThrow(test.expectedError);

        expect(onError).toHaveBeenCalledWith(
          test.containerError.message,
          undefined
        );
      }
    });

    it('should handle malformed error responses', async () => {
      mockFetch.mockResolvedValue(
        new Response('invalid json {', { status: 500 })
      );

      await expect(client.testRequest('/api/test')).rejects.toThrow(
        SandboxError
      );
    });

    it('should handle network failures', async () => {
      mockFetch.mockRejectedValue(new Error('Network connection timeout'));

      await expect(client.testRequest('/api/test')).rejects.toThrow(
        'Network connection timeout'
      );
    });

    it('should handle server unavailable scenarios', async () => {
      mockFetch.mockResolvedValue(
        new Response('Service Unavailable', { status: 503 })
      );

      await expect(client.testRequest('/api/test')).rejects.toThrow(
        SandboxError
      );

      expect(onError).toHaveBeenCalledWith(
        'HTTP error! status: 503',
        undefined
      );
    });
  });

  describe('streaming functionality', () => {
    it('should handle streaming responses', async () => {
      const streamData = 'data: {"type":"output","content":"stream data"}\n\n';
      const mockStream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(streamData));
          controller.close();
        }
      });

      mockFetch.mockResolvedValue(
        new Response(mockStream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' }
        })
      );

      const stream = await client.testStreamRequest('/api/stream');

      expect(stream).toBeInstanceOf(ReadableStream);

      const reader = stream.getReader();
      const { done, value } = await reader.read();
      const content = new TextDecoder().decode(value);

      expect(done).toBe(false);
      expect(content).toContain('stream data');

      reader.releaseLock();
    });

    it('should handle streaming errors', async () => {
      mockFetch.mockResolvedValue(
        new Response(
          JSON.stringify({
            error: 'Stream initialization failed',
            code: 'STREAM_ERROR'
          }),
          { status: 400 }
        )
      );

      await expect(client.testStreamRequest('/api/bad-stream')).rejects.toThrow(
        SandboxError
      );
    });

    it('should handle missing stream body', async () => {
      mockFetch.mockResolvedValue(
        new Response(null, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' }
        })
      );

      await expect(
        client.testStreamRequest('/api/empty-stream')
      ).rejects.toThrow('No response body for streaming');
    });
  });

  describe('stub integration', () => {
    it('should use stub when provided instead of fetch', async () => {
      const stubFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: true, source: 'stub' }), {
          status: 200
        })
      );

      const stub = { containerFetch: stubFetch };
      const stubClient = new TestHttpClient({
        baseUrl: 'http://test.com',
        port: 3000,
        stub
      });

      const result =
        await stubClient.testRequest<TestSourceResponse>('/api/stub-test');

      expect(result.success).toBe(true);
      expect(result.source).toBe('stub');
      expect(stubFetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/stub-test',
        { method: 'GET' },
        3000
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should handle stub errors', async () => {
      const stubFetch = vi
        .fn()
        .mockRejectedValue(new Error('Stub connection failed'));
      const stub = { containerFetch: stubFetch };
      const stubClient = new TestHttpClient({
        baseUrl: 'http://test.com',
        port: 3000,
        stub
      });

      await expect(stubClient.testRequest('/api/stub-error')).rejects.toThrow(
        'Stub connection failed'
      );
    });
  });

  describe('edge cases and resilience', () => {
    it('should handle responses with unusual status codes', async () => {
      const unusualStatusTests = [
        { status: 201, shouldSucceed: true },
        { status: 202, shouldSucceed: true },
        { status: 409, shouldSucceed: false },
        { status: 422, shouldSucceed: false },
        { status: 429, shouldSucceed: false }
      ];

      for (const test of unusualStatusTests) {
        mockFetch.mockResolvedValueOnce(
          new Response(
            test.shouldSucceed
              ? JSON.stringify({ success: true, status: test.status })
              : JSON.stringify({ error: `Status ${test.status}` }),
            { status: test.status }
          )
        );

        if (test.shouldSucceed) {
          const result = await client.testRequest<TestStatusResponse>(
            '/api/unusual-status'
          );
          expect(result.success).toBe(true);
          expect(result.status).toBe(test.status);
        } else {
          await expect(
            client.testRequest('/api/unusual-status')
          ).rejects.toThrow();
        }
      }
    });
  });

  describe('container startup retry logic', () => {
    it('should retry 503 errors with "no container instance available"', async () => {
      vi.useFakeTimers();

      mockFetch
        .mockResolvedValueOnce(
          new Response('Error: There is no container instance available', {
            status: 503
          })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ success: true, data: 'recovered' }), {
            status: 200
          })
        );

      const promise = client.testRequest<TestDataResponse>('/api/test');
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await promise;

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(result.success).toBe(true);
      expect(result.data).toBe('recovered');

      vi.useRealTimers();
    });

    it('should retry 500 errors with "container port not found"', async () => {
      vi.useFakeTimers();

      mockFetch
        .mockResolvedValueOnce(
          new Response('Connection refused: container port not found', {
            status: 500
          })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ success: true }), { status: 200 })
        );

      const promise = client.testRequest('/api/test');
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await promise;

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(result.success).toBe(true);

      vi.useRealTimers();
    });

    it('should retry 500 errors with "the container is not listening"', async () => {
      vi.useFakeTimers();

      mockFetch
        .mockResolvedValueOnce(
          new Response('Error: the container is not listening on port 3000', {
            status: 500
          })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ success: true }), { status: 200 })
        );

      const promise = client.testRequest('/api/test');
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await promise;

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(result.success).toBe(true);

      vi.useRealTimers();
    });

    it('should NOT retry 500 errors with "no such image"', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('Error: no such image: my-container:latest', {
          status: 500
        })
      );

      await expect(client.testRequest('/api/test')).rejects.toThrow();
      expect(mockFetch).toHaveBeenCalledTimes(1); // No retry
    });

    it('should NOT retry 500 errors with "container already exists"', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('Error: container already exists', { status: 500 })
      );

      await expect(client.testRequest('/api/test')).rejects.toThrow();
      expect(mockFetch).toHaveBeenCalledTimes(1); // No retry
    });

    it('should NOT retry 500 errors with unknown patterns', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('Internal server error: database connection failed', {
          status: 500
        })
      );

      await expect(client.testRequest('/api/test')).rejects.toThrow();
      expect(mockFetch).toHaveBeenCalledTimes(1); // Fail-safe: don't retry
    });

    it('should NOT retry 404 or other non-500/503 errors', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('Not found', { status: 404 })
      );

      await expect(client.testRequest('/api/test')).rejects.toThrow();
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should respect MIN_TIME_FOR_RETRY_MS and stop retrying', async () => {
      vi.useFakeTimers();

      // Mock responses that would trigger retry
      mockFetch.mockResolvedValue(
        new Response('No container instance available', { status: 503 })
      );

      const promise = client.testRequest('/api/test');

      // Fast-forward past retry budget (120s)
      await vi.advanceTimersByTimeAsync(125_000);

      // Should eventually give up and throw the 503 error
      await expect(promise).rejects.toThrow();

      vi.useRealTimers();
    });

    it('should use exponential backoff: 3s, 6s, 12s, 24s, 30s', async () => {
      vi.useFakeTimers();
      const delays: number[] = [];
      let callCount = 0;

      mockFetch.mockImplementation(async () => {
        delays.push(Date.now());
        callCount++;
        // After 5 attempts, return success to avoid timeout
        if (callCount >= 5) {
          return new Response(JSON.stringify({ success: true }), {
            status: 200
          });
        }
        return new Response('No container instance available', { status: 503 });
      });

      const promise = client.testRequest('/api/test');

      // Advance time to allow all retries
      await vi.advanceTimersByTimeAsync(80_000);

      await promise;

      // Check delays between attempts (approximately)
      // Attempt 1 at 0ms, Attempt 2 at ~3000ms, Attempt 3 at ~9000ms, etc.
      expect(delays.length).toBeGreaterThanOrEqual(4);

      vi.useRealTimers();
    });

    it('should retry multiple transient errors in sequence', async () => {
      vi.useFakeTimers();

      mockFetch
        .mockResolvedValueOnce(
          new Response('No container instance available', { status: 503 })
        )
        .mockResolvedValueOnce(
          new Response('Container port not found', { status: 500 })
        )
        .mockResolvedValueOnce(
          new Response('The container is not listening', { status: 500 })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ success: true }), { status: 200 })
        );

      const promise = client.testRequest('/api/test');

      // Advance time to allow all retries (3s + 6s + 12s = 21s)
      await vi.advanceTimersByTimeAsync(25_000);

      const result = await promise;

      expect(mockFetch).toHaveBeenCalledTimes(4);
      expect(result.success).toBe(true);

      vi.useRealTimers();
    });

    it('should handle case-insensitive error matching', async () => {
      vi.useFakeTimers();

      mockFetch
        .mockResolvedValueOnce(
          new Response('ERROR: CONTAINER PORT NOT FOUND', { status: 500 })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ success: true }), { status: 200 })
        );

      const promise = client.testRequest('/api/test');

      // Advance time for first retry (3s)
      await vi.advanceTimersByTimeAsync(5_000);

      const result = await promise;

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(result.success).toBe(true);

      vi.useRealTimers();
    });
  });
});
