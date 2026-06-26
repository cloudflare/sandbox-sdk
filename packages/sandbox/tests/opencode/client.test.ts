// packages/sandbox/tests/opencode/client.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createOpenCodeClient } from '../../src/opencode/client';
import type { OpenCodeHandle } from '../../src/opencode/lifecycle';

const createOpencodeClientMock = vi.fn();

// Mock the dynamic import of the OpenCode SDK client factory.
vi.mock('@opencode-ai/sdk/v2/client', () => ({
  createOpencodeClient: (opts: unknown) => createOpencodeClientMock(opts)
}));

interface MockHandle {
  ensure: ReturnType<typeof vi.fn>;
  config: ReturnType<typeof vi.fn>;
  fetch: ReturnType<typeof vi.fn>;
}

function createMockHandle(overrides: Partial<MockHandle> = {}): MockHandle {
  return {
    ensure: vi
      .fn()
      .mockResolvedValue({ port: 4096, url: 'http://localhost:4096' }),
    config: vi.fn().mockResolvedValue({ port: 4096 }),
    fetch: vi.fn().mockResolvedValue(new Response('ok')),
    ...overrides
  };
}

describe('createOpenCodeClient', () => {
  beforeEach(() => {
    createOpencodeClientMock.mockReset();
    createOpencodeClientMock.mockReturnValue({ session: {} });
  });

  it('ensures the server before building the client', async () => {
    const handle = createMockHandle();

    await createOpenCodeClient(handle as unknown as OpenCodeHandle);

    expect(handle.ensure).toHaveBeenCalledOnce();
  });

  it('builds the client against the resolved server url', async () => {
    const handle = createMockHandle();

    await createOpenCodeClient(handle as unknown as OpenCodeHandle);

    expect(createOpencodeClientMock).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: 'http://localhost:4096' })
    );
  });

  it('routes the client fetch through the handle', async () => {
    const handle = createMockHandle();
    await createOpenCodeClient(handle as unknown as OpenCodeHandle);

    const { fetch } = createOpencodeClientMock.mock.calls[0][0] as {
      fetch: (input: RequestInfo, init?: RequestInit) => Promise<Response>;
    };
    await fetch('http://localhost:4096/session');

    expect(handle.fetch).toHaveBeenCalledOnce();
    const forwarded = handle.fetch.mock.calls[0][0] as Request;
    expect(forwarded.url).toBe('http://localhost:4096/session');
  });

  it('passes the stored directory to the client', async () => {
    const handle = createMockHandle({
      config: vi
        .fn()
        .mockResolvedValue({ port: 4096, directory: '/home/user/agents' })
    });

    await createOpenCodeClient(handle as unknown as OpenCodeHandle);

    expect(createOpencodeClientMock).toHaveBeenCalledWith(
      expect.objectContaining({ directory: '/home/user/agents' })
    );
  });

  it('prefers a per-call directory override', async () => {
    const handle = createMockHandle({
      config: vi.fn().mockResolvedValue({ port: 4096, directory: '/stored' })
    });

    await createOpenCodeClient(handle as unknown as OpenCodeHandle, {
      directory: '/override'
    });

    expect(handle.ensure).toHaveBeenCalledWith({ directory: '/override' });
    expect(createOpencodeClientMock).toHaveBeenCalledWith(
      expect.objectContaining({ directory: '/override' })
    );
  });

  it('returns the built client', async () => {
    const handle = createMockHandle();
    const client = { session: { create: vi.fn() } };
    createOpencodeClientMock.mockReturnValue(client);

    const result = await createOpenCodeClient(
      handle as unknown as OpenCodeHandle
    );

    expect(result).toBe(client);
  });
});
