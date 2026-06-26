// packages/sandbox/tests/opencode/lifecycle.test.ts
import type { ProcessStatus } from '@repo/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ContainerUnavailableError, ErrorCode } from '../../src/errors';
import { withOpenCode } from '../../src/opencode/lifecycle';
import type { Sandbox } from '../../src/sandbox';

interface MockProcess {
  id: string;
  command: string;
  startTime: Date;
  exitCode: Promise<number>;
  waitForPort: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  getLogs: ReturnType<typeof vi.fn>;
  status: ReturnType<typeof vi.fn>;
}

interface MockSandbox {
  exec: ReturnType<typeof vi.fn>;
  listProcesses: ReturnType<typeof vi.fn>;
  getProcess: ReturnType<typeof vi.fn>;
  containerFetch: ReturnType<typeof vi.fn>;
}

function createMockProcess(
  overrides: Partial<Omit<MockProcess, 'status'>> & {
    status?: ProcessStatus;
  } = {}
): MockProcess {
  const { status: initialStatus = 'running', ...rest } = overrides;
  return {
    id: 'proc-1',
    command: 'opencode serve --port 4096 --hostname 0.0.0.0',
    startTime: new Date(),
    exitCode: Promise.resolve(0),
    waitForPort: vi.fn().mockResolvedValue(undefined),
    kill: vi.fn(),
    getLogs: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
    status: vi.fn().mockResolvedValue(initialStatus),
    ...rest
  };
}

function createMockSandbox(overrides: Partial<MockSandbox> = {}): MockSandbox {
  return {
    exec: vi.fn(),
    listProcesses: vi.fn().mockResolvedValue([]),
    getProcess: vi.fn().mockResolvedValue(null),
    containerFetch: vi.fn().mockResolvedValue(new Response('ok')),
    ...overrides
  };
}

function containerUnavailable(): ContainerUnavailableError {
  return new ContainerUnavailableError({
    code: ErrorCode.CONTAINER_UNAVAILABLE,
    message: 'Container restarted',
    context: { reason: 'container_replaced', retryable: true },
    httpStatus: 503,
    timestamp: new Date().toISOString()
  });
}

describe('withOpenCode', () => {
  let mockSandbox: MockSandbox;
  let mockProcess: MockProcess;

  beforeEach(() => {
    mockProcess = createMockProcess();
    mockSandbox = createMockSandbox({
      exec: vi.fn().mockResolvedValue(mockProcess)
    });
  });

  it('does not issue any RPC on construction (lazy)', () => {
    withOpenCode(mockSandbox as unknown as Sandbox);

    expect(mockSandbox.exec).not.toHaveBeenCalled();
    expect(mockSandbox.listProcesses).not.toHaveBeenCalled();
  });

  describe('ensure', () => {
    it('starts the server and returns rpc-safe metadata', async () => {
      const handle = withOpenCode(mockSandbox as unknown as Sandbox);

      const server = await handle.ensure();

      expect(mockSandbox.exec).toHaveBeenCalledWith(
        'opencode serve --port 4096 --hostname 0.0.0.0',
        expect.any(Object)
      );
      expect(server).toEqual({ port: 4096, url: 'http://localhost:4096' });
    });

    it('starts the server under a stable named process id', async () => {
      const handle = withOpenCode(mockSandbox as unknown as Sandbox);

      await handle.ensure();

      expect(mockSandbox.exec).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ processId: 'opencode-4096' })
      );
    });

    it('honors a custom process id', async () => {
      const handle = withOpenCode(mockSandbox as unknown as Sandbox, {
        processId: 'my-opencode'
      });

      await handle.ensure();

      expect(mockSandbox.exec).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ processId: 'my-opencode' })
      );
    });

    it('applies factory default options', async () => {
      const handle = withOpenCode(mockSandbox as unknown as Sandbox, {
        directory: '/home/user/agents'
      });

      await handle.ensure();

      expect(mockSandbox.exec).toHaveBeenCalledWith(
        'cd /home/user/agents && opencode serve --port 4096 --hostname 0.0.0.0',
        expect.any(Object)
      );
    });

    it('lets per-call options override defaults', async () => {
      const handle = withOpenCode(mockSandbox as unknown as Sandbox, {
        port: 4096
      });

      await handle.ensure({ port: 8080 });

      expect(mockSandbox.exec).toHaveBeenCalledWith(
        'opencode serve --port 8080 --hostname 0.0.0.0',
        expect.any(Object)
      );
    });

    it('reuses an already-running named server without scanning', async () => {
      mockSandbox.getProcess.mockResolvedValue(createMockProcess());
      const handle = withOpenCode(mockSandbox as unknown as Sandbox);

      const server = await handle.ensure();

      expect(mockSandbox.getProcess).toHaveBeenCalledWith('opencode-4096');
      expect(mockSandbox.listProcesses).not.toHaveBeenCalled();
      expect(mockSandbox.exec).not.toHaveBeenCalled();
      expect(server.port).toBe(4096);
    });

    it('retries once when the container is unavailable', async () => {
      mockSandbox.exec = vi
        .fn()
        .mockRejectedValueOnce(containerUnavailable())
        .mockResolvedValueOnce(mockProcess);
      const handle = withOpenCode(mockSandbox as unknown as Sandbox);

      const server = await handle.ensure();

      expect(mockSandbox.exec).toHaveBeenCalledTimes(2);
      expect(server.port).toBe(4096);
    });
  });

  describe('stop', () => {
    it('kills the running server process', async () => {
      const handle = withOpenCode(mockSandbox as unknown as Sandbox);
      await handle.ensure();

      await handle.stop();

      expect(mockProcess.kill).toHaveBeenCalled();
    });

    it('is a no-op when no server has been started', async () => {
      const handle = withOpenCode(mockSandbox as unknown as Sandbox);

      await expect(handle.stop()).resolves.toBeUndefined();
      expect(mockProcess.kill).not.toHaveBeenCalled();
    });
  });

  describe('status', () => {
    it('reports running via a named-process lookup', async () => {
      mockSandbox.getProcess.mockResolvedValue(createMockProcess());
      const handle = withOpenCode(mockSandbox as unknown as Sandbox);

      const status = await handle.status();

      expect(mockSandbox.getProcess).toHaveBeenCalledWith('opencode-4096');
      expect(mockSandbox.listProcesses).not.toHaveBeenCalled();
      expect(status).toEqual({
        running: true,
        port: 4096,
        url: 'http://localhost:4096'
      });
    });

    it('reports not running when the named process is absent', async () => {
      const handle = withOpenCode(mockSandbox as unknown as Sandbox);

      const status = await handle.status();

      expect(status.running).toBe(false);
    });
  });

  describe('config', () => {
    it('exposes the resolved directory and port', async () => {
      const handle = withOpenCode(mockSandbox as unknown as Sandbox, {
        directory: '/home/user/agents'
      });

      const config = await handle.config();

      expect(config).toEqual({ port: 4096, directory: '/home/user/agents' });
    });
  });

  describe('fetch', () => {
    it('ensures the server then routes through containerFetch', async () => {
      const handle = withOpenCode(mockSandbox as unknown as Sandbox);
      const request = new Request('http://example.com/session');

      await handle.fetch(request);

      expect(mockSandbox.exec).toHaveBeenCalled();
      expect(mockSandbox.containerFetch).toHaveBeenCalledWith(request, 4096);
    });
  });

  describe('onContainerStart', () => {
    it('re-ensures the last-used configuration', async () => {
      const handle = withOpenCode(mockSandbox as unknown as Sandbox);
      await handle.ensure({ port: 8080 });
      mockSandbox.exec.mockClear();
      mockSandbox.getProcess.mockResolvedValue(null);

      await handle.onContainerStart();

      expect(mockSandbox.exec).toHaveBeenCalledWith(
        'opencode serve --port 8080 --hostname 0.0.0.0',
        expect.any(Object)
      );
    });

    it('does nothing if the server was never started', async () => {
      const handle = withOpenCode(mockSandbox as unknown as Sandbox);

      await handle.onContainerStart();

      expect(mockSandbox.exec).not.toHaveBeenCalled();
    });
  });
});
