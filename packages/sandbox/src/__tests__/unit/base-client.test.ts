import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BaseHttpClient } from '../../clients/base-client';
import { SandboxError, FileNotFoundError } from '../../errors';
import type { HttpClientOptions, ErrorResponse } from '../../clients/types';

// Concrete implementation for testing the abstract base class
class TestHttpClient extends BaseHttpClient {
  constructor(options: HttpClientOptions = {}) {
    super({
      baseUrl: 'http://test.com',
      port: 3000,
      ...options,
    });
  }

  // Expose protected methods for testing
  public testDoFetch(path: string, options?: RequestInit) {
    return this.doFetch(path, options);
  }

  public testPostJson<T>(endpoint: string, data: Record<string, any>, responseHandler?: any) {
    return this.postJson<T>(endpoint, data, responseHandler);
  }

  public testGet<T>(endpoint: string) {
    return this.get<T>(endpoint);
  }

  public testDelete<T>(endpoint: string) {
    return this.delete<T>(endpoint);
  }

  public testHandleResponse<T>(response: Response, customHandler?: any) {
    return this.handleResponse<T>(response, customHandler);
  }

  public testHandleErrorResponse(response: Response) {
    return this.handleErrorResponse(response);
  }

  public testWithSession(data: Record<string, any>, sessionId?: string) {
    return this.withSession(data, sessionId);
  }

  public testHandleStreamResponse(response: Response) {
    return this.handleStreamResponse(response);
  }

  public testLogSuccess(operation: string, details?: string) {
    return this.logSuccess(operation, details);
  }

  public testLogError(operation: string, error: unknown) {
    return this.logError(operation, error);
  }
}

describe('BaseHttpClient', () => {
  let client: TestHttpClient;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock = vi.fn();
    global.fetch = fetchMock;
    
    client = new TestHttpClient();
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should initialize with default options', () => {
      const defaultClient = new TestHttpClient();
      expect(defaultClient.getSessionId()).toBeNull();
    });

    it('should initialize with custom options', () => {
      const onError = vi.fn();
      const customClient = new TestHttpClient({
        baseUrl: 'http://custom.com',
        port: 8080,
        onError,
      });
      
      expect(customClient.getSessionId()).toBeNull();
    });

    it('should handle stub option', () => {
      const stub = { containerFetch: vi.fn() };
      const stubClient = new TestHttpClient({
        baseUrl: 'http://test.com',
        port: 3000,
        stub,
      });
      
      expect(stubClient.getSessionId()).toBeNull();
    });
  });

  describe('doFetch', () => {
    it('should make HTTP request with correct URL and options', async () => {
      const mockResponse = new Response('{"success": true}', { status: 200 });
      fetchMock.mockResolvedValue(mockResponse);

      const response = await client.testDoFetch('/test', {
        method: 'POST',
        body: JSON.stringify({ test: true }),
      });

      expect(fetchMock).toHaveBeenCalledWith('http://test.com/test', {
        method: 'POST',
        body: JSON.stringify({ test: true }),
      });
      expect(response).toBe(mockResponse);
      expect(consoleLogSpy).toHaveBeenCalledWith('[HTTP Client] Making POST request to http://test.com/test');
      expect(consoleLogSpy).toHaveBeenCalledWith('[HTTP Client] Response: 200 ');
    });

    it('should use stub.containerFetch when stub is provided', async () => {
      const mockResponse = new Response('{"success": true}', { status: 200 });
      const stub = { containerFetch: vi.fn().mockResolvedValue(mockResponse) };
      const stubClient = new TestHttpClient({
        baseUrl: 'http://test.com',
        port: 3000,
        stub,
      });

      await stubClient.testDoFetch('/test', { method: 'GET' });

      expect(stub.containerFetch).toHaveBeenCalledWith(
        'http://localhost:3000/test',
        { method: 'GET' },
        3000
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('should log error responses', async () => {
      const mockResponse = new Response('Not Found', { status: 404, statusText: 'Not Found' });
      fetchMock.mockResolvedValue(mockResponse);

      const response = await client.testDoFetch('/notfound');

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[HTTP Client] Request failed: GET http://test.com/notfound - 404 Not Found'
      );
      expect(response.status).toBe(404);
    });

    it('should handle fetch errors', async () => {
      const fetchError = new Error('Network error');
      fetchMock.mockRejectedValue(fetchError);

      await expect(client.testDoFetch('/error')).rejects.toThrow('Network error');
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[HTTP Client] Request error: GET http://test.com/error',
        fetchError
      );
    });

    it('should default to GET method when no method specified', async () => {
      const mockResponse = new Response('{"success": true}', { status: 200 });
      fetchMock.mockResolvedValue(mockResponse);

      await client.testDoFetch('/test');

      expect(fetchMock).toHaveBeenCalledWith('http://test.com/test', undefined);
      expect(consoleLogSpy).toHaveBeenCalledWith('[HTTP Client] Making GET request to http://test.com/test');
    });
  });

  describe('postJson', () => {
    it('should make POST request with JSON body', async () => {
      const mockResponse = new Response('{"result": "success"}', { status: 200 });
      fetchMock.mockResolvedValue(mockResponse);

      const result = await client.testPostJson('/api/test', { data: 'test' });

      expect(fetchMock).toHaveBeenCalledWith('http://test.com/api/test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ data: 'test' }),
      });
      expect(result).toEqual({ result: 'success' });
    });

    it('should handle custom response handler', async () => {
      const mockResponse = new Response('{"data": "custom"}', { status: 200 });
      fetchMock.mockResolvedValue(mockResponse);

      const customHandler = vi.fn().mockResolvedValue('handled');
      const result = await client.testPostJson('/api/test', { data: 'test' }, customHandler);

      expect(customHandler).toHaveBeenCalledWith(mockResponse);
      expect(result).toBe('handled');
    });
  });

  describe('get', () => {
    it('should make GET request', async () => {
      const mockResponse = new Response('{"result": "success"}', { status: 200 });
      fetchMock.mockResolvedValue(mockResponse);

      const result = await client.testGet('/api/test');

      expect(fetchMock).toHaveBeenCalledWith('http://test.com/api/test', {
        method: 'GET',
      });
      expect(result).toEqual({ result: 'success' });
    });
  });

  describe('delete', () => {
    it('should make DELETE request', async () => {
      const mockResponse = new Response('{"result": "deleted"}', { status: 200 });
      fetchMock.mockResolvedValue(mockResponse);

      const result = await client.testDelete('/api/test');

      expect(fetchMock).toHaveBeenCalledWith('http://test.com/api/test', {
        method: 'DELETE',
      });
      expect(result).toEqual({ result: 'deleted' });
    });
  });

  describe('handleResponse', () => {
    it('should parse JSON response for successful requests', async () => {
      const mockResponse = new Response('{"data": "test"}', { status: 200 });

      const result = await client.testHandleResponse(mockResponse);

      expect(result).toEqual({ data: 'test' });
    });

    it('should call custom handler when provided', async () => {
      const mockResponse = new Response('{"data": "test"}', { status: 200 });
      const customHandler = vi.fn().mockResolvedValue('custom result');

      const result = await client.testHandleResponse(mockResponse, customHandler);

      expect(customHandler).toHaveBeenCalledWith(mockResponse);
      expect(result).toBe('custom result');
    });

    it('should handle error responses', async () => {
      const errorResponse = new Response(
        JSON.stringify({ error: 'Not found', code: 'FILE_NOT_FOUND' }),
        { status: 404 }
      );

      await expect(client.testHandleResponse(errorResponse)).rejects.toThrow(FileNotFoundError);
    });
  });

  describe('handleErrorResponse', () => {
    it('should parse error response and throw mapped error', async () => {
      const errorResponse = new Response(
        JSON.stringify({ 
          error: 'File not found', 
          code: 'FILE_NOT_FOUND',
          path: '/test/file.txt'
        }),
        { status: 404 }
      );

      await expect(client.testHandleErrorResponse(errorResponse)).rejects.toThrow(FileNotFoundError);
    });

    it('should handle non-JSON error responses', async () => {
      const errorResponse = new Response('Internal Server Error', { 
        status: 500, 
        statusText: 'Internal Server Error' 
      });

      await expect(client.testHandleErrorResponse(errorResponse)).rejects.toThrow(SandboxError);
    });

    it('should call onError callback when provided', async () => {
      const onError = vi.fn();
      const clientWithCallback = new TestHttpClient({ 
        baseUrl: 'http://test.com',
        port: 3000,
        onError 
      });

      const errorResponse = new Response(
        JSON.stringify({ error: 'Test error' }),
        { status: 400 }
      );

      await expect(clientWithCallback.testHandleErrorResponse(errorResponse)).rejects.toThrow();
      expect(onError).toHaveBeenCalledWith('Test error', undefined);
    });
  });

  describe('session management', () => {
    it('should set and get session ID', () => {
      expect(client.getSessionId()).toBeNull();

      client.setSessionId('test-session-123');
      expect(client.getSessionId()).toBe('test-session-123');

      client.setSessionId(null);
      expect(client.getSessionId()).toBeNull();
    });

    it('should include session ID in request data', () => {
      client.setSessionId('session-123');

      const data = { command: 'ls' };
      const result = client.testWithSession(data);

      expect(result).toEqual({
        command: 'ls',
        sessionId: 'session-123',
      });
    });

    it('should not include session ID when not set', () => {
      const data = { command: 'ls' };
      const result = client.testWithSession(data);

      expect(result).toEqual({ command: 'ls' });
    });

    it('should use provided session ID over instance session ID', () => {
      client.setSessionId('instance-session');

      const data = { command: 'ls' };
      const result = client.testWithSession(data, 'override-session');

      expect(result).toEqual({
        command: 'ls',
        sessionId: 'override-session',
      });
    });
  });

  describe('handleStreamResponse', () => {
    it('should return response body for successful streaming requests', async () => {
      const mockBody = new ReadableStream();
      const mockResponse = new Response(mockBody, { status: 200 });

      const result = await client.testHandleStreamResponse(mockResponse);

      expect(result).toBe(mockBody);
    });

    it('should handle error responses in streaming', async () => {
      const errorResponse = new Response(
        JSON.stringify({ error: 'Stream error' }),
        { status: 400 }
      );

      await expect(client.testHandleStreamResponse(errorResponse)).rejects.toThrow();
    });

    it('should throw error when response has no body', async () => {
      const mockResponse = new Response(null, { status: 200 });

      await expect(client.testHandleStreamResponse(mockResponse)).rejects.toThrow(
        'No response body for streaming'
      );
    });
  });

  describe('logging utilities', () => {
    it('should log successful operations', () => {
      client.testLogSuccess('Test Operation');

      expect(consoleLogSpy).toHaveBeenCalledWith(
        '[HTTP Client] Test Operation completed successfully'
      );
    });

    it('should log successful operations with details', () => {
      client.testLogSuccess('File Upload', 'test.txt (1.2KB)');

      expect(consoleLogSpy).toHaveBeenCalledWith(
        '[HTTP Client] File Upload: test.txt (1.2KB)'
      );
    });

    it('should log errors', () => {
      const error = new Error('Test error');
      client.testLogError('Test Operation', error);

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[HTTP Client] Error in Test Operation:',
        error
      );
    });
  });
});