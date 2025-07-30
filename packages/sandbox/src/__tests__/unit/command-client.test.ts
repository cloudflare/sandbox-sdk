import type { ExecuteResponse, HttpClientOptions } from '../../clients';
import { CommandClient } from '../../clients/command-client';

describe('CommandClient', () => {
  let client: CommandClient;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let fetchMock: ReturnType<typeof vi.fn>;
  let onCommandComplete: ReturnType<typeof vi.fn>;
  let onError: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock = vi.fn();
    global.fetch = fetchMock;
    onCommandComplete = vi.fn();
    onError = vi.fn();
    
    client = new CommandClient({
      baseUrl: 'http://test.com',
      port: 3000,
      onCommandComplete,
      onError,
    });
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should initialize with default options', () => {
      const defaultClient = new CommandClient();
      expect(defaultClient.getSessionId()).toBeNull();
    });

    it('should initialize with custom options', () => {
      const customClient = new CommandClient({
        baseUrl: 'http://custom.com',
        port: 8080,
        onCommandComplete,
        onError,
      });
      
      expect(customClient.getSessionId()).toBeNull();
    });
  });

  describe('execute', () => {
    const mockResponse: ExecuteResponse = {
      success: true,
      stdout: 'Hello World\n',
      stderr: '',
      exitCode: 0,
      command: 'echo "Hello World"',
      timestamp: '2023-01-01T00:00:00Z',
    };

    it('should execute command successfully', async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.execute('echo "Hello World"');

      expect(fetchMock).toHaveBeenCalledWith('http://test.com/api/execute', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          command: 'echo "Hello World"',
        }),
      });

      expect(result).toEqual(mockResponse);
      // Console logging is disabled in test environment for cleaner output
      expect(onCommandComplete).toHaveBeenCalledWith(
        true,
        0,
        'Hello World\n',
        '',
        'echo "Hello World"'
      );
    });

    it('should execute command with session ID', async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      client.setSessionId('session-123');
      await client.execute('ls', 'override-session');

      expect(fetchMock).toHaveBeenCalledWith('http://test.com/api/execute', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          command: 'ls',
          sessionId: 'override-session',
        }),
      });
    });

    it('should handle command execution failure', async () => {
      const failedResponse = {
        ...mockResponse,
        success: false,
        exitCode: 1,
        stderr: 'Command not found',
        command: 'invalid-command',
      };

      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(failedResponse), { status: 200 })
      );

      const result = await client.execute('invalid-command');

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(onCommandComplete).toHaveBeenCalledWith(
        false,
        1,
        failedResponse.stdout,
        'Command not found',
        'invalid-command'
      );
    });

    it('should handle HTTP errors during execution', async () => {
      const errorResponse = {
        error: 'Internal server error',
        code: 'INTERNAL_ERROR',
      };

      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(errorResponse), { status: 500 })
      );

      await expect(client.execute('test-command')).rejects.toThrow();
      // Console error logging is disabled in test environment for cleaner output
      expect(onError).toHaveBeenCalledWith(
        expect.any(String),
        'test-command'
      );
    });

    it('should handle network errors during execution', async () => {
      const networkError = new Error('Network failed');
      fetchMock.mockRejectedValue(networkError);

      await expect(client.execute('test-command')).rejects.toThrow('Network failed');
      // Console error logging is disabled in test environment for cleaner output
      expect(onError).toHaveBeenCalledWith(
        'Network failed',
        'test-command'
      );
    });
  });

  describe('executeStream', () => {
    it('should execute streaming command successfully', async () => {
      const mockStream = new ReadableStream();
      const mockResponse = new Response(mockStream, { status: 200 });
      fetchMock.mockResolvedValue(mockResponse);

      const result = await client.executeStream('tail -f logfile.txt');

      expect(fetchMock).toHaveBeenCalledWith('http://test.com/api/execute/stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          command: 'tail -f logfile.txt',
        }),
      });

      expect(result).toBe(mockStream);
      // Console logging is disabled in test environment for cleaner output
    });

    it('should execute streaming command with session ID', async () => {
      const mockStream = new ReadableStream();
      const mockResponse = new Response(mockStream, { status: 200 });
      fetchMock.mockResolvedValue(mockResponse);

      await client.executeStream('watch ls', 'session-456');

      expect(fetchMock).toHaveBeenCalledWith('http://test.com/api/execute/stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          command: 'watch ls',
          sessionId: 'session-456',
        }),
      });
    });

    it('should handle HTTP errors during streaming execution', async () => {
      const errorResponse = {
        error: 'Command failed',
        code: 'COMMAND_ERROR',
      };

      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(errorResponse), { status: 400 })
      );

      await expect(client.executeStream('invalid-stream-command')).rejects.toThrow();
      // Console error logging is disabled in test environment for cleaner output
      expect(onError).toHaveBeenCalledWith(
        expect.any(String),
        'invalid-stream-command'
      );
    });

    it('should handle network errors during streaming execution', async () => {
      const networkError = new Error('Connection lost');
      fetchMock.mockRejectedValue(networkError);

      await expect(client.executeStream('stream-command')).rejects.toThrow('Connection lost');
      // Console error logging is disabled in test environment for cleaner output
      expect(onError).toHaveBeenCalledWith(
        'Connection lost',
        'stream-command'
      );
    });

    it('should handle response with no body', async () => {
      const mockResponse = new Response(null, { status: 200 });
      fetchMock.mockResolvedValue(mockResponse);

      await expect(client.executeStream('test-command')).rejects.toThrow(
        'No response body for streaming'
      );
    });
  });

  describe('session management integration', () => {
    it('should use instance session ID when none provided', async () => {
      const mockResponse: ExecuteResponse = {
        success: true,
        stdout: 'test output',
        stderr: '',
        exitCode: 0,
        command: 'test',
        timestamp: '2023-01-01T00:00:00Z',
      };

      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      client.setSessionId('instance-session');
      await client.execute('test');

      expect(fetchMock).toHaveBeenCalledWith('http://test.com/api/execute', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          command: 'test',
          sessionId: 'instance-session',
        }),
      });
    });

    it('should not include session ID when none set', async () => {
      const mockResponse: ExecuteResponse = {
        success: true,
        stdout: 'test output',
        stderr: '',
        exitCode: 0,
        command: 'test',
        timestamp: '2023-01-01T00:00:00Z',
      };

      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      await client.execute('test');

      expect(fetchMock).toHaveBeenCalledWith('http://test.com/api/execute', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          command: 'test',
        }),
      });
    });
  });

  describe('error handling without callbacks', () => {
    it('should work when no callbacks are provided', async () => {
      const clientWithoutCallbacks = new CommandClient({
        baseUrl: 'http://test.com',
        port: 3000,
      });

      const networkError = new Error('Network failed');
      fetchMock.mockRejectedValue(networkError);

      await expect(clientWithoutCallbacks.execute('test')).rejects.toThrow('Network failed');
      // Console error logging is disabled in test environment for cleaner output
    });
  });
});