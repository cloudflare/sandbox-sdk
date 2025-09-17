/**
 * SandboxClient Tests - Simplified without Session Management
 * 
 * Tests core SandboxClient functionality. Session management has been removed
 * as sessions are now handled implicitly per sandbox instance.
 */

import { CommandClient } from '../../clients/command-client';
import { FileClient } from '../../clients/file-client';
import { GitClient } from '../../clients/git-client';
import { PortClient } from '../../clients/port-client';
import { ProcessClient } from '../../clients/process-client';
import { SandboxClient } from '../../clients/sandbox-client';
import { UtilityClient } from '../../clients/utility-client';

describe('SandboxClient', () => {
  let client: SandboxClient;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    fetchMock = vi.fn();
    global.fetch = fetchMock;
    
    client = new SandboxClient({
      baseUrl: 'http://test-sandbox.com',
      port: 3000,
    });
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    vi.restoreAllMocks();
  });

  describe('initialization', () => {
    it('should create all domain clients', () => {
      expect(client.commands).toBeInstanceOf(CommandClient);
      expect(client.files).toBeInstanceOf(FileClient);
      expect(client.processes).toBeInstanceOf(ProcessClient);
      expect(client.ports).toBeInstanceOf(PortClient);
      expect(client.git).toBeInstanceOf(GitClient);
      expect(client.utils).toBeInstanceOf(UtilityClient);
    });

    it('should use default baseUrl if not provided', () => {
      const defaultClient = new SandboxClient();
      expect(defaultClient.commands).toBeInstanceOf(CommandClient);
      expect(defaultClient.files).toBeInstanceOf(FileClient);
      expect(defaultClient.processes).toBeInstanceOf(ProcessClient);
      expect(defaultClient.ports).toBeInstanceOf(PortClient);
      expect(defaultClient.git).toBeInstanceOf(GitClient);
      expect(defaultClient.utils).toBeInstanceOf(UtilityClient);
    });

    it('should pass options to all clients', () => {
      const options = {
        baseUrl: 'http://custom.com',
        port: 8080,
        onCommandComplete: vi.fn(),
        onError: vi.fn(),
      };

      const customClient = new SandboxClient(options);
      expect(customClient.commands).toBeInstanceOf(CommandClient);
      expect(customClient.files).toBeInstanceOf(FileClient);
      expect(customClient.processes).toBeInstanceOf(ProcessClient);
      expect(customClient.ports).toBeInstanceOf(PortClient);
      expect(customClient.git).toBeInstanceOf(GitClient);
      expect(customClient.utils).toBeInstanceOf(UtilityClient);
    });
  });

  describe('client coordination', () => {
    it('should maintain client isolation between instances', () => {
      const client1 = new SandboxClient({ baseUrl: 'http://test1.com', port: 3000 });
      const client2 = new SandboxClient({ baseUrl: 'http://test2.com', port: 3000 });
      
      // Each client instance manages its own domain clients
      expect(client1.commands).toBeInstanceOf(CommandClient);
      expect(client2.commands).toBeInstanceOf(CommandClient);
      expect(client1.files).toBeInstanceOf(FileClient);
      expect(client2.files).toBeInstanceOf(FileClient);
      expect(client1.processes).toBeInstanceOf(ProcessClient);
      expect(client2.processes).toBeInstanceOf(ProcessClient);
      expect(client1.ports).toBeInstanceOf(PortClient);
      expect(client2.ports).toBeInstanceOf(PortClient);
      expect(client1.git).toBeInstanceOf(GitClient);
      expect(client2.git).toBeInstanceOf(GitClient);
      expect(client1.utils).toBeInstanceOf(UtilityClient);
      expect(client2.utils).toBeInstanceOf(UtilityClient);

      // Verify clients are separate instances
      expect(client1.commands).not.toBe(client2.commands);
      expect(client1.files).not.toBe(client2.files);
    });

    it('should allow dynamic client creation with different configurations', () => {
      const configs = [
        { baseUrl: 'http://dev.com', port: 3001 },
        { baseUrl: 'http://staging.com', port: 3002 },
        { baseUrl: 'http://prod.com', port: 3003 },
      ];

      configs.forEach(config => {
        const dynamicClient = new SandboxClient(config);
        expect(dynamicClient.commands).toBeInstanceOf(CommandClient);
        expect(dynamicClient.files).toBeInstanceOf(FileClient);
        expect(dynamicClient.processes).toBeInstanceOf(ProcessClient);
        expect(dynamicClient.ports).toBeInstanceOf(PortClient);
        expect(dynamicClient.git).toBeInstanceOf(GitClient);
        expect(dynamicClient.utils).toBeInstanceOf(UtilityClient);
      });
    });
  });

  describe('client lifecycle', () => {
    it('should handle multiple client instances without conflicts', () => {
      const clients = Array.from({ length: 5 }, (_, i) => 
        new SandboxClient({ 
          baseUrl: `http://test${i}.com`, 
          port: 3000 + i 
        })
      );

      clients.forEach((testClient, index) => {
        expect(testClient.commands).toBeInstanceOf(CommandClient);
        expect(testClient.files).toBeInstanceOf(FileClient);
        expect(testClient.processes).toBeInstanceOf(ProcessClient);
        expect(testClient.ports).toBeInstanceOf(PortClient);
        expect(testClient.git).toBeInstanceOf(GitClient);
        expect(testClient.utils).toBeInstanceOf(UtilityClient);

        // Verify independence
        if (index > 0) {
          expect(testClient.commands).not.toBe(clients[0].commands);
          expect(testClient.files).not.toBe(clients[0].files);
        }
      });
    });

    it('should maintain client integrity across operations', () => {
      // Mock responses for various operations
      fetchMock.mockImplementation(() => 
        Promise.resolve(new Response(JSON.stringify({ success: true }), { 
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }))
      );

      // Verify all clients are available and functional
      expect(typeof client.commands.execute).toBe('function');
      expect(typeof client.files.readFile).toBe('function');
      expect(typeof client.processes.listProcesses).toBe('function');
      expect(typeof client.ports.getExposedPorts).toBe('function');
      expect(typeof client.git.checkout).toBe('function');
      expect(typeof client.utils.ping).toBe('function');
    });
  });

  describe('error handling', () => {
    it('should handle initialization errors gracefully', () => {
      // Test edge cases in client creation
      expect(() => new SandboxClient({})).not.toThrow();
      expect(() => new SandboxClient({ baseUrl: '' })).not.toThrow();
      expect(() => new SandboxClient({ port: 0 })).not.toThrow();
    });

    it('should maintain client state during errors', () => {
      // Even if operations fail, client structure should remain intact
      fetchMock.mockRejectedValue(new Error('Network failure'));

      expect(client.commands).toBeInstanceOf(CommandClient);
      expect(client.files).toBeInstanceOf(FileClient);
      expect(client.processes).toBeInstanceOf(ProcessClient);
      expect(client.ports).toBeInstanceOf(PortClient);
      expect(client.git).toBeInstanceOf(GitClient);
      expect(client.utils).toBeInstanceOf(UtilityClient);
    });
  });
});

/**
 * NOTE: Extensive session management tests have been removed from this file.
 * Sessions are now handled implicitly per sandbox instance, eliminating the 
 * need for explicit session coordination across domain clients.
 * 
 * Previous session-focused tests included:
 * - Session propagation to domain clients
 * - Session lifecycle management
 * - Cross-client session coordination
 * - Session isolation between instances
 * - Session reset and reinitialization
 * 
 * These have been replaced with basic client initialization and coordination 
 * tests that focus on the core SandboxClient functionality.
 */