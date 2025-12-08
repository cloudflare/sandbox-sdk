import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../../src/client/http-client';

describe('HttpClient', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('should make request with auth header', async () => {
    const mockResponse = { success: true };
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify(mockResponse), { status: 200 })
    );

    const client = new HttpClient({
      baseUrl: 'https://bridge.example.com',
      apiKey: 'test-key',
      sandboxId: 'test-sandbox'
    });

    const result = await client.request('POST', '/exec', { command: 'ls' });

    expect(fetch).toHaveBeenCalledWith(
      'https://bridge.example.com/api/sandbox/test-sandbox/exec',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-key',
          'Content-Type': 'application/json'
        })
      })
    );
    expect(result).toEqual(mockResponse);
  });

  it('should throw on non-2xx response', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({ error: 'NOT_FOUND', message: 'File not found' }),
        { status: 404 }
      )
    );

    const client = new HttpClient({
      baseUrl: 'https://bridge.example.com',
      apiKey: 'test-key',
      sandboxId: 'test-sandbox'
    });

    await expect(client.request('GET', '/files/read')).rejects.toThrow();
  });

  it('should make GET request without body', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ files: [] }), { status: 200 })
    );

    const client = new HttpClient({
      baseUrl: 'https://bridge.example.com',
      apiKey: 'test-key',
      sandboxId: 'my-sandbox'
    });

    await client.request('GET', '/files/list');

    expect(fetch).toHaveBeenCalledWith(
      'https://bridge.example.com/api/sandbox/my-sandbox/files/list',
      expect.objectContaining({
        method: 'GET',
        body: undefined
      })
    );
  });

  it('should return stream for streaming requests', async () => {
    const mockStream = new ReadableStream();
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(mockStream, { status: 200 })
    );

    const client = new HttpClient({
      baseUrl: 'https://bridge.example.com',
      apiKey: 'test-key',
      sandboxId: 'test-sandbox'
    });

    const stream = await client.requestStream('POST', '/code/run/stream', {
      code: 'print(1)'
    });

    expect(stream).toBeInstanceOf(ReadableStream);
  });

  it('should throw on stream request with error response', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: 'CODE_ERROR' }), { status: 500 })
    );

    const client = new HttpClient({
      baseUrl: 'https://bridge.example.com',
      apiKey: 'test-key',
      sandboxId: 'test-sandbox'
    });

    await expect(
      client.requestStream('POST', '/code/run/stream', { code: 'error' })
    ).rejects.toThrow();
  });
});
