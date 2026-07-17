import { getSandbox } from '@cloudflare/sandbox';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import app from './worker';

// Define typed interface definitions matching the mock structure used in tests
interface MockTerminal {
  id: string;
  terminate: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
}

interface MockExecProcess {
  waitForExit: ReturnType<typeof vi.fn>;
  output: ReturnType<typeof vi.fn>;
}

interface MockSandbox {
  exec: ReturnType<typeof vi.fn>;
  createTerminal: ReturnType<typeof vi.fn>;
  getTerminal: ReturnType<typeof vi.fn>;
}

interface MockEnv {
  Sandbox: Record<string, unknown>;
  S3_BUCKET_NAME: string;
  AWS_REGION: string;
  ASSETS: {
    fetch: ReturnType<typeof vi.fn>;
  };
}

// Variables prefixed with "mock" are allowed inside hoisted vi.mock()
// Note: Vitest hoists vi.mock calls, and in v4, to avoid TDZ (temporal dead zone)
// we must define any hoisted mock variables before any other statements in the block,
// or inline them inside the vi.mock factory. In some setups, variables starting with "mock"
// are allowed but still must be defined in the correct order. Let's define the mocks
// entirely within the vi.mock factory to avoid hoist limitations completely, but we can
// assign them to global variables so our test blocks can access them!
const globalSpies = {
  terminate: vi.fn().mockResolvedValue(undefined)
};

vi.mock('@cloudflare/sandbox', () => {
  const mockTerminal = {
    id: 'term-s3-12345',
    terminate: vi.fn().mockImplementation(() => globalSpies.terminate()),
    connect: vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
  };

  const mockExecProcess: MockExecProcess = {
    waitForExit: vi.fn().mockResolvedValue({ exitCode: 0 }),
    output: vi
      .fn()
      .mockResolvedValue({ stdout: 'mounted', stderr: '', exitCode: 0 })
  };

  const mockSandbox: MockSandbox = {
    exec: vi.fn().mockResolvedValue(mockExecProcess),
    createTerminal: vi.fn().mockResolvedValue(mockTerminal),
    getTerminal: vi.fn().mockResolvedValue(mockTerminal)
  };

  return {
    getSandbox: vi.fn().mockReturnValue(mockSandbox),
    Sandbox: class {}
  };
});

describe('S3 Mount Worker & Terminal Ownership', () => {
  let mockSandbox: MockSandbox;
  let mockEnv: MockEnv;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSandbox = getSandbox(
      {} as unknown as Env['Sandbox'],
      'any'
    ) as unknown as MockSandbox;
    mockEnv = {
      Sandbox: {},
      S3_BUCKET_NAME: 'test-bucket',
      AWS_REGION: 'us-east-1',
      ASSETS: {
        fetch: vi.fn().mockResolvedValue(new Response('static-asset'))
      }
    };
  });

  it('session creation mounts S3 and creates exactly one terminal', async () => {
    // Setup mock executor responses
    mockSandbox.exec
      .mockResolvedValueOnce({
        output: vi
          .fn()
          .mockResolvedValue({ stdout: 'not-mounted', exitCode: 0 })
      })
      .mockResolvedValueOnce({
        output: vi.fn().mockResolvedValue({ stdout: 'ok', exitCode: 0 })
      })
      .mockResolvedValueOnce({
        output: vi.fn().mockResolvedValue({ stdout: '', exitCode: 0 })
      })
      .mockResolvedValueOnce({
        output: vi.fn().mockResolvedValue({ stdout: 'mounted', exitCode: 0 })
      })
      .mockResolvedValueOnce({
        waitForExit: vi.fn().mockResolvedValue({ exitCode: 0 })
      });

    const res = await app.fetch(
      new Request('http://localhost/api/session', { method: 'POST' }),
      mockEnv as unknown as Env
    );

    expect(res.status).toBe(200);
    const body = await res.json<{
      sandboxId: string;
      terminalId: string;
      mount: string;
    }>();
    expect(body.sandboxId).toContain('s3-');
    expect(body.terminalId).toBe('term-s3-12345');
    expect(body.mount).toBe('mounted');

    expect(mockSandbox.createTerminal).toHaveBeenCalledTimes(1);
    expect(mockSandbox.createTerminal).toHaveBeenCalledWith({
      command: ['bash'],
      cwd: '/mnt/s3'
    });
  });

  it('session creation fails and best-effort unmounts if terminal creation throws', async () => {
    // Setup mock executor responses
    mockSandbox.exec
      .mockResolvedValueOnce({
        output: vi
          .fn()
          .mockResolvedValue({ stdout: 'not-mounted', exitCode: 0 })
      })
      .mockResolvedValueOnce({
        output: vi.fn().mockResolvedValue({ stdout: 'ok', exitCode: 0 })
      })
      .mockResolvedValueOnce({
        output: vi.fn().mockResolvedValue({ stdout: '', exitCode: 0 })
      })
      .mockResolvedValueOnce({
        output: vi.fn().mockResolvedValue({ stdout: 'mounted', exitCode: 0 })
      })
      .mockResolvedValueOnce({
        waitForExit: vi.fn().mockResolvedValue({ exitCode: 0 })
      });

    mockSandbox.createTerminal.mockRejectedValueOnce(
      new Error('PTY creation failed')
    );

    const res = await app.fetch(
      new Request('http://localhost/api/session', { method: 'POST' }),
      mockEnv as unknown as Env
    );

    expect(res.status).toBe(500);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('PTY creation failed');

    // Verify unmount was called: (fusermount -u /mnt/s3)
    const fusermountExec = mockSandbox.exec.mock.calls.find((c: unknown[]) => {
      const args = c[0] as unknown[];
      return typeof args[2] === 'string' && args[2].includes('fusermount -u');
    });
    expect(fusermountExec).toBeDefined();
  });

  it('WS route recovers the same terminal and never allocates a new one', async () => {
    const res = await app.fetch(
      new Request(
        'http://localhost/ws/terminal/s3-12345?terminalId=term-s3-12345',
        {
          headers: { Upgrade: 'websocket' }
        }
      ),
      mockEnv as unknown as Env
    );

    expect(res.status).toBe(200);
    expect(mockSandbox.getTerminal).toHaveBeenCalledWith('term-s3-12345');
    expect(mockSandbox.createTerminal).not.toHaveBeenCalled();
  });

  it('WS route returns 400 if terminalId is missing, and 404 if terminal is not found', async () => {
    // Missing terminalId
    const res400 = await app.fetch(
      new Request('http://localhost/ws/terminal/s3-12345', {
        headers: { Upgrade: 'websocket' }
      }),
      mockEnv as unknown as Env
    );
    expect(res400.status).toBe(400);

    // Terminal not found (getTerminal returns null)
    mockSandbox.getTerminal.mockResolvedValueOnce(null);
    const res404 = await app.fetch(
      new Request(
        'http://localhost/ws/terminal/s3-12345?terminalId=term-nonexistent',
        {
          headers: { Upgrade: 'websocket' }
        }
      ),
      mockEnv as unknown as Env
    );
    expect(res404.status).toBe(404);
  });

  it('cleanup attempts terminal termination then unmount independently', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/session/s3-12345/cleanup', {
        method: 'POST',
        body: JSON.stringify({ terminalId: 'term-s3-12345' }),
        headers: { 'Content-Type': 'application/json' }
      }),
      mockEnv as unknown as Env
    );

    expect(res.status).toBe(200);
    const body = await res.json<{ status: string }>();
    expect(body.status).toBe('cleaned-up');

    // Terminal terminate called
    expect(globalSpies.terminate).toHaveBeenCalledTimes(1);

    // fusermount was also called
    const fusermountExec = mockSandbox.exec.mock.calls.find((c: unknown[]) => {
      const args = c[0] as unknown[];
      return typeof args[2] === 'string' && args[2].includes('fusermount -u');
    });
    expect(fusermountExec).toBeDefined();
  });

  it('cleanup still unmounts if terminal termination fails', async () => {
    globalSpies.terminate.mockRejectedValueOnce(new Error('Terminate failed'));

    const res = await app.fetch(
      new Request('http://localhost/api/session/s3-12345/cleanup', {
        method: 'POST',
        body: JSON.stringify({ terminalId: 'term-s3-12345' }),
        headers: { 'Content-Type': 'application/json' }
      }),
      mockEnv as unknown as Env
    );

    expect(res.status).toBe(200);

    // Unmount was still attempted
    const fusermountExec = mockSandbox.exec.mock.calls.find((c: unknown[]) => {
      const args = c[0] as unknown[];
      return typeof args[2] === 'string' && args[2].includes('fusermount -u');
    });
    expect(fusermountExec).toBeDefined();
  });

  it('cleanup gracefully handles absent JSON body and still attempts unmount', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/session/s3-12345/cleanup', {
        method: 'POST',
        body: '', // Empty body
        headers: { 'Content-Type': 'application/json' }
      }),
      mockEnv as unknown as Env
    );

    expect(res.status).toBe(200);
    const body = await res.json<{ status: string }>();
    expect(body.status).toBe('cleaned-up');

    // fusermount was still attempted
    const fusermountExec = mockSandbox.exec.mock.calls.find((c: unknown[]) => {
      const args = c[0] as unknown[];
      return typeof args[2] === 'string' && args[2].includes('fusermount -u');
    });
    expect(fusermountExec).toBeDefined();
  });
});
