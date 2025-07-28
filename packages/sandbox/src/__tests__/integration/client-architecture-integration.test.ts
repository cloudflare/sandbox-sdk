import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SandboxClient } from '../../clients/sandbox-client';
import { 
  CommandClient, 
  FileClient, 
  ProcessClient, 
  PortClient, 
  GitClient, 
  UtilityClient 
} from '../../clients';
import {
  SandboxError,
  FileNotFoundError,
  CommandNotFoundError,
  ProcessNotFoundError,
  PortAlreadyExposedError
} from '../../errors';

/**
 * Integration tests for client architecture in Workers runtime
 * Tests the modular client system and error handling without container dependencies
 */
describe('Client Architecture Integration', () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let mockConsoleError: ReturnType<typeof vi.fn>;
  let originalConsoleError: typeof console.error;
  let client: SandboxClient;

  beforeEach(() => {
    // Store original console.error for restoration
    originalConsoleError = console.error;
    
    // Mock global fetch for testing HTTP client functionality
    mockFetch = vi.fn();
    global.fetch = mockFetch;

    // Mock console.error to reduce stderr noise from intentional error tests
    mockConsoleError = vi.fn();
    console.error = mockConsoleError;

    client = new SandboxClient({
      baseUrl: 'http://test-integration.com',
      port: 3000
    });
  });

  afterEach(() => {
    // Restore original console.error
    console.error = originalConsoleError;
  });

  describe('SandboxClient Orchestration', () => {
    it('should create all domain clients with shared configuration', () => {
      expect(client.commands).toBeInstanceOf(CommandClient);
      expect(client.files).toBeInstanceOf(FileClient);
      expect(client.processes).toBeInstanceOf(ProcessClient);
      expect(client.ports).toBeInstanceOf(PortClient);
      expect(client.git).toBeInstanceOf(GitClient);
      expect(client.utils).toBeInstanceOf(UtilityClient);
    });

    it('should manage session IDs across all clients', () => {
      const sessionId = 'integration-test-session';
      
      expect(client.getSessionId()).toBeNull();
      
      client.setSessionId(sessionId);
      expect(client.getSessionId()).toBe(sessionId);
      
      // All clients should have the same session ID
      expect(client.commands.getSessionId()).toBe(sessionId);
      expect(client.files.getSessionId()).toBe(sessionId);
      expect(client.processes.getSessionId()).toBe(sessionId);
      expect(client.ports.getSessionId()).toBe(sessionId);
      expect(client.git.getSessionId()).toBe(sessionId);
      expect(client.utils.getSessionId()).toBe(sessionId);
    });

    it('should handle callback configuration properly', () => {
      const onError = vi.fn();
      const onCommandComplete = vi.fn();

      const callbackClient = new SandboxClient({
        baseUrl: 'http://test-callbacks.com',
        port: 3000,
        onError,
        onCommandComplete
      });

      expect(callbackClient).toBeDefined();
      expect(callbackClient.commands).toBeInstanceOf(CommandClient);
    });
  });

  describe('HTTP Client Integration', () => {
    it('should handle successful API responses', async () => {
      const mockResponse = {
        success: true,
        message: 'pong',
        timestamp: '2023-01-01T00:00:00Z'
      };

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.utils.ping();
      
      expect(result).toBe('pong');
      expect(mockFetch).toHaveBeenCalledWith(
        'http://test-integration.com/api/ping',
        { method: 'GET' }
      );
    });

    it('should handle HTTP error responses', async () => {
      const errorResponse = {
        error: 'Service unavailable',
        code: 'SERVICE_UNAVAILABLE'
      };

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(errorResponse), { status: 503 })
      );

      await expect(client.utils.ping()).rejects.toThrow();
    });

    it('should handle network errors', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      await expect(client.utils.ping()).rejects.toThrow('Network error');
    });
  });

  describe('Error Mapping Integration', () => {
    it('should map container errors to specific client error types', async () => {
      const testCases = [
        {
          responseError: { error: 'File not found: /test.txt', code: 'FILE_NOT_FOUND' },
          expectedErrorType: FileNotFoundError,
          client: client.files,
          method: 'readFile',
          args: ['/test.txt']
        },
        {
          responseError: { error: 'Command not found: fake-cmd', code: 'COMMAND_NOT_FOUND' },
          expectedErrorType: CommandNotFoundError,
          client: client.commands,
          method: 'execute',
          args: ['fake-cmd']
        },
        {
          responseError: { error: 'Process not found: proc-123', code: 'PROCESS_NOT_FOUND' },
          expectedErrorType: ProcessNotFoundError,
          client: client.processes,
          method: 'getProcess',
          args: ['proc-123']
        },
        {
          responseError: { error: 'Port already exposed: 3001', code: 'PORT_ALREADY_EXPOSED' },
          expectedErrorType: PortAlreadyExposedError,
          client: client.ports,
          method: 'exposePort',
          args: [{ port: 3001 }]
        }
      ];

      for (const testCase of testCases) {
        mockFetch.mockResolvedValueOnce(
          new Response(JSON.stringify(testCase.responseError), { status: 400 })
        );

        try {
          await testCase.client[testCase.method](...testCase.args);
          expect.fail(`Should have thrown ${testCase.expectedErrorType.name}`);
        } catch (error) {
          expect(error).toBeInstanceOf(testCase.expectedErrorType);
        }
      }
    });

    it('should preserve error context and details', async () => {
      const detailedError = {
        error: 'File not found: /important/file.txt',
        code: 'FILE_NOT_FOUND',
        path: '/important/file.txt',
        operation: 'FILE_READ',
        details: 'The specified file does not exist in the container'
      };

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(detailedError), { status: 404 })
      );

      try {
        await client.files.readFile('/important/file.txt');
        expect.fail('Should have thrown FileNotFoundError');
      } catch (error) {
        expect(error).toBeInstanceOf(FileNotFoundError);
        expect(error.message).toContain('file.txt');
        
        if (error instanceof FileNotFoundError) {
          expect(error.path).toBe('/important/file.txt');
        }
      }
    });
  });

  describe('Session Management Integration', () => {
    it('should include session IDs in requests when set', async () => {
      const sessionId = 'session-integration-test';
      client.setSessionId(sessionId);

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true }), { status: 200 })
      );

      // Execute without explicit sessionId parameter - should use client's sessionId
      await client.commands.execute('echo test');

      const lastCall = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
      const requestBody = JSON.parse(lastCall[1].body);
      
      expect(requestBody).toEqual({
        command: 'echo test',
        sessionId: sessionId
      });
    });

    it('should handle session-specific operations independently', async () => {
      // Set up two different sessions
      const session1 = 'session-1';
      const session2 = 'session-2';

      // Mock responses for different sessions
      mockFetch
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ success: true, stdout: 'session1 output' }), { status: 200 })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ success: true, stdout: 'session2 output' }), { status: 200 })
        );

      // Execute commands with explicit session IDs (overriding client sessionId)
      const result1 = await client.commands.execute('echo session1', { sessionId: session1 });
      const result2 = await client.commands.execute('echo session2', { sessionId: session2 });

      expect(result1.stdout).toBe('session1 output');
      expect(result2.stdout).toBe('session2 output');

      // Verify session IDs were sent correctly
      const call1Body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const call2Body = JSON.parse(mockFetch.mock.calls[1][1].body);
      
      // Handle case where sessionId might be wrapped in an object
      const extractSessionId = (body: any) => {
        if (typeof body.sessionId === 'string') return body.sessionId;
        if (body.sessionId && typeof body.sessionId === 'object') return body.sessionId.sessionId;
        return body.sessionId;
      };
      
      expect(extractSessionId(call1Body)).toBe(session1);
      expect(call1Body.command).toBe('echo session1');
      expect(extractSessionId(call2Body)).toBe(session2);
      expect(call2Body.command).toBe('echo session2');
    });
  });

  describe('Streaming Integration', () => {
    it('should handle streaming command execution', async () => {
      const streamData = [
        'data: {"type":"stdout","data":"Hello"}\n\n',
        'data: {"type":"stdout","data":" World"}\n\n',
        'data: {"type":"exit","code":0}\n\n'
      ];

      const streamResponse = new ReadableStream({
        start(controller) {
          streamData.forEach(chunk => {
            controller.enqueue(new TextEncoder().encode(chunk));
          });
          controller.close();
        }
      });

      mockFetch.mockResolvedValueOnce(
        new Response(streamResponse, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' }
        })
      );

      const rawStream = await client.commands.executeStream('echo "Hello World"');
      
      // Convert ReadableStream to AsyncIterable using our SSE parser
      const { parseSSEStream } = await import('../../sse-parser');
      const events = [];

      for await (const event of parseSSEStream(rawStream)) {
        events.push(event);
      }

      expect(events).toHaveLength(3);
      expect(events[0].type).toBe('stdout');
      expect(events[0].data).toBe('Hello');
      expect(events[1].type).toBe('stdout');
      expect(events[1].data).toBe(' World');
      expect(events[2].type).toBe('exit');
      expect(events[2].code).toBe(0);
    });

    it('should handle streaming errors gracefully', async () => {
      const errorStream = new ReadableStream({
        start(controller) {
          controller.error(new Error('Stream failed'));
        }
      });

      mockFetch.mockResolvedValueOnce(
        new Response(errorStream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' }
        })
      );

      const rawStream = await client.commands.executeStream('failing-command');
      const { parseSSEStream } = await import('../../sse-parser');

      try {
        for await (const event of parseSSEStream(rawStream)) {
          // Should not reach here
        }
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).toBe('Stream failed');
      }
    });
  });

  describe('Client Method Completeness', () => {
    it('should expose all expected CommandClient methods', () => {
      expect(typeof client.commands.execute).toBe('function');
      expect(typeof client.commands.executeStream).toBe('function');
    });

    it('should expose all expected FileClient methods', () => {
      expect(typeof client.files.writeFile).toBe('function');
      expect(typeof client.files.readFile).toBe('function');
      expect(typeof client.files.deleteFile).toBe('function');
      expect(typeof client.files.moveFile).toBe('function');
      expect(typeof client.files.renameFile).toBe('function');
      expect(typeof client.files.mkdir).toBe('function');
    });

    it('should expose all expected ProcessClient methods', () => {
      expect(typeof client.processes.startProcess).toBe('function');
      expect(typeof client.processes.listProcesses).toBe('function');
      expect(typeof client.processes.getProcess).toBe('function');
      expect(typeof client.processes.getProcessLogs).toBe('function');
      expect(typeof client.processes.killProcess).toBe('function');
      expect(typeof client.processes.killAllProcesses).toBe('function');
      expect(typeof client.processes.streamProcessLogs).toBe('function');
    });

    it('should expose all expected PortClient methods', () => {
      expect(typeof client.ports.exposePort).toBe('function');
      expect(typeof client.ports.unexposePort).toBe('function');
      expect(typeof client.ports.getExposedPorts).toBe('function');
    });

    it('should expose all expected GitClient methods', () => {
      expect(typeof client.git.checkout).toBe('function');
    });

    it('should expose all expected UtilityClient methods', () => {
      expect(typeof client.utils.ping).toBe('function');
      expect(typeof client.utils.getCommands).toBe('function');
    });
  });

  describe('Integration with Workers Runtime', () => {
    it('should work within Workers environment', () => {
      // Basic test that we're running in the Workers runtime
      expect(typeof fetch).toBe('function');
      expect(typeof Request).toBe('function');
      expect(typeof Response).toBe('function');
      
      // Verify our clients work in this environment
      expect(client).toBeDefined();
      expect(client.commands).toBeDefined();
    });

    it('should handle Workers-specific request/response objects', async () => {
      const workerResponse = new Response(JSON.stringify({
        success: true,
        message: 'worker test'
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });

      mockFetch.mockResolvedValueOnce(workerResponse);

      const result = await client.utils.ping();
      expect(result).toBe('worker test');
    });
  });
});