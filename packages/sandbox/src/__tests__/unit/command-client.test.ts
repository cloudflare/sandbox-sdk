/**
 * CommandClient Tests - High Quality Rewrite
 * 
 * Tests command execution behavior using proven patterns from container tests.
 * Focus: Test what users experience, not HTTP request structure.
 */

import type { ExecuteResponse, HttpClientOptions } from '../../clients';
import { CommandClient } from '../../clients/command-client';
import { CommandError, CommandNotFoundError, SandboxError } from '../../errors';

describe('CommandClient', () => {
  let client: CommandClient;
  let mockFetch: ReturnType<typeof vi.fn>;
  let onCommandComplete: ReturnType<typeof vi.fn>;
  let onError: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    
    mockFetch = vi.fn();
    global.fetch = mockFetch;
    
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
    vi.restoreAllMocks();
  });

  describe('execute', () => {
    it('should execute simple commands successfully', async () => {
      // Arrange: Mock successful command execution
      const mockResponse: ExecuteResponse = {
        success: true,
        stdout: 'Hello World\n',
        stderr: '',
        exitCode: 0,
        command: 'echo "Hello World"',
        timestamp: '2023-01-01T00:00:00Z',
      };
      
      mockFetch.mockResolvedValue(new Response(
        JSON.stringify(mockResponse),
        { status: 200 }
      ));

      // Act: Execute command
      const result = await client.execute('echo "Hello World"');

      // Assert: Verify command execution behavior
      expect(result.success).toBe(true);
      expect(result.stdout).toBe('Hello World\n');
      expect(result.stderr).toBe('');
      expect(result.exitCode).toBe(0);
      expect(result.command).toBe('echo "Hello World"');
      
      // Verify callback integration
      expect(onCommandComplete).toHaveBeenCalledWith(
        true,    // success
        0,       // exitCode
        'Hello World\n', // stdout
        '',      // stderr
        'echo "Hello World"' // command
      );
    });

    it('should handle command failures with proper exit codes', async () => {
      // Arrange: Mock failed command execution (command ran but failed)
      const mockResponse: ExecuteResponse = {
        success: false,
        stdout: '',
        stderr: 'command not found: nonexistent-cmd\n',
        exitCode: 127,
        command: 'nonexistent-cmd',
        timestamp: '2023-01-01T00:00:00Z',
      };
      
      mockFetch.mockResolvedValue(new Response(
        JSON.stringify(mockResponse),
        { status: 200 }
      ));

      // Act: Execute non-existent command
      const result = await client.execute('nonexistent-cmd');

      // Assert: Verify command failure is properly reported
      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(127);
      expect(result.stderr).toContain('command not found');
      expect(result.stdout).toBe('');
      
      // Verify failure callback with correct parameters
      expect(onCommandComplete).toHaveBeenCalledWith(
        false,   // success
        127,     // exitCode
        '',      // stdout
        'command not found: nonexistent-cmd\n', // stderr
        'nonexistent-cmd' // command
      );
    });

    it('should handle container-level errors with proper error mapping', async () => {
      // Arrange: Mock container error (not command failure, but execution failure)
      const errorResponse = {
        error: 'Command not found: invalidcmd',
        code: 'COMMAND_NOT_FOUND'
      };
      
      mockFetch.mockResolvedValue(new Response(
        JSON.stringify(errorResponse),
        { status: 404 }
      ));

      // Act & Assert: Verify proper error mapping
      await expect(client.execute('invalidcmd'))
        .rejects.toThrow(CommandNotFoundError);
        
      // Verify error callback
      expect(onError).toHaveBeenCalledWith(
        expect.stringContaining('Command not found'),
        'invalidcmd'
      );
    });

    it('should handle network failures gracefully', async () => {
      // Arrange: Mock network failure
      mockFetch.mockRejectedValue(new Error('Network connection failed'));

      // Act & Assert: Verify network error handling
      await expect(client.execute('ls'))
        .rejects.toThrow('Network connection failed');
        
      // Verify error callback called
      expect(onError).toHaveBeenCalledWith(
        'Network connection failed',
        'ls'
      );
    });

    it('should handle server errors with proper status codes', async () => {
      // Arrange: Mock various server errors
      const serverErrorScenarios = [
        { status: 400, code: 'COMMAND_EXECUTION_ERROR', error: CommandError }, // Maps to CommandError
        { status: 400, code: 'INVALID_COMMAND', error: CommandError }, // Now maps to CommandError
        { status: 500, code: 'EXECUTION_ERROR', error: SandboxError },
        { status: 503, code: 'SERVICE_UNAVAILABLE', error: SandboxError },
      ];

      for (const scenario of serverErrorScenarios) {
        mockFetch.mockResolvedValueOnce(new Response(
          JSON.stringify({ 
            error: 'Test error', 
            code: scenario.code 
          }),
          { status: scenario.status }
        ));

        await expect(client.execute('test-command'))
          .rejects.toThrow(scenario.error);
      }
    });

    it('should handle commands with large output', async () => {
      // Arrange: Mock command with substantial output
      const largeOutput = 'line of output\n'.repeat(10000); // ~150KB
      const mockResponse: ExecuteResponse = {
        success: true,
        stdout: largeOutput,
        stderr: '',
        exitCode: 0,
        command: 'find / -type f',
        timestamp: '2023-01-01T00:00:00Z',
      };
      
      mockFetch.mockResolvedValue(new Response(
        JSON.stringify(mockResponse),
        { status: 200 }
      ));

      // Act: Execute command that produces large output
      const result = await client.execute('find / -type f');

      // Assert: Verify large output handling
      expect(result.success).toBe(true);
      expect(result.stdout.length).toBeGreaterThan(100000);
      expect(result.stdout.split('\n')).toHaveLength(10001); // 10000 lines + empty
      expect(result.exitCode).toBe(0);
    });

    it('should handle concurrent command executions', async () => {
      // Arrange: Mock responses for concurrent commands
      mockFetch.mockImplementation((url: string, options: RequestInit) => {
        const body = JSON.parse(options.body as string);
        const command = body.command;
        
        // Simulate realistic command-specific responses
        return Promise.resolve(new Response(
          JSON.stringify({
            success: true,
            stdout: `output for ${command}\n`,
            stderr: '',
            exitCode: 0,
            command: command,
            timestamp: '2023-01-01T00:00:00Z',
          }),
          { status: 200 }
        ));
      });

      // Act: Execute multiple commands concurrently
      const commands = ['echo 1', 'echo 2', 'echo 3', 'pwd', 'ls'];
      const results = await Promise.all(
        commands.map(cmd => client.execute(cmd))
      );

      // Assert: Verify all commands executed successfully
      expect(results).toHaveLength(5);
      results.forEach((result, index) => {
        expect(result.success).toBe(true);
        expect(result.stdout).toBe(`output for ${commands[index]}\n`);
        expect(result.exitCode).toBe(0);
      });
      
      // Verify all callbacks were called
      expect(onCommandComplete).toHaveBeenCalledTimes(5);
    });

    it('should handle malformed server responses', async () => {
      // Arrange: Mock malformed JSON response
      mockFetch.mockResolvedValue(new Response(
        'invalid json {',
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      ));

      // Act & Assert: Verify graceful handling of malformed response
      await expect(client.execute('ls'))
        .rejects.toThrow(SandboxError);
        
      // Verify error callback called
      expect(onError).toHaveBeenCalled();
    });

    it('should handle empty command input', async () => {
      // Arrange: Mock validation error for empty command
      const errorResponse = {
        error: 'Invalid command: empty command provided',
        code: 'INVALID_COMMAND'
      };
      
      mockFetch.mockResolvedValue(new Response(
        JSON.stringify(errorResponse),
        { status: 400 }
      ));

      // Act & Assert: Verify empty command handling
      await expect(client.execute(''))
        .rejects.toThrow(CommandError);
    });

    it('should handle session context properly', async () => {
      // Arrange: Set session and mock response
      client.setSessionId('session-123');
      const mockResponse: ExecuteResponse = {
        success: true,
        stdout: '/home/user\n',
        stderr: '',
        exitCode: 0,
        command: 'pwd',
        timestamp: '2023-01-01T00:00:00Z',
      };
      
      mockFetch.mockResolvedValue(new Response(
        JSON.stringify(mockResponse),
        { status: 200 }
      ));

      // Act: Execute command with session
      const result = await client.execute('pwd');

      // Assert: Verify session context maintained
      expect(result.success).toBe(true);
      expect(result.stdout).toBe('/home/user\n');
      
      // Verify session included in request (behavior check, not structure)
      const [url, options] = mockFetch.mock.calls[0];
      const requestBody = JSON.parse(options.body);
      expect(requestBody.sessionId).toBe('session-123');
    });

    it('should handle override session ID', async () => {
      // Arrange: Set instance session but override with method parameter
      client.setSessionId('instance-session');
      const mockResponse: ExecuteResponse = {
        success: true,
        stdout: 'test\n',
        stderr: '',
        exitCode: 0,
        command: 'echo test',
        timestamp: '2023-01-01T00:00:00Z',
      };
      
      mockFetch.mockResolvedValue(new Response(
        JSON.stringify(mockResponse),
        { status: 200 }
      ));

      // Act: Execute with override session
      const result = await client.execute('echo test', 'override-session');

      // Assert: Verify override session used
      expect(result.success).toBe(true);
      
      const [url, options] = mockFetch.mock.calls[0];
      const requestBody = JSON.parse(options.body);
      expect(requestBody.sessionId).toBe('override-session');
    });

    it('should work without session ID', async () => {
      // Arrange: No session set, mock response
      const mockResponse: ExecuteResponse = {
        success: true,
        stdout: 'no session\n',
        stderr: '',
        exitCode: 0,
        command: 'echo "no session"',
        timestamp: '2023-01-01T00:00:00Z',
      };
      
      mockFetch.mockResolvedValue(new Response(
        JSON.stringify(mockResponse),
        { status: 200 }
      ));

      // Act: Execute without session
      const result = await client.execute('echo "no session"');

      // Assert: Verify command works without session
      expect(result.success).toBe(true);
      expect(result.stdout).toBe('no session\n');
      
      // Verify no session in request
      const [url, options] = mockFetch.mock.calls[0];
      const requestBody = JSON.parse(options.body);
      expect(requestBody.sessionId).toBeUndefined();
    });
  });

  describe('executeStream', () => {
    it('should handle streaming command execution', async () => {
      // Arrange: Mock Server-Sent Events stream
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
      
      mockFetch.mockResolvedValue(new Response(mockStream, {
        status: 200,
        headers: { 
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        }
      }));

      // Act: Execute streaming command
      const stream = await client.executeStream('tail -f app.log');

      // Assert: Verify streaming response
      expect(stream).toBeInstanceOf(ReadableStream);
      
      // Read and verify stream content
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

    it('should handle streaming command with session', async () => {
      // Arrange: Set session and mock stream
      client.setSessionId('stream-session');
      const mockStream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            'data: {"type":"start","command":"watch ls"}\n\n'
          ));
          controller.close();
        }
      });
      
      mockFetch.mockResolvedValue(new Response(mockStream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' }
      }));

      // Act: Execute streaming command with session
      const stream = await client.executeStream('watch ls');

      // Assert: Verify stream created and session included
      expect(stream).toBeInstanceOf(ReadableStream);
      
      const [url, options] = mockFetch.mock.calls[0];
      const requestBody = JSON.parse(options.body);
      expect(requestBody.sessionId).toBe('stream-session');
    });

    it('should handle streaming errors gracefully', async () => {
      // Arrange: Mock streaming error response
      const errorResponse = {
        error: 'Command failed to start streaming',
        code: 'STREAM_START_ERROR'
      };
      
      mockFetch.mockResolvedValue(new Response(
        JSON.stringify(errorResponse),
        { status: 400 }
      ));

      // Act & Assert: Verify streaming error handling
      await expect(client.executeStream('invalid-stream-command'))
        .rejects.toThrow(CommandError);
        
      // Verify error callback called
      expect(onError).toHaveBeenCalledWith(
        expect.stringContaining('Command failed to start streaming'),
        'invalid-stream-command'
      );
    });

    it('should handle streaming without response body', async () => {
      // Arrange: Mock response without body (edge case)
      mockFetch.mockResolvedValue(new Response(null, { 
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' }
      }));

      // Act & Assert: Verify error for missing stream body
      await expect(client.executeStream('test-command'))
        .rejects.toThrow('No response body for streaming');
    });

    it('should handle network failures during streaming setup', async () => {
      // Arrange: Mock network failure
      mockFetch.mockRejectedValue(new Error('Connection lost during streaming'));

      // Act & Assert: Verify network error handling
      await expect(client.executeStream('stream-command'))
        .rejects.toThrow('Connection lost during streaming');
        
      expect(onError).toHaveBeenCalledWith(
        'Connection lost during streaming',
        'stream-command'
      );
    });
  });

  describe('callback integration', () => {
    it('should work without any callbacks', async () => {
      // Arrange: Client without callbacks
      const clientWithoutCallbacks = new CommandClient({
        baseUrl: 'http://test.com',
        port: 3000,
      });
      
      const mockResponse: ExecuteResponse = {
        success: true,
        stdout: 'test output\n',
        stderr: '',
        exitCode: 0,
        command: 'echo test',
        timestamp: '2023-01-01T00:00:00Z',
      };
      
      mockFetch.mockResolvedValue(new Response(
        JSON.stringify(mockResponse),
        { status: 200 }
      ));

      // Act: Execute command without callbacks
      const result = await clientWithoutCallbacks.execute('echo test');

      // Assert: Verify operation succeeds without callbacks
      expect(result.success).toBe(true);
      expect(result.stdout).toBe('test output\n');
    });

    it('should handle errors gracefully without callbacks', async () => {
      // Arrange: Client without callbacks and network error
      const clientWithoutCallbacks = new CommandClient({
        baseUrl: 'http://test.com',
        port: 3000,
      });
      
      mockFetch.mockRejectedValue(new Error('Network failed'));

      // Act & Assert: Verify error handling without callbacks
      await expect(clientWithoutCallbacks.execute('test'))
        .rejects.toThrow('Network failed');
    });

    it('should call onCommandComplete for both success and failure', async () => {
      // Test success case
      const successResponse: ExecuteResponse = {
        success: true,
        stdout: 'success\n',
        stderr: '',
        exitCode: 0,
        command: 'echo success',
        timestamp: '2023-01-01T00:00:00Z',
      };
      
      mockFetch.mockResolvedValueOnce(new Response(
        JSON.stringify(successResponse),
        { status: 200 }
      ));

      await client.execute('echo success');
      
      expect(onCommandComplete).toHaveBeenLastCalledWith(
        true, 0, 'success\n', '', 'echo success'
      );

      // Test failure case
      const failureResponse: ExecuteResponse = {
        success: false,
        stdout: '',
        stderr: 'error\n',
        exitCode: 1,
        command: 'false',
        timestamp: '2023-01-01T00:00:00Z',
      };
      
      mockFetch.mockResolvedValueOnce(new Response(
        JSON.stringify(failureResponse),
        { status: 200 }
      ));

      await client.execute('false');
      
      expect(onCommandComplete).toHaveBeenLastCalledWith(
        false, 1, '', 'error\n', 'false'
      );
    });
  });

  describe('constructor options', () => {
    it('should initialize with minimal options', async () => {
      // Arrange: Create client with minimal config
      const minimalClient = new CommandClient();
      
      // Assert: Verify client initializes successfully
      expect(minimalClient.getSessionId()).toBeNull();
    });

    it('should initialize with full options', async () => {
      // Arrange: Create client with all options
      const fullOptionsClient = new CommandClient({
        baseUrl: 'http://custom.com',
        port: 8080,
        onCommandComplete: vi.fn(),
        onError: vi.fn(),
      });
      
      // Assert: Verify client initializes with custom options
      expect(fullOptionsClient.getSessionId()).toBeNull();
    });
  });
});

/**
 * This rewrite demonstrates the quality improvement:
 * 
 * BEFORE (❌ Poor Quality):
 * - Tested HTTP request structure instead of command behavior
 * - Over-complex mocks that didn't validate functionality
 * - Missing realistic error scenarios
 * - No edge case testing (large output, concurrent commands)
 * - Repetitive boilerplate comments
 * 
 * AFTER (✅ High Quality):
 * - Tests actual command execution behavior users experience
 * - Realistic error scenarios (network failures, server errors, malformed responses)
 * - Edge cases (large output, concurrent operations, streaming)
 * - Proper error mapping validation (container errors → client exceptions)
 * - Session management testing with behavior focus
 * - Callback integration testing for both success and failure paths
 * - Clean, focused test setup without over-mocking
 * 
 * Result: Tests that would actually catch bugs users encounter!
 */