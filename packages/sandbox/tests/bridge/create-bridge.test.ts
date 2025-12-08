import { describe, expect, it, vi } from 'vitest';
import { createBridge } from '../../src/bridge/create-bridge';

describe('createBridge', () => {
  const mockEnv = {
    Sandbox: {
      idFromName: vi.fn().mockReturnValue({ toString: () => 'test-id' }),
      get: vi.fn()
    },
    SANDBOX_API_KEY: 'test-secret-key'
  };

  it('should return 401 for missing auth header', async () => {
    const handler = createBridge();
    const request = new Request('https://example.com/api/sandbox/test/exec', {
      method: 'POST',
      body: JSON.stringify({ command: 'echo hi' })
    });

    const response = await handler.fetch!(
      request as any,
      mockEnv as any,
      {} as any
    );

    expect(response.status).toBe(401);
  });

  it('should return 401 for invalid API key', async () => {
    const handler = createBridge();
    const request = new Request('https://example.com/api/sandbox/test/exec', {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong-key' },
      body: JSON.stringify({ command: 'echo hi' })
    });

    const response = await handler.fetch!(
      request as any,
      mockEnv as any,
      {} as any
    );

    expect(response.status).toBe(401);
  });

  it('should return 204 for OPTIONS preflight', async () => {
    const handler = createBridge();
    const request = new Request('https://example.com/api/sandbox/test/exec', {
      method: 'OPTIONS'
    });

    const response = await handler.fetch!(
      request as any,
      mockEnv as any,
      {} as any
    );

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('should return 404 for non-API paths', async () => {
    const handler = createBridge();
    const request = new Request('https://example.com/health', {
      headers: { Authorization: 'Bearer test-secret-key' }
    });

    const response = await handler.fetch!(
      request as any,
      mockEnv as any,
      {} as any
    );

    expect(response.status).toBe(404);
  });
});
