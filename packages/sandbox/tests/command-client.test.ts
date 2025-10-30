import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecuteResponse } from '../src/clients';
import { CommandClient } from '../src/clients/command-client';
import {
  CommandError,
  CommandNotFoundError,
  SandboxError
} from '../src/errors';

describe('CommandClient', () => {
  let client: CommandClient;
  let mockFetch: ReturnType<typeof vi.fn>;
  let onCommandComplete: ReturnType<typeof vi.fn>;
  let onError: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockFetch = vi.fn();
    global.fetch = mockFetch as unknown as typeof fetch;

    onCommandComplete = vi.fn();
    onError = vi.fn();

    client = new CommandClient({
      baseUrl: 'http://test.com',
      port: 3000,
      onCommandComplete,
      onError
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('execute', () => {
    it('should execute simple commands successfully', async () => {
      const mockResponse: ExecuteResponse = {
        success: true,
        stdout: 'Hello World\n',
        stderr: '',
        exitCode: 0,
        command: 'echo "Hello World"',
        timestamp: '2023-01-01T00:00:00Z'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.execute('echo "Hello World"', 'session-exec');

      expect(result.success).toBe(true);
      expect(result.stdout).toBe('Hello World\n');
      expect(result.stderr).toBe('');
      expect(result.exitCode).toBe(0);
      expect(result.command).toBe('echo "Hello World"');
      expect(onCommandComplete).toHaveBeenCalledWith(
        true,
        0,
        'Hello World\n',
        '',
        'echo "Hello World"'
      );
    });

    it('should handle command failures with proper exit codes', async () => {
      const mockResponse: ExecuteResponse = {
        success: false,
        stdout: '',
        stderr: 'command not found: nonexistent-cmd\n',
        exitCode: 127,
        command: 'nonexistent-cmd',
        timestamp: '2023-01-01T00:00:00Z'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.execute('nonexistent-cmd', 'session-exec');

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(127);
      expect(result.stderr).toContain('command not found');
      expect(result.stdout).toBe('');
      expect(onCommandComplete).toHaveBeenCalledWith(
        false,
        127,
        '',
        'command not found: nonexistent-cmd\n',
        'nonexistent-cmd'
      );
    });

    it('should handle container-level errors with proper error mapping', async () => {
      const errorResponse = {
        code: 'COMMAND_NOT_FOUND',
        message: 'Command not found: invalidcmd',
        context: { command: 'invalidcmd' },
        httpStatus: 404,
        timestamp: new Date().toISOString()
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(errorResponse), { status: 404 })
      );

      await expect(client.execute('invalidcmd', 'session-err')).rejects.toThrow(
        CommandNotFoundError
      );
      expect(onError).toHaveBeenCalledWith(
        expect.stringContaining('Command not found'),
        'invalidcmd'
      );
    });

    it('should handle network failures gracefully', async () => {
      mockFetch.mockRejectedValue(new Error('Network connection failed'));

      await expect(client.execute('ls', 'session-err')).rejects.toThrow(
        'Network connection failed'
      );
      expect(onError).toHaveBeenCalledWith('Network connection failed', 'ls');
    });

    it('should handle server errors with proper status codes', async () => {
      const scenarios = [
        { status: 400, code: 'COMMAND_EXECUTION_ERROR', error: CommandError },
        { status: 500, code: 'EXECUTION_ERROR', error: SandboxError }
      ];

      for (const scenario of scenarios) {
        mockFetch.mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              code: scenario.code,
              message: 'Test error',
              context: {},
              httpStatus: scenario.status,
              timestamp: new Date().toISOString()
            }),
            { status: scenario.status }
          )
        );
        await expect(
          client.execute('test-command', 'session-err')
        ).rejects.toThrow(scenario.error);
      }
    });

    it('should handle commands with large output', async () => {
      const largeOutput = 'line of output\n'.repeat(10000);
      const mockResponse: ExecuteResponse = {
        success: true,
        stdout: largeOutput,
        stderr: '',
        exitCode: 0,
        command: 'find / -type f',
        timestamp: '2023-01-01T00:00:00Z'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.execute('find / -type f', 'session-exec');

      expect(result.success).toBe(true);
      expect(result.stdout.length).toBeGreaterThan(100000);
      expect(result.stdout.split('\n')).toHaveLength(10001);
      expect(result.exitCode).toBe(0);
    });

    it('should handle concurrent command executions', async () => {
      mockFetch.mockImplementation((url: string, options: RequestInit) => {
        const body = JSON.parse(options.body as string);
        const command = body.command;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              success: true,
              stdout: `output for ${command}\n`,
              stderr: '',
              exitCode: 0,
              command: command,
              timestamp: '2023-01-01T00:00:00Z'
            }),
            { status: 200 }
          )
        );
      });

      const commands = ['echo 1', 'echo 2', 'echo 3', 'pwd', 'ls'];
      const results = await Promise.all(
        commands.map((cmd) => client.execute(cmd, 'session-concurrent'))
      );

      expect(results).toHaveLength(5);
      results.forEach((result, index) => {
        expect(result.success).toBe(true);
        expect(result.stdout).toBe(`output for ${commands[index]}\n`);
        expect(result.exitCode).toBe(0);
      });
      expect(onCommandComplete).toHaveBeenCalledTimes(5);
    });

    it('should handle malformed server responses', async () => {
      mockFetch.mockResolvedValue(
        new Response('invalid json {', {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      );

      await expect(client.execute('ls', 'session-err')).rejects.toThrow(
        SandboxError
      );
      expect(onError).toHaveBeenCalled();
    });

    it('should handle empty command input', async () => {
      const errorResponse = {
        code: 'INVALID_COMMAND',
        message: 'Invalid command: empty command provided',
        context: {},
        httpStatus: 400,
        timestamp: new Date().toISOString()
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(errorResponse), { status: 400 })
      );

      await expect(client.execute('', 'session-err')).rejects.toThrow(
        CommandError
      );
    });

    it('should handle streaming command execution', async () => {
      const streamContent = [
        'data: {"type":"start","command":"tail -f app.log","timestamp":"2023-01-01T00:00:00Z"}\n\n',
        'data: {"type":"stdout","data":"log line 1\\n","timestamp":"2023-01-01T00:00:01Z"}\n\n',
        'data: {"type":"stdout","data":"log line 2\\n","timestamp":"2023-01-01T00:00:02Z"}\n\n',
        'data: {"type":"complete","exitCode":0,"timestamp":"2023-01-01T00:00:03Z"}\n\n'
      ].join('');

      const mockStream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(streamContent));
          controller.close();
        }
      });

      mockFetch.mockResolvedValue(
        new Response(mockStream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' }
        })
      );

      const stream = await client.executeStream(
        'tail -f app.log',
        'session-stream'
      );
      expect(stream).toBeInstanceOf(ReadableStream);

      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let content = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          content += decoder.decode(value);
        }
      } finally {
        reader.releaseLock();
      }

      expect(content).toContain('tail -f app.log');
      expect(content).toContain('log line 1');
      expect(content).toContain('log line 2');
      expect(content).toContain('"type":"complete"');
    });

    it('should handle streaming errors gracefully', async () => {
      const errorResponse = {
        code: 'STREAM_START_ERROR',
        message: 'Command failed to start streaming',
        context: { command: 'invalid-stream-command' },
        httpStatus: 400,
        timestamp: new Date().toISOString()
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(errorResponse), { status: 400 })
      );

      await expect(
        client.executeStream('invalid-stream-command', 'session-err')
      ).rejects.toThrow(CommandError);
      expect(onError).toHaveBeenCalledWith(
        expect.stringContaining('Command failed to start streaming'),
        'invalid-stream-command'
      );
    });

    it('should handle streaming without response body', async () => {
      mockFetch.mockResolvedValue(
        new Response(null, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' }
        })
      );

      await expect(
        client.executeStream('test-command', 'session-err')
      ).rejects.toThrow('No response body for streaming');
    });

    it('should handle network failures during streaming setup', async () => {
      mockFetch.mockRejectedValue(
        new Error('Connection lost during streaming')
      );

      await expect(
        client.executeStream('stream-command', 'session-err')
      ).rejects.toThrow('Connection lost during streaming');
      expect(onError).toHaveBeenCalledWith(
        'Connection lost during streaming',
        'stream-command'
      );
    });
  });

  describe('callback integration', () => {
    it('should work without any callbacks', async () => {
      const clientWithoutCallbacks = new CommandClient({
        baseUrl: 'http://test.com',
        port: 3000
      });

      const mockResponse: ExecuteResponse = {
        success: true,
        stdout: 'test output\n',
        stderr: '',
        exitCode: 0,
        command: 'echo test',
        timestamp: '2023-01-01T00:00:00Z'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await clientWithoutCallbacks.execute(
        'echo test',
        'session-nocb'
      );

      expect(result.success).toBe(true);
      expect(result.stdout).toBe('test output\n');
    });

    it('should handle errors gracefully without callbacks', async () => {
      const clientWithoutCallbacks = new CommandClient({
        baseUrl: 'http://test.com',
        port: 3000
      });

      mockFetch.mockRejectedValue(new Error('Network failed'));

      await expect(
        clientWithoutCallbacks.execute('test', 'session-nocb')
      ).rejects.toThrow('Network failed');
    });

    it('should call onCommandComplete for both success and failure', async () => {
      const successResponse: ExecuteResponse = {
        success: true,
        stdout: 'success\n',
        stderr: '',
        exitCode: 0,
        command: 'echo success',
        timestamp: '2023-01-01T00:00:00Z'
      };

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(successResponse), { status: 200 })
      );

      await client.execute('echo success', 'session-cb');
      expect(onCommandComplete).toHaveBeenLastCalledWith(
        true,
        0,
        'success\n',
        '',
        'echo success'
      );

      const failureResponse: ExecuteResponse = {
        success: false,
        stdout: '',
        stderr: 'error\n',
        exitCode: 1,
        command: 'false',
        timestamp: '2023-01-01T00:00:00Z'
      };

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(failureResponse), { status: 200 })
      );

      await client.execute('false', 'session-cb');
      expect(onCommandComplete).toHaveBeenLastCalledWith(
        false,
        1,
        '',
        'error\n',
        'false'
      );
    });
  });

  describe('constructor options', () => {
    it('should initialize with minimal options', async () => {
      const minimalClient = new CommandClient();
      expect(minimalClient).toBeDefined();
    });

    it('should initialize with full options', async () => {
      const fullOptionsClient = new CommandClient({
        baseUrl: 'http://custom.com',
        port: 8080,
        onCommandComplete: vi.fn(),
        onError: vi.fn()
      });
      expect(fullOptionsClient).toBeDefined();
    });
  });
});
