/**
 * SDK Interface Contract Tests
 * 
 * These tests validate that the public SDK interfaces remain stable and
 * backwards compatible. They test the exact API that external consumers
 * depend on and prevent breaking changes to public methods and types.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { SandboxClient } from '../../client';
import type { 
  ExecOptions, 
  ExecResult,
  FileReadOptions,
  FileWriteOptions,
  FileResult,
  ProcessStartOptions,
  ProcessResult,
  PortExposeOptions,
  PortResult,
  GitCheckoutOptions,
  GitResult,
  SessionOptions,
  SessionResult
} from '../../types';

// Mock fetch for testing
global.fetch = vi.fn();

describe('SDK Interface Contract Validation', () => {
  let client: SandboxClient;
  const MOCK_BASE_URL = 'https://sandbox.example.com';

  beforeAll(() => {
    client = new SandboxClient(MOCK_BASE_URL);
  });

  describe('SandboxClient Constructor Contract', () => {
    it('should accept baseUrl as string parameter', () => {
      const testClient = new SandboxClient('https://test.example.com');
      expect(testClient).toBeInstanceOf(SandboxClient);
    });

    it('should accept baseUrl with options object', () => {
      const testClient = new SandboxClient('https://test.example.com', {
        timeout: 30000,
        headers: { 'Authorization': 'Bearer token' }
      });
      expect(testClient).toBeInstanceOf(SandboxClient);
    });

    it('should throw for invalid baseUrl', () => {
      expect(() => new SandboxClient('')).toThrow();
      expect(() => new SandboxClient('invalid-url')).toThrow();
    });
  });

  describe('Command Execution Interface Contract', () => {
    it('should have execute method with correct signature', () => {
      expect(typeof client.execute).toBe('function');
      expect(client.execute.length).toBe(2); // command, options
    });

    it('should accept execute parameters matching ExecOptions contract', async () => {
      const mockResponse = {
        ok: true,
        json: vi.fn().mockResolvedValue({
          success: true,
          output: 'test output',
          exitCode: 0,
          timestamp: new Date().toISOString()
        })
      };
      (global.fetch as any).mockResolvedValue(mockResponse);

      // Test with minimal parameters
      const result1 = await client.execute('ls -la');
      expect(result1).toBeDefined();

      // Test with full ExecOptions interface
      const options: ExecOptions = {
        sessionId: 'test-session',
        cwd: '/tmp',
        env: { NODE_ENV: 'test' },
        background: false,
        streaming: false,
        timeout: 30000
      };

      const result2 = await client.execute('echo "test"', options);
      expect(result2).toBeDefined();

      // Verify fetch was called with correct parameters
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/execute'),
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json'
          }),
          body: expect.stringContaining('"command":"echo \\"test\\""')
        })
      );
    });

    it('should return ExecResult contract', async () => {
      const mockResponseData = {
        success: true,
        output: 'command output',
        exitCode: 0,
        processId: 'proc-123',
        timestamp: '2023-01-01T00:00:00.000Z'
      };

      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(mockResponseData)
      });

      const result: ExecResult = await client.execute('echo test');

      // Validate ExecResult interface compliance
      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('output');
      expect(result).toHaveProperty('exitCode');
      expect(result).toHaveProperty('timestamp');
      expect(typeof result.success).toBe('boolean');
      expect(typeof result.output).toBe('string');
      expect(typeof result.exitCode).toBe('number');
      expect(typeof result.timestamp).toBe('string');

      // Optional fields
      if (result.processId) {
        expect(typeof result.processId).toBe('string');
      }
      if (result.error) {
        expect(typeof result.error).toBe('string');
      }
    });

    it('should handle streaming execution interface', async () => {
      const mockResponse = {
        ok: true,
        body: new ReadableStream(),
        headers: new Map([['content-type', 'text/event-stream']])
      };
      (global.fetch as any).mockResolvedValue(mockResponse);

      // Should accept streaming option
      const streamOptions: ExecOptions = {
        streaming: true,
        sessionId: 'test-session'
      };

      const result = await client.execute('long-running-command', streamOptions);
      expect(result).toBeDefined();
      
      // Should have called with streaming endpoint
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/stream'),
        expect.any(Object)
      );
    });
  });

  describe('File Operations Interface Contract', () => {
    it('should have file operation methods with correct signatures', () => {
      expect(typeof client.readFile).toBe('function');
      expect(typeof client.writeFile).toBe('function');
      expect(typeof client.deleteFile).toBe('function');
      expect(typeof client.renameFile).toBe('function');
      expect(typeof client.createDirectory).toBe('function');
      
      expect(client.readFile.length).toBe(2); // path, options
      expect(client.writeFile.length).toBe(3); // path, content, options
      expect(client.deleteFile.length).toBe(2); // path, options
      expect(client.renameFile.length).toBe(3); // oldPath, newPath, options
      expect(client.createDirectory.length).toBe(2); // path, options
    });

    it('should accept readFile parameters matching FileReadOptions contract', async () => {
      const mockResponse = {
        ok: true,
        json: vi.fn().mockResolvedValue({
          success: true,
          content: 'file content',
          size: 12,
          timestamp: new Date().toISOString()
        })
      };
      (global.fetch as any).mockResolvedValue(mockResponse);

      // Test with minimal parameters
      await client.readFile('/tmp/test.txt');

      // Test with full FileReadOptions interface
      const options: FileReadOptions = {
        sessionId: 'test-session',
        encoding: 'utf-8'
      };

      await client.readFile('/tmp/test.txt', options);

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/files/read'),
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"/tmp/test.txt"')
        })
      );
    });

    it('should accept writeFile parameters matching FileWriteOptions contract', async () => {
      const mockResponse = {
        ok: true,
        json: vi.fn().mockResolvedValue({
          success: true,
          bytesWritten: 12,
          timestamp: new Date().toISOString()
        })
      };
      (global.fetch as any).mockResolvedValue(mockResponse);

      // Test with minimal parameters
      await client.writeFile('/tmp/test.txt', 'content');

      // Test with full FileWriteOptions interface
      const options: FileWriteOptions = {
        sessionId: 'test-session',
        encoding: 'utf-8',
        overwrite: true
      };

      await client.writeFile('/tmp/test2.txt', 'content', options);

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/files/write'),
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"content":"content"')
        })
      );
    });

    it('should return FileResult contract', async () => {
      const mockResponseData = {
        success: true,
        content: 'file content',
        size: 12,
        bytesWritten: 12,
        timestamp: '2023-01-01T00:00:00.000Z'
      };

      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(mockResponseData)
      });

      const result: FileResult = await client.readFile('/tmp/test.txt');

      // Validate FileResult interface compliance
      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('timestamp');
      expect(typeof result.success).toBe('boolean');
      expect(typeof result.timestamp).toBe('string');

      // Optional fields should be properly typed when present
      if (result.content !== undefined) {
        expect(typeof result.content).toBe('string');
      }
      if (result.size !== undefined) {
        expect(typeof result.size).toBe('number');
      }
      if (result.bytesWritten !== undefined) {
        expect(typeof result.bytesWritten).toBe('number');
      }
      if (result.error !== undefined) {
        expect(typeof result.error).toBe('string');
      }
    });
  });

  describe('Process Management Interface Contract', () => {
    it('should have process methods with correct signatures', () => {
      expect(typeof client.startProcess).toBe('function');
      expect(typeof client.listProcesses).toBe('function');
      expect(typeof client.stopProcess).toBe('function');
      expect(typeof client.getProcessLogs).toBe('function');
      
      expect(client.startProcess.length).toBe(2); // command, options
      expect(client.listProcesses.length).toBe(1); // options
      expect(client.stopProcess.length).toBe(2); // processId, options
      expect(client.getProcessLogs.length).toBe(2); // processId, options
    });

    it('should accept startProcess parameters matching ProcessStartOptions contract', async () => {
      const mockResponse = {
        ok: true,
        json: vi.fn().mockResolvedValue({
          success: true,
          processId: 'proc-123',
          pid: 12345,
          timestamp: new Date().toISOString()
        })
      };
      (global.fetch as any).mockResolvedValue(mockResponse);

      // Test with minimal parameters
      await client.startProcess('node server.js');

      // Test with full ProcessStartOptions interface
      const options: ProcessStartOptions = {
        sessionId: 'test-session',
        background: true,
        cwd: '/tmp/app',
        env: { PORT: '8080' }
      };

      await client.startProcess('node server.js', options);

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/processes/start'),
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"background":true')
        })
      );
    });

    it('should return ProcessResult contract', async () => {
      const mockResponseData = {
        success: true,
        processId: 'proc-123',
        pid: 12345,
        processes: [
          {
            id: 'proc-123',
            command: 'node server.js',
            status: 'running',
            pid: 12345,
            createdAt: '2023-01-01T00:00:00.000Z'
          }
        ],
        timestamp: '2023-01-01T00:00:00.000Z'
      };

      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(mockResponseData)
      });

      const result: ProcessResult = await client.startProcess('node server.js');

      // Validate ProcessResult interface compliance
      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('timestamp');
      expect(typeof result.success).toBe('boolean');
      expect(typeof result.timestamp).toBe('string');

      // Optional fields validation
      if (result.processId !== undefined) {
        expect(typeof result.processId).toBe('string');
      }
      if (result.pid !== undefined) {
        expect(typeof result.pid).toBe('number');
      }
      if (result.processes !== undefined) {
        expect(Array.isArray(result.processes)).toBe(true);
        if (result.processes.length > 0) {
          const process = result.processes[0];
          expect(process).toHaveProperty('id');
          expect(process).toHaveProperty('command');
          expect(process).toHaveProperty('status');
          expect(typeof process.id).toBe('string');
          expect(typeof process.command).toBe('string');
          expect(typeof process.status).toBe('string');
        }
      }
    });
  });

  describe('Port Management Interface Contract', () => {
    it('should have port methods with correct signatures', () => {
      expect(typeof client.exposePort).toBe('function');
      expect(typeof client.listPorts).toBe('function');
      expect(typeof client.closePort).toBe('function');
      
      expect(client.exposePort.length).toBe(2); // port, options
      expect(client.listPorts.length).toBe(1); // options
      expect(client.closePort.length).toBe(2); // port, options
    });

    it('should accept exposePort parameters matching PortExposeOptions contract', async () => {
      const mockResponse = {
        ok: true,
        json: vi.fn().mockResolvedValue({
          success: true,
          port: 8080,
          previewUrl: 'https://preview.example.com/8080',
          timestamp: new Date().toISOString()
        })
      };
      (global.fetch as any).mockResolvedValue(mockResponse);

      // Test with minimal parameters
      await client.exposePort(8080);

      // Test with full PortExposeOptions interface
      const options: PortExposeOptions = {
        sessionId: 'test-session',
        name: 'web-server'
      };

      await client.exposePort(8080, options);

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/ports/expose'),
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"port":8080')
        })
      );
    });

    it('should return PortResult contract', async () => {
      const mockResponseData = {
        success: true,
        port: 8080,
        name: 'web-server',
        previewUrl: 'https://preview.example.com/8080',
        ports: [
          {
            id: 'port-123',
            port: 8080,
            name: 'web-server',
            isActive: true,
            previewUrl: 'https://preview.example.com/8080'
          }
        ],
        timestamp: '2023-01-01T00:00:00.000Z'
      };

      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(mockResponseData)
      });

      const result: PortResult = await client.exposePort(8080);

      // Validate PortResult interface compliance
      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('timestamp');
      expect(typeof result.success).toBe('boolean');
      expect(typeof result.timestamp).toBe('string');

      // Optional fields validation
      if (result.port !== undefined) {
        expect(typeof result.port).toBe('number');
      }
      if (result.name !== undefined) {
        expect(typeof result.name).toBe('string');
      }
      if (result.previewUrl !== undefined) {
        expect(typeof result.previewUrl).toBe('string');
      }
      if (result.ports !== undefined) {
        expect(Array.isArray(result.ports)).toBe(true);
        if (result.ports.length > 0) {
          const port = result.ports[0];
          expect(port).toHaveProperty('id');
          expect(port).toHaveProperty('port');
          expect(port).toHaveProperty('isActive');
          expect(typeof port.id).toBe('string');
          expect(typeof port.port).toBe('number');
          expect(typeof port.isActive).toBe('boolean');
        }
      }
    });
  });

  describe('Git Operations Interface Contract', () => {
    it('should have git methods with correct signatures', () => {
      expect(typeof client.gitCheckout).toBe('function');
      expect(client.gitCheckout.length).toBe(2); // repoUrl, options
    });

    it('should accept gitCheckout parameters matching GitCheckoutOptions contract', async () => {
      const mockResponse = {
        ok: true,
        json: vi.fn().mockResolvedValue({
          success: true,
          output: 'Cloning completed',
          exitCode: 0,
          targetDir: '/tmp/repo',
          timestamp: new Date().toISOString()
        })
      };
      (global.fetch as any).mockResolvedValue(mockResponse);

      // Test with minimal parameters
      await client.gitCheckout('https://github.com/user/repo.git');

      // Test with full GitCheckoutOptions interface
      const options: GitCheckoutOptions = {
        sessionId: 'test-session',
        branch: 'develop',
        targetDir: '/tmp/my-repo'
      };

      await client.gitCheckout('https://github.com/user/repo.git', options);

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/git/checkout'),
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"branch":"develop"')
        })
      );
    });

    it('should return GitResult contract', async () => {
      const mockResponseData = {
        success: true,
        output: 'Clone completed successfully',
        exitCode: 0,
        targetDir: '/tmp/repo',
        timestamp: '2023-01-01T00:00:00.000Z'
      };

      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(mockResponseData)
      });

      const result: GitResult = await client.gitCheckout('https://github.com/user/repo.git');

      // Validate GitResult interface compliance
      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('timestamp');
      expect(typeof result.success).toBe('boolean');
      expect(typeof result.timestamp).toBe('string');

      // Optional fields validation
      if (result.output !== undefined) {
        expect(typeof result.output).toBe('string');
      }
      if (result.exitCode !== undefined) {
        expect(typeof result.exitCode).toBe('number');
      }
      if (result.targetDir !== undefined) {
        expect(typeof result.targetDir).toBe('string');
      }
      if (result.error !== undefined) {
        expect(typeof result.error).toBe('string');
      }
    });
  });

  describe('Session Management Interface Contract', () => {
    it('should have session methods with correct signatures', () => {
      expect(typeof client.createSession).toBe('function');
      expect(typeof client.listSessions).toBe('function');
      expect(typeof client.deleteSession).toBe('function');
      
      expect(client.createSession.length).toBe(1); // options
      expect(client.listSessions.length).toBe(0); // no parameters
      expect(client.deleteSession.length).toBe(1); // sessionId
    });

    it('should accept createSession parameters matching SessionOptions contract', async () => {
      const mockResponse = {
        ok: true,
        json: vi.fn().mockResolvedValue({
          success: true,
          sessionId: 'session-123',
          timestamp: new Date().toISOString()
        })
      };
      (global.fetch as any).mockResolvedValue(mockResponse);

      // Test with minimal parameters
      await client.createSession();

      // Test with full SessionOptions interface
      const options: SessionOptions = {
        env: { NODE_ENV: 'development' },
        cwd: '/tmp/workspace'
      };

      await client.createSession(options);

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/sessions'),
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"env":{')
        })
      );
    });

    it('should return SessionResult contract', async () => {
      const mockResponseData = {
        success: true,
        sessionId: 'session-123',
        sessions: [
          {
            id: 'session-123',
            createdAt: '2023-01-01T00:00:00.000Z',
            isActive: true,
            hasActiveProcess: false
          }
        ],
        timestamp: '2023-01-01T00:00:00.000Z'
      };

      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(mockResponseData)
      });

      const result: SessionResult = await client.createSession();

      // Validate SessionResult interface compliance
      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('timestamp');
      expect(typeof result.success).toBe('boolean');
      expect(typeof result.timestamp).toBe('string');

      // Optional fields validation
      if (result.sessionId !== undefined) {
        expect(typeof result.sessionId).toBe('string');
      }
      if (result.sessions !== undefined) {
        expect(Array.isArray(result.sessions)).toBe(true);
        if (result.sessions.length > 0) {
          const session = result.sessions[0];
          expect(session).toHaveProperty('id');
          expect(session).toHaveProperty('createdAt');
          expect(session).toHaveProperty('isActive');
          expect(typeof session.id).toBe('string');
          expect(typeof session.createdAt).toBe('string');
          expect(typeof session.isActive).toBe('boolean');
        }
      }
    });
  });

  describe('Error Handling Interface Contract', () => {
    it('should throw consistent error types for network failures', async () => {
      (global.fetch as any).mockRejectedValue(new Error('Network error'));

      await expect(client.execute('ls')).rejects.toThrow('Network error');
    });

    it('should return error results for API errors without throwing', async () => {
      const mockErrorResponse = {
        ok: false,
        status: 400,
        json: vi.fn().mockResolvedValue({
          success: false,
          error: 'Command validation failed',
          timestamp: new Date().toISOString()
        })
      };
      (global.fetch as any).mockResolvedValue(mockErrorResponse);

      const result = await client.execute('invalid-command');
      
      expect(result.success).toBe(false);
      expect(result.error).toBe('Command validation failed');
      expect(typeof result.timestamp).toBe('string');
    });

    it('should handle timeout errors consistently', async () => {
      const timeoutClient = new SandboxClient(MOCK_BASE_URL, { timeout: 1 });
      
      (global.fetch as any).mockImplementation(() => 
        new Promise(resolve => setTimeout(resolve, 100))
      );

      await expect(timeoutClient.execute('long-command')).rejects.toThrow('timeout');
    });
  });

  describe('Backwards Compatibility Contract', () => {
    it('should maintain method signatures across versions', () => {
      // These method signatures should never change to maintain backwards compatibility
      const methodSignatures = {
        execute: ['string', 'object?'],
        readFile: ['string', 'object?'],
        writeFile: ['string', 'string', 'object?'],
        deleteFile: ['string', 'object?'],
        renameFile: ['string', 'string', 'object?'],
        createDirectory: ['string', 'object?'],
        startProcess: ['string', 'object?'],
        listProcesses: ['object?'],
        stopProcess: ['string', 'object?'],
        exposePort: ['number', 'object?'],
        listPorts: ['object?'],
        closePort: ['number', 'object?'],
        gitCheckout: ['string', 'object?'],
        createSession: ['object?'],
        listSessions: [],
        deleteSession: ['string']
      };

      for (const [method, expectedParams] of Object.entries(methodSignatures)) {
        expect(client).toHaveProperty(method);
        expect(typeof (client as any)[method]).toBe('function');
        expect((client as any)[method].length).toBe(expectedParams.length);
      }
    });

    it('should maintain interface field compatibility', () => {
      // These type checks ensure that required interface fields haven't been removed
      const execOptions: ExecOptions = {
        sessionId: 'test',
        cwd: '/tmp',
        env: {},
        background: false,
        streaming: false,
        timeout: 30000
      };

      const fileReadOptions: FileReadOptions = {
        sessionId: 'test',
        encoding: 'utf-8'
      };

      const fileWriteOptions: FileWriteOptions = {
        sessionId: 'test',
        encoding: 'utf-8',
        overwrite: true
      };

      // If these assignments compile, the interfaces are backwards compatible
      expect(execOptions).toBeDefined();
      expect(fileReadOptions).toBeDefined();
      expect(fileWriteOptions).toBeDefined();
    });
  });
});

/**
 * These SDK Interface contract tests are ESSENTIAL for maintaining backwards
 * compatibility and preventing breaking changes to the public SDK API. They validate:
 * 
 * 1. **Method Signature Stability**: All public methods maintain exact same signatures
 * 2. **Parameter Interface Compliance**: Input options match expected TypeScript interfaces
 * 3. **Return Type Contracts**: Results match expected TypeScript interfaces exactly
 * 4. **Error Handling Consistency**: Errors are thrown or returned consistently
 * 5. **Optional Parameter Handling**: Optional parameters work correctly without breaking
 * 6. **Type Safety Validation**: Runtime types match compile-time TypeScript interfaces
 * 7. **Constructor Contract**: Client initialization works with expected parameters
 * 8. **Backwards Compatibility**: Existing consumer code continues to work
 * 9. **Field Presence Contracts**: Required fields are always present in results
 * 10. **Network Error Handling**: Network failures are handled consistently
 * 
 * These tests act as a safety net against accidental breaking changes during
 * refactoring or feature additions. They should be run as part of CI/CD to catch
 * breaking changes before they reach consumers.
 * 
 * If any of these tests fail, it indicates that a breaking change has been introduced
 * that will affect external SDK consumers. Such changes require:
 * - Version bumping (major version for breaking changes)
 * - Migration guides for consumers
 * - Deprecation warnings for removed functionality
 * - Backwards compatibility shims where possible
 */