// packages/sandbox/tests/opencode/opencode.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createOpencode } from '../../src/opencode/opencode';
import { OpencodeStartupError } from '../../src/opencode/types';

// Mock the dynamic import of @opencode-ai/sdk
vi.mock('@opencode-ai/sdk', () => ({
  createOpencodeClient: vi.fn().mockReturnValue({ session: {} })
}));

describe('createOpencode', () => {
  let mockSandbox: any;
  let mockProcess: any;

  beforeEach(() => {
    mockProcess = {
      waitForPort: vi.fn().mockResolvedValue(undefined),
      kill: vi.fn().mockResolvedValue(undefined),
      getLogs: vi.fn().mockResolvedValue({ stdout: '', stderr: '' })
    };

    mockSandbox = {
      startProcess: vi.fn().mockResolvedValue(mockProcess),
      containerFetch: vi.fn().mockResolvedValue(new Response('ok'))
    };
  });

  it('should start OpenCode server on default port 4096', async () => {
    const result = await createOpencode(mockSandbox);

    expect(mockSandbox.startProcess).toHaveBeenCalledWith(
      'opencode serve --port 4096 --hostname 0.0.0.0',
      expect.any(Object)
    );
    expect(result.server.port).toBe(4096);
    expect(result.server.url).toBe('http://localhost:4096');
  });

  it('should start OpenCode server on custom port', async () => {
    const result = await createOpencode(mockSandbox, { port: 8080 });

    expect(mockSandbox.startProcess).toHaveBeenCalledWith(
      'opencode serve --port 8080 --hostname 0.0.0.0',
      expect.any(Object)
    );
    expect(result.server.port).toBe(8080);
  });

  it('should pass config via OPENCODE_CONFIG_CONTENT env var', async () => {
    const config = { provider: { anthropic: { apiKey: 'test-key' } } };
    await createOpencode(mockSandbox, { config });

    expect(mockSandbox.startProcess).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(config) }
      })
    );
  });

  it('should wait for port to be ready', async () => {
    await createOpencode(mockSandbox);

    expect(mockProcess.waitForPort).toHaveBeenCalledWith(4096, {
      mode: 'http',
      path: '/',
      timeout: 60_000
    });
  });

  it('should return client and server', async () => {
    const result = await createOpencode(mockSandbox);

    expect(result.client).toBeDefined();
    expect(result.server).toBeDefined();
    expect(result.server.process).toBe(mockProcess);
  });

  it('should provide stop method that kills process', async () => {
    const result = await createOpencode(mockSandbox);

    await result.server.stop();

    expect(mockProcess.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('should throw OpencodeStartupError when server fails to start', async () => {
    mockProcess.waitForPort.mockRejectedValue(new Error('timeout'));
    mockProcess.getLogs.mockResolvedValue({
      stdout: '',
      stderr: 'Server crashed'
    });

    await expect(createOpencode(mockSandbox)).rejects.toThrow(
      OpencodeStartupError
    );
    await expect(createOpencode(mockSandbox)).rejects.toThrow(/Server crashed/);
  });
});
