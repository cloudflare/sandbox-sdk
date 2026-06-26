// packages/sandbox/tests/opencode/lifecycle.test.ts
import type { ProcessStatus } from '@repo/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ContainerUnavailableError, ErrorCode } from '../../src/errors';
import { withOpenCode } from '../../src/opencode/lifecycle';
import type { Sandbox } from '../../src/sandbox';

interface MockProcess {
  id: string;
  command: string;
  status: ProcessStatus;
  startTime: Date;
  waitForPort: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  getLogs: ReturnType<typeof vi.fn>;
}

interface MockSandbox {
  startProcess: ReturnType<typeof vi.fn>;
  listProcesses: ReturnType<typeof vi.fn>;
  containerFetch: ReturnType<typeof vi.fn>;
}

function createMockProcess(overrides: Partial<MockProcess> = {}): MockProcess {
  return {
    id: 'proc-1',
    command: 'opencode serve --port 4096 --hostname 0.0.0.0',
    status: 'running',
    startTime: new Date(),
    waitForPort: vi.fn().mockResolvedValue(undefined),
    kill: vi.fn().mockResolvedValue(undefined),
    getLogs: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
    ...overrides
  };
}

function createMockSandbox(overrides: Partial<MockSandbox> = {}): MockSandbox {
  return {
    startProcess: vi.fn(),
    listProcesses: vi.fn().mockResolvedValue([]),
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
      startProcess: vi.fn().mockResolvedValue(mockProcess)
    });
  });

  it('does not issue any RPC on construction (lazy)', () => {
    withOpenCode(mockSandbox as unknown as Sandbox);

    expect(mockSandbox.startProcess).not.toHaveBeenCalled();
    expect(mockSandbox.listProcesses).not.toHaveBeenCalled();
  });

  describe('ensure', () => {
    it('starts the server and returns rpc-safe metadata', async () => {
      const handle = withOpenCode(mockSandbox as unknown as Sandbox);

      const server = await handle.ensure();

      expect(mockSandbox.startProcess).toHaveBeenCalledWith(
        'opencode serve --port 4096 --hostname 0.0.0.0',
        expect.any(Object)
      );
      expect(server).toEqual({ port: 4096, url: 'http://localhost:4096' });
    });

    it('applies factory default options', async () => {
      const handle = withOpenCode(mockSandbox as unknown as Sandbox, {
        directory: '/home/user/agents'
      });

      await handle.ensure();

      expect(mockSandbox.startProcess).toHaveBeenCalledWith(
        'cd /home/user/agents && opencode serve --port 4096 --hostname 0.0.0.0',
        expect.any(Object)
      );
    });

    it('lets per-call options override defaults', async () => {
      const handle = withOpenCode(mockSandbox as unknown as Sandbox, {
        port: 4096
      });

      await handle.ensure({ port: 8080 });

      expect(mockSandbox.startProcess).toHaveBeenCalledWith(
        'opencode serve --port 8080 --hostname 0.0.0.0',
        expect.any(Object)
      );
    });

    it('reuses an already-running server', async () => {
      mockSandbox.listProcesses.mockResolvedValue([createMockProcess()]);
      const handle = withOpenCode(mockSandbox as unknown as Sandbox);

      const server = await handle.ensure();

      expect(mockSandbox.startProcess).not.toHaveBeenCalled();
      expect(server.port).toBe(4096);
    });

    it('retries once when the container is unavailable', async () => {
      mockSandbox.startProcess = vi
        .fn()
        .mockRejectedValueOnce(containerUnavailable())
        .mockResolvedValueOnce(mockProcess);
      const handle = withOpenCode(mockSandbox as unknown as Sandbox);

      const server = await handle.ensure();

      expect(mockSandbox.startProcess).toHaveBeenCalledTimes(2);
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
    it('reports running when a matching process exists', async () => {
      mockSandbox.listProcesses.mockResolvedValue([createMockProcess()]);
      const handle = withOpenCode(mockSandbox as unknown as Sandbox);

      const status = await handle.status();

      expect(status).toEqual({
        running: true,
        port: 4096,
        url: 'http://localhost:4096'
      });
    });

    it('reports not running when no matching process exists', async () => {
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

      expect(mockSandbox.startProcess).toHaveBeenCalled();
      expect(mockSandbox.containerFetch).toHaveBeenCalledWith(request, 4096);
    });
  });

  describe('onContainerStart', () => {
    it('re-ensures the last-used configuration', async () => {
      const handle = withOpenCode(mockSandbox as unknown as Sandbox);
      await handle.ensure({ port: 8080 });
      mockSandbox.startProcess.mockClear();
      mockSandbox.listProcesses.mockResolvedValue([]);

      await handle.onContainerStart();

      expect(mockSandbox.startProcess).toHaveBeenCalledWith(
        'opencode serve --port 8080 --hostname 0.0.0.0',
        expect.any(Object)
      );
    });

    it('does nothing if the server was never started', async () => {
      const handle = withOpenCode(mockSandbox as unknown as Sandbox);

      await handle.onContainerStart();

      expect(mockSandbox.startProcess).not.toHaveBeenCalled();
    });
  });
});
