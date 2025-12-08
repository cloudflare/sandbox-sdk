import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeSandboxClient } from '../../src/client/sandbox-client';

describe('BridgeSandboxClient', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('exec', () => {
    it('should execute command via bridge', async () => {
      const mockResult = {
        success: true,
        exitCode: 0,
        stdout: 'hello\n',
        stderr: '',
        command: 'echo hello',
        duration: 50
      };
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify(mockResult), { status: 200 })
      );

      const client = new BridgeSandboxClient('my-sandbox', {
        baseUrl: 'https://bridge.example.com',
        apiKey: 'test-key'
      });

      const result = await client.exec('echo hello');

      expect(result.stdout).toBe('hello\n');
      expect(result.exitCode).toBe(0);
      expect(fetch).toHaveBeenCalledWith(
        'https://bridge.example.com/api/sandbox/my-sandbox/exec',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ command: 'echo hello' })
        })
      );
    });
  });

  describe('file operations', () => {
    it('should write file via bridge', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ success: true, path: '/test.txt' }), {
          status: 200
        })
      );

      const client = new BridgeSandboxClient('my-sandbox', {
        baseUrl: 'https://bridge.example.com',
        apiKey: 'test-key'
      });

      const result = await client.writeFile('/test.txt', 'hello world');

      expect(result.success).toBe(true);
      expect(fetch).toHaveBeenCalledWith(
        'https://bridge.example.com/api/sandbox/my-sandbox/files/write',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ path: '/test.txt', content: 'hello world' })
        })
      );
    });

    it('should read file via bridge', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(
          JSON.stringify({ content: 'hello world', path: '/test.txt' }),
          { status: 200 }
        )
      );

      const client = new BridgeSandboxClient('my-sandbox', {
        baseUrl: 'https://bridge.example.com',
        apiKey: 'test-key'
      });

      const result = await client.readFile('/test.txt');

      expect(result.content).toBe('hello world');
      expect(fetch).toHaveBeenCalledWith(
        'https://bridge.example.com/api/sandbox/my-sandbox/files/read?path=%2Ftest.txt',
        expect.anything()
      );
    });
  });

  describe('process management', () => {
    it('should start process via bridge', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            processId: 'proc-123',
            pid: 1234,
            command: 'node server.js',
            status: 'running',
            startTime: '2024-01-01T00:00:00Z'
          }),
          { status: 200 }
        )
      );

      const client = new BridgeSandboxClient('my-sandbox', {
        baseUrl: 'https://bridge.example.com',
        apiKey: 'test-key'
      });

      const process = await client.startProcess('node server.js');

      expect(process.id).toBe('proc-123');
      expect(process.command).toBe('node server.js');
      expect(process.status).toBe('running');
    });

    it('should list processes via bridge', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            processes: [
              {
                processId: 'proc-1',
                command: 'node a.js',
                status: 'running',
                startTime: '2024-01-01T00:00:00Z'
              },
              {
                processId: 'proc-2',
                command: 'node b.js',
                status: 'completed',
                startTime: '2024-01-01T00:01:00Z'
              }
            ]
          }),
          { status: 200 }
        )
      );

      const client = new BridgeSandboxClient('my-sandbox', {
        baseUrl: 'https://bridge.example.com',
        apiKey: 'test-key'
      });

      const processes = await client.listProcesses();

      expect(processes).toHaveLength(2);
      expect(processes[0].id).toBe('proc-1');
      expect(processes[1].id).toBe('proc-2');
    });
  });

  describe('session management', () => {
    it('should create session via bridge', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ sessionId: 'session-abc' }), {
          status: 200
        })
      );

      const client = new BridgeSandboxClient('my-sandbox', {
        baseUrl: 'https://bridge.example.com',
        apiKey: 'test-key'
      });

      const session = await client.createSession();

      expect(session.id).toBe('session-abc');
    });
  });

  describe('code interpreter', () => {
    it('should run code via bridge', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            code: 'print("Hello, World!")',
            logs: { stdout: ['Hello, World!'], stderr: [] },
            results: []
          }),
          { status: 200 }
        )
      );

      const client = new BridgeSandboxClient('my-sandbox', {
        baseUrl: 'https://bridge.example.com',
        apiKey: 'test-key'
      });

      const result = await client.runCode('print("Hello, World!")');

      expect(result.logs.stdout).toContain('Hello, World!');
    });
  });

  describe('unsupported operations', () => {
    it('should throw for mountBucket', async () => {
      const client = new BridgeSandboxClient('my-sandbox', {
        baseUrl: 'https://bridge.example.com',
        apiKey: 'test-key'
      });

      await expect(
        client.mountBucket('my-bucket', '/mnt', {
          endpoint: 'https://r2.example.com'
        })
      ).rejects.toThrow('not supported');
    });

    it('should throw for wsConnect', async () => {
      const client = new BridgeSandboxClient('my-sandbox', {
        baseUrl: 'https://bridge.example.com',
        apiKey: 'test-key'
      });

      const request = new Request('https://example.com');
      await expect(client.wsConnect(request, 8080)).rejects.toThrow(
        'not supported'
      );
    });
  });
});
