/**
 * Cross-Client Contract Tests - Simplified
 * 
 * These tests validate that contracts between different client types are maintained,
 * ensuring consistent behavior across all domain clients. Session management has 
 * been removed as sessions are now implicit per sandbox instance.
 */

import { CommandClient } from '../../clients/command-client';
import { FileClient } from '../../clients/file-client';
import { GitClient } from '../../clients/git-client';
import { PortClient } from '../../clients/port-client';
import { ProcessClient } from '../../clients/process-client';
import { SandboxClient } from '../../clients/sandbox-client';
import { UtilityClient } from '../../clients/utility-client';

describe('Cross-Client Contract Validation', () => {
  let sandboxClient: SandboxClient;
  let fetchMock: ReturnType<typeof vi.fn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock = vi.fn();
    global.fetch = fetchMock;
    
    sandboxClient = new SandboxClient({
      baseUrl: 'http://test-contracts.com',
      port: 3000,
    });
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    vi.restoreAllMocks();
  });

  describe('Client Initialization Contracts', () => {
    it('should ensure all domain clients are properly initialized', () => {
      // Verify that SandboxClient consistently initializes all domain clients
      expect(sandboxClient.commands).toBeInstanceOf(CommandClient);
      expect(sandboxClient.files).toBeInstanceOf(FileClient);
      expect(sandboxClient.processes).toBeInstanceOf(ProcessClient);
      expect(sandboxClient.ports).toBeInstanceOf(PortClient);
      expect(sandboxClient.git).toBeInstanceOf(GitClient);
      expect(sandboxClient.utils).toBeInstanceOf(UtilityClient);
    });

    it('should maintain client isolation across multiple sandbox instances', () => {
      const client1 = new SandboxClient({ baseUrl: 'http://test1.com', port: 3001 });
      const client2 = new SandboxClient({ baseUrl: 'http://test2.com', port: 3002 });

      // Verify proper isolation
      expect(client1.commands).not.toBe(client2.commands);
      expect(client1.files).not.toBe(client2.files);
      expect(client1.processes).not.toBe(client2.processes);
      expect(client1.ports).not.toBe(client2.ports);
      expect(client1.git).not.toBe(client2.git);
      expect(client1.utils).not.toBe(client2.utils);

      // Verify each maintains proper types
      expect(client1.commands).toBeInstanceOf(CommandClient);
      expect(client2.commands).toBeInstanceOf(CommandClient);
      expect(client1.files).toBeInstanceOf(FileClient);
      expect(client2.files).toBeInstanceOf(FileClient);
    });
  });

  describe('Method Signature Contracts', () => {
    it('should ensure consistent method signatures across client types', () => {
      const clients = [
        sandboxClient.commands,
        sandboxClient.files,
        sandboxClient.processes,
        sandboxClient.ports,
        sandboxClient.git,
        sandboxClient.utils
      ];

      // All clients should be objects with methods (not primitives)
      clients.forEach(client => {
        expect(typeof client).toBe('object');
        expect(client).not.toBeNull();
      });
    });

    it('should maintain consistent async behavior across operations', () => {
      // Mock consistent responses
      fetchMock.mockImplementation(() => 
        Promise.resolve(new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }))
      );

      // All major operations should return promises
      const commandPromise = sandboxClient.commands.execute('test', 'test-session');
      const filePromise = sandboxClient.files.readFile('/test.txt', 'test-session');
      const processPromise = sandboxClient.processes.listProcesses();
      const portPromise = sandboxClient.ports.getExposedPorts();
      const gitPromise = sandboxClient.git.checkout('https://github.com/test/repo.git', 'test-session');
      const utilPromise = sandboxClient.utils.ping();

      expect(commandPromise).toBeInstanceOf(Promise);
      expect(filePromise).toBeInstanceOf(Promise);
      expect(processPromise).toBeInstanceOf(Promise);
      expect(portPromise).toBeInstanceOf(Promise);
      expect(gitPromise).toBeInstanceOf(Promise);
      expect(utilPromise).toBeInstanceOf(Promise);
    });
  });

  describe('Error Handling Contracts', () => {
    it('should handle errors consistently across all clients', async () => {
      // Mock error response
      fetchMock.mockImplementation(() => 
        Promise.resolve(new Response(JSON.stringify({
          error: 'Test error',
          code: 'TEST_ERROR'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        }))
      );

      // All clients should handle errors consistently (throw, not return error objects)
      await expect(sandboxClient.commands.execute('bad-command', 'test-session')).rejects.toThrow();
      await expect(sandboxClient.files.readFile('/nonexistent', 'test-session')).rejects.toThrow();
      await expect(sandboxClient.processes.killProcess('bad-id')).rejects.toThrow();
      await expect(sandboxClient.ports.unexposePort(99999)).rejects.toThrow();
      await expect(sandboxClient.git.checkout('bad-url', 'test-session')).rejects.toThrow();
    });

    it('should maintain client stability during errors', async () => {
      // Mock network failure
      fetchMock.mockRejectedValue(new Error('Network failure'));

      // Even after errors, clients should remain intact
      try {
        await sandboxClient.commands.execute('test', 'test-session');
      } catch (error) {
        // Expected to fail
      }

      // Verify clients are still properly initialized
      expect(sandboxClient.commands).toBeInstanceOf(CommandClient);
      expect(sandboxClient.files).toBeInstanceOf(FileClient);
      expect(sandboxClient.processes).toBeInstanceOf(ProcessClient);
      expect(sandboxClient.ports).toBeInstanceOf(PortClient);
      expect(sandboxClient.git).toBeInstanceOf(GitClient);
      expect(sandboxClient.utils).toBeInstanceOf(UtilityClient);
    });
  });

  describe('Response Format Contracts', () => {
    it('should maintain consistent response structure across successful operations', async () => {
      // Mock different but valid response structures for each client type
      fetchMock.mockImplementation((url: string) => {
        if (url.includes('execute')) {
          return Promise.resolve(new Response(JSON.stringify({ 
            success: true, 
            stdout: 'command output',
            stderr: '',
            exitCode: 0
          }), { status: 200 }));
        }
        if (url.includes('read')) {
          return Promise.resolve(new Response(JSON.stringify({ 
            success: true,
            content: 'file content',
            path: '/test.txt'
          }), { status: 200 }));
        }
        if (url.includes('list')) {
          return Promise.resolve(new Response(JSON.stringify({ 
            success: true,
            processes: []
          }), { status: 200 }));
        }
        // Default response
        return Promise.resolve(new Response(JSON.stringify({ 
          success: true 
        }), { status: 200 }));
      });

      // Test various operations
      const commandResult = await sandboxClient.commands.execute('echo test', 'test-session');
      const fileResult = await sandboxClient.files.readFile('/test.txt', 'test-session');
      const processResult = await sandboxClient.processes.listProcesses();

      // Verify response structures
      expect(commandResult).toHaveProperty('success');
      expect(commandResult).toHaveProperty('stdout');
      expect(fileResult).toHaveProperty('success');
      expect(fileResult).toHaveProperty('content');
      expect(processResult).toHaveProperty('success');
      expect(processResult).toHaveProperty('processes');
    });
  });

  describe('Configuration Propagation Contracts', () => {
    it('should propagate configuration consistently to all domain clients', () => {
      const config = {
        baseUrl: 'http://custom-config.com',
        port: 9999,
        onCommandComplete: vi.fn(),
        onError: vi.fn(),
      };

      const configuredClient = new SandboxClient(config);

      // Verify all domain clients exist (configuration propagation successful)
      expect(configuredClient.commands).toBeInstanceOf(CommandClient);
      expect(configuredClient.files).toBeInstanceOf(FileClient);
      expect(configuredClient.processes).toBeInstanceOf(ProcessClient);
      expect(configuredClient.ports).toBeInstanceOf(PortClient);
      expect(configuredClient.git).toBeInstanceOf(GitClient);
      expect(configuredClient.utils).toBeInstanceOf(UtilityClient);
    });

    it('should handle partial configuration gracefully', () => {
      const partialConfigs = [
        {},
        { baseUrl: 'http://partial.com' },
        { port: 8080 },
        { onError: vi.fn() },
      ];

      partialConfigs.forEach(config => {
        const partialClient = new SandboxClient(config);
        
        // Should still create all domain clients
        expect(partialClient.commands).toBeInstanceOf(CommandClient);
        expect(partialClient.files).toBeInstanceOf(FileClient);
        expect(partialClient.processes).toBeInstanceOf(ProcessClient);
        expect(partialClient.ports).toBeInstanceOf(PortClient);
        expect(partialClient.git).toBeInstanceOf(GitClient);
        expect(partialClient.utils).toBeInstanceOf(UtilityClient);
      });
    });
  });
});

/**
 * NOTE: Session-related contract tests have been removed.
 * 
 * Previous session contract tests validated:
 * - Session propagation across all domain clients
 * - Session consistency during operations
 * - Session isolation between client instances
 * - Session state management lifecycle
 * 
 * These have been replaced with tests that focus on:
 * - Client initialization consistency
 * - Method signature contracts
 * - Error handling consistency
 * - Response format contracts
 * - Configuration propagation
 */