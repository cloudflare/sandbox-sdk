// packages/sandbox/tests/opencode/fetch.test.ts
import { describe, expect, it, vi } from 'vitest';
import { createSandboxFetch } from '../../src/opencode/fetch';

describe('createSandboxFetch', () => {
  it('should create a fetch function that calls containerFetch with correct port', async () => {
    const mockContainerFetch = vi.fn().mockResolvedValue(new Response('ok'));
    const mockSandbox = {
      containerFetch: mockContainerFetch
    };

    const sandboxFetch = createSandboxFetch(mockSandbox as any, 4096);

    const request = new Request('http://localhost:4096/session');
    await sandboxFetch(request);

    expect(mockContainerFetch).toHaveBeenCalledWith(request, 4096);
  });

  it('should use default port 4096 when not specified', async () => {
    const mockContainerFetch = vi.fn().mockResolvedValue(new Response('ok'));
    const mockSandbox = {
      containerFetch: mockContainerFetch
    };

    const sandboxFetch = createSandboxFetch(mockSandbox as any);

    const request = new Request('http://localhost:4096/test');
    await sandboxFetch(request);

    expect(mockContainerFetch).toHaveBeenCalledWith(request, 4096);
  });

  it('should return the response from containerFetch', async () => {
    const expectedResponse = new Response('{"status":"ok"}', {
      headers: { 'Content-Type': 'application/json' }
    });
    const mockSandbox = {
      containerFetch: vi.fn().mockResolvedValue(expectedResponse)
    };

    const sandboxFetch = createSandboxFetch(mockSandbox as any, 8080);

    const request = new Request('http://localhost:8080/api');
    const response = await sandboxFetch(request);

    expect(response).toBe(expectedResponse);
  });
});
